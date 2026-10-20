const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Business Playbooks ("AI Campaigns"): real AI only, and "dispatch" only ever creates drafts.
let A;
let B;
let bizA;
let bizB;
let prodA;
let prodB;
let leadOk;
let leadOk2;
let leadPlaceholder;
let leadNoEmail;
let leadB;

const aiDown = () => ({ match: u => u.startsWith('https://api.groq.com/'), respond: () => h.json(500, {}) });
const emailCount = async () => Number((await h.db().get('SELECT COUNT(*) AS c FROM emails')).c);

async function addBusiness(ws, body) {
  const r = await h.api('POST', '/api/v1/businesses/connected', { token: ws.token, body });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.businessId;
}

async function addLead(ws, body) {
  const mock = h.mockFetch([aiDown()]);
  try {
    const r = await h.api('POST', '/api/v1/leads', { token: ws.token, body });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.lead.id;
  } finally { mock.restore(); }
}

test.before(async () => {
  await h.prepareDatabase();
  A = await h.createWorkspace({ name: 'Playbooks A' });
  B = await h.createWorkspace({ name: 'Playbooks B' });
  // Same business name in both workspaces: only the caller's record may ever be used.
  bizA = await addBusiness(A, { name: 'Shared Name Co', industry: 'Logistics', description: 'Route planning software for couriers', target_audience: 'Courier operations managers', products: ['Route planner'], business_type: 'owner', workspace_id: B.workspaceId });
  bizB = await addBusiness(B, { name: 'Shared Name Co', industry: 'Retail', description: 'B-only secret description', target_audience: 'B audience' });
  prodA = (await h.api('POST', '/api/v1/products', { token: A.token, body: { name: 'RouteKit', tagline: 'Plan delivery routes', features: ['Driver app'] } })).data.productId;
  prodB = (await h.api('POST', '/api/v1/products', { token: B.token, body: { name: 'B Product' } })).data.productId;
  leadOk = await addLead(A, { name: 'Dana Smith', email: 'dana@fleetco.io' });
  leadOk2 = await addLead(A, { name: 'Lee Wong', email: 'lee@fleetco.io' });
  leadPlaceholder = await addLead(A, { name: 'Placeholder Pat', email: 'pat@example.com' });
  leadNoEmail = await addLead(A, { name: 'No Email Nia' });
  leadB = await addLead(B, { name: 'B Lead', email: 'b@other.io' });
});
test.after(() => h.shutdown());

test('businesses are workspace-scoped; type and workspace come from the server', async () => {
  const { get } = h.db();
  const row = await get('SELECT workspace_id, business_type FROM connected_businesses WHERE id = ?', [bizA]);
  assert.equal(Number(row.workspace_id), A.workspaceId);
  assert.equal(row.business_type, 'client', 'owner type cannot be set through the API');
  const list = await h.api('GET', '/api/v1/businesses/connected', { token: B.token });
  assert.ok(list.data.businesses.every(b => Number(b.workspace_id) === B.workspaceId));
  assert.ok(!list.data.businesses.some(b => b.id === bizA));
  assert.equal((await h.api('POST', '/api/v1/businesses/connected', { token: A.token, body: { name: 'X', industry: 'Y', website: 'javascript:alert(1)' } })).status, 400);
});

test('dispatch creates drafts for selected leads only and never records a send', async () => {
  const before = await emailCount();
  const draftsBefore = Number((await h.db().get('SELECT COUNT(*) AS c FROM email_drafts WHERE workspace_id = ?', [A.workspaceId])).c);
  const body = { businessId: bizA, productId: prodA, subject: 'Plan routes faster', body: 'RouteKit plans delivery routes for your drivers.', leadIds: [leadOk, leadPlaceholder, leadNoEmail] };
  const r = await h.api('POST', '/api/v1/marketing/dispatch-campaign', { token: A.token, body });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.sent, false);
  assert.equal(r.data.draftsCreated, 1);
  assert.deepEqual(r.data.skipped.map(s => s.leadId).sort(), [leadPlaceholder, leadNoEmail].sort());
  assert.match(r.data.message, /Nothing was sent/);
  assert.equal(await emailCount(), before, 'no email row is ever written by dispatch');

  const { get } = h.db();
  const d = await get('SELECT * FROM email_drafts WHERE id = ?', [r.data.drafts[0].draftId]);
  assert.equal(Number(d.workspace_id), A.workspaceId);
  assert.equal(d.status, 'Draft', 'must still be approved and confirmed in Mail Drafts');
  assert.equal(d.recipient_email, 'dana@fleetco.io');
  assert.equal(Number(d.lead_id), leadOk);
  assert.equal(d.product_name, 'RouteKit');
  assert.match(d.body_text, /^Hi Dana,\n\nRouteKit plans delivery routes/);
  const draftsAfter = Number((await get('SELECT COUNT(*) AS c FROM email_drafts WHERE workspace_id = ?', [A.workspaceId])).c);
  assert.equal(draftsAfter, draftsBefore + 1);
});

test('dispatch validation: explicit leads, ownership, no internal notes, permissions', async () => {
  const before = await emailCount();
  const base = { businessId: bizA, subject: 'S', body: 'B' };
  assert.equal((await h.api('POST', '/api/v1/marketing/dispatch-campaign', { token: A.token, body: base })).status, 400, 'no implicit "latest 5 leads"');
  assert.equal((await h.api('POST', '/api/v1/marketing/dispatch-campaign', { token: A.token, body: { ...base, leadIds: [] } })).status, 400);
  assert.equal((await h.api('POST', '/api/v1/marketing/dispatch-campaign', { token: A.token, body: { ...base, leadIds: [leadOk, leadB] } })).status, 404, 'foreign lead');
  assert.equal((await h.api('POST', '/api/v1/marketing/dispatch-campaign', { token: A.token, body: { ...base, businessId: bizB, leadIds: [leadOk] } })).status, 404, 'foreign business');
  assert.equal((await h.api('POST', '/api/v1/marketing/dispatch-campaign', { token: A.token, body: { ...base, productId: prodB, leadIds: [leadOk] } })).status, 404, 'foreign product');
  const withTip = await h.api('POST', '/api/v1/marketing/dispatch-campaign', { token: A.token, body: { ...base, leadIds: [leadOk], internal_tip: 'Offer $50 off' } });
  assert.equal(withTip.status, 400, 'internal notes are not accepted into customer drafts');
  const approver = await h.addMember(A.workspaceId, 'Approver');
  assert.equal((await h.api('POST', '/api/v1/marketing/dispatch-campaign', { token: approver.token, body: { ...base, leadIds: [leadOk2] } })).status, 403);
  assert.equal((await h.api('POST', '/api/v1/marketing/dispatch-campaign', { body: { ...base, leadIds: [leadOk2] } })).status, 401);
  assert.equal(await emailCount(), before);
});

test('the retired B2B campaign send cannot record a delivery', async () => {
  const W1 = await h.addMember(1, 'Workspace Owner');
  const before = await emailCount();
  const r = await h.api('POST', '/api/v1/b2b/campaigns/send', { token: W1.token, body: { campaignId: 1, clientId: 1 } });
  assert.equal(r.status, 410);
  assert.equal(r.data.code, 'RETIRED');
  assert.equal(await emailCount(), before);
});

test('playbooks come from the AI, grounded in the caller workspace facts, with unverified claims flagged', async () => {
  let prompt = '';
  const ideas = { ideas: [
    { channel: 'Cold email', angle: 'Plan routes faster', subject: 'Cut planning time by 80%', email_body: 'RouteKit plans routes. Start a 14-day free pilot.', summary: 'Target courier ops', internal_tip: 'Follow up in 3 days' },
    { channel: 'LinkedIn', angle: 'Driver app', subject: 'A driver app for couriers', email_body: 'RouteKit includes a driver app.', summary: 'Ops managers', internal_tip: '' }
  ] };
  const mock = h.mockFetch([h.groqRoute(b => { prompt = b.messages.map(m => m.content).join('\n'); return JSON.stringify(ideas); })]);
  let r;
  try {
    r = await h.api('POST', '/api/v1/marketing/generate-ideas', { token: A.token, body: { businessId: bizA, productId: prodA, goal: 'Book intro calls' } });
  } finally { mock.restore(); }
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ideas.length, 2);
  assert.match(prompt, /Route planning software for couriers/);
  assert.match(prompt, /RouteKit/);
  assert.doesNotMatch(prompt, /B-only secret description/, 'never the same-named business of another workspace');
  assert.deepEqual(r.data.ideas[0].needs_verification.sort(), ['14-day free pilot', '80%'].sort());
  assert.deepEqual(r.data.ideas[1].needs_verification, []);
});

test('no canned playbooks: AI failure, foreign records and missing selection are reported honestly', async () => {
  const mock = h.mockFetch([aiDown()]);
  let down;
  try {
    down = await h.api('POST', '/api/v1/marketing/generate-ideas', { token: A.token, body: { businessId: bizA } });
  } finally { mock.restore(); }
  assert.equal(down.status, 503);
  assert.equal(down.data.code, 'AI_UNAVAILABLE');
  assert.equal(down.data.ideas, undefined, 'no fallback ideas');

  assert.equal((await h.api('POST', '/api/v1/marketing/generate-ideas', { token: A.token, body: {} })).status, 400, 'no default business');
  assert.equal((await h.api('POST', '/api/v1/marketing/generate-ideas', { token: A.token, body: { businessName: 'Shared Name Co' } })).status, 400, 'no name lookup');
  assert.equal((await h.api('POST', '/api/v1/marketing/generate-ideas', { token: A.token, body: { businessId: bizB } })).status, 404);
  assert.equal((await h.api('POST', '/api/v1/marketing/generate-ideas', { token: A.token, body: { businessId: bizA, productId: prodB } })).status, 404);
  const member = await h.addMember(A.workspaceId, 'Member');
  assert.equal((await h.api('POST', '/api/v1/marketing/generate-ideas', { token: member.token, body: { businessId: bizA } })).status, 403);
});
