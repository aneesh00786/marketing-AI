const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Product Emails is hidden unless PRODUCT_EMAILS_ENABLED=1; unsubscribe links always work.
let W;

test.before(async () => {
  await h.prepareDatabase();
  W = await h.createWorkspace({ name: 'Feature flags' });
});
test.after(() => h.shutdown());

test('with Product Emails off, its API refuses, the status reports it off and the worker sends nothing', async () => {
  delete process.env.PRODUCT_EMAILS_ENABLED;
  const r = await h.api('GET', '/api/v1/mail/product-emails/batches', { token: W.token });
  assert.equal(r.status, 404);
  assert.equal(r.data.code, 'FEATURE_DISABLED');
  const status = await h.api('GET', '/api/status');
  assert.equal(status.data.features.productEmails, false);
  const worker = require('../workers/socialWorker');
  const productEmails = require('../modules/mail/productEmails/service');
  const outreachSender = require('../modules/outreach/outreachSender');
  const saved = { processBatches: productEmails.processBatches, monitored: productEmails.monitoredWorkspaces, detect: productEmails.detectUnsubscribeReplies, sync: outreachSender.syncInboxes };
  let called = false;
  let detected = false;
  productEmails.processBatches = async () => { called = true; return 0; };
  productEmails.monitoredWorkspaces = async () => [W.workspaceId];
  productEmails.detectUnsubscribeReplies = async () => { detected = true; return 0; };
  outreachSender.syncInboxes = async () => {}; // no mailbox connection in tests
  try {
    assert.equal(await worker.processProductEmails(), 0);
    assert.equal(called, false, 'no batch processing while the feature is off');
    assert.equal(detected, true, 'unsubscribe replies to marketing email are still applied');
  } finally {
    productEmails.processBatches = saved.processBatches;
    productEmails.monitoredWorkspaces = saved.monitored;
    productEmails.detectUnsubscribeReplies = saved.detect;
    outreachSender.syncInboxes = saved.sync;
  }
});

test('unsubscribe links keep working while Product Emails is off', async () => {
  delete process.env.PRODUCT_EMAILS_ENABLED;
  const r = await h.api('GET', `/api/v1/mail/unsubscribe/${'a'.repeat(40)}`);
  assert.equal(r.status, 404);
  assert.match(String(r.data), /Link not valid/, 'the unsubscribe route answers (unknown token), not FEATURE_DISABLED');
});

test('setting PRODUCT_EMAILS_ENABLED=1 turns it back on without a code change', async () => {
  process.env.PRODUCT_EMAILS_ENABLED = '1';
  try {
    const status = await h.api('GET', '/api/status');
    assert.equal(status.data.features.productEmails, true);
    const r = await h.api('GET', '/api/v1/mail/product-emails/batches', { token: W.token });
    assert.notEqual(r.data?.code, 'FEATURE_DISABLED');
  } finally {
    delete process.env.PRODUCT_EMAILS_ENABLED;
  }
});
