const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');

// Campaigns sent with Amazon SES. SES and SNS are local fakes behind the fetch mock (unmatched
// requests fail loudly): no real AWS call is made and nothing is ever sent.
const db = () => h.db();
process.env.APP_BASE_URL = 'https://app.marketech.test';
process.env.SES_SEND_INLINE = '0';

const sns = () => require('../modules/mail/ses/snsWebhook');
const sesCampaigns = () => require('../modules/mail/ses/sesCampaigns');

/** Fake SES v2: account, identities, outbound emails (each recorded with its decoded MIME). */
function fakeSes() {
  const s = { sent: [], calls: [], verified: new Set(['acme-co.io']), sendResponder: null, account: { SendingEnabled: true, ProductionAccessEnabled: true, SendQuota: { Max24HourSend: 50000, MaxSendRate: 14, SentLast24Hours: 3 } } };
  s.routes = [{
    match: u => /^https:\/\/email\.[a-z0-9-]+\.amazonaws\.com\/v2\/email\//.test(u),
    respond: (url, init) => {
      const u = new URL(url);
      const auth = String(init.headers.Authorization || '');
      s.calls.push({ method: init.method, path: u.pathname, auth });
      if (!/^AWS4-HMAC-SHA256 Credential=AKIATESTKEY0000001\/\d{8}\/us-east-1\/ses\/aws4_request, SignedHeaders=[a-z;-]+, Signature=[a-f0-9]{64}$/.test(auth)) {
        return h.json(403, { message: 'The security token included in the request is invalid.' }, { 'x-amzn-ErrorType': 'UnrecognizedClientException' });
      }
      if (u.pathname === '/v2/email/account') return h.json(200, s.account);
      const idm = /^\/v2\/email\/identities\/(.+)$/.exec(u.pathname);
      if (idm) {
        const id = decodeURIComponent(idm[1]);
        return s.verified.has(id) ? h.json(200, { VerifiedForSendingStatus: true }) : h.json(404, { message: 'Not found' }, { 'x-amzn-ErrorType': 'NotFoundException' });
      }
      if (u.pathname === '/v2/email/outbound-emails' && init.method === 'POST') {
        const body = JSON.parse(init.body);
        if (s.sendResponder) { const r = s.sendResponder(body); if (r) return r; }
        const raw = Buffer.from(body.Content.Raw.Data, 'base64').toString('utf8');
        const id = `0100${crypto.randomBytes(12).toString('hex')}-000000`;
        s.sent.push({ id, to: body.Destination.ToAddresses[0], from: body.FromEmailAddress, raw, configurationSet: body.ConfigurationSetName, tags: Object.fromEntries(body.EmailTags.map(t => [t.Name, t.Value])) });
        return h.json(200, { MessageId: id });
      }
      return h.json(404, { message: 'Unknown' });
    }
  }];
  return s;
}

// SNS signing key (the fake certificate URL returns its public key).
const snsKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const CERT_URL = 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem';
const TOPIC = 'arn:aws:sns:us-east-1:123456789012:marketech-ses-events';
function signed(m) {
  const msg = { SignatureVersion: '2', SigningCertURL: CERT_URL, Timestamp: new Date().toISOString(), TopicArn: TOPIC, MessageId: crypto.randomUUID(), ...m };
  msg.Signature = crypto.createSign('RSA-SHA256').update(sns().stringToSign(msg)).sign(snsKeys.privateKey, 'base64');
  return msg;
}
const subscribeVisits = [];

let S;
let mock;
test.before(async () => {
  await h.prepareDatabase();
  process.env.APP_BASE_URL = 'https://app.marketech.test';
  sns().setFetchForTests(async url => {
    if (url === CERT_URL) return snsKeys.publicKey.export({ type: 'spki', format: 'pem' });
    if (url.startsWith('https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription')) { subscribeVisits.push(url); return '<ConfirmSubscriptionResponse/>'; }
    throw new Error(`unexpected fetch ${url}`);
  });
});
test.beforeEach(() => { S = fakeSes(); mock = h.mockFetch(S.routes); });
test.afterEach(() => mock.restore());
test.after(() => h.shutdown());

const capi = (ws, method, p, body) => h.api(method, `/api/v1/mail/campaigns${p}`, { token: ws.token, body });
const sapi = (ws, method, p, body) => h.api(method, `/api/v1/mail/ses${p}`, { token: ws.token, body });
const row = id => db().get('SELECT * FROM mail_campaigns WHERE id = ?', [id]);
const KEYS = { region: 'us-east-1', accessKeyId: 'AKIATESTKEY0000001', secretAccessKey: 'testSecretKey/abcdefghijklmnop1234', configurationSet: 'marketech-events', maxPerSecond: 50 };

async function sesWorkspace(name) {
  const ws = await h.createWorkspace({ name: `${name} ${Date.now()}` });
  const r = await sapi(ws, 'PUT', '/settings', KEYS);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return ws;
}

/** A contact list whose people gave marketing consent (with method and evidence). */
async function consentedList(ws, people, name = 'Customers') {
  const list = await capi(ws, 'POST', '/contact-lists', { name, contacts: people });
  assert.equal(list.status, 200, JSON.stringify(list.data));
  for (const p of people) {
    await db().run(`INSERT INTO leads (workspace_id, name, email, status, marketing_consent, marketing_consent_method, marketing_consent_evidence, marketing_consent_obtained_at, created_at, updated_at)
      VALUES (?, ?, ?, 'New', 'granted', 'web_form', 'Signed up on the website', '2026-10-01', UTC_TIMESTAMP(), UTC_TIMESTAMP())`, [ws.workspaceId, p.name, p.email.toLowerCase()]);
  }
  return list.data.list.id;
}

const CAMPAIGN = {
  name: 'November offer', subject: 'Hi {{first_name}}, our November offer', fromName: 'Acme', fromEmail: 'news@acme-co.io',
  html: '<p>Hello $[FNAME|there]$,</p><p>See <a href="https://acme-co.io/offer">the offer</a>.</p><p><a href="$[LI:UNSUBSCRIBE]$">Unsubscribe</a></p>',
};

async function sentCampaign(ws, people) {
  const listId = await consentedList(ws, people);
  const c = (await capi(ws, 'POST', '', { ...CAMPAIGN, mailListIds: [listId] })).data.campaign;
  const v = (await capi(ws, 'POST', `/${c.id}/validate`, {})).data.validation;
  assert.equal(v.ready, true, JSON.stringify(v));
  assert.equal((await capi(ws, 'POST', `/${c.id}/approve`, {})).status, 200);
  const s = await capi(ws, 'POST', `/${c.id}/send`, { confirm: true });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  return c;
}
const nextJob = ws => db().get("SELECT * FROM background_jobs WHERE workspace_id = ? AND job_type = 'ses_campaign_send' AND status = 'queued' ORDER BY id DESC LIMIT 1", [ws.workspaceId]);
async function runJobs(ws) {
  for (let i = 0; i < 10; i++) {
    const job = await nextJob(ws);
    if (!job) return;
    await db().run("UPDATE background_jobs SET status = 'running' WHERE id = ?", [job.id]);
    await sesCampaigns().runSendJob(job);
    await db().run("UPDATE background_jobs SET status = 'succeeded' WHERE id = ?", [job.id]);
  }
}

test('SES settings: the secret is stored encrypted and never returned; the connection test reads the account; SES needs keys first', async () => {
  const ws = await h.createWorkspace({ name: `SES settings ${Date.now()}` });
  assert.equal((await sapi(ws, 'GET', '/settings')).data.ses.configured, false, 'not set up until keys are saved');
  const saved = await sapi(ws, 'PUT', '/settings', KEYS);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.ses.configured, true);
  assert.equal(saved.data.ses.accessKeyId, 'AKIA…0001', 'masked');
  assert.ok(!JSON.stringify(saved.data).includes(KEYS.secretAccessKey), 'the secret is never returned');
  const stored = await db().get('SELECT ses_secret_ciphertext FROM mail_delivery_settings WHERE workspace_id = ?', [ws.workspaceId]);
  assert.ok(stored.ses_secret_ciphertext && !stored.ses_secret_ciphertext.includes(KEYS.secretAccessKey), 'encrypted at rest');
  assert.match(saved.data.ses.notificationUrl, /^https:\/\/app\.marketech\.test\/api\/v1\/mail\/t\/webhooks\/ses\/[a-f0-9]{32}$/);
  const t = await sapi(ws, 'POST', '/test', {});
  assert.equal(t.status, 200, JSON.stringify(t.data));
  assert.deepEqual([t.data.account.productionAccess, t.data.account.maxSendRate], [true, 14]);
  S.account.ProductionAccessEnabled = false;
  assert.match((await sapi(ws, 'POST', '/test', {})).data.message, /sandbox/);
  const other = await h.createWorkspace({ name: `SES other ${Date.now()}` });
  assert.equal((await sapi(other, 'GET', '/settings')).data.ses.configured, false, 'another workspace has its own settings');
});

test('SES send: each consented person gets one personalized email with their unsubscribe link and tracking; a retried job sends nobody twice', async () => {
  const ws = await sesWorkspace('SES send');
  const people = [{ name: 'Priya Nair', email: 'priya@shop.io' }, { name: 'Kerala Traders', company: 'Kerala Traders', email: 'info@kt.in' }, { name: 'Sam Lee', email: 'sam@shop.io' }];
  const c = await sentCampaign(ws, people);
  let r = await row(c.id);
  assert.deepEqual([r.status, r.submit_stage, r.provider, r.upload_total], ['submitting', 'ses_send', 'ses', 3]);
  await runJobs(ws);
  r = await row(c.id);
  assert.equal(r.status, 'submitted');
  assert.equal(S.sent.length, 3);
  assert.deepEqual(S.sent.map(x => x.to).sort(), ['info@kt.in', 'priya@shop.io', 'sam@shop.io']);
  const priya = S.sent.find(x => x.to === 'priya@shop.io');
  assert.equal(priya.from, 'news@acme-co.io');
  assert.equal(priya.configurationSet, 'marketech-events');
  assert.equal(priya.tags.marketech_campaign, String(c.id));
  assert.match(priya.raw, /Subject: Hi Priya, our November offer/);
  assert.match(priya.raw, /Hello Priya,/);
  assert.match(priya.raw, /List-Unsubscribe:\s+<https:\/\/app\.marketech\.test\/api\/v1\/mail\/unsubscribe\/c\/\d+-[a-f0-9]{32}\?e=priya%40shop\.io>/);
  assert.match(priya.raw, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
  assert.match(priya.raw.replace(/=\r?\n/g, ''), /\/api\/v1\/mail\/t\/o\/[a-f0-9]{32}\.gif/, 'open pixel');
  assert.match(priya.raw.replace(/=\r?\n/g, ''), /\/api\/v1\/mail\/t\/c\/[a-f0-9]{32}/, 'tracked link');
  assert.ok(!/\$\[/.test(priya.raw), 'no merge tags left');
  assert.match(S.sent.find(x => x.to === 'info@kt.in').raw, /Hello Kerala Traders team,/, 'a business without a contact person is greeted by its name');
  const report = JSON.parse(r.report_json);
  assert.deepEqual([report.provider, report.emails_sent_count, report.delivered_count, report.opens_count], ['ses', 3, 0, 0]);
  // A repeated job (e.g. after a worker restart) emails nobody again.
  const old = await db().get("SELECT * FROM background_jobs WHERE workspace_id = ? AND job_type = 'ses_campaign_send' ORDER BY id LIMIT 1", [ws.workspaceId]);
  await db().run("UPDATE mail_campaigns SET status = 'submitting', submit_stage = 'ses_send' WHERE id = ?", [c.id]);
  await sesCampaigns().runSendJob(old);
  assert.equal(S.sent.length, 3, 'never sent twice');
});

test('SES events through SNS: the subscription is confirmed; delivered, opens, clicks, bounces and complaints reach the report; bounces and complaints are stopped', async () => {
  const ws = await sesWorkspace('SES events');
  const people = ['a', 'b', 'c'].map(k => ({ name: `Person ${k.toUpperCase()}`, email: `${k}@shop.io` }));
  const c = await sentCampaign(ws, people);
  await runJobs(ws);
  const url = (await sapi(ws, 'GET', '/settings')).data.ses.notificationUrl.replace('https://app.marketech.test', '');
  const post = msg => h.api('POST', url, { rawBody: JSON.stringify(msg), headers: { 'content-type': 'text/plain; charset=UTF-8' } });
  // Subscription confirmation: confirmed by visiting Amazon's SubscribeURL; the topic is then the only one accepted.
  const conf = await post(signed({ Type: 'SubscriptionConfirmation', Token: 'tok', Message: 'confirm', SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=x&Token=tok' }));
  assert.equal(conf.status, 200);
  assert.equal(subscribeVisits.length, 1);
  assert.equal((await sapi(ws, 'GET', '/settings')).data.ses.snsTopicArn, TOPIC);
  const msgId = to => S.sent.find(x => x.to === to).id;
  const event = (type, to, extra = {}) => signed({ Type: 'Notification', Message: JSON.stringify({ eventType: type, mail: { messageId: msgId(to), timestamp: new Date().toISOString(), destination: [to] }, ...extra }) });
  for (const to of ['a@shop.io', 'b@shop.io']) assert.equal((await post(event('Delivery', to, { delivery: { timestamp: new Date().toISOString() } }))).status, 200);
  const bounce = event('Bounce', 'c@shop.io', { bounce: { bounceType: 'Permanent', bounceSubType: 'General', bouncedRecipients: [{ emailAddress: 'c@shop.io', diagnosticCode: '550 5.1.1 user unknown' }], timestamp: new Date().toISOString() } });
  assert.equal((await post(bounce)).status, 200);
  assert.equal((await post(bounce)).data, 'Already handled', 'each SNS message once');
  assert.equal((await post(event('Complaint', 'b@shop.io', { complaint: { complaintFeedbackType: 'abuse', timestamp: new Date().toISOString() } }))).status, 200);
  // Not verified, or from another topic: refused, nothing recorded.
  const forged = event('Delivery', 'c@shop.io');
  forged.Signature = Buffer.from('x'.repeat(256)).toString('base64');
  assert.equal((await post(forged)).status, 403);
  assert.equal((await post(signed({ Type: 'Notification', TopicArn: 'arn:aws:sns:us-east-1:999:other', Message: '{}' }))).status, 403);
  const badCert = event('Delivery', 'a@shop.io');
  badCert.SigningCertURL = 'https://evil.example.com/cert.pem';
  assert.equal((await post(badCert)).status, 403, 'certificates only from Amazon SNS hosts');
  // Opens and clicks: Marketech.ai's own pixel and links.
  const a = S.sent.find(x => x.to === 'a@shop.io').raw.replace(/=\r?\n/g, '').replace(/=3D/g, '=');
  const pixel = /\/api\/v1\/mail\/t\/o\/([a-f0-9]{32})\.gif/.exec(a)[0];
  const link = /\/api\/v1\/mail\/t\/c\/([a-f0-9]{32})/.exec(a)[0];
  assert.equal((await h.api('GET', pixel)).status, 200);
  const click = await h.api('GET', link);
  assert.ok([301, 302, 303, 307].includes(click.status), String(click.status));
  // The report and the stop-list.
  const fresh = (await capi(ws, 'POST', `/${c.id}/refresh`, {})).data.campaign;
  const rep = fresh.report;
  assert.deepEqual([rep.emails_sent_count, rep.delivered_count, rep.opens_count, rep.unique_clicks_count, rep.hardbounce_count, rep.spams_count],
    [3, 2, 1, 1, 1, 1]);
  const stops = await db().all('SELECT email, reason FROM email_suppressions WHERE workspace_id = ? ORDER BY email', [ws.workspaceId]);
  assert.deepEqual(stops.map(x => [x.email, x.reason]), [['b@shop.io', 'complaint'], ['c@shop.io', 'bounced']]);
  // Per-recipient activity.
  const opened = await capi(ws, 'GET', `/${c.id}/recipients?activity=opened`);
  assert.equal(opened.status, 200, JSON.stringify(opened.data));
  assert.deepEqual(opened.data.recipients.map(x => x.email), ['a@shop.io']);
  const bounced = (await capi(ws, 'GET', `/${c.id}/recipients?activity=hard_bounced`)).data.recipients;
  assert.deepEqual(bounced.map(x => [x.email, x.reason]), [['c@shop.io', '550 5.1.1 user unknown']]);
});

test('SES stops on a hard refusal with SES\'s reason; Send again continues with the people not yet emailed', async () => {
  const ws = await sesWorkspace('SES paused');
  const people = ['p1', 'p2', 'p3'].map(k => ({ name: `Person ${k}`, email: `${k}@shop.io` }));
  const c = await sentCampaign(ws, people);
  let n = 0;
  S.sendResponder = () => (++n === 2 ? h.json(400, { message: 'Sending is paused for this account.' }, { 'x-amzn-ErrorType': 'SendingPausedException' }) : null);
  await runJobs(ws);
  let r = await row(c.id);
  assert.deepEqual([r.status, r.provider_code], ['failed', 'SendingPausedExcepti']);
  assert.match(r.provider_message, /Sending is paused.*Send again continues/s);
  assert.equal(S.sent.length, 1);
  S.sendResponder = null;
  assert.equal((await capi(ws, 'POST', `/${c.id}/send`, { confirm: true })).status, 200);
  await runJobs(ws);
  r = await row(c.id);
  assert.equal(r.status, 'submitted');
  assert.deepEqual(S.sent.map(x => x.to).sort(), ['p1@shop.io', 'p2@shop.io', 'p3@shop.io'], 'each person exactly once');
});

test('SES checks before approval: an unverified sender, no unsubscribe link and no consent are refused', async () => {
  const ws = await sesWorkspace('SES checks');
  const listId = await consentedList(ws, [{ name: 'Ann', email: 'ann@shop.io' }]);
  const check = async body => (await capi(ws, 'POST', `/${(await capi(ws, 'POST', '', { ...CAMPAIGN, mailListIds: [listId], ...body })).data.campaign.id}/validate`, {})).data.validation;
  assert.ok((await check({ fromEmail: 'news@not-verified.io' })).problems.some(p => /not verified in Amazon SES/.test(p)));
  assert.ok((await check({ html: '<p>Hello</p>' })).problems.some(p => /unsubscribe link/.test(p)));
  const cold = (await capi(ws, 'POST', '/contact-lists', { name: 'Cold', contacts: [{ name: 'X', email: 'x@cold.io' }] })).data.list.id;
  assert.ok((await check({ mailListIds: [cold] })).problems.some(p => /no recorded marketing consent/.test(p)));
  const aud = await capi(ws, 'GET', '/audiences');
  assert.equal(aud.status, 200);
  assert.ok(aud.data.mailLists.some(l => l.id === listId));
});
