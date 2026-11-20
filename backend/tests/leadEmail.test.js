const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');
// Staff send only from their own verified address: every member here has one (see senders.test.js for the rule).
const addMember = async (workspaceId, role) => { const m = await h.addMember(workspaceId, role); await h.verifiedSender(m, workspaceId); return m; };

// "Email leads" (Leads → ✉): a member emails a lead's own address from the Leads page, without Mail Center
// or "Send email". Same rules as Compose (purpose, opt-outs, unsubscribe). SMTP is a stub: nothing is sent.
const db = () => h.db();
const key = () => ({ 'Idempotency-Key': crypto.randomBytes(16).toString('hex') });
let W; let MEM; let LEAD; let OTHER_LEAD;

async function send(who, leadId, body, sent = []) {
  const mock = h.mockFetch([h.smtpRoute(m => sent.push(m))]);
  try {
    return await h.api('POST', `/api/v1/leads/${leadId}/send-email`, { token: who.token, headers: key(), body: { subject: 'Quick update', body: 'Hi,\n\nNews about our range.', purpose: 'marketing', confirm: true, ...body } });
  } finally { mock.restore(); }
}

test.before(async () => {
  await h.prepareDatabase();
  W = await h.createWorkspace({ name: 'Lead email' });
  await h.useMarketingSmtp(W, 'sales@lead-co.io');
  MEM = await addMember(W.workspaceId, 'Member');
  // Members see leads they own: one of theirs, one of the owner's.
  LEAD = (await db().run("INSERT INTO leads (workspace_id, name, email, status, owner_user_id, created_by_user_id, lead_source, created_at) VALUES (?, 'Kim Co', 'kim@kimco.io', 'New', ?, ?, 'manual', UTC_TIMESTAMP())", [W.workspaceId, MEM.userId, MEM.userId])).lastID;
  OTHER_LEAD = (await db().run("INSERT INTO leads (workspace_id, name, email, status, owner_user_id, created_by_user_id, lead_source, created_at) VALUES (?, 'Lee Co', 'lee@leeco.io', 'New', ?, ?, 'manual', UTC_TIMESTAMP())", [W.workspaceId, W.userId, W.userId])).lastID;
});
test.after(() => h.shutdown());

test('without "Email leads" (or "Send email") a member cannot email leads; with it, only the lead\'s own address', async () => {
  const no = await send(MEM, LEAD, { recipient_email: 'kim@kimco.io' });
  assert.equal(no.status, 403);
  assert.equal((await h.api('PUT', `/api/v1/workspace/members/${MEM.userId}/grants/leads.email`, { token: W.token })).status, 200);
  const wrong = await send(MEM, LEAD, { recipient_email: 'someone@else.io' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.data.code, 'NOT_LEAD_EMAIL');
  const sent = [];
  const ok = await send(MEM, LEAD, { recipient_email: 'kim@kimco.io' }, sent);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'kim@kimco.io');
  assert.match(sent[0].html, /unsubscribe/i, 'marketing safeguards apply');
  const e = await db().get('SELECT sent_by_user_id FROM emails WHERE id = ?', [ok.data.emailId]);
  assert.equal(Number(e.sent_by_user_id), MEM.userId);
});

test('a lead the member cannot see is refused; transactional still needs its own permission', async () => {
  const hidden = await send(MEM, OTHER_LEAD, { recipient_email: 'lee@leeco.io' });
  assert.ok([403, 404].includes(hidden.status), String(hidden.status));
  const tx = await send(MEM, LEAD, { recipient_email: 'kim@kimco.io', subject: 'Your order #1042 has shipped', body: 'Your order #1042 shipped today.', purpose: 'transactional' });
  assert.equal(tx.status, 403);
  assert.equal(tx.data.code, 'TRANSACTIONAL_NOT_PERMITTED');
});

test('"Email leads" is a grantable permission under Leads; Owners have it by role', async () => {
  const list = await h.api('GET', '/api/v1/workspace/members', { token: W.token });
  assert.ok(list.data.grantable.some(g => g.capability === 'leads.email'));
  const owner = list.data.members.find(m => m.isYou);
  assert.equal(owner.grants?.['leads.email'] ?? 'role', 'role');
});
