import { route, send, getSql, currentUser, DOC_TYPES, blobAccess, blobReady, blobMode, loadConfig, publicViewOn } from './_lib.js';

// GET → everything the page needs: settings, monthly lifting, branding activities.
export default route(async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
  const me = await currentUser(req);
  const config = await loadConfig();
  if (!me && !publicViewOn(config)) return send(res, 401, { error: 'Please sign in' });
  const sql = getSql();
  const [lift, acts, files] = await Promise.all([
    sql`SELECT prod, month, tonnes::float8 AS tonnes FROM sail_lifting`,
    sql`SELECT id, data, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at FROM sail_activities`,
    sql`SELECT id, kind, ref, doc_type, name, size::float8 AS size, content_type, uploaded_by, to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS created FROM sail_files ORDER BY created_at`
  ]);
  const lifting = {};
  lift.forEach(r => { lifting[`${r.prod}_${r.month}`] = { prod: r.prod, month: r.month, tonnes: Number(r.tonnes) }; });
  const activities = acts.map(r => ({ ...r.data, id: r.id, createdAt: r.data.createdAt || r.created_at }));
  if (!me) {
    // Guest (public view): figures only. No documents, no people's emails or phone numbers.
    const guestActs = activities.map(({ updatedBy, ...a }) => a);
    const guestFiles = files.map(f => ({ kind: f.kind, ref: f.ref }));
    const guestCfg = { ...config, notify: { ...config.notify, budgetWa: [], claimsWa: [] }, termsUpdatedBy: '' };
    return send(res, 200, { me: null, guest: true, config: guestCfg, lifting, activities: guestActs, files: guestFiles, storage: { ready: false } });
  }
  return send(res, 200, { me, config, lifting, activities, files, storage: { ready: blobReady(), mode: blobMode(), access: blobAccess(), docTypes: DOC_TYPES } });
});
