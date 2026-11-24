import { queryAll, query, request, escapeQueryValue } from './qbo.js';

const key = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

function addTo(map, k, item) {
  if (!k) return;
  const list = map.get(k) || [];
  if (!list.includes(item)) list.push(item);
  map.set(k, list);
}

function buildAccountIndex(accounts) {
  const byFullName = new Map();
  const byNumber = new Map();
  const byName = new Map();
  for (const a of accounts) {
    addTo(byFullName, key(a.FullyQualifiedName), a);
    if (a.AcctNum) {
      addTo(byNumber, key(a.AcctNum), a);
      addTo(byFullName, key(`${a.AcctNum} ${a.Name}`), a);
      addTo(byFullName, key(`${a.AcctNum} - ${a.Name}`), a);
      addTo(byFullName, key(`${a.AcctNum} ${a.FullyQualifiedName}`), a);
    }
    addTo(byName, key(a.Name), a);
  }
  return { byFullName, byNumber, byName, all: accounts };
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// Close matches for a name that wasn't found: small typos, or part of a longer name.
function suggestAccounts(index, input) {
  const k = key(input);
  if (k.length < 3) return [];
  return index.all
    .filter((a) => {
      const full = key(a.FullyQualifiedName);
      const name = key(a.Name);
      return full.includes(k) || editDistance(k, name) <= 2 || editDistance(k, full) <= 2;
    })
    .slice(0, 3)
    .map((a) => a.FullyQualifiedName);
}

function findAccount(index, input) {
  const k = key(input);
  for (const map of [index.byFullName, index.byNumber, index.byName]) {
    const hits = map.get(k);
    if (hits?.length === 1) return { account: hits[0] };
    if (hits?.length > 1) {
      return { error: `"${input}" matches ${hits.length} accounts (${hits.map((a) => a.FullyQualifiedName).join(', ')}). Use the full name, like "Parent:Child", or the account number.` };
    }
  }
  const suggestions = suggestAccounts(index, input);
  return {
    error: `Account "${input}" isn't in QuickBooks.${suggestions.length ? ` Did you mean ${suggestions.map((s) => `"${s}"`).join(' or ')}?` : ''}`,
  };
}

function buildNameIndex(customers, vendors, employees) {
  const map = new Map();
  const add = (k, entity) => {
    if (!k) return;
    const list = map.get(k) || [];
    // A top-level customer's full name equals its display name: count it once.
    if (!list.some((e) => e.type === entity.type && e.id === entity.id)) list.push(entity);
    map.set(k, list);
  };
  for (const [type, list] of [['Customer', customers], ['Vendor', vendors], ['Employee', employees]]) {
    for (const item of list) {
      add(key(item.DisplayName), { type, id: item.Id, displayName: item.DisplayName });
      if (type === 'Customer' && item.FullyQualifiedName) add(key(item.FullyQualifiedName), { type, id: item.Id, displayName: item.FullyQualifiedName });
    }
  }
  return map;
}

function findName(index, input, preferType) {
  const hits = index.get(key(input)) || [];
  if (!hits.length) return { error: `Name "${input}" isn't a customer, vendor or employee in QuickBooks.` };
  if (hits.length === 1) return { entity: hits[0] };
  const preferred = hits.filter((h) => h.type === preferType);
  if (preferred.length === 1) return { entity: preferred[0] };
  const types = [...new Set(hits.map((h) => h.type))];
  if (types.length === hits.length) {
    // Same name as e.g. both a customer and a vendor: pick in a fixed order, and say so.
    const pick = hits.find((h) => h.type === 'Customer') || hits.find((h) => h.type === 'Vendor') || hits[0];
    return { entity: pick, warning: `"${input}" is both a ${types.join(' and a ').toLowerCase()}; used the ${pick.type.toLowerCase()}.` };
  }
  return { error: `"${input}" matches more than one ${types[0].toLowerCase()} in QuickBooks.` };
}

function buildSimpleIndex(list) {
  const map = new Map();
  for (const item of list) {
    addTo(map, key(item.FullyQualifiedName || item.Name), item);
    addTo(map, key(item.Name), item);
  }
  return map;
}

function findSimple(index, input, label) {
  const hits = index.get(key(input)) || [];
  if (hits.length === 1) return { item: hits[0] };
  if (hits.length > 1) return { error: `${label} "${input}" matches more than one ${label.toLowerCase()}. Use the full name, like "Parent:Child".` };
  return { error: `${label} "${input}" isn't in QuickBooks.` };
}

async function optionalList(entity, needed) {
  if (!needed) return [];
  try {
    return await queryAll(entity, 'Active = true');
  } catch {
    return []; // e.g. class or location tracking is turned off for this company
  }
}

async function findExistingDocNumbers(docNumbers) {
  const existing = new Map();
  const unique = [...new Set(docNumbers.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const list = chunk.map((d) => `'${escapeQueryValue(d)}'`).join(', ');
    const resp = await query(`select Id, DocNumber, TxnDate from JournalEntry where DocNumber in (${list}) maxresults 1000`);
    for (const je of resp.JournalEntry || []) {
      const k = key(je.DocNumber);
      if (!existing.has(k)) existing.set(k, []);
      existing.get(k).push({ id: je.Id, txnDate: je.TxnDate });
    }
  }
  return existing;
}

async function companyCurrency() {
  try {
    const prefs = (await request('GET', 'preferences'))?.Preferences?.CurrencyPrefs;
    return { home: prefs?.HomeCurrency?.value || null, multi: Boolean(prefs?.MultiCurrencyEnabled) };
  } catch {
    return { home: null, multi: false };
  }
}

// Date + the set of (account, debit/credit, amount) lines identifies an entry when there's no Journal No.
const fingerprint = (date, lines) => `${date}#${lines.map((l) => `${l.accountId}|${l.type}|${l.cents}`).sort().join(';')}`;

async function findSameContentEntries(entries) {
  const dates = entries.filter((e) => !e.docNumber && e.txnDate).map((e) => e.txnDate).sort();
  const found = new Map();
  if (!dates.length) return found;
  const existing = await queryAll('JournalEntry', `TxnDate >= '${dates[0]}' and TxnDate <= '${dates.at(-1)}'`);
  for (const je of existing) {
    const lines = (je.Line || [])
      .filter((l) => l.JournalEntryLineDetail)
      .map((l) => ({ accountId: l.JournalEntryLineDetail.AccountRef?.value, type: l.JournalEntryLineDetail.PostingType, cents: Math.round(Number((l.Amount * 100).toPrecision(12))) }));
    const fp = fingerprint(je.TxnDate, lines);
    if (!found.has(fp)) found.set(fp, []);
    found.get(fp).push({ id: je.Id, txnDate: je.TxnDate, docNumber: je.DocNumber || null });
  }
  return found;
}

/**
 * Looks up every account, name, class and location the file mentions, checks for
 * entries already in QuickBooks, and attaches the API payload to each valid entry.
 */
export async function resolveEntries(entries) {
  const lines = entries.flatMap((e) => e.lines);
  const needNames = lines.some((l) => l.name);
  const needClasses = lines.some((l) => l.className);
  const needLocations = lines.some((l) => l.location);

  const [accounts, customers, vendors, employees, classes, departments, existing, sameContent, currency] = await Promise.all([
    queryAll('Account', 'Active = true'),
    optionalList('Customer', needNames),
    optionalList('Vendor', needNames),
    optionalList('Employee', needNames),
    optionalList('Class', needClasses),
    optionalList('Department', needLocations),
    findExistingDocNumbers(entries.map((e) => e.docNumber)),
    findSameContentEntries(entries),
    companyCurrency(),
  ]);

  const accountIndex = buildAccountIndex(accounts);
  const nameIndex = buildNameIndex(customers, vendors, employees);
  const classIndex = buildSimpleIndex(classes);
  const locationIndex = buildSimpleIndex(departments);

  for (const entry of entries) {
    for (const line of entry.lines) {
      if (line.account) {
        const { account, error } = findAccount(accountIndex, line.account);
        if (error) line.errors.push(error);
        else line.accountRef = { id: account.Id, name: account.FullyQualifiedName, type: account.AccountType, currency: account.CurrencyRef?.value };
      }

      const accountType = line.accountRef?.type;
      const preferType = accountType === 'Accounts Receivable' ? 'Customer' : accountType === 'Accounts Payable' ? 'Vendor' : null;
      if (line.name) {
        const { entity, error, warning } = findName(nameIndex, line.name, preferType);
        if (error) line.errors.push(error);
        else line.entityRef = entity;
        if (warning) entry.warnings.push(`Row ${line.row}: ${warning}`);
      }
      if (accountType === 'Accounts Receivable' && line.entityRef?.type !== 'Customer' && !line.errors.length) {
        line.errors.push('Lines on an Accounts Receivable account need a customer in the Name column.');
      }
      if (accountType === 'Accounts Payable' && line.entityRef?.type !== 'Vendor' && !line.errors.length) {
        line.errors.push('Lines on an Accounts Payable account need a vendor in the Name column.');
      }

      if (line.className) {
        const { item, error } = findSimple(classIndex, line.className, 'Class');
        if (error) line.errors.push(classes.length ? error : `Class "${line.className}" isn't in QuickBooks, or class tracking is turned off.`);
        else line.classRef = { id: item.Id, name: item.FullyQualifiedName || item.Name };
      }
      if (line.location) {
        const { item, error } = findSimple(locationIndex, line.location, 'Location');
        if (error) line.errors.push(departments.length ? error : `Location "${line.location}" isn't in QuickBooks, or location tracking is turned off.`);
        else line.locationRef = { id: item.Id, name: item.FullyQualifiedName || item.Name };
      }
    }

    if (entry.currency && currency.home && entry.currency !== currency.home && !currency.multi) {
      entry.errors.push(
        `Amounts are in ${entry.currency}, but this QuickBooks company works in ${currency.home} and multicurrency is off. Use a company set up in ${entry.currency}.`,
      );
    }

    if (entry.docNumber) {
      const dupes = existing.get(key(entry.docNumber));
      if (dupes?.length) {
        entry.duplicateOf = dupes;
        entry.warnings.push(`Journal No ${entry.docNumber} is already in QuickBooks (dated ${dupes.map((d) => d.txnDate).join(', ')}).`);
      }
    } else if (entry.txnDate && entry.lines.every((l) => l.accountRef)) {
      const fp = fingerprint(
        entry.txnDate,
        entry.lines.map((l) => ({ accountId: l.accountRef.id, type: l.debit > 0 ? 'Debit' : 'Credit', cents: l.debit || l.credit })),
      );
      const dupes = sameContent.get(fp);
      if (dupes?.length) {
        entry.duplicateOf = dupes;
        entry.warnings.push(
          `QuickBooks already has a journal entry on this date with the same accounts and amounts${dupes[0].docNumber ? ` (no. ${dupes[0].docNumber})` : ''}.`,
        );
      }
    }

    const hasErrors = entry.errors.length || entry.lines.some((l) => l.errors.length);
    entry.status = hasErrors ? 'error' : entry.duplicateOf ? 'duplicate' : 'ready';
    if (!hasErrors) entry.payload = toPayload(entry, currency.home);
  }
  return entries;
}

function toPayload(entry, homeCurrency) {
  const payload = {
    TxnDate: entry.txnDate,
    ...(entry.docNumber ? { DocNumber: entry.docNumber } : {}),
    Line: entry.lines.map((l) => {
      const detail = {
        PostingType: l.debit > 0 ? 'Debit' : 'Credit',
        AccountRef: { value: l.accountRef.id },
      };
      if (l.entityRef) detail.Entity = { Type: l.entityRef.type, EntityRef: { value: l.entityRef.id } };
      if (l.classRef) detail.ClassRef = { value: l.classRef.id };
      if (l.locationRef) detail.DepartmentRef = { value: l.locationRef.id };
      return {
        DetailType: 'JournalEntryLineDetail',
        Amount: (l.debit || l.credit) / 100,
        ...(l.description ? { Description: l.description } : {}),
        JournalEntryLineDetail: detail,
      };
    }),
  };
  if (entry.memo) payload.PrivateNote = entry.memo;
  if (entry.currency && entry.currency !== homeCurrency) payload.CurrencyRef = { value: entry.currency };
  if (entry.exchangeRate) payload.ExchangeRate = entry.exchangeRate;
  return payload;
}
