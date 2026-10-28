/**
 * Optional features that can be switched off without removing code.
 * Product Emails (product -> leads -> personalised email batches) is off unless
 * PRODUCT_EMAILS_ENABLED=1: its API answers "feature disabled", the worker does not send batches and
 * the Mail Center hides it. Unsubscribe links stay active either way, so opt-outs are always honoured.
 */
const productEmailsEnabled = (env = process.env) => String(env.PRODUCT_EMAILS_ENABLED || '').trim() === '1';

/** Express middleware: 404 FEATURE_DISABLED while Product Emails is off. */
function requireProductEmails(req, res, next) {
  if (productEmailsEnabled()) return next();
  return res.status(404).json({ success: false, code: 'FEATURE_DISABLED', error: 'Product Emails is not enabled on this server.' });
}

module.exports = { productEmailsEnabled, requireProductEmails };
