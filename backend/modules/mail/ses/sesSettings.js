/**
 * The Amazon SES connection that sends a workspace's campaigns. Like the other mail settings: kept per workspace (the secret encrypted,
 * never returned), with the server's .env as the fallback when a workspace has no keys:
 *   AWS_SES_REGION, AWS_SES_ACCESS_KEY_ID, AWS_SES_SECRET_ACCESS_KEY, AWS_SES_CONFIGURATION_SET,
 *   AWS_SES_MAX_PER_SECOND.
 * The SNS notification URL (delivered, bounces, complaints) carries an opaque per-workspace token.
 */
const crypto = require('crypto');
const { z } = require('zod');
const { run, get } = require('../../../db/database');
const { audit } = require('../../../lib/audit');
const secretBox = require('../../../lib/secretBox');
const ses = require('./sesClient');

const ws = ctx => ctx.auth.workspaceId;
const httpError = (status, message, code) => Object.assign(new Error(message), { status, code, expose: true });

async function row(workspaceId) {
  return get('SELECT * FROM mail_delivery_settings WHERE workspace_id = ?', [workspaceId]);
}

function serverConfig() {
  const e = process.env;
  if (!e.AWS_SES_REGION || !e.AWS_SES_ACCESS_KEY_ID || !e.AWS_SES_SECRET_ACCESS_KEY) return null;
  return {
    region: e.AWS_SES_REGION.trim(), accessKeyId: e.AWS_SES_ACCESS_KEY_ID.trim(), secretAccessKey: e.AWS_SES_SECRET_ACCESS_KEY.trim(),
    configurationSet: (e.AWS_SES_CONFIGURATION_SET || '').trim() || null, maxPerSecond: Number(e.AWS_SES_MAX_PER_SECOND) || null, source: 'server'
  };
}

/** The SES connection to send with: the workspace's own keys, else the server's, else null. */
async function sesConfig(workspaceId) {
  const r = await row(workspaceId);
  if (r && r.ses_region && r.ses_access_key_id && r.ses_secret_ciphertext) {
    return {
      region: r.ses_region, accessKeyId: r.ses_access_key_id, secretAccessKey: secretBox.decrypt(r.ses_secret_ciphertext),
      configurationSet: r.ses_configuration_set || null, maxPerSecond: r.ses_max_per_second || null, source: 'workspace'
    };
  }
  const s = serverConfig();
  return s ? { ...s, configurationSet: r?.ses_configuration_set || s.configurationSet, maxPerSecond: r?.ses_max_per_second || s.maxPerSecond } : null;
}

/** Campaigns are sent with Amazon SES. */
async function campaignProvider() {
  return 'ses';
}

function publicBase() {
  return (process.env.APP_BASE_URL || '').replace(/\/$/, '');
}

async function snsToken(workspaceId) {
  const r = await row(workspaceId);
  if (r?.sns_token) return r.sns_token;
  const token = crypto.randomBytes(16).toString('hex');
  await run(`INSERT INTO mail_delivery_settings (workspace_id, sns_token, created_at, updated_at) VALUES (?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
    ON DUPLICATE KEY UPDATE sns_token = COALESCE(sns_token, VALUES(sns_token))`, [workspaceId, token]);
  return (await row(workspaceId)).sns_token;
}

const mask = id => (id ? `${String(id).slice(0, 4)}…${String(id).slice(-4)}` : null);

/** The AWS region of an SNS topic ARN (arn:aws:sns:<region>:<account>:<name>). */
const topicRegion = arn => (/^arn:aws[a-z-]*:sns:([a-z0-9-]+):/.exec(String(arn || '')) || [])[1] || null;

async function getSettings(ctx) {
  const r = await row(ws(ctx));
  const last = await get('SELECT MAX(received_at) AS at, COUNT(*) AS n FROM mail_ses_notifications WHERE workspace_id = ?', [ws(ctx)]).catch(() => null);
  const cfg = await sesConfig(ws(ctx)).catch(() => null);
  const base = publicBase();
  return {
    provider: 'ses',
    canConfigure: ctx.auth.capabilities.has('mail.configure'),
    // What this person may do with campaigns (the Campaigns screen shows only what is allowed).
    canCompose: ctx.auth.capabilities.has('mail.compose'),
    canSend: ctx.auth.capabilities.has('mail.send'),
    ses: {
      configured: !!cfg,
      source: cfg?.source || null,
      region: r?.ses_region || (cfg?.source === 'server' ? cfg.region : null),
      accessKeyId: mask(r?.ses_access_key_id || (cfg?.source === 'server' ? cfg.accessKeyId : null)),
      hasSecret: !!(r?.ses_secret_ciphertext) || cfg?.source === 'server',
      configurationSet: r?.ses_configuration_set || cfg?.configurationSet || null,
      maxPerSecond: r?.ses_max_per_second || cfg?.maxPerSecond || null,
      // Where SNS sends SES events (delivered, bounces, complaints) for this workspace.
      notificationUrl: base && ctx.auth.capabilities.has('mail.configure') ? `${base}/api/v1/mail/t/webhooks/ses/${await snsToken(ws(ctx))}` : null,
      snsTopicArn: r?.ses_sns_topic_arn || null,
      // SES only publishes events to an SNS topic in its own region: a topic elsewhere never gets any.
      snsTopicRegion: topicRegion(r?.ses_sns_topic_arn),
      snsRegionMismatch: !!(r?.ses_sns_topic_arn && topicRegion(r.ses_sns_topic_arn) && (r?.ses_region || cfg?.region) && topicRegion(r.ses_sns_topic_arn) !== (r?.ses_region || cfg?.region)),
      lastEventAt: last?.at || null,
      eventsReceived: Number(last?.n) || 0,
      // SES's own open/click tracking published events in the last 30 days (they are ignored; turn it off).
      sesEngagementTracking: !!(r?.ses_engagement_seen_at && Date.now() - new Date(r.ses_engagement_seen_at instanceof Date ? r.ses_engagement_seen_at : `${String(r.ses_engagement_seen_at).replace(' ', 'T')}Z`).getTime() < 30 * 86400000),
      warmupEnabled: r?.ses_warmup_enabled === undefined || r?.ses_warmup_enabled === null ? true : !!Number(r.ses_warmup_enabled),
      lastCheckedAt: r?.ses_last_checked_at || null,
      lastError: r?.ses_last_error || null
    }
  };
}

const saveSchema = z.object({
  region: z.string().trim().regex(ses.REGION_RE, 'Enter an AWS region such as us-east-1 or ap-south-1.').optional(),
  accessKeyId: z.string().trim().regex(/^[A-Z0-9]{16,128}$/, 'Enter the access key ID (letters and digits, e.g. AKIA…).').optional(),
  secretAccessKey: z.string().trim().min(16).max(128).optional(),
  configurationSet: z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Configuration set names use letters, digits, - and _.').or(z.literal('')).optional(),
  maxPerSecond: z.number().int().min(1).max(500).nullable().optional(),
  clearKeys: z.literal(true).optional(),
  forgetSnsTopic: z.literal(true).optional(),
  warmupEnabled: z.boolean().optional()
}).strict();

async function saveSettings(ctx, input) {
  const v = saveSchema.parse(input || {});
  if ((v.accessKeyId || v.secretAccessKey) && !secretBox.isConfigured()) throw httpError(409, 'Credential encryption is not configured on the server (SOCIAL_TOKEN_ENCRYPTION_KEY).', 'SETUP_REQUIRED');
  await snsToken(ws(ctx));
  const sets = [];
  const params = [];
  const set = (col, val) => { sets.push(`${col} = ?`); params.push(val); };
  const before = await row(ws(ctx));
  if (v.region !== undefined) set('ses_region', v.region);
  // A new region needs a new SNS topic (SES publishes only to topics in its own region); so does "forget".
  if (v.forgetSnsTopic || (v.region !== undefined && before?.ses_region && v.region !== before.ses_region)) set('ses_sns_topic_arn', null);
  if (v.accessKeyId !== undefined) set('ses_access_key_id', v.accessKeyId);
  if (v.secretAccessKey !== undefined) set('ses_secret_ciphertext', secretBox.encrypt(v.secretAccessKey));
  if (v.configurationSet !== undefined) set('ses_configuration_set', v.configurationSet || null);
  if (v.maxPerSecond !== undefined) set('ses_max_per_second', v.maxPerSecond);
  if (v.warmupEnabled !== undefined) set('ses_warmup_enabled', v.warmupEnabled ? 1 : 0);
  if (v.clearKeys) { set('ses_access_key_id', null); set('ses_secret_ciphertext', null); set('ses_region', null); }
  if (sets.length) {
    set('updated_by', ctx.auth.userId || null);
    await run(`UPDATE mail_delivery_settings SET ${sets.join(', ')}, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ?`, [...params, ws(ctx)]);
  }
  await audit(ctx, 'mail.delivery_settings_saved', { resourceType: 'mail_provider', resourceId: 'ses', metadata: { keysChanged: !!(v.accessKeyId || v.secretAccessKey || v.clearKeys), region: v.region || null, snsTopicForgotten: !!v.forgetSnsTopic } });
  return getSettings(ctx);
}

/** Asks SES for the account status with the saved keys. */
async function testConnection(ctx) {
  const cfg = await sesConfig(ws(ctx));
  if (!cfg) throw httpError(400, 'Add the Amazon SES region and access keys first.', 'SES_NOT_CONFIGURED');
  await snsToken(ws(ctx));
  try {
    const account = await ses.getAccount(cfg);
    await run('UPDATE mail_delivery_settings SET ses_last_checked_at = UTC_TIMESTAMP(), ses_last_error = NULL WHERE workspace_id = ?', [ws(ctx)]);
    await audit(ctx, 'mail.ses_tested', { resourceType: 'mail_provider', resourceId: 'ses', metadata: { productionAccess: account.productionAccess, sendingEnabled: account.sendingEnabled } });
    return {
      ok: account.sendingEnabled, account,
      message: !account.sendingEnabled ? 'Amazon SES answered, but sending is paused for this account.'
        : account.productionAccess ? `Connected. Up to ${account.max24HourSend ?? '?'} emails a day, ${account.maxSendRate ?? '?'} per second.`
          : 'Connected, but the account is in the SES sandbox: it can only send to verified addresses. Request production access in the AWS console before sending campaigns.'
    };
  } catch (err) {
    await run('UPDATE mail_delivery_settings SET ses_last_checked_at = UTC_TIMESTAMP(), ses_last_error = ? WHERE workspace_id = ?', [String(err.message).slice(0, 500), ws(ctx)]);
    throw err;
  }
}

module.exports = { sesConfig, campaignProvider, getSettings, saveSettings, testConnection, snsToken };
