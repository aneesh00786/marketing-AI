const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');

// Personal sender addresses ("My sender email", migration 067): a member adds their address, confirms it with
// the emailed link, and then sends from it. Staff cannot send without one; Owners/Admins keep the workspace
// address when they have none. Mail providers are local fakes: nothing is sent.
process.env.APP_BASE_URL = 'https://app.marketech.test';
const db = () => h.db();
const uid = () => crypto.randomBytes(4).toString('hex');
const key = () => ({ 'Idempotency-Key': crypto.randomBytes(16).toString('hex') });
let W; let STAFF; let OTHER;

const zepto = calls => ({ match: u => u.startsWith('https://api.zeptomail.com/'), respond: (u, init) => { calls.push(JSON.parse(init.body)); return h.json(200, { request_id: `r-${uid()}` }); } });
async function withZepto(fn) {
  const calls = [];
  const mock = h.mockFetch([zepto(calls)]);
  try { return { r: await fn(), calls }; } finally { mock.restore(); }
}
const tokenFrom = call => /senders\/verify\/([a-f0-9]{64})/.exec(call.htmlbody || '')?.[1];
const compose = (who, extra = {}) => h.api('POST', '/api/v1/emails/send', { token: who.token, headers: key(),
  body: { recipient_email: `kim-${uid()}@client.io`, subject: 'Your order #1042 has shipped', body: 'Your order #1042 shipped today.', purpose: 'transactional', confirm: true, ...extra } });

test.before(async () => {
  await h.prepareDatabase();
  W = await h.createWorkspace({ name: 'Senders' });
  assert.equal((await h.api('POST', '/api/v1/mail/config', { token: W.token, body: { provider: 'zeptomail', smtp_user: 'emailapikey', smtp_pass: 'z-key', sender_email: 'sales@thrive-co.io', sender_name: 'ThriveWoo' } })).status, 200);
  STAFF = await h.addMember(W.workspaceId, 'Marketing Manager');
  OTHER = await h.addMember(W.workspaceId, 'Marketing Manager');
  // Marketing Managers send transactional only with the grant; give it so the sender rule is what is tested.
  for (const m of [STAFF, OTHER]) await h.api('PUT', `/api/v1/workspace/members/${m.userId}/grants/mail.send_transactional`, { token: W.token });
});
test.after(() => h.shutdown());

test('migration 067 adds the table', async () => {
  assert.ok(await db().get("SELECT 1 AS x FROM schema_migrations WHERE id = '067_member_senders'"));
});

test('nobody sends until they have a confirmed address (the Owner here confirmed the workspace address)', async () => {
  const { r } = await withZepto(() => compose(STAFF));
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'SENDER_REQUIRED');
  const owner = await withZepto(() => compose(W));
  assert.equal(owner.r.status, 200, JSON.stringify(owner.r.data));
  assert.equal(owner.calls[0].from.address, 'sales@thrive-co.io');
});

test('adding an address emails a single-use link; opening it verifies the address; then mail goes from it', async () => {
  const addr = `anita-${uid()}@thrive-co.io`;
  const { r, calls } = await withZepto(() => h.api('POST', '/api/v1/mail/senders', { token: STAFF.token, body: { email: addr, name: 'Anita' } }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.sender.status, 'pending');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to[0].email_address.address, addr);
  const token = tokenFrom(calls[0]);
  assert.ok(token, 'the email carries the link');
  // Still pending: cannot send yet.
  assert.equal((await withZepto(() => compose(STAFF))).r.data.code, 'SENDER_REQUIRED');

  const page = await h.api('GET', `/api/v1/mail/senders/verify/${token}`);
  assert.equal(page.status, 200);
  assert.match(page.data, /Address confirmed/);
  assert.equal((await h.api('GET', `/api/v1/mail/senders/verify/${token}`)).status, 400, 'single use');
  assert.equal((await h.api('GET', '/api/v1/mail/senders', { token: STAFF.token })).data.senders[0].status, 'verified');

  const sent = await withZepto(() => compose(STAFF));
  assert.equal(sent.r.status, 200, JSON.stringify(sent.r.data));
  assert.equal(sent.calls[0].from.address, addr);
  assert.equal(sent.calls[0].from.name, 'Anita');
  assert.equal(sent.calls[0].reply_to[0].address, addr, 'replies go to the person');
  const e = await db().get('SELECT sender_email FROM emails WHERE id = ?', [sent.r.data.emailId]);
  assert.equal(e.sender_email, addr);

  // Another person's address, a public mailbox, or someone else's chosen From: refused.
  assert.equal((await withZepto(() => h.api('POST', '/api/v1/mail/senders', { token: OTHER.token, body: { email: addr } }))).r.data.code, 'SENDER_TAKEN');
  assert.equal((await withZepto(() => h.api('POST', '/api/v1/mail/senders', { token: OTHER.token, body: { email: 'me@gmail.com' } }))).r.data.code, 'PUBLIC_DOMAIN');
  assert.equal((await withZepto(() => compose(STAFF, { from_email: 'sales@thrive-co.io' }))).r.data.code, 'SENDER_NOT_YOURS');
});

test('an expired link is refused; resend gives a new one', async () => {
  const addr = `ravi-${uid()}@thrive-co.io`;
  const { r, calls } = await withZepto(() => h.api('POST', '/api/v1/mail/senders', { token: OTHER.token, body: { email: addr } }));
  const token = tokenFrom(calls[0]);
  await db().run('UPDATE member_sender_addresses SET token_expires_at = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE id = ?', [r.data.sender.id]);
  const page = await h.api('GET', `/api/v1/mail/senders/verify/${token}`);
  assert.equal(page.status, 400);
  assert.match(page.data, /expired/);
  assert.equal((await withZepto(() => h.api('POST', `/api/v1/mail/senders/${r.data.sender.id}/resend`, { token: OTHER.token }))).r.data.code, 'TOO_SOON', 'at most once a minute');
  await db().run('UPDATE member_sender_addresses SET last_sent_at = UTC_TIMESTAMP() - INTERVAL 2 MINUTE WHERE id = ?', [r.data.sender.id]);
  const again = await withZepto(() => h.api('POST', `/api/v1/mail/senders/${r.data.sender.id}/resend`, { token: OTHER.token }));
  assert.equal(again.r.status, 200);
  assert.equal((await h.api('GET', `/api/v1/mail/senders/verify/${tokenFrom(again.calls[0])}`)).status, 200);
  assert.equal((await h.api('DELETE', `/api/v1/mail/senders/${r.data.sender.id}`, { token: STAFF.token })).status, 404, "nobody removes another person's");
});

test('campaigns: everyone (Owners too) uses only their own confirmed address; an Owner may send a member\'s campaign from the member\'s', async () => {
  const mine = (await h.api('GET', '/api/v1/mail/senders', { token: STAFF.token })).data.senders.find(s => s.status === 'verified').email;
  const bad = await h.api('POST', '/api/v1/mail/campaigns', { token: STAFF.token, body: { name: `c-${uid()}`, fromEmail: 'sales@thrive-co.io' } });
  assert.equal(bad.status, 403);
  assert.equal(bad.data.code, 'SENDER_NOT_YOURS');
  const ok = await h.api('POST', '/api/v1/mail/campaigns', { token: STAFF.token, body: { name: `c-${uid()}`, fromEmail: mine } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  // The Owner: only addresses they confirmed (here the workspace address they set up), not any address.
  assert.equal((await h.api('POST', '/api/v1/mail/campaigns', { token: W.token, body: { name: `c-${uid()}`, fromEmail: 'news@thrive-co.io' } })).data.code, 'SENDER_NOT_YOURS');
  assert.equal((await h.api('POST', '/api/v1/mail/campaigns', { token: W.token, body: { name: `c-${uid()}`, fromEmail: 'sales@thrive-co.io' } })).status, 200);
  // Editing the member's campaign keeps the member's address (it is theirs).
  assert.equal((await h.api('PATCH', `/api/v1/mail/campaigns/${ok.data.campaign.id}`, { token: W.token, body: { name: 'Renamed', fromEmail: mine } })).status, 200);
  // Senders list says everyone needs one.
  assert.equal((await h.api('GET', '/api/v1/mail/senders', { token: W.token })).data.required, true);
});

test('each address says whether Amazon SES can send from it; "Ask AWS" requests verification of one address', async () => {
  const KEYS = { region: 'us-east-1', accessKeyId: 'AKIATESTKEY0000001', secretAccessKey: 'testSecretKey/abcdefghijklmnop1234', maxPerSecond: 5 };
  assert.equal((await h.api('PUT', '/api/v1/mail/ses/settings', { token: W.token, body: KEYS })).status, 200);
  const created = [];
  const ses = { match: u => /^https:\/\/email\.us-east-1\.amazonaws\.com\/v2\/email\/identities/.test(u), respond: (url, init) => {
    const id = decodeURIComponent(new URL(url).pathname.split('/').pop());
    if (init.method === 'POST') { created.push(JSON.parse(init.body).EmailIdentity); return h.json(200, { IdentityType: 'EMAIL_ADDRESS', VerifiedForSendingStatus: false }); }
    return id === 'thrive-co.io' ? h.json(200, { VerifiedForSendingStatus: true }) : h.json(404, { message: 'Not found' }, { 'x-amzn-ErrorType': 'NotFoundException' });
  } };
  // A confirmed address on a domain SES does not know.
  const other = `aneesh-${uid()}@jrboon-co.io`;
  const zcalls = [];
  let mock = h.mockFetch([ses, zepto(zcalls)]);
  let added;
  try { added = await h.api('POST', '/api/v1/mail/senders', { token: STAFF.token, body: { email: other } }); } finally { mock.restore(); }
  assert.equal(added.data.sender.ses.ready, false);
  await h.api('GET', `/api/v1/mail/senders/verify/${tokenFrom(zcalls[0])}`);
  mock = h.mockFetch([ses]);
  try {
    const list = (await h.api('GET', '/api/v1/mail/senders', { token: STAFF.token })).data.senders;
    assert.equal(list.find(s => s.email === other).ses.ready, false, 'SES cannot send from it yet');
    assert.equal(list.find(s => /thrive-co\.io$/.test(s.email)).ses.ready, true, 'the verified domain can');
    const id = list.find(s => s.email === other).id;
    const r = await h.api('POST', `/api/v1/mail/senders/${id}/aws`, { token: STAFF.token });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.match(r.data.message, /Amazon Web Services emailed a confirmation link/);
    assert.deepEqual(created, [other]);
  } finally { mock.restore(); }
});
