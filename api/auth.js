import { route, send, readBody, getSql, checkPassword, hashPassword, setSession, clearSession, currentUser } from './_lib.js';

// POST {action: login | logout | me | change_password}
export default route(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const b = await readBody(req);
  const sql = getSql();

  if (b.action === 'login') {
    const email = String(b.email || '').trim().toLowerCase();
    const rows = await sql`SELECT id, email, name, role, pw_hash, active FROM sail_users WHERE email = ${email}`;
    const u = rows[0];
    if (!u || !u.active || !checkPassword(b.password || '', u.pw_hash)) return send(res, 401, { error: 'Wrong email or password' });
    setSession(req, res, u.id);
    return send(res, 200, { user: { id: u.id, email: u.email, name: u.name, role: u.role } });
  }
  if (b.action === 'logout') { clearSession(req, res); return send(res, 200, { ok: true }); }

  const me = await currentUser(req);
  if (b.action === 'me') {
    if (!me) {
      const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM sail_users`;
      return send(res, 200, { user: null, setup: n === 0 });
    }
    return send(res, 200, { user: me });
  }
  if (!me) return send(res, 401, { error: 'Please sign in again' });

  if (b.action === 'change_password') {
    const rows = await sql`SELECT pw_hash FROM sail_users WHERE id = ${me.id}`;
    if (!checkPassword(b.current || '', rows[0].pw_hash)) return send(res, 400, { error: 'Current password is wrong' });
    if (String(b.next || '').length < 6) return send(res, 400, { error: 'New password must be at least 6 characters' });
    await sql`UPDATE sail_users SET pw_hash = ${hashPassword(b.next)} WHERE id = ${me.id}`;
    return send(res, 200, { ok: true });
  }
  return send(res, 400, { error: 'Unknown action' });
});
