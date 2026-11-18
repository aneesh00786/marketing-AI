const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');

// Marketing email from Compose in a workspace whose mailbox is ZeptoMail (transactional only): it goes
// through Amazon SES when SES is set up, with the unsubscribe link and header; never through ZeptoMail.
// SES is a local fake behind the fetch mock: nothing is sent.
const db = () => h.db();
process.env.APP_BASE_URL = 'https://app.marketech.test'; // one-click unsubscribe links need the public https address
const uid = () => crypto.randomBytes(4).toString('hex');
const key = () => ({ 'Idempotency-Key': crypto.randomBytes(16).toString('hex') });
const KEYS = { region: 'us-east-1', accessKeyId: 'AKIATESTKEY0000001', secretAccessKey: 'testSecretKey/abcdefghijklmnop1234', maxPerSecond: 5 };

function fakeSes(verified) {
  const s = { sent: [], zepto: [] };
  s.routes = [
    { match: u => u.startsWith('https://api.zeptomail.com/'), respond: (u, init) => { s.zepto.push(JSON.parse(init.body)); return h.json(200, { request_id: `r-${uid()}` }); } },
    {
      match: u => /^https:\/\/email\.us-east-1\.amazonaws\.com\/v2\/email\//.test(u),
      respond: (url, init) => {
        const u = new URL(url);
        const idm = /^\/v2\/email\/identities\/(.+)$/.exec(u.pathname);
        if (idm) return verified.has(decodeURIComponent(idm[1])) ? h.json(200, { VerifiedForSendingStatus: true }) : h.json(404, { message: 'Not found' }, { 'x-amzn-ErrorType': 'NotFoundException' });
        if (u.pathname === '/v2/email/outbound-emails') {
          const body = JSON.parse(init.body);
          s.sent.push({ from: body.FromEmailAddress, to: body.Destination.ToAddresses[0], raw: Buffer.from(body.Content.Raw.Data, 'base64').toString('utf8') });
          return h.json(200, { MessageId: `0100${uid()}-000000` });
        }
        return h.json(404, { message: 'Unknown' });
      }
    }
  ];
  return s;
}

let Z;
test.before(async () => {
  await h.prepareDatabase();
  Z = await h.createWorkspace({ name: 'Zepto + SES' });
  assert.equal((await h.api('POST', '/api/v1/mail/config', { token: Z.token, body: { provider: 'zeptomail', smtp_user: 'emailapikey', smtp_pass: 'zepto-Z', sender_email: 'sales@thrive-co.io', sender_name: 'Thrive' } })).status, 200);
});
test.after(() => h.shutdown());

async function compose(body, verified) {
  const s = fakeSes(verified);
  const mock = h.mockFetch(s.routes);
  try {
    const r = await h.api('POST', '/api/v1/emails/send', { token: Z.token, headers: key(), body: { recipient_email: `kim-${uid()}@client.io`, subject: 'Quick update', confirm: true, ...body } });
    return { r, s };
  } finally { mock.restore(); }
}

test('without SES, marketing in a ZeptoMail workspace is refused and says how to fix it', async () => {
  const { r, s } = await compose({ body: 'Hi,\n\nNews.', purpose: 'marketing' }, new Set());
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'MARKETING_PROVIDER_BLOCKED');
  assert.match(r.data.error || r.data.message, /Amazon SES/);
  assert.equal(s.zepto.length + s.sent.length, 0);
});

test('with SES set up, marketing goes through SES (unsubscribe link and header, line breaks kept), never ZeptoMail', async () => {
  assert.equal((await h.api('PUT', '/api/v1/mail/ses/settings', { token: Z.token, body: KEYS })).status, 200);
  const status = await h.api('GET', '/api/v1/mail/marketing', { token: Z.token });
  assert.equal(status.data.marketing.allowed, true);
  assert.equal(status.data.marketing.marketingVia, 'ses');

  const { r, s } = await compose({ body: 'Hi,\n\nI hope you are doing well.\n\nBest regards,\nAneesh', purpose: 'marketing' }, new Set(['thrive-co.io']));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(s.zepto.length, 0, 'never ZeptoMail');
  assert.equal(s.sent.length, 1);
  // Quoted-printable soft breaks and folded headers undone.
  const raw = s.sent[0].raw.replace(/=\r?\n/g, '').replace(/\r?\n[ \t]+/g, ' ');
  assert.equal(s.sent[0].from, 'sales@thrive-co.io');
  assert.match(raw, /^List-Unsubscribe: <https?:\/\/[^>]+>, <mailto:sales@thrive-co\.io\?subject=unsubscribe>/m);
  assert.match(raw, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
  assert.match(raw, /unsubscribe/i, 'visible unsubscribe link in the body');
  assert.match(raw, /<p style=3D"margin:0 0 1em">Hi,<\/p>|<p style="margin:0 0 1em">Hi,<\/p>/, 'paragraphs kept');
  const e = await db().get('SELECT smtp_status FROM emails WHERE id = ?', [r.data.emailId]);
  assert.equal(e.smtp_status, 'Sent via Amazon SES');

  // Transactional is unchanged: ZeptoMail.
  const t = await compose({ body: 'Your order #1042 has shipped.', subject: 'Your order #1042 has shipped', purpose: 'transactional' }, new Set(['thrive-co.io']));
  assert.equal(t.r.status, 200, JSON.stringify(t.r.data));
  assert.equal(t.s.zepto.length, 1);
  assert.equal(t.s.sent.length, 0);
});

test('a sender not verified in SES is refused with a clear message; nothing is sent', async () => {
  const { r, s } = await compose({ body: 'Hi,\n\nNews.', purpose: 'marketing' }, new Set());
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'SES_SENDER_NOT_VERIFIED');
  assert.equal(s.sent.length + s.zepto.length, 0);
});
