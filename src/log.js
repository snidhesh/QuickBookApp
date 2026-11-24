import crypto from 'node:crypto';
import { config } from './config.js';
import { store } from './store.js';

// Error log: every error is written to the hosting logs (console) and kept in storage so it
// can be viewed in the app and downloaded for Intuit support. Newest first, capped by count
// and age.
export const LOG_MAX_ENTRIES = 2000;
export const LOG_RETENTION_DAYS = 90;
const KEY = `log:errors:${config.environment}`;
const cutoff = () => Date.now() - LOG_RETENTION_DAYS * 86400 * 1000;

// Defensive: never let a token, secret, password or OAuth authorization code into the log.
// (A plain `code` field is kept: QuickBooks error codes such as 6000 are what support needs.)
const SECRET_FIELD = /token|secret|password|authorization|cookie|^auth_?code$|^oauth_?code$/i;
function scrub(value, depth = 0) {
  if (depth > 5 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_FIELD.test(k) ? '[removed]' : scrub(v, depth + 1);
  return out;
}

async function dropExpired() {
  // Oldest entries sit at the end of the list; trim any that are past the retention period.
  const tail = await store.lrange(KEY, -50, -1);
  let expired = 0;
  for (let i = tail.length - 1; i >= 0 && Date.parse(tail[i].at) < cutoff(); i--) expired++;
  if (expired) await store.ltrim(KEY, 0, -(expired + 1));
}

/**
 * Records an error. `event` fields: source (where it happened), message, and any of
 * level, operation, status, intuitTid, faults, context, stack.
 */
export async function logError(event) {
  const entry = scrub({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    environment: config.environment,
    level: 'error',
    ...event,
  });
  console.error(`[journal-import] ${JSON.stringify(entry)}`);
  try {
    await store.lpushCapped(KEY, entry, LOG_MAX_ENTRIES);
    await dropExpired();
  } catch (err) {
    // Storage itself failing must not hide the original error; the console line above remains.
    console.error(`[journal-import] could not store error log entry: ${err.message}`);
  }
  return entry;
}

export async function readErrorLog() {
  const min = cutoff();
  return (await store.lrange(KEY, 0, -1)).filter((e) => Date.parse(e.at) >= min);
}
