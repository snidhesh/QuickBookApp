const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (cents) => (cents ? money.format(cents / 100) : '');
const fmtDate = (iso) =>
  iso ? new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'No date';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const state = { status: null, batch: null, filter: 'all', posting: false };

const STATUS_LABEL = {
  ready: 'Ready',
  error: 'Needs fixing',
  duplicate: 'Already in QuickBooks',
  posting: 'Posting…',
  posted: 'Posted',
  failed: "Didn't post",
};

function showNotice(message, kind = 'error') {
  const el = $('#notice');
  if (!message) {
    el.hidden = true;
    return;
  }
  el.className = `notice ${kind === 'info' ? 'info' : ''}`;
  el.innerHTML = message;
  el.hidden = false;
}

// ---------- connection ----------

async function loadStatus() {
  const res = await fetch('/api/status');
  state.status = await res.json();
  const s = state.status;
  $('#login').hidden = !s.loginRequired;
  $('#workspace').hidden = Boolean(s.loginRequired);
  if (s.setupError) {
    showNotice(esc(s.setupError));
    $('#login').hidden = true;
    $('#workspace').hidden = true;
    $('#conn').innerHTML = '';
    return;
  }
  if (s.loginRequired) {
    $('#conn').innerHTML = '';
    resetReview();
    $('#password').focus();
    return;
  }
  renderConnection();
}

// API calls that find the session expired send the user back to the sign-in screen.
async function api(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    const data = await res.clone().json().catch(() => ({}));
    if (data.loginRequired) {
      await loadStatus();
      throw Object.assign(new Error('Your session ended. Sign in again.'), { handled: true });
    }
  }
  return res;
}

function wireLogin() {
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('#password').value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      $('#login-error').textContent = data.error || 'Sign-in failed.';
      return;
    }
    $('#password').value = '';
    showNotice('');
    loadStatus();
  });
}

function renderConnection() {
  const s = state.status;
  const conn = $('#conn');
  const env = s.environment === 'sandbox' ? '<span class="env">(sandbox)</span>' : '';
  const signOut = s.signOut ? '<button class="quiet" id="sign-out" type="button">Sign out</button>' : '';
  if (!s.configured) {
    conn.innerHTML = `<span><span class="dot"></span>Not set up</span>`;
    showNotice(
      'The app has no QuickBooks keys yet. Copy <code>.env.example</code> to <code>.env</code>, add the Client ID and Client Secret from your Intuit developer app, then restart.',
    );
  } else if (s.connected) {
    conn.innerHTML = `<span><span class="dot on"></span>Connected to <strong>${esc(s.companyName || `company ${s.realmId}`)}</strong> ${env}</span>
      <button class="quiet" id="disconnect" type="button">Disconnect</button>`;
    $('#disconnect').onclick = async () => {
      await api('/api/disconnect', { method: 'POST' }).catch(() => {});
      resetReview();
      loadStatus();
    };
  } else {
    conn.innerHTML = `<span><span class="dot"></span>Not connected ${env}</span>
      <a class="link-button primary-link" href="/connect">Connect to QuickBooks</a>`;
  }
  if (signOut) {
    conn.insertAdjacentHTML('beforeend', signOut);
    $('#sign-out').onclick = async () => {
      await fetch('/api/logout', { method: 'POST' });
      resetReview();
      loadStatus();
    };
  }
  const canUpload = s.configured && s.connected;
  $('#upload-form').classList.toggle('disabled', !canUpload);
  $('#file').disabled = !canUpload;
  $('#drop-sub').textContent = canUpload
    ? '.xlsx, .xls or .csv, up to 4 MB'
    : 'Connect to QuickBooks first so accounts can be checked.';
}

// ---------- upload ----------

async function uploadFile(file) {
  if (!file || state.posting) return;
  const form = $('#upload-form');
  form.classList.add('busy');
  $('#drop-sub').textContent = `Checking ${file.name} against QuickBooks…`;
  showNotice('');

  const body = new FormData();
  body.append('file', file);
  body.append('dateOrder', $('#dateOrder').value);
  try {
    const res = await api('/api/preview', { method: 'POST', body });
    const data = await res.json();
    if (res.status === 401) {
      await loadStatus();
      showNotice(esc(data.error || 'The QuickBooks connection ended. Connect again.'));
      return;
    }
    if (!res.ok && !data.fileErrors) throw new Error(data.error || `Upload failed (${res.status}).`);
    state.batch = data;
    state.batch.entries ||= [];
    state.batch.entries.forEach((e) => (e.baseStatus = e.status));
    state.filter = state.batch.entries.some((e) => e.status === 'error') ? 'error' : 'all';
    renderReview();
    $('#review').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  } catch (err) {
    if (!err.handled) showNotice(esc(err.message));
  } finally {
    form.classList.remove('busy');
    $('#file').value = '';
    renderConnection();
  }
}

function wireUpload() {
  $('#file').addEventListener('change', (e) => uploadFile(e.target.files[0]));
  const target = $('#drop-target');
  ['dragenter', 'dragover'].forEach((t) =>
    target.addEventListener(t, (e) => {
      e.preventDefault();
      if (!$('#file').disabled) target.classList.add('over');
    }),
  );
  ['dragleave', 'drop'].forEach((t) => target.addEventListener(t, () => target.classList.remove('over')));
  target.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!$('#file').disabled) uploadFile(e.dataTransfer.files[0]);
  });
}

// ---------- review ----------

function resetReview() {
  state.batch = null;
  $('#review').hidden = true;
}

const counts = () => {
  const c = { all: 0, ready: 0, error: 0, duplicate: 0, posted: 0, failed: 0 };
  for (const e of state.batch.entries) {
    c.all++;
    c[e.status] = (c[e.status] || 0) + 1;
  }
  return c;
};

function postable() {
  const includeDups = $('#include-dups').checked;
  const eligible = (s) => s === 'ready' || (includeDups && s === 'duplicate');
  return state.batch.entries.filter((e) => eligible(e.status) || (e.status === 'failed' && eligible(e.baseStatus)));
}

function renderReview() {
  const b = state.batch;
  $('#review').hidden = false;
  $('#review-title').textContent = b.fileName;

  const c = counts();
  const parts = [];
  if (c.posted) parts.push(`${c.posted} posted`);
  if (c.ready) parts.push(`${c.ready} ready to post`);
  if (c.failed) parts.push(`${c.failed} didn't post`);
  if (c.error) parts.push(`${c.error} need fixing in the file`);
  if (c.duplicate) parts.push(`${c.duplicate} already in QuickBooks`);
  const lines = b.entries.reduce((n, e) => n + e.lines.length, 0);
  $('#review-summary').textContent = b.entries.length
    ? `${plural(c.all, 'entry', 'entries')}, ${plural(lines, 'line')}${b.sheetName ? ` from sheet "${b.sheetName}"` : ''}. ${parts.join(', ')}.`
    : '';

  $('#file-errors').innerHTML = (b.fileErrors || []).map((m) => `<div class="file-error">${esc(m)}</div>`).join('');
  $('#dup-option').hidden = !c.duplicate;

  const n = postable().length;
  const btn = $('#post-btn');
  btn.disabled = state.posting || n === 0;
  if (!state.posting) btn.textContent = n ? `Post ${plural(n, 'entry', 'entries')} to QuickBooks` : c.posted ? 'All entries posted' : 'Nothing to post';

  const tabs = [
    ['all', 'All', c.all],
    ['error', 'Needs fixing', c.error],
    ['ready', 'Ready', c.ready],
    ['duplicate', 'Already in QuickBooks', c.duplicate],
    ['posted', 'Posted', c.posted],
    ['failed', "Didn't post", c.failed],
  ].filter(([k, , n]) => k === 'all' || n > 0);
  if (!tabs.some(([k]) => k === state.filter)) state.filter = 'all';
  $('#filters').innerHTML = b.entries.length
    ? tabs.map(([k, label, n]) => `<button type="button" role="tab" data-filter="${k}" aria-selected="${state.filter === k}">${label} (${n})</button>`).join('')
    : '';
  $('#filters').querySelectorAll('button').forEach((el) => {
    el.onclick = () => {
      state.filter = el.dataset.filter;
      renderReview();
    };
  });

  const shown = b.entries.filter((e) => state.filter === 'all' || e.status === state.filter);
  $('#entries').innerHTML = shown.length
    ? shown.map(renderEntry).join('')
    : b.entries.length
      ? '<p class="empty">No entries in this view.</p>'
      : '';
}

function renderEntry(e) {
  const showClass = e.lines.some((l) => l.className || l.location);
  const msgs = [
    ...e.errors.map((m) => `<li class="err">${esc(m)}</li>`),
    ...(e.status === 'failed' && e.result ? [`<li class="err">QuickBooks said: ${esc(e.result.error)}</li>`] : []),
    ...e.warnings.map((m) => `<li class="warn">${esc(m)}</li>`),
  ];
  let status = esc(STATUS_LABEL[e.status] || e.status);
  if (e.status === 'posted' && e.result?.link) {
    status = `<a href="${esc(e.result.link)}" target="_blank" rel="noopener">Posted, open in QuickBooks</a>`;
  }
  const off = e.totalDebit !== e.totalCredit;

  const rows = e.lines
    .map((l) => {
      const account = l.accountResolved
        ? `${esc(l.account)}${l.accountResolved.toLowerCase() !== l.account.toLowerCase() ? `<span class="sub matched">${esc(l.accountResolved)}</span>` : ''}`
        : esc(l.account);
      const extra = [l.className && `Class: ${esc(l.className)}`, l.location && `Location: ${esc(l.location)}`].filter(Boolean).join(', ');
      const name = l.nameResolved ? `${esc(l.name)}<span class="sub">${esc(l.nameResolved.match(/\((\w+)\)$/)?.[1] || '')}</span>` : esc(l.name);
      const main = `<tr class="${l.errors.length ? 'has-error' : ''}">
        <td class="row-no">${l.row}</td>
        <td>${account}${extra ? `<span class="sub">${extra}</span>` : ''}</td>
        <td>${esc(l.description)}</td>
        <td>${name}</td>
        <td class="num">${fmt(l.debit)}</td>
        <td class="num">${fmt(l.credit)}</td>
      </tr>`;
      const errs = l.errors.length
        ? `<tr class="line-errors"><td></td><td colspan="5">${l.errors.map(esc).join('<br>')}</td></tr>`
        : '';
      return main + errs;
    })
    .join('');

  return `<article class="sheet s-${e.status}" id="entry-${esc(e.key)}">
    <header class="sheet-head">
      <span class="je-no">${esc(e.docNumber || e.key)}</span>
      <span class="je-date">${fmtDate(e.txnDate)}</span>
      ${e.currency ? `<span class="je-date">${esc(e.currency)}</span>` : ''}
      <span class="je-memo">${esc(e.memo)}</span>
      <span class="je-status">${status}</span>
    </header>
    ${msgs.length ? `<ul class="msgs">${msgs.join('')}</ul>` : ''}
    <div class="ledger-wrap">
      <table class="ledger">
        <thead><tr><th class="row-no">Row</th><th>Account${showClass ? ', class, location' : ''}</th><th>Description</th><th>Name</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot class="${off ? 'off' : ''}"><tr>
          <td></td><td colspan="3" class="total-label">${off ? `Out of balance by ${money.format(Math.abs(e.totalDebit - e.totalCredit) / 100)}` : 'Total'}</td>
          <td class="num">${money.format(e.totalDebit / 100)}</td>
          <td class="num">${money.format(e.totalCredit / 100)}</td>
        </tr></tfoot>
      </table>
    </div>
  </article>`;
}

// ---------- posting ----------

async function postEntries() {
  const b = state.batch;
  const targets = postable();
  if (!targets.length || state.posting) return;
  state.posting = true;
  const byKey = new Map(b.entries.map((e) => [e.key, e]));
  targets.forEach((e) => (e.status = 'posting'));
  let done = 0;
  const btn = $('#post-btn');
  btn.disabled = true;
  btn.textContent = `Posting 0 of ${targets.length}…`;
  state.filter = 'all';
  renderReview();

  // The server posts for a limited time per request, then reports how many are left;
  // keep asking until everything in this run has been tried.
  const runId = crypto.randomUUID();
  try {
    for (let round = 0; round < 100; round++) {
      const res = await api('/api/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId: b.batchId, includeDuplicates: $('#include-dups').checked, runId }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Posting failed (${res.status}).`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let remaining = 0;
      let progressed = 0;
      let fatal = false;
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          if (msg.type === 'entry') {
            const e = byKey.get(msg.key);
            e.result = msg.result;
            e.status = msg.result.ok ? 'posted' : 'failed';
            done++;
            progressed++;
            btn.textContent = `Posting ${done} of ${targets.length}…`;
            renderReview();
          } else if (msg.type === 'fatal') {
            fatal = true;
            showNotice(esc(msg.error));
            loadStatus();
          } else if (msg.type === 'done') {
            remaining = msg.remaining;
          }
        }
      }
      if (fatal || remaining <= 0 || progressed === 0) break;
    }
  } catch (err) {
    if (!err.handled) showNotice(esc(err.message));
  } finally {
    // Anything the server never reached goes back to its previous state.
    b.entries.forEach((e) => {
      if (e.status === 'posting') e.status = e.result ? (e.result.ok ? 'posted' : 'failed') : e.baseStatus;
    });
    state.posting = false;
    const c = counts();
    if (c.posted && !c.failed) showNotice(`${plural(c.posted, 'entry', 'entries')} posted to QuickBooks.`, 'info');
    else if (c.failed) showNotice(`${plural(c.failed, 'entry', 'entries')} didn't post. The reason is shown on each one; fix it in QuickBooks or the file, then post again.`);
    renderReview();
  }
}

// ---------- start ----------

$('#post-btn').addEventListener('click', postEntries);
$('#include-dups').addEventListener('change', () => renderReview());
wireUpload();
wireLogin();

const params = new URLSearchParams(location.search);
if (params.get('error')) showNotice(esc(params.get('error')));
if (params.has('error')) history.replaceState(null, '', '/');
loadStatus();
