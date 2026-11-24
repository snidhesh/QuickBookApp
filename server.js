import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { config, isConfigured } from './src/config.js';
import { store, storeKind } from './src/store.js';
import * as qbo from './src/qbo.js';
import { parseWorkbook, buildTemplate } from './src/parse.js';
import { resolveEntries } from './src/resolve.js';
import { logError, readErrorLog, LOG_MAX_ENTRIES, LOG_RETENTION_DAYS } from './src/log.js';

const app = express();
app.set('trust proxy', true);

// Express 4 doesn't catch rejected promises from async handlers; pass them to the error handler.
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Vercel rejects request bodies over 4.5 MB before they reach the app.
const MAX_UPLOAD_MB = 4;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 } });

const BATCH_TTL = 60 * 60; // seconds an upload stays available for posting
const SESSION_DAYS = 7;
// Posting stops after this long and the page asks for the rest, so a big batch never
// runs into the hosting time limit.
const POST_TIME_BUDGET_MS = Number(process.env.POST_TIME_BUDGET_MS || 45000);

app.use(express.json({ limit: '1mb' }));
// On Vercel, public/ is served by the CDN and express.static is ignored.
app.use(express.static(new URL('./public', import.meta.url).pathname));

// ---------- cookies & sessions ----------

const sign = (value) => crypto.createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setCookie(req, res, name, value, maxAgeSeconds) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (req.secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

const authRequired = () => Boolean(config.appPassword) || config.onVercel;

function hasSession(req) {
  if (!authRequired()) return true;
  const raw = readCookie(req, 'session');
  if (!raw) return false;
  const [expires, sig] = raw.split('.');
  return Number(expires) > Date.now() && safeEqual(sig, sign(`session:${expires}`));
}

function requireSession(req, res, next) {
  if (config.onVercel && !config.appPassword) {
    return res.status(503).json({ error: 'APP_PASSWORD is not set. Add it in the Vercel project settings and redeploy.' });
  }
  if (!hasSession(req)) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sign in to continue.', loginRequired: true });
    return res.redirect('/');
  }
  next();
}

app.post('/api/login', route(async (req, res) => {
  if (!config.appPassword) return res.json({ ok: true });
  const ipKey = `login-fail:${req.ip}`;
  const failures = Number((await store.get(ipKey)) || 0);
  if (failures >= 10) return res.status(429).json({ error: 'Too many wrong passwords. Try again in 15 minutes.' });
  if (!safeEqual(String(req.body?.password || ''), config.appPassword)) {
    await store.incr(ipKey, 15 * 60);
    await logError({ level: 'warning', source: 'sign-in', message: 'Wrong password entered.', context: { ip: req.ip } });
    await new Promise((r) => setTimeout(r, 500));
    return res.status(401).json({ error: "That password isn't right." });
  }
  const expires = String(Date.now() + SESSION_DAYS * 86400 * 1000);
  setCookie(req, res, 'session', `${expires}.${sign(`session:${expires}`)}`, SESSION_DAYS * 86400);
  res.json({ ok: true });
}));

app.post('/api/logout', (req, res) => {
  setCookie(req, res, 'session', '', 0);
  res.json({ ok: true });
});

app.get('/api/status', route(async (req, res) => {
  const base = { configured: isConfigured(), environment: config.environment, passwordSet: Boolean(config.appPassword), storage: storeKind };
  if (config.onVercel && storeKind !== 'redis') {
    return res.json({ ...base, setupError: 'No storage is connected. Add Upstash for Redis to the Vercel project, then redeploy.' });
  }
  if (config.onVercel && !config.appPassword) {
    return res.json({ ...base, setupError: 'APP_PASSWORD is not set. Add it in the Vercel project settings, then redeploy.' });
  }
  if (!hasSession(req)) return res.json({ ...base, loginRequired: true });
  try {
    res.json({ ...base, signOut: authRequired(), ...(await qbo.connectionStatus()) });
  } catch (err) {
    await logError({ source: 'server', operation: 'GET /api/status', message: err.message });
    res.status(500).json({ ...base, error: err.message });
  }
}));

// ---------- QuickBooks connection ----------

app.get('/connect', requireSession, route(async (req, res) => {
  if (!isConfigured()) return res.redirect('/?error=' + encodeURIComponent('Add QBO_CLIENT_ID and QBO_CLIENT_SECRET, then restart the app.'));
  const state = crypto.randomBytes(16).toString('hex');
  setCookie(req, res, 'oauth_state', `${state}.${sign(`state:${state}`)}`, 600);
  res.redirect(await qbo.authorizationUrl(state));
}));

app.get('/callback', requireSession, route(async (req, res) => {
  const { code, realmId, state, error } = req.query;
  const [cookieState, sig] = (readCookie(req, 'oauth_state') || '').split('.');
  setCookie(req, res, 'oauth_state', '', 0);
  if (error) {
    await logError({ source: 'quickbooks-connect', message: `QuickBooks returned "${error}" instead of connecting.` });
    return res.redirect('/?error=' + encodeURIComponent(`QuickBooks didn't connect: ${error}`));
  }
  if (!cookieState || !safeEqual(cookieState, String(state || '')) || !safeEqual(sig, sign(`state:${cookieState}`))) {
    await logError({ source: 'quickbooks-connect', message: 'Connection rejected: the state check failed (link expired, reused, or forged).' });
    return res.redirect('/?error=' + encodeURIComponent('The sign-in link expired. Connect again.'));
  }
  try {
    await qbo.exchangeCode(String(code), String(realmId));
    res.redirect('/');
  } catch (err) {
    // Token errors are logged by the QuickBooks client; log anything else here.
    if (!(err instanceof qbo.QboError)) await logError({ source: 'quickbooks-connect', message: err.message });
    res.redirect('/?error=' + encodeURIComponent(err.message));
  }
}));

app.post('/api/disconnect', requireSession, route(async (req, res) => {
  await qbo.disconnect();
  res.json({ ok: true });
}));

app.get('/template.xlsx', (req, res) => {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="journal-entries-template.xlsx"');
  res.send(buildTemplate());
});

// ---------- upload, review, post ----------

const summarize = (entry, result) => ({
  key: entry.key,
  docNumber: entry.docNumber,
  txnDate: entry.txnDate,
  memo: entry.memo,
  currency: entry.currency,
  status: result?.ok ? 'posted' : entry.status,
  errors: entry.errors,
  warnings: entry.warnings,
  totalDebit: entry.totalDebit,
  totalCredit: entry.totalCredit,
  result: result || null,
  lines: entry.lines.map((l) => ({
    row: l.row,
    account: l.account,
    accountResolved: l.accountRef?.name || null,
    debit: l.debit,
    credit: l.credit,
    description: l.description,
    name: l.name,
    nameResolved: l.entityRef ? `${l.entityRef.displayName} (${l.entityRef.type.toLowerCase()})` : null,
    className: l.className,
    location: l.location,
    errors: l.errors,
  })),
});

function uploadSingle(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `The file is larger than ${MAX_UPLOAD_MB} MB. Split it into smaller files.` });
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

app.post('/api/preview', requireSession, uploadSingle, route(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a file to upload.' });
  const dateOrder = req.body.dateOrder === 'DMY' ? 'DMY' : 'MDY';
  const parsed = parseWorkbook(req.file.buffer, { dateOrder });
  if (parsed.fileErrors.length && !parsed.entries.length) {
    return res.status(422).json({ fileName: req.file.originalname, fileErrors: parsed.fileErrors });
  }
  try {
    await resolveEntries(parsed.entries);
  } catch (err) {
    // QuickBooks errors are logged where they happen; log anything else here.
    if (!(err instanceof qbo.QboError)) {
      await logError({ source: 'upload', operation: 'check file', message: err.message, context: { file: req.file.originalname } });
    }
    return res.status(err.status === 401 ? 401 : 502).json({ error: err.message });
  }
  const batchId = crypto.randomUUID();
  // Only what posting needs is stored; requestid makes each entry's post idempotent.
  const stored = parsed.entries.map((e) => ({ key: e.key, status: e.status, payload: e.payload || null, requestId: crypto.randomUUID() }));
  await store.set(`batch:${batchId}`, stored, BATCH_TTL);
  res.json({
    batchId,
    fileName: req.file.originalname,
    sheetName: parsed.sheetName,
    fileErrors: parsed.fileErrors,
    entries: parsed.entries.map((e) => summarize(e)),
  });
}));

// Posts entries one at a time and streams each result back as a line of JSON. Stops when
// the time budget runs out; the page then calls again for the rest.
app.post('/api/post', requireSession, route(async (req, res) => {
  const batchId = String(req.body.batchId || '');
  const entries = await store.get(`batch:${batchId}`);
  if (!entries) return res.status(404).json({ error: 'This upload has expired. Upload the file again.' });
  const lockKey = `batch:${batchId}:lock`;
  if (!(await store.claim(lockKey, POST_TIME_BUDGET_MS + 60000))) {
    return res.status(409).json({ error: 'These entries are already being posted.' });
  }

  const resultsKey = `batch:${batchId}:results`;
  const includeDuplicates = Boolean(req.body.includeDuplicates);
  // Each click on Post is one run (runId from the page). Follow-up rounds of a run skip
  // entries that already failed in that run; a new click retries them.
  const runId = String(req.body.runId || crypto.randomUUID());
  const results = await store.hgetall(resultsKey);
  const toPost = entries.filter(
    (e) =>
      !results[e.key]?.ok &&
      results[e.key]?.runId !== runId &&
      (e.status === 'ready' || (includeDuplicates && e.status === 'duplicate')),
  );
  const started = Date.now();
  let changedRequestIds = false;
  let remaining = toPost.length;

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-store');
  res.write(JSON.stringify({ type: 'start', total: toPost.length }) + '\n');

  try {
    for (const [i, entry] of toPost.entries()) {
      if (i > 0 && Date.now() - started > POST_TIME_BUDGET_MS) break;
      let result;
      try {
        const je = await qbo.createJournalEntry(entry.payload, entry.requestId, {
          entry: entry.key,
          journalNo: entry.payload?.DocNumber || null,
          txnDate: entry.payload?.TxnDate || null,
          batchId,
        });
        result = { ok: true, id: je.Id, link: qbo.journalLink(je.Id) };
      } catch (err) {
        result = { ok: false, error: err.message, intuitTid: err.intuitTid, runId };
        // QuickBooks replays its first answer for a repeated requestid, so a retry after a
        // definite rejection needs a new id. Keep the id when the outcome is unknown (network/5xx).
        if (err.status && err.status < 500) {
          entry.requestId = crypto.randomUUID();
          changedRequestIds = true;
        }
        if (err.status === 401) {
          await store.hset(resultsKey, entry.key, result, BATCH_TTL);
          res.write(JSON.stringify({ type: 'entry', key: entry.key, result }) + '\n');
          res.write(JSON.stringify({ type: 'fatal', error: `${err.message} Then post the remaining entries.` }) + '\n');
          remaining = 0;
          break;
        }
      }
      await store.hset(resultsKey, entry.key, result, BATCH_TTL);
      remaining--;
      res.write(JSON.stringify({ type: 'entry', key: entry.key, result }) + '\n');
    }
  } finally {
    if (changedRequestIds) await store.set(`batch:${batchId}`, entries, BATCH_TTL);
    await store.del(lockKey);
    res.write(JSON.stringify({ type: 'done', remaining }) + '\n');
    res.end();
  }
}));

// ---------- error log ----------

app.get('/api/errors', requireSession, route(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ retentionDays: LOG_RETENTION_DAYS, maxEntries: LOG_MAX_ENTRIES, environment: config.environment, entries: await readErrorLog() });
}));

app.get('/api/errors/download', requireSession, route(async (req, res) => {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="journal-import-error-log-${stamp}.json"`);
  res.setHeader('Cache-Control', 'no-store');
  const entries = await readErrorLog();
  res.send(JSON.stringify({ app: 'Journal import for QuickBooks Online', environment: config.environment, exportedAt: new Date().toISOString(), entries }, null, 2));
}));

// Anything unexpected ends up here: log it and answer with a plain message.
app.use(async (err, req, res, next) => {
  await logError({
    source: 'server',
    operation: `${req.method} ${req.path}`,
    message: err.message || String(err),
    stack: err.stack?.split('\n').slice(0, 6).join('\n'),
  });
  if (res.headersSent) return res.end();
  res.status(500).json({ error: 'Something went wrong on the server. The error has been logged.' });
});

// Vercel runs the exported app; locally we start a server.
export default app;

if (!config.onVercel) {
  const server = app.listen(config.port, config.host, () => {
    console.log(`Journal entry import running at http://localhost:${config.port} (${config.environment}, ${storeKind} storage)`);
    if (!isConfigured()) console.log('QBO_CLIENT_ID / QBO_CLIENT_SECRET are not set. Copy .env.example to .env and fill them in.');
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `Port ${config.port} is already in use, probably by another copy of this app.\n` +
          `Stop it (find it with: lsof -nP -iTCP:${config.port} -sTCP:LISTEN), or set a different PORT in .env ` +
          `and update the redirect URI in .env and on the Intuit developer portal to match.`,
      );
      process.exit(1);
    }
    throw err;
  });
}
