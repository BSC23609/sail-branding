import { Readable } from 'node:stream';
import { del, get, issueSignedToken, presignUrl } from '@vercel/blob';
import { route, send, readBody, getSql, currentUser, canEdit, DOC_TYPES, blobAccess } from './_lib.js';

const REF_RE = /^[A-Za-z0-9_-]{3,40}$/;
const LIFT_REF_RE = /^(HR|STR)_\d{4}-(0[1-9]|1[0-2])$/;

async function openFile(req, res, me) {
  const id = Number(new URL(req.url, 'http://x').searchParams.get('id'));
  const sql = getSql();
  const [f] = await sql`SELECT * FROM sail_files WHERE id = ${id}`;
  if (!f) return send(res, 404, { error: 'File not found' });
  if (blobAccess() === 'public') { res.statusCode = 302; res.setHeader('Location', f.url); return res.end(); }
  // Private store: hand out a 10-minute signed link; fall back to streaming the file through this function.
  try {
    const tok = await issueSignedToken({ pathname: f.pathname, operations: ['get'], validUntil: Date.now() + 10 * 60 * 1000 });
    const { presignedUrl } = await presignUrl(tok, { operation: 'get', pathname: f.pathname, access: 'private' });
    res.statusCode = 302; res.setHeader('Location', presignedUrl); res.setHeader('Cache-Control', 'no-store'); return res.end();
  } catch (e) {
    console.warn('presign failed, streaming instead:', e.message);
  }
  const r = await get(f.pathname, { access: 'private' });
  if (!r || r.statusCode !== 200) return send(res, 404, { error: 'File not found in storage' });
  res.statusCode = 200;
  res.setHeader('Content-Type', r.blob.contentType || f.content_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  Readable.fromWeb(r.stream).pipe(res);
}

// GET ?id=… opens a file (any signed-in user). POST {action: register | delete} (editors).
export default route(async (req, res) => {
  const me = await currentUser(req);
  if (!me) return send(res, 401, { error: 'Please sign in' });
  if (req.method === 'GET') return openFile(req, res, me);
  if (req.method !== 'POST') return send(res, 405, { error: 'GET or POST only' });
  if (!canEdit(me)) return send(res, 403, { error: 'You have view-only access' });
  const b = await readBody(req);
  const sql = getSql();

  if (b.action === 'register') {
    const kind = b.kind === 'lifting' ? 'lifting' : b.kind === 'activity' ? 'activity' : null;
    if (!kind || !REF_RE.test(b.ref || '')) return send(res, 400, { error: 'Bad reference' });
    if (kind === 'lifting' && !LIFT_REF_RE.test(b.ref)) return send(res, 400, { error: 'Bad lifting month' });
    if (kind === 'activity') {
      const [a] = await sql`SELECT id FROM sail_activities WHERE id = ${b.ref}`;
      if (!a) return send(res, 400, { error: 'Save the activity first' });
    }
    if (!DOC_TYPES.includes(b.docType)) return send(res, 400, { error: 'Pick a document type' });
    let host = '';
    try { host = new URL(b.url).hostname; } catch { /* bad url */ }
    if (!host.endsWith('.blob.vercel-storage.com') || !String(b.pathname || '').startsWith(`sail/${kind}/${b.ref}/`)) return send(res, 400, { error: 'Bad file location' });
    const rows = await sql`INSERT INTO sail_files (kind, ref, doc_type, name, size, content_type, url, pathname, uploaded_by)
      VALUES (${kind}, ${b.ref}, ${b.docType}, ${String(b.name || 'file').slice(0, 200)}, ${Math.max(0, Number(b.size) || 0)}, ${String(b.type || '').slice(0, 100)}, ${b.url}, ${b.pathname}, ${me.email})
      RETURNING id`;
    return send(res, 200, { ok: true, id: rows[0].id });
  }
  if (b.action === 'delete') {
    const [f] = await sql`SELECT id, url FROM sail_files WHERE id = ${Number(b.id)}`;
    if (!f) return send(res, 200, { ok: true });
    try { await del(f.url); } catch (e) { console.warn('blob delete failed:', e.message); }
    await sql`DELETE FROM sail_files WHERE id = ${f.id}`;
    return send(res, 200, { ok: true });
  }
  return send(res, 400, { error: 'Unknown action' });
});
