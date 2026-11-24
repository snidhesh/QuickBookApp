import fs from 'node:fs';
import path from 'node:path';

// Key-value storage for the QuickBooks connection and uploaded batches.
// On Vercel every request may run on a fresh instance, so state lives in Upstash Redis
// (REST API, no client library needed). Locally it falls back to a JSON file in data/.

const restUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const restToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

export const storeKind = restUrl && restToken ? 'redis' : 'file';

// ---------- Upstash Redis over REST ----------

async function redis(...args) {
  const res = await fetch(restUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${restToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args.map((a) => (typeof a === 'number' ? String(a) : a))),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(`Storage error: ${json.error || res.statusText}`);
  return json.result;
}

const redisStore = {
  async get(key) {
    const v = await redis('GET', key);
    return v == null ? null : JSON.parse(v);
  },
  async set(key, value, ttlSeconds) {
    if (ttlSeconds) await redis('SET', key, JSON.stringify(value), 'EX', ttlSeconds);
    else await redis('SET', key, JSON.stringify(value));
  },
  async del(key) {
    await redis('DEL', key);
  },
  // Sets only if the key doesn't exist; true when this caller got it (used as a lock).
  async claim(key, ttlMs) {
    return (await redis('SET', key, '1', 'NX', 'PX', ttlMs)) === 'OK';
  },
  async hset(key, field, value, ttlSeconds) {
    await redis('HSET', key, field, JSON.stringify(value));
    if (ttlSeconds) await redis('EXPIRE', key, ttlSeconds);
  },
  async hgetall(key) {
    const flat = (await redis('HGETALL', key)) || [];
    const out = {};
    for (let i = 0; i < flat.length; i += 2) out[flat[i]] = JSON.parse(flat[i + 1]);
    return out;
  },
  async incr(key, ttlSeconds) {
    const n = await redis('INCR', key);
    if (n === 1 && ttlSeconds) await redis('EXPIRE', key, ttlSeconds);
    return n;
  },
};

// ---------- Local file (development) ----------

const file = process.env.LOCAL_STORE_FILE || new URL('../data/store.json', import.meta.url).pathname;
let cache = null;

function load() {
  if (!cache) {
    try {
      cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      cache = {};
    }
  }
  const now = Date.now();
  for (const [k, item] of Object.entries(cache)) if (item.expiresAt && item.expiresAt < now) delete cache[k];
  return cache;
}

function save() {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cache), { mode: 0o600 });
}

const expiry = (ttlSeconds) => (ttlSeconds ? Date.now() + ttlSeconds * 1000 : null);

const fileStore = {
  async get(key) {
    return load()[key]?.value ?? null;
  },
  async set(key, value, ttlSeconds) {
    load()[key] = { value, expiresAt: expiry(ttlSeconds) };
    save();
  },
  async del(key) {
    delete load()[key];
    save();
  },
  async claim(key, ttlMs) {
    const data = load();
    if (data[key]) return false;
    data[key] = { value: 1, expiresAt: Date.now() + ttlMs };
    save();
    return true;
  },
  async hset(key, field, value, ttlSeconds) {
    const data = load();
    const item = data[key] || { value: {}, expiresAt: null };
    item.value[field] = value;
    if (ttlSeconds) item.expiresAt = expiry(ttlSeconds);
    data[key] = item;
    save();
  },
  async hgetall(key) {
    return { ...(load()[key]?.value || {}) };
  },
  async incr(key, ttlSeconds) {
    const data = load();
    const item = data[key] || { value: 0, expiresAt: expiry(ttlSeconds) };
    item.value += 1;
    data[key] = item;
    save();
    return item.value;
  },
};

export const store = storeKind === 'redis' ? redisStore : fileStore;
