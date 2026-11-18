import { route, send, getSql, currentUser, DEFAULT_CFG } from './_lib.js';

// GET → everything the page needs: settings, monthly lifting, branding activities.
export default route(async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
  const me = await currentUser(req);
  if (!me) return send(res, 401, { error: 'Please sign in' });
  const sql = getSql();
  const [cfgRows, lift, acts] = await Promise.all([
    sql`SELECT data FROM sail_config WHERE id = 1`,
    sql`SELECT prod, month, tonnes::float8 AS tonnes FROM sail_lifting`,
    sql`SELECT id, data, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at FROM sail_activities`
  ]);
  const config = { ...DEFAULT_CFG, ...(cfgRows[0]?.data || {}) };
  const lifting = {};
  lift.forEach(r => { lifting[`${r.prod}_${r.month}`] = { prod: r.prod, month: r.month, tonnes: Number(r.tonnes) }; });
  const activities = acts.map(r => ({ ...r.data, id: r.id, createdAt: r.data.createdAt || r.created_at }));
  return send(res, 200, { me, config, lifting, activities });
});
