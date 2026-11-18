// Shared helpers (files starting with "_" are not exposed as routes on Vercel)
import { neon } from '@neondatabase/serverless';
import crypto from 'node:crypto';

let _sql = null;
export function getSql() {
  if (_sql) return _sql;
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error('DATABASE_URL is not set. Add your Neon connection string in Vercel → Settings → Environment Variables.');
  _sql = neon(url);
  return _sql;
}
export function setSql(fn) { _sql = fn; _ready = null; } // local tests only

export const DEFAULT_CATS = ['Gifting - T-shirts', 'Gifting - Stationery', 'Gifting - Other', 'Signage / Hoarding', 'Shop / Yard branding', 'Vehicle branding', 'Print & Brochures', 'Digital / Social media', 'Dealer & customer meet', 'Other'];
export const DEFAULT_CFG = {
  rate: 100, giftCapPct: 25, lapse: false, releases: { '2026-04': 'early' }, categories: DEFAULT_CATS, publicView: true,
  notify: { budgetWa: [], claimsWa: [], pendingDays: 7, claimDays: 30, warnDays: 7 }
};

export const DOC_TYPES = ['Invoice', 'Creative / artwork', 'SAIL approval', 'Credit note', 'Photo / proof', 'SAIL invoice', 'Other'];
export const blobAccess = () => (process.env.BLOB_ACCESS === 'public' ? 'public' : 'private');
// Two ways Vercel connects a Blob store: a read-write token, or (newer) BLOB_STORE_ID + the project's OIDC token.
export const blobMode = () => process.env.BLOB_READ_WRITE_TOKEN ? 'token' : (process.env.BLOB_STORE_ID ? 'presigned' : null);
export const blobReady = () => !!blobMode();

let _ready = null;
export function ensureSchema() {
  if (!_ready) _ready = (async () => {
    const sql = getSql();
    await sql`CREATE TABLE IF NOT EXISTS sail_users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'editor',          -- admin | editor | viewer
      pw_hash TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS sail_config (
      id INT PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT
    )`;
    await sql`CREATE TABLE IF NOT EXISTS sail_lifting (
      prod TEXT NOT NULL,                            -- HR | STR
      month TEXT NOT NULL,                           -- YYYY-MM
      tonnes NUMERIC(14,3) NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT,
      PRIMARY KEY (prod, month)
    )`;
    await sql`CREATE TABLE IF NOT EXISTS sail_activities (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT
    )`;
    await sql`CREATE TABLE IF NOT EXISTS sail_files (
      id SERIAL PRIMARY KEY,
      kind TEXT NOT NULL,                            -- activity | lifting
      ref TEXT NOT NULL,                             -- activity id, or HR_2026-04 style for lifting
      doc_type TEXT NOT NULL,
      name TEXT NOT NULL,
      size BIGINT NOT NULL DEFAULT 0,
      content_type TEXT,
      url TEXT NOT NULL,
      pathname TEXT NOT NULL,
      uploaded_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS sail_files_ref ON sail_files(kind, ref)`;
    await sql`INSERT INTO sail_config (id, data) VALUES (1, ${JSON.stringify(DEFAULT_CFG)}::jsonb) ON CONFLICT (id) DO NOTHING`;
    // First admin comes from env vars, only while the user table is empty.
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM sail_users`;
    const em = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const pw = process.env.ADMIN_PASSWORD || '';
    if (n === 0 && em && pw) {
      await sql`INSERT INTO sail_users (email, name, role, pw_hash) VALUES (${em}, 'Admin', 'admin', ${hashPassword(pw)}) ON CONFLICT (email) DO NOTHING`;
    }
  })().catch(e => { _ready = null; throw e; });
  return _ready;
}

/* ---------- passwords ---------- */
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
export function checkPassword(pw, stored) {
  try {
    const [alg, s, h] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const hash = crypto.scryptSync(String(pw), Buffer.from(s, 'hex'), 64);
    return crypto.timingSafeEqual(hash, Buffer.from(h, 'hex'));
  } catch { return false; }
}

/* ---------- sessions (signed cookie) ---------- */
const COOKIE = 'sail_session';
const DAYS = 30;
function secret() {
  const s = process.env.SESSION_SECRET || '';
  if (s.length < 16) throw new Error('SESSION_SECRET is not set (use at least 16 random characters) in Vercel → Settings → Environment Variables.');
  return s;
}
const b64 = s => Buffer.from(s).toString('base64url');
function sign(payload) {
  const body = b64(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}
function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const good = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (mac.length !== good.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(c => { const i = c.indexOf('='); if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); });
  return out;
}
const secureFlag = req => (req.headers['x-forwarded-proto'] === 'http' || /^localhost|^127\./.test(req.headers.host || '')) ? '' : '; Secure';
export function setSession(req, res, uid) {
  const tok = sign({ uid, exp: Date.now() + DAYS * 864e5 });
  res.setHeader('Set-Cookie', `${COOKIE}=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DAYS * 86400}${secureFlag(req)}`);
}
export function clearSession(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag(req)}`);
}
/** Returns the signed-in, active user or null. */
export async function currentUser(req) {
  const p = verify(cookies(req)[COOKIE]);
  if (!p) return null;
  const sql = getSql();
  const rows = await sql`SELECT id, email, name, role FROM sail_users WHERE id = ${p.uid} AND active = true`;
  return rows[0] || null;
}
/** Public (no-login) read-only view is on unless an admin switched it off. */
export const publicViewOn = cfg => cfg?.publicView !== false;
export async function loadConfig() {
  const rows = await getSql()`SELECT data FROM sail_config WHERE id = 1`;
  return { ...DEFAULT_CFG, ...(rows[0]?.data || {}) };
}
export const canEdit = u => u && (u.role === 'admin' || u.role === 'editor');
export const isAdmin = u => u && u.role === 'admin';

/* ---------- http ---------- */
export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
/** Wraps a route: schema ready, errors returned as JSON. */
export function route(fn) {
  return async (req, res) => {
    try { await ensureSchema(); await fn(req, res); }
    catch (e) { console.error(e); send(res, 500, { error: e.message || 'Server error' }); }
  };
}
