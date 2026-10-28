const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');

// Migration 025: Compose purpose audit records, the Owners/Admins report, and per-member grants of
// mail.send_transactional. ZeptoMail is mocked and SMTP stubbed; nothing is sent.
const db = () => h.db();
const uid = () => crypto.randomBytes(4).toString('hex');
const key = () => ({ 'Idempotency-Key': crypto.randomBytes(16).toString('hex') });
const CAP = 'mail.send_transactional';

let Z; let OTHER;
const RECEIPT = { subject: 'Your order #1042 has shipped', body: 'Hi Kim, your order #1042 shipped today.' };
const PROMO = { subject: 'Spring sale', body: '30% off everything for a limited time. Shop now!' };

const zeptoRoute = calls => ({ match: u => u.startsWith('https://api.zeptomail.com/'), respond: (u, init) => { calls.push(JSON.parse(init.body)); return h.json(calls.failWith || 200, calls.failWith ? { error: 'rejected' } : { request_id: `r-${uid()}` }); } });
async function compose(who, body, { headers = key(), calls = [] } = {}) {
  const mock = h.mockFetch([zeptoRoute(calls)]);
  try { return await h.api('POST', '/api/v1/emails/send', { token: who.token, headers, body: { recipient_email: `kim-${uid()}@client.io`, confirm: true, ...body } }); } finally { mock.restore(); }
}
const requestRow = (ws, k) => db().get('SELECT * FROM mail_send_requests WHERE workspace_id = ? AND idempotency_key = ?', [ws.workspaceId, k]);
const report = (who, qs = '') => h.api('GET', `/api/v1/mail/compose-report${qs}`, { token: who.token });
const grant = (who, target, cap = CAP) => h.api('PUT', `/api/v1/workspace/members/${target.userId}/grants/${cap}`, { token: who.token });
const revoke = (who, target, cap = CAP) => h.api('DELETE', `/api/v1/workspace/members/${target.userId}/grants/${cap}`, { token: who.token });

test.before(async () => {
  await h.prepareDatabase();
  Z = await h.createWorkspace({ name: 'Audit Z' });
  OTHER = await h.createWorkspace({ name: 'Audit other' });
  for (const ws of [Z, OTHER]) {
    assert.equal((await h.api('POST', '/api/v1/mail/config', { token: ws.token, body: { provider: 'zeptomail', smtp_user: 'emailapikey', smtp_pass: `z-${ws.workspaceId}`, sender_email: `hello@ws${ws.workspaceId}.io`, sender_name: 'N' } })).status, 200);
  }
});
test.after(() => h.shutdown());

// ------------------------------------------------------------------ migration

test('migration 025: three nullable purpose columns, the report index and the grants table (keys, cascades); no grants created', async () => {
  assert.ok(await db().get("SELECT 1 AS x FROM schema_migrations WHERE id = '025_compose_purpose_and_grants'"));
  const cols = await db().all("SELECT COLUMN_NAME AS c, IS_NULLABLE AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_send_requests' AND COLUMN_NAME IN ('declared_purpose','applied_purpose','purpose_reasons') ORDER BY c");
  assert.deepEqual(cols.map(c => [c.c, c.n]), [['applied_purpose', 'YES'], ['declared_purpose', 'YES'], ['purpose_reasons', 'YES']]);
  assert.ok(await db().get("SELECT 1 AS x FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_send_requests' AND INDEX_NAME = 'idx_mail_send_requests_ws_created'"));
  const fks = await db().all("SELECT CONSTRAINT_NAME AS n, DELETE_RULE AS d FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'workspace_member_capability_grants' ORDER BY n");
  assert.deepEqual(fks.map(f => [f.n, f.d]), [['fk_member_capability_grantor', 'SET NULL'], ['fk_member_capability_user', 'CASCADE'], ['fk_member_capability_ws', 'CASCADE']]);
  assert.ok(await db().get("SELECT 1 AS x FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspace_member_capability_grants' AND INDEX_NAME = 'uq_member_capability' AND NON_UNIQUE = 0"));
  // Existing Marketing Managers / Approvers were not copied into grants.
  const mm = await h.addMember(Z.workspaceId, 'Marketing Manager');
  assert.equal((await db().get('SELECT COUNT(*) AS n FROM workspace_member_capability_grants WHERE workspace_id = ?', [Z.workspaceId])).n, 0);
  assert.equal((await compose(mm, { ...RECEIPT, purpose: 'transactional' })).data.code, 'TRANSACTIONAL_NOT_PERMITTED');
});

// ------------------------------------------------------------------ purpose record

test('the purpose is recorded atomically with the claim: declared, applied and reason codes', async () => {
  let h1 = key();
  assert.equal((await compose(Z, { ...RECEIPT, purpose: 'transactional' }, { headers: h1 })).status, 200);
  let r = await requestRow(Z, h1['Idempotency-Key']);
  assert.deepEqual([r.declared_purpose, r.applied_purpose, r.purpose_reasons, r.status], ['transactional', 'transactional', null, 'sent']);
  // Refused as marketing in a ZeptoMail-only workspace: nothing is claimed, so no record (the refusal is in the audit log).
  h1 = key();
  assert.equal((await compose(Z, { ...PROMO, purpose: 'transactional' }, { headers: h1 })).status, 409);
  assert.equal(await requestRow(Z, h1['Idempotency-Key']) ?? null, null);
  // Reclassified marketing that is sent (approved SMTP mailbox): reasons recorded.
  const S = await h.createWorkspace({ name: 'Audit S' });
  await h.useMarketingSmtp(S, 'news@s-audit.io');
  const hs = key();
  const mock = h.mockFetch([h.smtpRoute(() => {})]);
  try { assert.equal((await h.api('POST', '/api/v1/emails/send', { token: S.token, headers: hs, body: { recipient_email: 'kim@client.io', ...PROMO, purpose: 'transactional', confirm: true } })).status, 200); } finally { mock.restore(); }
  r = await requestRow(S, hs['Idempotency-Key']);
  assert.deepEqual([r.declared_purpose, r.applied_purpose, r.purpose_reasons], ['transactional', 'marketing', 'promotional_phrases']);
});

test('the purpose record never changes: duplicates and retries reuse it; a retry that would change the purpose is refused', async () => {
  const headers = key();
  const body = { ...RECEIPT, purpose: 'transactional', recipient_email: `once-${uid()}@client.io` };
  const fail = []; fail.failWith = 422;
  assert.equal((await compose(Z, body, { headers, calls: fail })).status, 502, 'clear rejection, nothing sent');
  const before = await requestRow(Z, headers['Idempotency-Key']);
  assert.equal(before.status, 'failed');
  assert.equal((await compose(Z, { ...body, subject: 'Other' }, { headers })).status, 422, 'the same key with other content is refused');
  const ok = await compose(Z, body, { headers });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const dup = await compose(Z, body, { headers });
  assert.equal(dup.data.duplicate, true);
  const after = await requestRow(Z, headers['Idempotency-Key']);
  assert.equal(after.id, before.id, 'the original row is reused');
  assert.equal(after.status, 'sent');
  assert.deepEqual([after.declared_purpose, after.applied_purpose, after.purpose_reasons, after.created_at.getTime()], [before.declared_purpose, before.applied_purpose, before.purpose_reasons, before.created_at.getTime()]);

  // A failed transactional attempt whose retry would now be classified as marketing (a matching marketing
  // template was added meanwhile; the workspace can send marketing): refused, record unchanged, nothing sent.
  const S = await h.createWorkspace({ name: 'Audit retry' });
  await h.useMarketingSmtp(S, 'news@retry-co.io');
  const h2 = key();
  const b2 = { recipient_email: `twice-${uid()}@client.io`, subject: 'Your account update', body: 'Hi Kim, your account settings were updated today as you requested on our website.', purpose: 'transactional', confirm: true };
  const sent = [];
  let mock = h.mockFetch([h.smtpRoute(m => sent.push(m), () => h.json(422, { error: 'rejected' }))]);
  try { assert.equal((await h.api('POST', '/api/v1/emails/send', { token: S.token, headers: h2, body: b2 })).status, 502); } finally { mock.restore(); }
  const rec = await requestRow(S, h2['Idempotency-Key']);
  assert.deepEqual([rec.applied_purpose, rec.status], ['transactional', 'failed']);
  await h.api('POST', '/api/v1/mail/templates', { token: S.token, body: { name: 'Mirror', category: 'Newsletter', html: `<p>${b2.body}</p>` } });
  mock = h.mockFetch([h.smtpRoute(m => sent.push(m))]);
  let retry;
  try { retry = await h.api('POST', '/api/v1/emails/send', { token: S.token, headers: h2, body: b2 }); } finally { mock.restore(); }
  assert.equal(retry.status, 409, JSON.stringify(retry.data));
  assert.equal(retry.data.code, 'PURPOSE_CHANGED');
  assert.equal(sent.length, 1, 'only the first (rejected) attempt reached the mailbox');
  const rec2 = await requestRow(S, h2['Idempotency-Key']);
  assert.deepEqual([rec2.declared_purpose, rec2.applied_purpose, rec2.purpose_reasons, rec2.status], [rec.declared_purpose, rec.applied_purpose, rec.purpose_reasons, 'failed']);
});

test('no application code path updates the purpose columns after the claim', () => {
  const roots = ['modules', 'services', 'lib', 'workers', 'server.js'].map(p => path.join(__dirname, '..', p));
  const files = [];
  const walk = p => { if (fs.statSync(p).isDirectory()) fs.readdirSync(p).forEach(f => walk(path.join(p, f))); else if (p.endsWith('.js')) files.push(p); };
  roots.forEach(walk);
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/UPDATE\s+mail_send_requests[\s\S]{0,300}?(WHERE|`|"|')/gi)) {
      if (/declared_purpose|applied_purpose|purpose_reasons/.test(m[0])) offenders.push(path.relative(path.join(__dirname, '..'), f));
    }
  }
  assert.deepEqual(offenders, []);
});

// ------------------------------------------------------------------ report

test('report: Owners/Admins only; this workspace only; masked recipients; no content; legacy rows "not recorded"', async () => {
  const admin = await h.addMember(Z.workspaceId, 'Workspace Admin');
  for (const role of ['Marketing Manager', 'Approver', 'Member']) {
    const m = await h.addMember(Z.workspaceId, role);
    assert.equal((await report(m)).status, 403, role);
  }
  await db().run("INSERT INTO mail_send_requests (workspace_id, idempotency_key, request_hash, status, requested_by, created_at, updated_at) VALUES (?, ?, ?, 'sent', NULL, UTC_TIMESTAMP(), UTC_TIMESTAMP())", [Z.workspaceId, `legacy-${uid()}-aaaaaaaaaaaa`, 'x'.repeat(64)]);
  const sentTo = `dana-${uid()}@client.io`;
  assert.equal((await compose(Z, { ...RECEIPT, purpose: 'transactional', recipient_email: sentTo })).status, 200);
  assert.equal((await compose(OTHER, { ...RECEIPT, purpose: 'transactional', recipient_email: 'other@elsewhere-ws.io' })).status, 200);

  const r = await report(admin);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const mine = r.data.sends.find(s => s.recipient === `d***@client.io` && s.appliedPurpose === 'transactional');
  assert.ok(mine, 'masked recipient');
  assert.deepEqual(Object.keys(mine).sort(), ['appliedPurpose', 'at', 'declaredPurpose', 'emailId', 'id', 'reasons', 'recipient', 'sender', 'status']);
  assert.equal(mine.sender.userId, Z.userId);
  assert.ok(r.data.sends.some(s => s.appliedPurpose === 'not_recorded' && s.declaredPurpose === null), 'legacy rows are "not recorded", never transactional');
  const text = JSON.stringify(r.data);
  assert.doesNotMatch(text, new RegExp(sentTo), 'no full address');
  assert.doesNotMatch(text, /shipped today|order #1042/, 'no message content');
  assert.doesNotMatch(text, /elsewhere-ws\.io/, 'other workspace not included');
  assert.ok(r.data.refused.some(x => x.reason === 'transactional_not_permitted'), 'refused attempts from the audit log');
  assert.ok(r.data.refused.every(x => !('recipient' in x)));
});

test('report filters (purpose, dates), pagination and validation', async () => {
  const t = await report(Z, '?purpose=transactional');
  assert.ok(t.data.sends.length && t.data.sends.every(s => s.appliedPurpose === 'transactional'));
  const n = await report(Z, '?purpose=not_recorded');
  assert.ok(n.data.sends.every(s => s.appliedPurpose === 'not_recorded'));
  const old = await report(Z, '?from=2020-01-01&to=2020-01-31');
  assert.deepEqual([old.data.sends.length, old.data.refused.length], [0, 0]);
  for (const qs of ['?purpose=all', '?from=2026-13-40', '?from=2020-01-01&to=2026-01-01', '?to=2020-01-01&from=2020-02-01', '?page=0', '?extra=1']) {
    assert.equal((await report(Z, qs)).status, 400, qs);
  }
  for (let i = 0; i < 51; i++) await db().run("INSERT INTO mail_send_requests (workspace_id, idempotency_key, request_hash, status, applied_purpose, declared_purpose, created_at, updated_at) VALUES (?, ?, ?, 'failed', 'marketing', NULL, UTC_TIMESTAMP(), UTC_TIMESTAMP())", [OTHER.workspaceId, `p-${uid()}-${i}-aaaaaaaaaa`, 'y'.repeat(64)]);
  const p1 = await report(OTHER, '?purpose=marketing');
  assert.equal(p1.data.sends.length, 50);
  assert.equal(p1.data.hasMore, true);
  const p2 = await report(OTHER, '?purpose=marketing&page=2');
  assert.ok(p2.data.sends.length >= 1);
  assert.deepEqual(p2.data.refused, [], 'refused attempts are listed on page 1 only');
});

// ------------------------------------------------------------------ grants

test('grants: Owners/Admins grant mail.send_transactional to eligible members only; enforced on the server; audited; revocable', async () => {
  const mm = await h.addMember(Z.workspaceId, 'Marketing Manager');
  const appr = await h.addMember(Z.workspaceId, 'Approver');
  const member = await h.addMember(Z.workspaceId, 'Member');
  const admin = await h.addMember(Z.workspaceId, 'Workspace Admin');

  assert.equal((await grant(mm, appr)).status, 403, 'a Marketing Manager cannot grant');
  assert.equal((await grant(Z, member)).data.code, 'NOT_ELIGIBLE', 'Members cannot send mail at all');
  assert.equal((await grant(Z, admin)).data.code, 'ALREADY_IN_ROLE');
  assert.equal((await grant(Z, mm, 'mail.configure')).data.code, 'NOT_GRANTABLE');
  assert.equal((await grant(Z, mm, 'billing.manage')).data.code, 'NOT_GRANTABLE');
  const outsider = await h.addMember(OTHER.workspaceId, 'Marketing Manager');
  assert.equal((await grant(Z, outsider)).status, 404, 'not a member of this workspace');

  assert.equal((await grant(admin, mm)).status, 200, 'Admins can grant');
  assert.equal((await grant(Z, mm)).status, 200, 'idempotent');
  assert.equal((await db().get("SELECT COUNT(*) AS n FROM audit_logs WHERE workspace_id = ? AND action = 'workspace.capability_granted' AND resource_id = ?", [Z.workspaceId, String(mm.userId)])).n, 1);
  const me = await h.api('GET', '/api/v1/auth/me', { token: mm.token });
  assert.ok(me.data.capabilities.includes(CAP));
  const sent = await compose(mm, { ...RECEIPT, purpose: 'transactional' });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(sent.data.purpose, 'transactional');
  // Promotional content is still marketing, grant or not.
  assert.equal((await compose(mm, { ...PROMO, purpose: 'transactional' })).data.code, 'MARKETING_PROVIDER_BLOCKED');

  const list = await h.api('GET', '/api/v1/workspace/members', { token: Z.token });
  const states = Object.fromEntries(list.data.members.map(m => [m.userId, m.grants?.[CAP]]));
  assert.deepEqual([states[mm.userId], states[appr.userId], states[member.userId], states[admin.userId]], ['granted', 'eligible', 'not_eligible', 'role']);
  const asMember = await h.api('GET', '/api/v1/workspace/members', { token: member.token });
  assert.ok(asMember.data.members.every(m => m.grants === undefined), 'grant details are for Owners/Admins only');

  assert.equal((await revoke(Z, mm)).status, 200);
  assert.ok(await db().get("SELECT 1 AS x FROM audit_logs WHERE workspace_id = ? AND action = 'workspace.capability_revoked' AND resource_id = ?", [Z.workspaceId, String(mm.userId)]));
  assert.equal((await compose(mm, { ...RECEIPT, purpose: 'transactional' })).data.code, 'TRANSACTIONAL_NOT_PERMITTED');
});

test('grants fail closed: a role change removes an ineligible grant (not restored later); a stray grant on an ineligible role is ignored; removal deletes grants', async () => {
  const mm = await h.addMember(Z.workspaceId, 'Marketing Manager');
  assert.equal((await grant(Z, mm)).status, 200);
  assert.equal((await h.api('PATCH', `/api/v1/workspace/members/${mm.userId}`, { token: Z.token, body: { role: 'Member' } })).status, 200);
  assert.equal(await db().get('SELECT 1 AS x FROM workspace_member_capability_grants WHERE workspace_id = ? AND user_id = ?', [Z.workspaceId, mm.userId]) ?? null, null);
  const a = await db().get("SELECT metadata_json FROM audit_logs WHERE workspace_id = ? AND action = 'workspace.capability_revoked' AND resource_id = ? ORDER BY id DESC LIMIT 1", [Z.workspaceId, String(mm.userId)]);
  assert.equal(JSON.parse(a.metadata_json).reason, 'role_changed');
  await h.api('PATCH', `/api/v1/workspace/members/${mm.userId}`, { token: Z.token, body: { role: 'Marketing Manager' } });
  assert.equal((await compose(mm, { ...RECEIPT, purpose: 'transactional' })).data.code, 'TRANSACTIONAL_NOT_PERMITTED', 'not restored by changing back');

  // A grant row for a role that does not qualify (e.g. written directly) is ignored.
  const member = await h.addMember(Z.workspaceId, 'Member');
  await db().run('INSERT INTO workspace_member_capability_grants (workspace_id, user_id, capability, granted_by) VALUES (?, ?, ?, NULL)', [Z.workspaceId, member.userId, CAP]);
  const { effectiveCapabilities } = require('../lib/capabilityGrants');
  assert.equal((await effectiveCapabilities(Z.workspaceId, member.userId, 'Member')).has(CAP), false);
  // So is a grant of a capability that is not grantable.
  const appr = await h.addMember(Z.workspaceId, 'Approver');
  await db().run('INSERT INTO workspace_member_capability_grants (workspace_id, user_id, capability, granted_by) VALUES (?, ?, ?, NULL)', [Z.workspaceId, appr.userId, 'mail.configure']);
  assert.equal((await effectiveCapabilities(Z.workspaceId, appr.userId, 'Approver')).has('mail.configure'), false);
  // A grant in another workspace does not apply here.
  await db().run('INSERT INTO workspace_member_capability_grants (workspace_id, user_id, capability, granted_by) VALUES (?, ?, ?, NULL)', [OTHER.workspaceId, appr.userId, CAP]);
  assert.equal((await effectiveCapabilities(Z.workspaceId, appr.userId, 'Approver')).has(CAP), false);

  const mm2 = await h.addMember(Z.workspaceId, 'Marketing Manager');
  await grant(Z, mm2);
  assert.equal((await h.api('DELETE', `/api/v1/workspace/members/${mm2.userId}`, { token: Z.token })).status, 200);
  assert.equal(await db().get('SELECT 1 AS x FROM workspace_member_capability_grants WHERE workspace_id = ? AND user_id = ?', [Z.workspaceId, mm2.userId]) ?? null, null);
});

test('REVIEW: refused Compose attempts are not crowded out by other refusals; the list is capped at 50 and says so', async () => {
  const W = await h.createWorkspace({ name: 'Audit refused' });
  const ins = (meta) => db().run("INSERT INTO audit_logs (workspace_id, actor_user_id, actor_type, action, metadata_json, created_at) VALUES (?, ?, 'user', 'mail.send_blocked', ?, UTC_TIMESTAMP())", [W.workspaceId, W.userId, JSON.stringify(meta)]);
  await ins({ path: 'compose', reason: 'transactional_not_permitted', purpose: { declared: 'transactional', applied: 'transactional', reasons: [] } });
  for (let i = 0; i < 60; i++) await ins({ path: 'draft', reason: 'unsubscribed' });
  let r = await report(W);
  assert.equal(r.status, 200);
  assert.equal(r.data.refused.length, 1, 'the Compose refusal is listed despite 60 newer draft refusals');
  assert.equal(r.data.refusedTruncated, false);
  r = await report(W, '?purpose=marketing');
  assert.equal(r.data.refused.length, 0, 'purpose filter applied');
  for (let i = 0; i < 55; i++) await ins({ path: 'compose', reason: 'MARKETING_PROVIDER_BLOCKED', purpose: { declared: null, applied: 'marketing', reasons: ['purpose_missing'] } });
  r = await report(W);
  assert.equal(r.data.refused.length, 50);
  assert.equal(r.data.refusedTruncated, true);
});
