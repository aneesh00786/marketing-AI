const test = require('node:test');
const assert = require('node:assert/strict');
process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');

const { zonedLocalToUtc, utcToZonedLocal, isValidTimeZone } = require('../lib/time');
const secretBox = require('../lib/secretBox');
const { assertSafeUrl, isBlockedAddress } = require('../lib/safeFetch');
const { evaluateAccount, requiredPublishFeature } = require('../modules/social/capabilities');
const { unverifiedClaims } = require('../modules/social/campaignService');
const { redact } = require('../lib/audit');
const meta = require('../modules/social/providers/meta');

test('time zone conversion stores the intended instant in UTC', () => {
  assert.equal(zonedLocalToUtc('2026-11-03T09:30', 'Asia/Kolkata').toISOString(), '2026-11-03T04:00:00.000Z');
  // Melbourne is UTC+11 in November (daylight time).
  assert.equal(zonedLocalToUtc('2026-11-03T09:30', 'Australia/Melbourne').toISOString(), '2026-11-02T22:30:00.000Z');
  // New York: EDT (UTC-4) before 1 Nov 2026, EST (UTC-5) after.
  assert.equal(zonedLocalToUtc('2026-10-30T12:00', 'America/New_York').toISOString(), '2026-10-30T16:00:00.000Z');
  assert.equal(zonedLocalToUtc('2026-11-05T12:00', 'America/New_York').toISOString(), '2026-11-05T17:00:00.000Z');
  assert.equal(utcToZonedLocal(new Date('2026-11-03T04:00:00Z'), 'Asia/Kolkata'), '2026-11-03T09:30');
});

test('time zone conversion rejects wall times skipped by daylight saving and bad input', () => {
  assert.throws(() => zonedLocalToUtc('2026-03-08T02:30', 'America/New_York'), /does not exist/);
  assert.throws(() => zonedLocalToUtc('2026-03-08 25:00', 'UTC'), /format|does not exist/);
  assert.throws(() => zonedLocalToUtc('2026-03-08T10:00', 'Mars/Base'), /Unknown time zone/);
  assert.equal(isValidTimeZone('Europe/London'), true);
  assert.equal(isValidTimeZone('Nope/Nope'), false);
});

test('secretBox encrypts with authentication and detects tampering', () => {
  const enc = secretBox.encryptJson({ access_token: 'abc123' });
  assert.ok(enc.startsWith('enc:v1:'));
  assert.ok(!enc.includes('abc123'));
  assert.deepEqual(secretBox.decryptJson(enc), { access_token: 'abc123' });
  const parts = enc.split(':');
  const ct = Buffer.from(parts[4], 'base64url');
  ct[0] ^= 0xff;
  parts[4] = ct.toString('base64url');
  assert.throws(() => secretBox.decrypt(parts.join(':')));
});

test('SSRF guard blocks private, loopback, link-local, metadata and odd ports', () => {
  for (const url of [
    'http://127.0.0.1/', 'http://10.0.0.5/', 'http://192.168.1.3/', 'http://172.20.1.1/', 'http://169.254.169.254/latest/meta-data',
    'http://[::1]/', 'http://[fd00::1]/', 'http://[::ffff:127.0.0.1]/', 'http://localhost/', 'http://db.internal/',
    'http://example.com:3306/', 'ftp://example.com/', 'file:///etc/passwd', 'http://user:pass@example.com/', 'http://0.0.0.0/'
  ]) {
    assert.throws(() => assertSafeUrl(url), `${url} should be blocked`);
  }
  assert.doesNotThrow(() => assertSafeUrl('https://example.com/page'));
  assert.equal(isBlockedAddress('8.8.8.8'), false);
  assert.equal(isBlockedAddress('100.64.1.1'), true);
});

test('capability registry reflects provider support, implementation and granted scopes', () => {
  process.env.META_APP_ID = 'id';
  process.env.META_APP_SECRET = 'secret';
  const ig = evaluateAccount({ account_type: 'instagram_business', scopes_json: JSON.stringify(['instagram_basic', 'instagram_content_publish']) });
  assert.equal(ig.publish_image.status, 'available');
  assert.equal(ig.publish_text.status, 'unsupported_by_provider');
  assert.equal(ig.publish_video.status, 'not_implemented');
  assert.equal(ig.comments_read.status, 'missing_permission');
  assert.deepEqual(ig.comments_read.missingScopes, ['instagram_manage_comments']);

  // A connected account keeps working from its own token, whether or not app credentials are present.
  delete process.env.META_APP_SECRET;
  const fb = evaluateAccount({ account_type: 'facebook_page', scopes_json: '["pages_manage_posts"]' });
  assert.equal(fb.publish_text.status, 'available');
  assert.equal(fb.analytics_post.status, 'missing_permission');

  assert.equal(requiredPublishFeature({ link_url: null }, [{ asset_type: 'image' }]), 'publish_image');
  assert.equal(requiredPublishFeature({ link_url: 'https://x.test' }, []), 'publish_link');
  assert.equal(requiredPublishFeature({}, []), 'publish_text');
});

test('unverified price and statistic claims are flagged unless present in the facts', () => {
  const flags = unverifiedClaims('Only $49/month! Cut costs by 40% and grow 3x.', JSON.stringify({ offer: 'Save 40% for 3 months' }));
  assert.ok(flags.some(f => f.includes('$49')));
  assert.ok(flags.includes('3x'));
  assert.ok(!flags.includes('40%'));
});

test('audit redaction removes secrets at any depth', () => {
  const out = redact({ access_token: 'a', nested: { refresh_token: 'b', ok: 1, list: [{ password: 'c' }] } });
  assert.equal(out.access_token, '[redacted]');
  assert.equal(out.nested.refresh_token, '[redacted]');
  assert.equal(out.nested.ok, 1);
  assert.equal(out.nested.list[0].password, '[redacted]');
});

test('Meta webhook signature verification uses the app secret over the raw body', () => {
  process.env.META_APP_SECRET = 'app-secret';
  const raw = Buffer.from('{"object":"page"}');
  const sig = 'sha256=' + require('crypto').createHmac('sha256', 'app-secret').update(raw).digest('hex');
  assert.equal(meta.verifyWebhookSignature(raw, sig), true);
  assert.equal(meta.verifyWebhookSignature(Buffer.from('{"object":"tampered"}'), sig), false);
  assert.equal(meta.verifyWebhookSignature(raw, 'sha256=00'), false);
  assert.equal(meta.verifyWebhookSignature(raw, undefined), false);
});
