import { route, send, readBody, getSql, currentUser, isAdmin, hashPassword } from './_lib.js';

const ROLES = ['admin', 'editor', 'viewer'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// POST {action: list | add | update | reset_password | delete}  — admins only
export default route(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const me = await currentUser(req);
  if (!me) return send(res, 401, { error: 'Please sign in' });
  if (!isAdmin(me)) return send(res, 403, { error: 'Only an admin can manage users' });
  const b = await readBody(req);
  const sql = getSql();
  const id = Number(b.id);

  const adminsLeft = async exceptId => {
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM sail_users WHERE role = 'admin' AND active = true AND id <> ${exceptId}`;
    return n;
  };

  switch (b.action) {
    case 'list': {
      const users = await sql`SELECT id, email, name, role, active, to_char(created_at, 'YYYY-MM-DD') AS created FROM sail_users ORDER BY role, name, email`;
      return send(res, 200, { users });
    }
    case 'add': {
      const email = String(b.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return send(res, 400, { error: 'Enter a valid email' });
      if (!ROLES.includes(b.role)) return send(res, 400, { error: 'Pick a role' });
      if (String(b.password || '').length < 6) return send(res, 400, { error: 'Starting password must be at least 6 characters' });
      const rows = await sql`INSERT INTO sail_users (email, name, role, pw_hash) VALUES (${email}, ${String(b.name || '').trim().slice(0, 80)}, ${b.role}, ${hashPassword(b.password)})
                             ON CONFLICT (email) DO NOTHING RETURNING id`;
      if (!rows.length) return send(res, 409, { error: 'That email already has an account' });
      return send(res, 200, { ok: true });
    }
    case 'update': {
      if (!ROLES.includes(b.role)) return send(res, 400, { error: 'Pick a role' });
      const active = b.active !== false;
      if ((b.role !== 'admin' || !active) && (await adminsLeft(id)) === 0) {
        const [u] = await sql`SELECT role FROM sail_users WHERE id = ${id}`;
        if (u?.role === 'admin') return send(res, 400, { error: 'Keep at least one active admin' });
      }
      await sql`UPDATE sail_users SET role = ${b.role}, active = ${active}, name = ${String(b.name || '').trim().slice(0, 80)} WHERE id = ${id}`;
      return send(res, 200, { ok: true });
    }
    case 'reset_password': {
      if (String(b.password || '').length < 6) return send(res, 400, { error: 'Password must be at least 6 characters' });
      await sql`UPDATE sail_users SET pw_hash = ${hashPassword(b.password)} WHERE id = ${id}`;
      return send(res, 200, { ok: true });
    }
    case 'delete': {
      if (id === me.id) return send(res, 400, { error: "You can't delete your own account" });
      const [u] = await sql`SELECT role FROM sail_users WHERE id = ${id}`;
      if (u?.role === 'admin' && (await adminsLeft(id)) === 0) return send(res, 400, { error: 'Keep at least one active admin' });
      await sql`DELETE FROM sail_users WHERE id = ${id}`;
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 400, { error: 'Unknown action' });
});
