import crypto from 'node:crypto';
import { del } from '@vercel/blob';
import { route, send, readBody, getSql, currentUser, canEdit, isAdmin, DEFAULT_CFG, blobReady } from './_lib.js';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ['Draft', 'Sent to SAIL', 'Approved by SAIL', 'Rejected', 'Completed'];
const CLAIMS = ['Not claimed', 'Draft invoice sent', 'Claim submitted to SAIL', 'Claim received'];
const POT_RE = /^(HR|STR)_\d{4}_Q[1-4]$/;

const str = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const num = v => (v === null || v === undefined || v === '') ? null : (Number.isFinite(+v) && +v >= 0 ? +v : NaN);
const date = v => (v ? (DATE_RE.test(v) ? v : 'bad') : '');

function cleanActivity(a) {
  const out = {
    title: str(a.title, 200), category: str(a.category, 100), prod: a.prod, pot: a.pot, vendor: str(a.vendor, 200),
    plannedOn: date(a.plannedOn), estAmount: num(a.estAmount), status: a.status, sailRef: str(a.sailRef, 100),
    submittedOn: date(a.submittedOn), approvedOn: date(a.approvedOn), approvedAmount: num(a.approvedAmount),
    actualAmount: num(a.actualAmount), invoiceNo: str(a.invoiceNo, 100), invoiceDate: date(a.invoiceDate),
    claimStatus: CLAIMS.includes(a.claimStatus) ? a.claimStatus : 'Not claimed', claimSubmittedOn: date(a.claimSubmittedOn),
    cnNo: str(a.cnNo, 100), cnDate: date(a.cnDate), cnAmount: num(a.cnAmount),
    remarks: str(a.remarks, 1000), createdAt: str(a.createdAt, 40), updatedAt: new Date().toISOString()
  };
  const errs = [];
  if (!out.title) errs.push('title');
  if (!['HR', 'STR'].includes(out.prod)) errs.push('product');
  if (!POT_RE.test(out.pot || '') || !out.pot.startsWith(out.prod + '_')) errs.push('budget quarter');
  if (!STATUSES.includes(out.status)) errs.push('status');
  ['estAmount', 'approvedAmount', 'actualAmount', 'cnAmount'].forEach(k => { if (Number.isNaN(out[k])) errs.push(k); });
  ['plannedOn', 'submittedOn', 'approvedOn', 'invoiceDate', 'claimSubmittedOn', 'cnDate'].forEach(k => { if (out[k] === 'bad') errs.push(k); });
  return { out, errs };
}

function cleanConfig(c) {
  const cats = Array.isArray(c.categories) ? c.categories.map(x => str(x, 80)).filter(Boolean).slice(0, 40) : DEFAULT_CFG.categories;
  const releases = {};
  Object.entries(c.releases || {}).forEach(([k, v]) => { if (MONTH_RE.test(k) && (v === 'early' || v === 'hold')) releases[k] = v; });
  const wa = list => (Array.isArray(list) ? list : []).slice(0, 30).map(x => ({ name: str(x.name, 60), num: String(x.num || '').replace(/\D/g, '').slice(0, 13) })).filter(x => x.num.length >= 11);
  const n = c.notify || {};
  const int = (v, d) => Math.max(1, Math.min(365, parseInt(v, 10) || d));
  return {
    rate: Math.max(0, +c.rate || 0), giftCapPct: Math.min(100, Math.max(0, +c.giftCapPct || 0)), lapse: !!c.lapse,
    releases, categories: cats.length ? cats : DEFAULT_CFG.categories,
    notify: { budgetWa: wa(n.budgetWa), claimsWa: wa(n.claimsWa), pendingDays: int(n.pendingDays, 7), claimDays: int(n.claimDays, 30), warnDays: int(n.warnDays, 7) }
  };
}

// POST {action: lifting | releases | config | activity | delete_activity}
export default route(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const me = await currentUser(req);
  if (!me) return send(res, 401, { error: 'Please sign in' });
  if (!canEdit(me)) return send(res, 403, { error: 'You have view-only access' });
  const b = await readBody(req);
  const sql = getSql();

  switch (b.action) {
    case 'lifting': {
      if (!['HR', 'STR'].includes(b.prod) || !MONTH_RE.test(b.month || '')) return send(res, 400, { error: 'Bad month or product' });
      const t = num(b.tonnes);
      if (t === null || Number.isNaN(t) || t > 1e7) return send(res, 400, { error: 'Enter tonnes as a positive number' });
      await sql`INSERT INTO sail_lifting (prod, month, tonnes, updated_at, updated_by) VALUES (${b.prod}, ${b.month}, ${t}, now(), ${me.email})
                ON CONFLICT (prod, month) DO UPDATE SET tonnes = EXCLUDED.tonnes, updated_at = now(), updated_by = EXCLUDED.updated_by`;
      return send(res, 200, { ok: true });
    }
    case 'releases': { // editors may set SAIL release status per month
      if (!MONTH_RE.test(b.month || '')) return send(res, 400, { error: 'Bad month' });
      const mode = ['early', 'hold'].includes(b.mode) ? b.mode : null;
      const rows = await sql`SELECT data FROM sail_config WHERE id = 1`;
      const cfg = { ...DEFAULT_CFG, ...(rows[0]?.data || {}) };
      const rel = { ...(cfg.releases || {}) };
      if (mode) rel[b.month] = mode; else delete rel[b.month];
      await sql`UPDATE sail_config SET data = data || ${JSON.stringify({ releases: rel })}::jsonb, updated_at = now(), updated_by = ${me.email} WHERE id = 1`;
      return send(res, 200, { ok: true, releases: rel });
    }
    case 'config': {
      if (!isAdmin(me)) return send(res, 403, { error: 'Only an admin can change settings' });
      const rows = await sql`SELECT data FROM sail_config WHERE id = 1`;
      const merged = cleanConfig({ ...DEFAULT_CFG, ...(rows[0]?.data || {}), ...(b.config || {}) });
      await sql`UPDATE sail_config SET data = ${JSON.stringify(merged)}::jsonb, updated_at = now(), updated_by = ${me.email} WHERE id = 1`;
      return send(res, 200, { ok: true, config: merged });
    }
    case 'activity': {
      const { out, errs } = cleanActivity(b.data || {});
      if (errs.length) return send(res, 400, { error: 'Check these fields: ' + errs.join(', ') });
      const id = b.id && /^[A-Za-z0-9_-]{6,40}$/.test(b.id) ? b.id : crypto.randomUUID().replace(/-/g, '').slice(0, 20);
      if (!out.createdAt) out.createdAt = out.updatedAt;
      out.updatedBy = me.email;
      await sql`INSERT INTO sail_activities (id, data, updated_at, updated_by) VALUES (${id}, ${JSON.stringify(out)}::jsonb, now(), ${me.email})
                ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now(), updated_by = EXCLUDED.updated_by`;
      return send(res, 200, { ok: true, id });
    }
    case 'delete_activity': {
      const aid = String(b.id || '');
      const files = await sql`SELECT id, url FROM sail_files WHERE kind = 'activity' AND ref = ${aid}`;
      if (files.length && blobReady()) { try { await del(files.map(f => f.url)); } catch (e) { console.warn('blob delete failed:', e.message); } }
      await sql`DELETE FROM sail_files WHERE kind = 'activity' AND ref = ${aid}`;
      await sql`DELETE FROM sail_activities WHERE id = ${aid}`;
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 400, { error: 'Unknown action' });
});
