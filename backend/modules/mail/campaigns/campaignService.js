const crypto = require('crypto');
const { z } = require('zod');
const { run, get, all } = require('../../../db/database');
const { audit } = require('../../../lib/audit');
const { toDbDateTime } = require('../../../lib/time');
const { unresolvedPlaceholders, TOKEN_RE } = require('../../../lib/mailContent');
const { sanitizeEmailHtml } = require('../../../lib/emailHtml');
const { workerAuthorizationProblem } = require('../../../lib/workerAuthorization');
const zoho = require('../zoho/zohoService');

/**
 * Email campaigns written, approved and managed in Marketech.ai; Zoho Campaigns only delivers them.
 *
 * Marketech.ai: name, subject, sender, HTML content, the Zoho mailing lists to send to (chosen
 * from the connected account; lists and consent are managed in Zoho, no contacts are uploaded),
 * validation, approval, submission status and the delivery report.
 *
 * Zoho (internal, never done by the user): createCampaign makes the delivery object Zoho needs
 * (content imported from a public, expiring content URL), then sendcampaign sends it. Each step is
 * claimed in the database first and never retried automatically after an unclear result.
 */
const ws = ctx => ctx.auth.workspaceId;
const { httpError } = zoho;

const MAX_HTML = 300000; // Zoho's documented content limit (error 3001)
const CONTENT_TTL_MS = 24 * 60 * 60 * 1000;
const REVIEW_WAIT_MS = 10 * 60 * 1000;
const EDITABLE = ['draft', 'approved', 'failed'];
const PUBLIC_DOMAINS = /@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|gmx|yandex|proton|protonmail|mail|zoho|rediffmail)\.[a-z.]+$/i;
// Zoho merge tags such as $[LI:UNSUBSCRIBE]$ are not placeholders.
const ZOHO_TAG_RE = /\$\[[^\]\n]{1,80}\]\$/g;
const UNSUB_TAG_RE = /\$\[LI:(UNSUBSCRIBE|ORG_OPTOUT)\]\$/i;
const KEY_RE = /^[A-Za-z0-9_-]{1,100}$/;
const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const SENT_LIKE = new Set(['sent', 'inprogress', 'scheduled', 'sending']);

const fields = {
  name: z.string().trim().min(1, 'Enter a campaign name.').max(150),
  subject: z.string().trim().max(255).nullable(),
  fromName: z.string().trim().max(100).nullable(),
  fromEmail: z.union([z.literal(''), z.string().trim().email('Enter a valid sender email.').max(255)]).nullable(),
  html: z.string().max(MAX_HTML, `Content is limited to ${MAX_HTML} characters (Zoho's limit).`).nullable(),
  lists: z.array(z.object({ key: z.string().regex(KEY_RE), name: z.string().max(200).optional() }).strict()).max(20),
  topicId: z.union([z.literal(''), z.string().regex(KEY_RE)]).nullable()
};
// templateId: start from a saved template (its HTML is copied into the campaign).
const createSchema = z.object({ ...fields, name: fields.name, templateId: z.union([z.number().int().positive(), z.string().regex(/^\d{1,10}$/)]).nullable() }).partial().required({ name: true }).strict();
const updateSchema = z.object(fields).partial().strict();

const COLUMN = { name: 'name', subject: 'subject', fromName: 'from_name', fromEmail: 'from_email', html: 'html_content', topicId: 'topic_id' };

function parse(v, fallback) { try { return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } }

function present(row, { full = false } = {}) {
  const keys = parse(row.list_keys_json, []);
  const names = parse(row.list_names_json, {});
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    fromName: row.from_name,
    fromEmail: row.from_email,
    ...(full ? { html: row.html_content || '' } : {}),
    lists: keys.map(k => ({ key: k, name: names[k] || null })),
    topicId: row.topic_id,
    status: row.status,
    version: row.version,
    approved: row.approved_version === row.version && ['approved', 'failed', 'submitting', 'submitted', 'needs_review'].includes(row.status),
    approvedAt: row.approved_at,
    submitStage: row.submit_stage,
    zohoPrepared: !!row.zoho_campaign_key && row.zoho_key_version === row.version,
    zohoStatus: row.zoho_status,
    providerCode: row.provider_code,
    providerMessage: row.provider_message,
    report: parse(row.report_json, null),
    submittedAt: row.submitted_at,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function requireRow(ctx, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'Invalid id.', 'VALIDATION_ERROR');
  const row = await get('SELECT * FROM mail_campaigns WHERE id = ? AND workspace_id = ?', [id, ws(ctx)]);
  if (!row) throw httpError(404, 'Campaign not found.', 'NOT_FOUND');
  return row;
}

// ------------------------------------------------------------------ management (Marketech.ai)

async function list(ctx) {
  const rows = await all('SELECT * FROM mail_campaigns WHERE workspace_id = ? ORDER BY id DESC LIMIT 200', [ws(ctx)]);
  return rows.map(r => present(r));
}

async function getOne(ctx, id) {
  return present(await requireRow(ctx, id), { full: true });
}

function columnsFrom(v) {
  const sets = [];
  const params = [];
  for (const [k, col] of Object.entries(COLUMN)) {
    if (v[k] === undefined) continue;
    // Campaign HTML is served publicly to Zoho and recipients: sanitized on every save.
    const val = k === 'html' && v[k] ? sanitizeEmailHtml(v[k]) : v[k];
    sets.push(`${col} = ?`);
    params.push(val === '' ? null : val);
  }
  if (v.lists !== undefined) {
    sets.push('list_keys_json = ?', 'list_names_json = ?');
    params.push(JSON.stringify([...new Set(v.lists.map(l => l.key))]), JSON.stringify(Object.fromEntries(v.lists.map(l => [l.key, l.name || null]))));
  }
  return { sets, params };
}

async function create(ctx, input) {
  const v = createSchema.parse(input || {});
  if (v.templateId) {
    const { html } = await require('../templates/templateService').htmlForUse(ws(ctx), v.templateId);
    if (v.html === undefined) v.html = html;
  }
  delete v.templateId;
  const { sets, params } = columnsFrom(v);
  const cols = sets.map(s => s.split(' = ')[0]);
  const ins = await run(
    `INSERT INTO mail_campaigns (workspace_id, ${cols.join(', ')}, status, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ${cols.map(() => '?').join(', ')}, 'draft', 1, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [ws(ctx), ...params, ctx.auth.userId, ctx.auth.userId]
  );
  await audit(ctx, 'mail.campaign_created', { resourceType: 'mail_campaign', resourceId: ins.lastID });
  return getOne(ctx, ins.lastID);
}

/** Any edit returns the campaign to draft (new version, approval cleared). */
async function update(ctx, id, input) {
  const row = await requireRow(ctx, id);
  if (!EDITABLE.includes(row.status)) throw httpError(409, `A ${row.status.replace('_', ' ')} campaign cannot be edited.`, 'NOT_EDITABLE');
  const v = updateSchema.parse(input || {});
  const { sets, params } = columnsFrom(v);
  if (!sets.length) throw httpError(400, 'Nothing to update.', 'VALIDATION_ERROR');
  const r = await run(
    `UPDATE mail_campaigns SET ${sets.join(', ')}, status = 'draft', version = version + 1, approved_version = NULL, approved_by = NULL, approved_at = NULL,
       content_token_hash = NULL, content_token_expires_at = NULL, provider_code = NULL, provider_message = NULL, updated_by = ?, updated_at = UTC_TIMESTAMP()
     WHERE id = ? AND workspace_id = ? AND status IN ('draft', 'approved', 'failed')`,
    [...params, ctx.auth.userId, row.id, ws(ctx)]
  );
  if (!r.changes) throw httpError(409, 'The campaign changed meanwhile. Reload and try again.', 'CONFLICT');
  await audit(ctx, 'mail.campaign_updated', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { fields: Object.keys(v) } });
  return getOne(ctx, row.id);
}

async function remove(ctx, id) {
  const row = await requireRow(ctx, id);
  if (!EDITABLE.includes(row.status)) throw httpError(409, 'A campaign that was submitted to Zoho, or whose submission is unclear, cannot be deleted.', 'NOT_EDITABLE');
  await run("DELETE FROM mail_campaigns WHERE id = ? AND workspace_id = ? AND status IN ('draft', 'approved', 'failed')", [row.id, ws(ctx)]);
  await audit(ctx, 'mail.campaign_deleted', { resourceType: 'mail_campaign', resourceId: row.id });
  return { deleted: true };
}

/** Mailing lists and topics of the connected Zoho account, to choose recipients from. */
async function zohoAudiences(ctx) {
  await zoho.assertReady(ws(ctx));
  const lists = await fetchLists(ws(ctx));
  let topics = [];
  try {
    const t = await zoho.readCall(ws(ctx), 'topics', { details: JSON.stringify({ from_index: 0, range: 100 }) });
    topics = (t.topicDetails || []).map(x => ({ id: String(x.topicId), name: x.topicName || null }));
  } catch (err) {
    if (err.code === 'ZOHO_REAUTH_REQUIRED' || err.code === 'ZOHO_UNAUTHORIZED') throw err;
    topics = []; // topics are optional (only for accounts with topic management)
  }
  return { lists, topics, note: 'Lists, their contacts and consent are managed in Zoho Campaigns. Marketech.ai does not upload or change contacts.' };
}

async function fetchLists(workspaceId) {
  try {
    const d = await zoho.readCall(workspaceId, 'getmailinglists', { sort: 'asc', fromindex: '1', range: '100' });
    return (d.list_of_details || []).map(l => ({ key: String(l.listkey), name: l.listname || null, contacts: l.noofcontacts != null ? Number(l.noofcontacts) : null }));
  } catch (err) {
    if (['2203', '995'].includes(err.providerCode)) return [];
    throw err;
  }
}

function publicBaseUrl() {
  const base = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  return /^https:\/\//i.test(base) && !/localhost|127\.0\.0\.1|\.local\b|\.internal\b/i.test(base) ? base : null;
}

/**
 * Problems block approval and sending; warnings are shown. Lists are checked against Zoho when
 * the workspace is connected.
 */
async function validateRow(ctx, row, { checkZoho = true } = {}) {
  const problems = [];
  const warnings = [];
  const html = row.html_content || '';
  if (!String(row.subject || '').trim()) problems.push('Add a subject.');
  if (!row.from_email) problems.push('Add the sender email (an address verified in Zoho Campaigns).');
  else if (PUBLIC_DOMAINS.test(row.from_email)) problems.push('Zoho does not send from public mailbox domains (Gmail, Yahoo, Outlook...). Use an address on your own domain.');
  if (!html.trim()) problems.push('Add the email content.');
  if (html.length > MAX_HTML) problems.push(`Content exceeds ${MAX_HTML} characters.`);
  const placeholders = unresolvedPlaceholders({ subject: String(row.subject || '').replace(ZOHO_TAG_RE, ''), html: html.replace(ZOHO_TAG_RE, '') });
  const tokens = placeholders.filter(p => new RegExp(`^${TOKEN_RE.source}$`).test(p));
  const brackets = placeholders.filter(p => !tokens.includes(p));
  if (brackets.length) problems.push(`Replace the placeholders: ${brackets.join(', ')}.`);
  if (tokens.length) problems.push(`Personalization tokens are not filled for Zoho delivery yet: ${tokens.join(', ')}. Replace them with text (or use Zoho merge tags such as $[LI:UNSUBSCRIBE]$).`);
  const keys = parse(row.list_keys_json, []);
  if (!keys.length) problems.push('Choose at least one Zoho mailing list.');
  if (html && !UNSUB_TAG_RE.test(html)) warnings.push('No unsubscribe link: add $[LI:UNSUBSCRIBE]$ (or $[LI:ORG_OPTOUT]$). Without it Zoho adds its default footer or holds the campaign.');
  if (/<img[^>]+src=["'](?!https:\/\/|data:)/i.test(html)) warnings.push('Some images do not use https:// URLs; they may not show in Zoho.');
  if (!publicBaseUrl()) problems.push('The server needs a public https APP_BASE_URL: Zoho imports the content from a Marketech.ai link.');
  warnings.push('Sending limits depend on your Zoho plan and policies; Marketech.ai cannot read them. The sender address must be verified in Zoho.');

  if (checkZoho) {
    try {
      await zoho.assertReady(ws(ctx));
      const available = new Set((await fetchLists(ws(ctx))).map(l => l.key));
      const missing = keys.filter(k => !available.has(k));
      if (missing.length) problems.push(`These lists no longer exist in Zoho: ${missing.join(', ')}.`);
    } catch (err) {
      problems.push(err.message);
    }
  }
  return { ready: problems.length === 0, problems, warnings };
}

async function validate(ctx, id) {
  return validateRow(ctx, await requireRow(ctx, id));
}

async function approve(ctx, id) {
  const row = await requireRow(ctx, id);
  if (row.status !== 'draft') throw httpError(409, row.status === 'approved' ? 'This version is already approved.' : `A ${row.status.replace('_', ' ')} campaign cannot be approved.`, 'NOT_APPROVABLE');
  const v = await validateRow(ctx, row);
  if (!v.ready) throw Object.assign(httpError(400, v.problems.join(' '), 'NOT_READY'), { details: v });
  const r = await run(
    "UPDATE mail_campaigns SET status = 'approved', approved_version = version, approved_by = ?, approved_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ? AND status = 'draft' AND version = ?",
    [ctx.auth.userId, row.id, ws(ctx), row.version]
  );
  if (!r.changes) throw httpError(409, 'The campaign changed meanwhile. Reload and try again.', 'CONFLICT');
  await audit(ctx, 'mail.campaign_approved', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { version: row.version } });
  return getOne(ctx, row.id);
}

// ------------------------------------------------------------------ delivery (Zoho, internal)

const marker = row => `(Marketech #${row.id} v${row.version})`;

async function setState(id, st, extra = {}) {
  const sets = ['status = ?', 'updated_at = UTC_TIMESTAMP()'];
  const params = [st];
  for (const [col, val] of Object.entries(extra)) { sets.push(`${col} = ?`); params.push(val); }
  await run(`UPDATE mail_campaigns SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
}

/**
 * Sends an approved campaign through Zoho. Claimed first (approved/failed -> submitting), so it
 * runs once. Step 1 creates the Zoho delivery object unless this version already has one; step 2
 * sends it. A clear Zoho rejection leaves it "failed" (fix and send again, reusing the Zoho object
 * if it exists); an unclear result leaves it "needs_review" until Zoho shows what happened.
 */
async function send(ctx, id, { confirm } = {}) {
  if (confirm !== true) throw httpError(400, 'Explicit confirmation (confirm: true) is required to send a campaign.', 'CONFIRMATION_REQUIRED');
  const row = await requireRow(ctx, id);
  if (!['approved', 'failed'].includes(row.status) || row.approved_version !== row.version) {
    const msg = { submitting: 'This campaign is being submitted right now.', submitted: 'This campaign was already submitted to Zoho.', needs_review: 'The last submission has an unknown outcome. Check its status first.' }[row.status] || 'Approve the campaign before sending it.';
    throw httpError(409, msg, row.status === 'submitted' ? 'ALREADY_SUBMITTED' : row.status === 'needs_review' ? 'NEEDS_REVIEW' : row.status === 'submitting' ? 'SUBMIT_IN_PROGRESS' : 'NOT_APPROVED');
  }
  // The approval must still be backed by an active member allowed to send, in an active workspace.
  const authProblem = await workerAuthorizationProblem(ws(ctx), row.approved_by, 'mail.send');
  if (authProblem) throw httpError(409, `${authProblem.message} Approve the campaign again.`, authProblem.code);
  const v = await validateRow(ctx, row);
  if (!v.ready) throw Object.assign(httpError(400, v.problems.join(' '), 'NOT_READY'), { details: v });

  const claim = await run(
    "UPDATE mail_campaigns SET status = 'submitting', submitted_by = ?, provider_code = NULL, provider_message = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ? AND status IN ('approved', 'failed') AND approved_version = version AND version = ?",
    [ctx.auth.userId, row.id, ws(ctx), row.version]
  );
  if (!claim.changes) throw httpError(409, 'This campaign is being submitted right now.', 'SUBMIT_IN_PROGRESS');
  await audit(ctx, 'mail.campaign_submit_started', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { version: row.version } });

  // Step 1: the Zoho delivery object for this version (created at most once).
  let key = row.zoho_key_version === row.version ? row.zoho_campaign_key : null;
  if (!key) {
    const token = crypto.randomBytes(32).toString('base64url');
    await setState(row.id, 'submitting', {
      submit_stage: 'create',
      content_token_hash: crypto.createHash('sha256').update(token).digest('hex'),
      content_token_expires_at: toDbDateTime(new Date(Date.now() + CONTENT_TTL_MS))
    });
    const keys = parse(row.list_keys_json, []);
    try {
      const res = await zoho.writeCall(ws(ctx), 'createCampaign', {
        campaignname: `${String(row.name).slice(0, 100)} ${marker(row)}`,
        from_email: row.from_email,
        ...(row.from_name ? { from_name: row.from_name } : {}),
        subject: row.subject,
        content_url: `${publicBaseUrl()}/api/v1/mail/campaigns/content/${token}`,
        list_details: JSON.stringify(Object.fromEntries(keys.map(k => [k, []]))),
        ...(row.topic_id ? { topicId: row.topic_id } : {})
      });
      key = String(res.campaignKey || res.campaign_key || '');
      if (!KEY_RE.test(key)) throw Object.assign(new Error('Zoho did not return a campaign key.'), { outcomeUnknown: true, code: 'ZOHO_BAD_RESPONSE' });
      try {
        await setState(row.id, 'submitting', { submit_stage: 'send', zoho_campaign_key: key, zoho_key_version: row.version });
      } catch (dbErr) {
        // Zoho created the object but it could not be recorded: settle it by checking, never by recreating.
        throw Object.assign(new Error(`Zoho prepared the campaign (key ${key}) but it could not be recorded.`), { outcomeUnknown: true, code: 'ZOHO_KEY_NOT_RECORDED' });
      }
      await audit(ctx, 'mail.campaign_zoho_prepared', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { zohoCampaignKey: key } });
    } catch (err) {
      return fail(ctx, row, 'create', err);
    }
  }

  // Step 2: send.
  await setState(row.id, 'submitting', { submit_stage: 'send' });
  try {
    const res = await zoho.writeCall(ws(ctx), 'sendcampaign', { campaignkey: key });
    await setState(row.id, 'submitted', { submit_stage: null, zoho_status: res.campaign_status || null, provider_code: res.code != null ? String(res.code) : null, provider_message: res.message ? String(res.message).slice(0, 500) : null, submitted_at: toDbDateTime(new Date()) });
    await audit(ctx, 'mail.campaign_submitted', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { zohoCampaignKey: key, zohoStatus: res.campaign_status || null } });
  } catch (err) {
    if (err.providerCode === '6600') {
      await setState(row.id, 'submitted', { submit_stage: null, zoho_status: 'Sent', provider_code: '6600', provider_message: 'Zoho reports the campaign was already sent.', submitted_at: toDbDateTime(new Date()) });
      await audit(ctx, 'mail.campaign_already_sent', { resourceType: 'mail_campaign', resourceId: row.id });
      throw httpError(409, 'Zoho reports that this campaign was already sent.', 'ALREADY_SENT');
    }
    return fail(ctx, row, 'send', err);
  }
  return getOne(ctx, row.id);
}

async function fail(ctx, row, stage, err) {
  const unknown = !!err.outcomeUnknown;
  await setState(row.id, unknown ? 'needs_review' : 'failed', {
    submit_stage: stage,
    provider_code: String(err.providerCode || err.code || 'ERROR').slice(0, 20),
    provider_message: String(err.message || '').slice(0, 500)
  });
  await audit(ctx, unknown ? 'mail.campaign_submit_unknown' : 'mail.campaign_submit_failed', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { stage, code: err.providerCode || err.code || null } });
  throw err;
}

const REPORT_FIELDS = ['emails_sent_count', 'delivered_count', 'delivered_percent', 'opens_count', 'open_percent', 'unique_clicks_count', 'bounces_count', 'hardbounce_count', 'softbounce_count', 'unsub_count', 'spams_count', 'complaints_count', 'unsent_count'];
const first = v => (Array.isArray(v) ? v[0] || null : v || null);

/** Finds the Zoho object created for this version by its unique name marker. */
async function findCreated(ctx, row) {
  const d = await zoho.readCall(ws(ctx), 'recentcampaigns', { status: 'all', fromindex: '1', range: '100', sort: 'desc' }).catch(err => {
    if (err.providerCode === '6101') return {};
    throw err;
  });
  const listOf = Object.values(d || {}).find(v => Array.isArray(v) && v.some(x => x && 'campaign_key' in x)) || [];
  const hit = listOf.find(c => String(c.campaign_name || '').includes(marker(row)));
  return hit ? { key: String(hit.campaign_key), status: hit.campaign_status || null } : null;
}

/**
 * Pulls Zoho's status and report. An unclear submission is settled when Zoho shows the outcome:
 * a found delivery object becomes "prepared" (send again reuses it); a sent/in-progress campaign
 * becomes "submitted".
 */
async function refresh(ctx, id) {
  const row = await requireRow(ctx, id);
  if (row.status === 'needs_review' && row.submit_stage === 'create' && !row.zoho_campaign_key) {
    const hit = await findCreated(ctx, row);
    if (hit) {
      await run("UPDATE mail_campaigns SET zoho_campaign_key = ?, zoho_key_version = ?, zoho_status = ?, status = 'failed', submit_stage = 'send', provider_message = 'Prepared in Zoho but not sent. Send again to send it.', last_checked_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'needs_review'",
        [hit.key, row.version, hit.status, row.id]);
      await audit(ctx, 'mail.campaign_reconciled', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { stage: 'create', found: true } });
    }
    return getOne(ctx, row.id);
  }
  if (!row.zoho_campaign_key) return getOne(ctx, row.id);
  const d = await zoho.readCall(ws(ctx), 'getcampaigndetails', { campaignkey: row.zoho_campaign_key, campaigntype: 'normal' });
  const report = first(d['campaign-reports']);
  const picked = report ? Object.fromEntries(REPORT_FIELDS.filter(f => report[f] !== undefined).map(f => [f, report[f]])) : null;
  await run('UPDATE mail_campaigns SET zoho_status = ?, report_json = ?, last_checked_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ?',
    [d.campaign_status || null, picked ? JSON.stringify(picked) : null, row.id]);
  if (row.status === 'needs_review' && SENT_LIKE.has(norm(d.campaign_status))) {
    await run("UPDATE mail_campaigns SET status = 'submitted', submit_stage = NULL, submitted_at = COALESCE(submitted_at, UTC_TIMESTAMP()) WHERE id = ? AND status = 'needs_review'", [row.id]);
    await audit(ctx, 'mail.campaign_reconciled', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { stage: row.submit_stage, zohoStatus: d.campaign_status } });
  }
  return getOne(ctx, row.id);
}

/**
 * After checking Zoho: an unclear submission may be marked "not done" (so it can be sent again)
 * only after a wait, and only if Zoho still shows no sent campaign / no delivery object.
 */
async function resolve(ctx, id, { confirm } = {}) {
  if (confirm !== true) throw httpError(400, 'Explicit confirmation (confirm: true) is required.', 'CONFIRMATION_REQUIRED');
  const row = await requireRow(ctx, id);
  if (row.status !== 'needs_review') throw httpError(409, 'Only a submission with an unknown outcome can be resolved.', 'NOT_NEEDS_REVIEW');
  if (Date.now() - new Date(row.updated_at).getTime() < REVIEW_WAIT_MS) throw httpError(409, 'Wait at least 10 minutes after the request, then check again.', 'TOO_EARLY');
  if (row.submit_stage === 'create' && !row.zoho_campaign_key) {
    const hit = await findCreated(ctx, row);
    if (hit) { await refresh(ctx, id); throw httpError(409, 'Zoho has the campaign; it was prepared. Send again to send it.', 'ALREADY_PREPARED'); }
    await run("UPDATE mail_campaigns SET status = 'failed', provider_message = 'Not prepared in Zoho (checked).', updated_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'needs_review'", [row.id]);
  } else {
    const d = await zoho.readCall(ws(ctx), 'getcampaigndetails', { campaignkey: row.zoho_campaign_key, campaigntype: 'normal' });
    if (SENT_LIKE.has(norm(d.campaign_status))) { await refresh(ctx, id); throw httpError(409, `Zoho shows the campaign as "${d.campaign_status}", so it was submitted.`, 'ALREADY_SUBMITTED'); }
    await run("UPDATE mail_campaigns SET status = 'failed', zoho_status = ?, provider_message = 'Not sent by Zoho (checked).', updated_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'needs_review'", [d.campaign_status || null, row.id]);
  }
  await audit(ctx, 'mail.campaign_resolved', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { stage: row.submit_stage } });
  return getOne(ctx, row.id);
}

/** Public content URL Zoho imports the HTML from: token-bound, expiring, approved version only. */
async function contentByToken(token) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(token || ''))) return null;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const row = await get(
    "SELECT html_content FROM mail_campaigns WHERE content_token_hash = ? AND content_token_expires_at > UTC_TIMESTAMP() AND approved_version = version AND status IN ('submitting', 'submitted', 'needs_review', 'failed')",
    [hash]
  );
  return row ? row.html_content : null;
}

module.exports = { list, getOne, create, update, remove, zohoAudiences, validate, approve, send, refresh, resolve, contentByToken };
