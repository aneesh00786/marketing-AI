const crypto = require('crypto');

/**
 * Authenticated encryption (AES-256-GCM) for credentials stored at rest:
 * social OAuth tokens and mailbox passwords.
 *
 * Ciphertext format: enc:v1:<iv>:<tag>:<ciphertext>  (base64url segments)
 * The key comes from SOCIAL_TOKEN_ENCRYPTION_KEY (32 bytes, base64 or hex).
 */
const PREFIX = 'enc:v1:';

function loadKey() {
  const raw = process.env.SOCIAL_TOKEN_ENCRYPTION_KEY || '';
  if (!raw) return null;
  let key = null;
  if (/^[0-9a-f]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
  else key = Buffer.from(raw, 'base64');
  return key.length === 32 ? key : null;
}

function isConfigured() {
  return loadKey() !== null;
}

function requireKey() {
  const key = loadKey();
  if (!key) {
    const err = new Error('Credential encryption is not configured. Set SOCIAL_TOKEN_ENCRYPTION_KEY (32 random bytes, base64) in backend/.env.');
    err.code = 'ENCRYPTION_NOT_CONFIGURED';
    throw err;
  }
  return key;
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;
  const key = requireKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${ct.toString('base64url')}`;
}

function decrypt(value) {
  if (!isEncrypted(value)) return value;
  const key = requireKey();
  const [ivB64, tagB64, ctB64] = value.slice(PREFIX.length).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
}

function encryptJson(obj) {
  return encrypt(JSON.stringify(obj));
}

function decryptJson(value) {
  if (!value) return null;
  return JSON.parse(decrypt(value));
}

/** Short, non-reversible digest for lookups (e.g. OAuth state) without storing the raw value. */
function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

module.exports = {
  isConfigured,
  isEncrypted,
  encrypt,
  decrypt,
  encryptJson,
  decryptJson,
  sha256
};
