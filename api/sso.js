// Group single sign-on: the Bharat Steel Group hub (app.thebharatsteelgroup.com) sends people here
// already signed in. GET /api/sso?token=...&next=/...  (token: HS256, 60 seconds, addressed to this app)
import crypto from 'node:crypto';
import { route, getSql, hashPassword, setSession } from './_lib.js';

function verifyToken(token, secret, aud) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('bad token');
  const want = crypto.createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest();
  const got = Buffer.from(parts[2], 'base64url');
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw new Error('bad signature');
  const head = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  if (head.alg !== 'HS256') throw new Error('bad alg');
  const c = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  const now = Math.floor(Date.now() / 1000);
  if (c.iss !== 'bsg-hub' || c.aud !== aud) throw new Error('wrong app');
  if (!c.exp || c.exp < now - 5) { const e = new Error('expired'); e.expired = true; throw e; }
  return c;
}

function page(res, status, msg) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>SAIL Branding</title><body style="font:15px system-ui,sans-serif;background:#f4f6f8;color:#1e1d1d;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="background:#fff;border-radius:14px;padding:28px;max-width:420px;box-shadow:0 8px 30px rgba(10,43,102,.12)">
<h2 style="margin:0 0 8px;color:#0A2B66">Could not sign you in</h2><p>${msg}</p><p><a href="/">Go to sign in</a></p></div></body>`);
}

export default route(async (req, res) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  const secret = String(process.env.GROUP_SSO_SECRET || '').trim();
  if (!secret) return page(res, 401, 'Group sign-in is not set up on SAIL Branding yet.');
  const q = new URL(req.url, 'http://x').searchParams;
  let c;
  try {
    c = verifyToken(q.get('token'), secret, process.env.GROUP_SSO_APP_KEY || 'sail-branding');
  } catch (e) {
    return page(res, 401, e.expired ? 'That sign-in link expired. Open the app again from the group portal.'
                                    : 'Group sign-in could not be verified.');
  }
  const email = [c.email, c.sub].map(v => String(v || '').trim().toLowerCase()).find(v => v.includes('@'));
  if (!email) return page(res, 403, 'Your group account has no email, which SAIL Branding signs in with. Ask an admin to add it.');
  const sql = getSql();
  let u = (await sql`SELECT id, active FROM sail_users WHERE lower(email) = ${email}`)[0];
  if (!u) {
    // First visit from the hub, which has already checked this person may open SAIL Branding:
    // create the account as an editor. An admin can change the role under Users.
    const pw = hashPassword(crypto.randomBytes(24).toString('hex'));
    u = (await sql`INSERT INTO sail_users (email, name, role, pw_hash) VALUES (${email}, ${String(c.name || '')}, 'editor', ${pw})
                   ON CONFLICT (email) DO NOTHING RETURNING id, active`)[0]
        || (await sql`SELECT id, active FROM sail_users WHERE lower(email) = ${email}`)[0];
  }
  if (!u || !u.active) return page(res, 403, 'Your SAIL Branding account is switched off. Ask an admin to turn it back on.');
  setSession(req, res, u.id);
  if (q.get('embed') === '1') {
    // Opened in a tab inside the hub: the browser only keeps a SameSite=None + Partitioned cookie there,
    // sent only while the hub is the page around this app (no other site can use it).
    const ck = String(res.getHeader('Set-Cookie') || '').replace('SameSite=Lax', 'SameSite=None; Partitioned');
    res.setHeader('Set-Cookie', /;\s*Secure/i.test(ck) ? ck : ck + '; Secure');
  }
  const next = q.get('next') || '/';
  res.statusCode = 303;
  res.setHeader('Location', next.startsWith('/') && !next.startsWith('//') ? next : '/');
  res.setHeader('Cache-Control', 'no-store');
  res.end();
});
