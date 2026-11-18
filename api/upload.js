import { handleUpload, handleUploadPresigned } from '@vercel/blob/client';
import { issueSignedToken } from '@vercel/blob';
import { route, send, readBody, currentUser, canEdit, blobReady, blobMode } from './_lib.js';

const PATH_RE = /^sail\/(activity|lifting)\/[A-Za-z0-9_-]{3,40}\/[^/]{1,200}$/;

// Issues a short-lived upload token so the browser can send the file straight to Vercel Blob
// (no 4.5 MB function limit). The file is recorded afterwards via /api/files {action:'register'}.
export default route(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const me = await currentUser(req);
  if (!me) return send(res, 401, { error: 'Please sign in' });
  if (!canEdit(me)) return send(res, 403, { error: 'You have view-only access' });
  if (!blobReady()) return send(res, 503, { error: 'File storage is not connected yet. In Vercel: Storage → Create → Blob (Private) → connect it to this project, then redeploy.' });
  const body = await readBody(req);
  const MAX = 100 * 1024 * 1024;
  if (blobMode() === 'presigned') {
    // Store connected with BLOB_STORE_ID (OIDC): hand the browser a short-lived presigned upload URL.
    const json = await handleUploadPresigned({
      body,
      request: req,
      getSignedToken: async pathname => {
        if (!PATH_RE.test(pathname)) throw new Error('Bad file path');
        const token = await issueSignedToken({ pathname, operations: ['put'], validUntil: Date.now() + 30 * 60 * 1000, maximumSizeInBytes: MAX });
        return { token, urlOptions: { addRandomSuffix: true, maximumSizeInBytes: MAX } };
      }
    });
    return send(res, 200, json);
  }
  const json = await handleUpload({
    body,
    request: req,
    onBeforeGenerateToken: async pathname => {
      if (!PATH_RE.test(pathname)) throw new Error('Bad file path');
      return { maximumSizeInBytes: MAX, addRandomSuffix: true, tokenPayload: JSON.stringify({ uid: me.id }) };
    }
  });
  return send(res, 200, json);
});
