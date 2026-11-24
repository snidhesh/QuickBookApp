import * as XLSX from 'xlsx';

// Column names users commonly use, normalized (lowercase, letters and digits only).
const COLUMN_ALIASES = {
  journalNo: ['journalno', 'journalnumber', 'journalnum', 'journalid', 'journal', 'entryno', 'entrynumber', 'je', 'jeno', 'jenumber', 'jeid', 'journalentryno', 'journalentrynumber', 'docnumber', 'docno', 'refno', 'referenceno', 'voucherno', 'vouchernumber', 'voucher', 'txnno', 'transactionno'],
  date: ['journaldate', 'date', 'txndate', 'entrydate', 'transactiondate', 'postingdate'],
  account: ['accountname', 'account', 'accountnumber', 'accountno', 'glaccount', 'ledgeraccount', 'accountcode'],
  debit: ['debits', 'debit', 'dr', 'debitamount', 'debitamt'],
  credit: ['credits', 'credit', 'cr', 'creditamount', 'creditamt'],
  description: ['description', 'linedescription', 'linememo', 'memo', 'narration', 'particulars'],
  name: ['name', 'entity', 'customervendor', 'payee', 'customer', 'vendor', 'employee'],
  className: ['class', 'classname'],
  location: ['location', 'department', 'locationname'],
  currency: ['currency', 'currencycode'],
  exchangeRate: ['exchangerate', 'rate', 'fxrate'],
  entryMemo: ['journalmemo', 'entrymemo', 'privatenote', 'notes', 'journalnote'],
  taxCode: ['tax', 'taxcode', 'vat', 'vatcode', 'taxrate', 'vatrate'],
};

export const TEMPLATE_HEADERS = ['Journal No', 'Journal Date', 'Account Name', 'Debits', 'Credits', 'Description', 'Name', 'Class', 'Location', 'Currency', 'Journal Memo'];

// "DEBITS (AED)" -> "debits": text in brackets is ignored when matching column names.
const normalize = (s) => String(s ?? '').replace(/\([^)]*\)/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// A currency code in the Debits/Credits headers, e.g. "DEBITS (AED)" -> "AED".
function headerCurrency(row, map) {
  for (const field of ['debit', 'credit']) {
    const m = String(row[map[field]] ?? '').match(/\(\s*([A-Za-z]{3})\s*\)/);
    if (m) return m[1].toUpperCase();
  }
  return '';
}

function mapHeaders(row) {
  const map = {};
  row.forEach((cell, idx) => {
    const key = normalize(cell);
    if (!key) return;
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (map[field] === undefined && aliases.includes(key)) {
        map[field] = idx;
        return;
      }
    }
  });
  return map;
}

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';
const text = (v) => (isBlank(v) ? '' : String(v).trim());

// Rounds to whole cents; toPrecision strips float noise so 1.005 becomes 101 cents, not 100.
const toCents = (n) => Math.round(Number((n * 100).toPrecision(12)));

// Returns an integer number of cents, null for blank, or NaN for unreadable values.
export function parseAmount(v) {
  if (isBlank(v)) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? toCents(v) : NaN;
  let s = String(v).trim();
  if (/^[-–—]$/.test(s)) return null; // accounting-style "-" for zero
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  // Allow currency symbols or codes around the number: $1,200.50, Rs. 500, 100 USD
  s = s
    .replace(/^(?:[A-Za-z]{3}\s+|Rs\.?\s*|[$€£₹¥])/i, '')
    .replace(/\s+[A-Za-z]{3}$/, '')
    .replace(/[\s,]/g, '');
  if (!/^[-+]?\d*\.?\d+$/.test(s)) return NaN;
  const n = toCents(Number(s));
  return negative ? -n : n;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function isoDate(y, m, d) {
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Returns YYYY-MM-DD or null. Excel stores real dates as serial numbers, which are unambiguous;
// text dates like 03/04/2026 are read using dateOrder ('MDY' or 'DMY').
export function parseDate(v, dateOrder = 'MDY', date1904 = false) {
  if (isBlank(v)) return null;
  if (v instanceof Date) return isoDate(v.getFullYear(), v.getMonth() + 1, v.getDate());
  if (typeof v === 'number') {
    const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
    const dt = new Date(epoch + Math.floor(v) * 86400000);
    return isoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  const s = String(v).trim();
  let m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/))) return isoDate(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:\s.*)?$/))) {
    return dateOrder === 'DMY' ? isoDate(+m[3], +m[2], +m[1]) : isoDate(+m[3], +m[1], +m[2]);
  }
  if ((m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,})[\s,-]+(\d{2}|\d{4})$/))) {
    const mon = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    return mon < 0 ? null : isoDate(+m[3], mon + 1, +m[1]);
  }
  if ((m = s.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/))) {
    const mon = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    return mon < 0 ? null : isoDate(+m[3], mon + 1, +m[2]);
  }
  return null;
}

function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const map = mapHeaders(rows[i] || []);
    if (map.account !== undefined && (map.debit !== undefined || map.credit !== undefined)) return { index: i, map };
  }
  return null;
}

const fmtCents = (c) => (c / 100).toFixed(2);

/**
 * Reads the workbook and groups its rows into journal entries.
 * Journal No and date carry down to following lines when left blank, so files where
 * only the first line of each entry has them still work.
 */
export function parseWorkbook(buffer, { dateOrder = 'MDY' } = {}) {
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', raw: true, cellDates: false, dense: false });
  } catch {
    return { fileErrors: ['This file could not be read. Upload an .xlsx, .xls or .csv file.'], entries: [] };
  }
  const date1904 = Boolean(wb.Workbook?.WBProps?.date1904);

  let sheetName = null;
  let header = null;
  let rows = null;
  let rowOffset = 0;
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws?.['!ref']) continue;
    const r = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
    const h = findHeader(r);
    if (h) {
      sheetName = name;
      header = { ...h, currency: headerCurrency(r[h.index], h.map) };
      rows = r;
      rowOffset = XLSX.utils.decode_range(ws['!ref']).s.r;
      break;
    }
  }

  if (!header) {
    return {
      fileErrors: [
        'No header row found. The sheet needs at least an "Account Name" column and "Debits" / "Credits" columns. Download the template to see the expected layout.',
      ],
      entries: [],
    };
  }

  const { map } = header;
  const fileErrors = [];
  if (map.date === undefined) fileErrors.push('Add a "Journal Date" column.');
  if (fileErrors.length) return { fileErrors, entries: [], sheetName };

  // With a Journal No column, lines are grouped by number. Without one, consecutive lines
  // form an entry until their debits and credits balance, or the date changes.
  const groupByNumber = map.journalNo !== undefined;
  const get = (row, field) => (map[field] === undefined ? null : row[map[field]]);
  const entries = [];
  const byNumber = new Map();
  let open = null; // entry being built when grouping by balance
  let lastJournalNo = '';
  let lastDateRaw = null;

  const newEntry = (docNumber) => ({
    key: docNumber,
    docNumber,
    dateRaw: [],
    currency: '',
    exchangeRateRaw: null,
    memo: '',
    lines: [],
    errors: [],
    warnings: [],
    debitSoFar: 0,
    creditSoFar: 0,
  });

  for (let i = header.index + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const rowNumber = rowOffset + i + 1;
    const account = text(get(row, 'account'));
    const debitRaw = get(row, 'debit');
    const creditRaw = get(row, 'credit');
    const journalNoCell = text(get(row, 'journalNo'));
    const dateCell = get(row, 'date');

    // Skip blank rows and total/subtotal rows.
    if (!account && isBlank(debitRaw) && isBlank(creditRaw)) continue;
    if (!account && !journalNoCell && groupByNumber) continue;
    const totalLabel = /^(grand\s+|sub\s*)?totals?\b/i;
    if ((!account && totalLabel.test(journalNoCell)) || totalLabel.test(account)) continue;
    if (!account && !groupByNumber && totalLabel.test(text(get(row, 'description')))) continue;

    const journalNo = journalNoCell || lastJournalNo;
    if (journalNoCell) {
      if (journalNoCell !== lastJournalNo) lastDateRaw = null;
      lastJournalNo = journalNoCell;
    }
    const dateRaw = isBlank(dateCell) ? lastDateRaw : dateCell;
    if (!isBlank(dateCell)) lastDateRaw = dateCell;

    const line = {
      row: rowNumber,
      account,
      description: text(get(row, 'description')),
      name: text(get(row, 'name')),
      className: text(get(row, 'className')),
      location: text(get(row, 'location')),
      taxCode: text(get(row, 'taxCode')),
      debit: 0,
      credit: 0,
      errors: [],
    };

    const debit = parseAmount(debitRaw);
    const credit = parseAmount(creditRaw);
    if (Number.isNaN(debit)) line.errors.push(`Debit "${text(debitRaw)}" isn't a number.`);
    if (Number.isNaN(credit)) line.errors.push(`Credit "${text(creditRaw)}" isn't a number.`);
    if (debit < 0 || credit < 0) line.errors.push('Amounts must be positive. Put the amount in the other column instead.');
    if (debit > 0 && credit > 0) line.errors.push('A line can have a debit or a credit, not both. Split it into two lines.');
    if ([debit, credit].every((v) => v === null || v === 0)) line.errors.push('This line has no amount.');
    if (!account) line.errors.push('Account is empty.');
    if (line.description.length > 4000) line.errors.push('Description is longer than 4,000 characters.');
    if (line.taxCode) line.errors.push(`Tax "${line.taxCode}" can't be posted yet: this app doesn't apply tax codes to journal lines.`);
    line.debit = debit > 0 ? debit : 0;
    line.credit = credit > 0 ? credit : 0;

    let entry;
    if (groupByNumber) {
      const key = journalNo || `Row ${rowNumber}`;
      entry = byNumber.get(key);
      if (!entry) {
        entry = newEntry(journalNo);
        entry.key = key;
        byNumber.set(key, entry);
        entries.push(entry);
      }
      if (!journalNo) line.errors.push('Journal No is empty.');
    } else {
      const lineDate = parseDate(dateRaw, dateOrder, date1904);
      const balanced = open && open.lines.length >= 2 && open.debitSoFar === open.creditSoFar;
      const dateChanged = open && lineDate && open.firstDate && lineDate !== open.firstDate;
      if (!open || balanced || dateChanged) {
        open = newEntry('');
        open.firstDate = lineDate;
        entries.push(open);
      }
      entry = open;
    }

    entry.dateRaw.push({ value: dateRaw, row: rowNumber });
    entry.currency ||= text(get(row, 'currency')).toUpperCase();
    if (isBlank(entry.exchangeRateRaw)) entry.exchangeRateRaw = get(row, 'exchangeRate');
    entry.memo ||= text(get(row, 'entryMemo'));
    entry.debitSoFar += line.debit;
    entry.creditSoFar += line.credit;
    entry.lines.push(line);
  }

  for (const entry of entries) {
    if (!groupByNumber) {
      const first = entry.lines[0].row;
      const last = entry.lines.at(-1).row;
      entry.key = first === last ? `Row ${first}` : `Rows ${first}–${last}`;
    }
    entry.currency ||= header.currency;
    delete entry.debitSoFar;
    delete entry.creditSoFar;
    delete entry.firstDate;
    finishEntry(entry, dateOrder, date1904);
  }

  if (!entries.length) fileErrors.push('The sheet has a header row but no journal lines under it.');
  return { fileErrors, sheetName, groupedBy: groupByNumber ? 'number' : 'balance', entries };
}

function finishEntry(entry, dateOrder, date1904) {
  const dates = new Set();
  for (const { value, row } of entry.dateRaw) {
    if (isBlank(value)) {
      entry.errors.push(`Row ${row}: date is empty.`);
      continue;
    }
    const iso = parseDate(value, dateOrder, date1904);
    if (!iso) entry.errors.push(`Row ${row}: "${text(value)}" isn't a date this app can read. Use a real Excel date or YYYY-MM-DD.`);
    else dates.add(iso);
  }
  if (dates.size > 1) entry.errors.push(`Lines have different dates (${[...dates].join(', ')}). All lines of an entry share one date.`);
  entry.txnDate = dates.size ? [...dates][0] : null;
  delete entry.dateRaw;

  if (entry.docNumber.length > 21) entry.errors.push('Journal No is longer than 21 characters, the QuickBooks limit.');
  if (entry.memo.length > 4000) entry.errors.push('Journal memo is longer than 4,000 characters.');

  if (!isBlank(entry.exchangeRateRaw)) {
    const rate = Number(String(entry.exchangeRateRaw).replace(/,/g, ''));
    if (!(rate > 0)) entry.errors.push(`Exchange rate "${text(entry.exchangeRateRaw)}" isn't a positive number.`);
    else entry.exchangeRate = rate;
  }
  delete entry.exchangeRateRaw;

  entry.totalDebit = entry.lines.reduce((s, l) => s + l.debit, 0);
  entry.totalCredit = entry.lines.reduce((s, l) => s + l.credit, 0);
  if (entry.lines.length < 2) entry.errors.push('An entry needs at least two lines.');
  if (entry.totalDebit !== entry.totalCredit) {
    entry.errors.push(
      `Out of balance by ${fmtCents(Math.abs(entry.totalDebit - entry.totalCredit))}: debits ${fmtCents(entry.totalDebit)}, credits ${fmtCents(entry.totalCredit)}.`,
    );
  }
}

export function buildTemplate() {
  const rows = [
    TEMPLATE_HEADERS,
    ['JE-1001', '2026-11-01', 'Rent or Lease', 1500, null, 'November office rent', '', '', '', '', 'Monthly rent accrual'],
    ['JE-1001', '2026-11-01', 'Checking', null, 1500, 'November office rent', '', '', '', '', ''],
    ['JE-1002', '2026-11-03', 'Advertising', 250.75, null, 'Online ads', '', '', '', '', ''],
    ['JE-1002', '2026-11-03', 'Office Expenses', 49.25, null, 'Printer paper', '', '', '', '', ''],
    ['JE-1002', '2026-11-03', 'Checking', null, 300, 'Card payment', '', '', '', '', ''],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  // Store dates as real Excel dates (serial numbers) so they're unambiguous in any locale.
  for (let r = 1; r < rows.length; r++) {
    const addr = XLSX.utils.encode_cell({ r, c: 1 });
    const [y, m, d] = rows[r][1].split('-').map(Number);
    ws[addr] = { t: 'n', v: (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000, z: 'yyyy-mm-dd' };
  }
  ws['!cols'] = [12, 14, 28, 12, 12, 30, 22, 14, 14, 10, 28].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Journal Entries');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
