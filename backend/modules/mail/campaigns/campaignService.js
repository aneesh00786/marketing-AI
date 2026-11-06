const crypto = require('crypto');
const { z } = require('zod');
const { run, get, all } = require('../../../db/database');
const { audit } = require('../../../lib/audit');
const { unresolvedPlaceholders, TOKEN_RE } = require('../../../lib/mailContent');
const { sanitizeEmailHtml } = require('../../../lib/emailHtml');
const { workerAuthorizationProblem } = require('../../../lib/workerAuthorization');
const contactsSvc = require('./campaignContacts');
const sesSettings = require('../ses/sesSettings');
const sesCampaigns = () => require('../ses/sesCampaigns');

/**
 * Email campaigns written, approved and sent in Marketech.ai, delivered with Amazon SES.
 *
 * A campaign has a name, subject, sender, HTML content and its recipients: contact lists kept in
 * Marketech.ai and leads chosen one by one. It is validated, approved by someone who may send, then
 * sent: Marketech.ai emails each person itself (ses/sesCampaigns.js), with their own unsubscribe link
 * and open/click tracking; SES reports delivered, bounces and complaints (ses/snsWebhook.js).
 *
 * Personalization: the Merge Tags menu writes $[FNAME|there]$ / $[LNAME|]$ (a tag with its default
 * value); {{first_name}} / {{last_name}} from older campaigns work too. Each is filled per person.
 */
const PERSONAL_TOKEN_RE = /\{\{\s*(first_name|last_name)\s*\}\}/gi;
const usesNames = (...parts) => parts.some(p => new RegExp(PERSONAL_TOKEN_RE.source, 'i').test(String(p || '')) || /\$\[(FNAME|LNAME)\b/i.test(String(p || '')));

const ws = ctx => ctx.auth.workspaceId;
const httpError = (status, message, code) => Object.assign(new Error(message), { status, code, expose: true });

const MAX_HTML = 300000;
const EDITABLE = ['draft', 'approved', 'failed'];
const PUBLIC_DOMAINS = /@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|gmx|yandex|proton|protonmail|mail|zoho|rediffmail)\.[a-z.]+$/i;
// Merge tags such as $[FNAME|there]$ and $[LI:UNSUBSCRIBE]$ are not placeholders.
const MERGE_TAG_RE = /\$\[[^\]\n]{1,80}\]\$/g;
const UNSUB_TAG_RE = /\$\[LI:(UNSUBSCRIBE|ORG_OPTOUT)\]\$/i;

const fields = {
  name: z.string().trim().min(1, 'Enter a campaign name.').max(150),
  subject: z.string().trim().max(255).nullable(),
  fromName: z.string().trim().max(100).nullable(),
  fromEmail: z.union([z.literal(''), z.string().trim().email('Enter a valid sender email.').max(255)]).nullable(),
  html: z.string().max(MAX_HTML, `Content is limited to ${MAX_HTML} characters.`).nullable(),
  // Contact lists kept in Marketech.ai.
  mailListIds: z.array(z.number().int().positive()).max(20)
};
// templateId: start from a saved template (its HTML is copied into the campaign).
const createSchema = z.object({ ...fields, name: fields.name, templateId: z.union([z.number().int().positive(), z.string().regex(/^\d{1,10}$/)]).nullable() }).partial().required({ name: true }).strict();
const updateSchema = z.object(fields).partial().strict();

const COLUMN = { name: 'name', subject: 'subject', fromName: 'from_name', fromEmail: 'from_email', html: 'html_content' };

function parse(v, fallback) { try { return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } }

function present(row, { full = false } = {}) {
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    fromName: row.from_name,
    fromEmail: row.from_email,
    ...(full ? { html: row.html_content || '' } : {}),
    mailListIds: parse(row.mail_list_ids_json, []),
    // While sending: how many of the recipients have been handled.
    upload: row.upload_total != null ? { total: row.upload_total, done: row.upload_done || 0 } : null,
    status: row.status,
    version: row.version,
    approved: row.approved_version === row.version && ['approved', 'failed', 'submitting', 'submitted'].includes(row.status),
    approvedAt: row.approved_at,
    submitStage: row.submit_stage,
    provider: row.provider || null,
    sendStatus: row.zoho_status || null,
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

// ------------------------------------------------------------------ management

/** Characters of HTML per list thumbnail (the top of the email only). */
const THUMB_CHARS = 40000;

/** opts.thumbs: also return the start of each campaign's HTML for the list thumbnails (capped). */
async function list(ctx, { thumbs = false } = {}) {
  const rows = await all('SELECT * FROM mail_campaigns WHERE workspace_id = ? ORDER BY id DESC LIMIT 200', [ws(ctx)]);
  return rows.map(r => ({ ...present(r), ...(thumbs ? { thumbHtml: String(r.html_content || '').slice(0, THUMB_CHARS) } : {}) }));
}

async function getOne(ctx, id) {
  const row = await requireRow(ctx, id);
  const { n } = await get('SELECT COUNT(*) AS n FROM mail_campaign_contacts WHERE workspace_id = ? AND campaign_id = ?', [ws(ctx), row.id]);
  return { ...present(row, { full: true }), contactCount: Number(n), mailLists: await mailListsOf(ws(ctx), parse(row.mail_list_ids_json, [])) };
}

/**
 * The chosen contact lists with their counts: everyone who may get the campaign (subscribed, not on
 * the stop-list, with marketing consent) and how many are left out for lack of consent.
 */
const ELIGIBLE_SQL = require('../contacts/consent').eligibleSql('c');
async function mailListsOf(workspaceId, ids) {
  if (!ids.length) return [];
  const rows = await all(
    `SELECT l.id, l.name,
       COUNT(DISTINCT CASE WHEN m.status = 'subscribed' AND s.email IS NULL AND ${ELIGIBLE_SQL} THEN c.id END) AS reachable,
       COUNT(DISTINCT CASE WHEN m.status = 'subscribed' AND s.email IS NULL AND NOT ${ELIGIBLE_SQL} THEN c.id END) AS no_consent
     FROM mail_lists l
     LEFT JOIN mail_list_members m ON m.list_id = l.id
     LEFT JOIN mail_contacts c ON c.id = m.contact_id
     LEFT JOIN email_suppressions s ON s.workspace_id = l.workspace_id AND s.email = c.email
     WHERE l.workspace_id = ? AND l.id IN (${ids.map(() => '?').join(',')})
     GROUP BY l.id`, [workspaceId, ...ids]);
  const byId = new Map(rows.map(r => [r.id, r]));
  return ids.map(id => byId.get(id)).filter(Boolean).map(r => ({ id: r.id, name: r.name, reachable: Number(r.reachable) || 0, noConsent: Number(r.no_consent) || 0 }));
}

/** Refuses list ids from another workspace (or deleted lists). */
async function checkMailLists(ctx, ids) {
  if (!ids || !ids.length) return;
  const found = await all(`SELECT id FROM mail_lists WHERE workspace_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [ws(ctx), ...ids]);
  if (found.length !== new Set(ids).size) throw httpError(400, 'Some chosen lists no longer exist. Choose them again.', 'VALIDATION_ERROR');
}

function columnsFrom(v) {
  const sets = [];
  const params = [];
  for (const [k, col] of Object.entries(COLUMN)) {
    if (v[k] === undefined) continue;
    // Campaign HTML is shown to recipients: sanitized on every save.
    const val = k === 'html' && v[k] ? sanitizeEmailHtml(v[k]) : v[k];
    sets.push(`${col} = ?`);
    params.push(val === '' ? null : val);
  }
  if (v.mailListIds !== undefined) {
    sets.push('mail_list_ids_json = ?');
    params.push(JSON.stringify([...new Set(v.mailListIds)]));
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
  await checkMailLists(ctx, v.mailListIds);
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

async function editableRow(ctx, id) {
  const row = await requireRow(ctx, id);
  if (!EDITABLE.includes(row.status)) throw httpError(409, `A ${row.status.replace('_', ' ')} campaign cannot be edited.`, 'NOT_EDITABLE');
  // Once some people got it, it is not changed: the rest must get the same email (Send again continues).
  if (row.status === 'failed' && row.provider === 'ses' && await get("SELECT 1 AS x FROM mail_campaign_recipients WHERE campaign_id = ? AND version = ? AND status IN ('sent', 'unknown') LIMIT 1", [row.id, row.version])) {
    throw httpError(409, 'This campaign was already sent to some people, so it cannot be changed. Send again to continue, or duplicate it.', 'NOT_EDITABLE');
  }
  return row;
}

/** Any edit returns the campaign to draft (new version, approval cleared). */
async function resetToDraft(ctx, row, sets = [], params = []) {
  const r = await run(
    `UPDATE mail_campaigns SET ${[...sets, ''].join(', ')}status = 'draft', version = version + 1, approved_version = NULL, approved_by = NULL, approved_at = NULL,
       provider_code = NULL, provider_message = NULL, updated_by = ?, updated_at = UTC_TIMESTAMP()
     WHERE id = ? AND workspace_id = ? AND status IN ('draft', 'approved', 'failed')`,
    [...params, ctx.auth.userId, row.id, ws(ctx)]
  );
  if (!r.changes) throw httpError(409, 'The campaign changed meanwhile. Reload and try again.', 'CONFLICT');
}

async function update(ctx, id, input) {
  const row = await editableRow(ctx, id);
  const v = updateSchema.parse(input || {});
  await checkMailLists(ctx, v.mailListIds);
  const { sets, params } = columnsFrom(v);
  if (!sets.length) throw httpError(400, 'Nothing to update.', 'VALIDATION_ERROR');
  await resetToDraft(ctx, row, sets, params);
  await audit(ctx, 'mail.campaign_updated', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { fields: Object.keys(v) } });
  return getOne(ctx, row.id);
}

/**
 * A sent campaign stays as it was; to send it again, it is copied. The copy is a new draft with its
 * own version history: no approval, recipients' results or report come with it.
 */
async function duplicate(ctx, id) {
  const row = await requireRow(ctx, id);
  const ins = await run(
    `INSERT INTO mail_campaigns (workspace_id, name, subject, from_name, from_email, html_content, mail_list_ids_json, status, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [ws(ctx), `${String(row.name).slice(0, 143)} (copy)`, row.subject, row.from_name, row.from_email, row.html_content, row.mail_list_ids_json, ctx.auth.userId, ctx.auth.userId]
  );
  const contacts = await contactsSvc.copySelection(ws(ctx), row.id, ins.lastID);
  await audit(ctx, 'mail.campaign_duplicated', { resourceType: 'mail_campaign', resourceId: ins.lastID, metadata: { from: row.id, ...contacts } });
  return { campaign: await getOne(ctx, ins.lastID), contactsDropped: contacts.dropped };
}

/**
 * Deletes a campaign. Drafts, approved and failed ones: anyone who composes. Sent ones: only those
 * who send (it removes the history here; unsubscribes and bounces stay in the stop-list). A campaign
 * being sent right now cannot be deleted.
 */
async function remove(ctx, id) {
  const row = await requireRow(ctx, id);
  // needs_review: an old campaign from the Zoho days whose outcome was never settled; deleted like a sent one.
  const sent = row.status === 'submitted' || row.status === 'needs_review';
  if (!EDITABLE.includes(row.status) && !sent) throw httpError(409, 'A campaign that is being sent cannot be deleted. Wait until it finishes.', 'NOT_DELETABLE');
  if (sent && !ctx.auth.capabilities.has('mail.send')) throw httpError(403, 'Only people who can send campaigns can delete a sent campaign.', 'FORBIDDEN');
  await run("DELETE FROM mail_campaigns WHERE id = ? AND workspace_id = ? AND status IN ('draft', 'approved', 'failed', 'submitted', 'needs_review')", [row.id, ws(ctx)]);
  await audit(ctx, sent ? 'mail.campaign_deleted_after_send' : 'mail.campaign_deleted', { resourceType: 'mail_campaign', resourceId: row.id });
  return { deleted: true };
}

/** Selected contacts: a change needs a new approval, because the audience is part of what was approved. */
async function getContacts(ctx, id) {
  return contactsSvc.selection(ctx, (await requireRow(ctx, id)).id);
}

async function changeContacts(ctx, id, input, change) {
  const row = await editableRow(ctx, id);
  const result = await change(ctx, row, input, () => resetToDraft(ctx, row));
  return { ...result, campaign: await getOne(ctx, row.id) };
}

const setContactLeads = (ctx, id, input) => changeContacts(ctx, id, input, contactsSvc.setLeads);
const removeContacts = (ctx, id, input) => changeContacts(ctx, id, input, contactsSvc.removeContacts);

/** Leads to choose from, with why each one can or cannot be emailed (marketing: consent required). */
const leadOptions = (ctx, query) => require('../productEmails/service').listRecipients(ctx, query, { maxSelect: contactsSvc.MAX_CONTACTS, maxPageSize: 2000, requireConsent: true });

/** The contact lists a campaign can go to, with their counts. */
async function audiences(ctx) {
  const all_ = await require('../contacts/listService').lists(ctx);
  const mailLists = all_.lists.map(l => ({ id: l.id, name: l.name, reachable: l.reachable, total: l.total, noConsent: l.noConsent || 0 }));
  return { mailLists, note: 'Campaigns are sent with Amazon SES to your contact lists and selected contacts.' };
}

function publicBaseUrl() {
  const base = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  try {
    const u = new URL(base);
    if (u.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && u.hostname === 'localhost')) return null;
    return base;
  } catch (e) {
    return null;
  }
}

/** Problems block approval and sending; warnings are shown. */
async function validateRow(ctx, row, { checkSes = true } = {}) {
  const problems = [];
  const warnings = [];
  const html = row.html_content || '';
  if (!String(row.subject || '').trim()) problems.push('Add a subject.');
  if (!row.from_email) problems.push('Add the sender email (an address or domain verified in Amazon SES).');
  else if (PUBLIC_DOMAINS.test(row.from_email)) problems.push('Use a sender address on your own domain: public mailbox domains (Gmail, Yahoo, Outlook...) fail email authentication when sent through Amazon SES.');
  if (!html.trim()) problems.push('Add the email content.');
  if (html.length > MAX_HTML) problems.push(`Content exceeds ${MAX_HTML} characters.`);
  const placeholders = unresolvedPlaceholders({ subject: String(row.subject || '').replace(MERGE_TAG_RE, ''), html: html.replace(MERGE_TAG_RE, '') });
  const tokens = placeholders.filter(p => new RegExp(`^${TOKEN_RE.source}$`).test(p) && !new RegExp(`^${PERSONAL_TOKEN_RE.source}$`, 'i').test(p));
  const brackets = placeholders.filter(p => !new RegExp(`^${TOKEN_RE.source}$`).test(p));
  if (brackets.length) problems.push(`Replace the placeholders: ${brackets.join(', ')}.`);
  if (tokens.length) problems.push(`These personalization fields cannot be filled: ${tokens.join(', ')}. Only {{first_name}} and {{last_name}} are supported in campaigns; replace the others with text.`);
  const contacts = await contactsSvc.assess(ws(ctx), row.id);
  const eligible = contacts.filter(c => c.eligible).length;
  const listIds = parse(row.mail_list_ids_json, []);
  const mailLists = await mailListsOf(ws(ctx), listIds);
  const listPeople = mailLists.reduce((n, l) => n + l.reachable, 0);
  if (listIds.length && mailLists.length !== listIds.length) problems.push('Some chosen lists were deleted. Choose the lists again (Recipients).');
  const noConsent = mailLists.reduce((n, l) => n + l.noConsent, 0);
  if (!eligible && !listPeople) {
    problems.push(mailLists.length ? (noConsent
      ? `Nobody in the chosen lists can get marketing email: ${noConsent.toLocaleString('en-US')} contact(s) have no recorded marketing consent, and the others are unsubscribed or bounced. Record consent on their leads, or choose other lists.`
      : 'Nobody in the chosen lists can be emailed (all unsubscribed or bounced). Choose other lists.') : contacts.length ? 'None of the selected contacts can be emailed. Choose others or a list.' : 'Choose at least one contact list.');
  }
  if (noConsent && (listPeople || eligible)) warnings.push(`${noConsent.toLocaleString('en-US')} contact(s) in the chosen lists have no recorded marketing consent and are left out of this campaign. Record consent on their leads (how and when it was given) to include them.`);
  if (listPeople) warnings.push(`${listPeople.toLocaleString('en-US')} contact(s) from ${mailLists.map(l => `"${l.name}"`).join(', ')} will be emailed one by one with Amazon SES.`);
  if (eligible) warnings.push(`${eligible} selected contact(s) will be emailed with Amazon SES.`);
  if (usesNames(row.subject, html)) warnings.push('Personalized with merge tags: each person sees their own name, and leads without a contact person see their business name (e.g. "Big Red Packaging team"). Anyone without a name sees the tag\'s default value.');
  if (contacts.length > eligible) warnings.push(`${contacts.length - eligible} selected contact(s) cannot be emailed and will be skipped.`);
  if (html && !UNSUB_TAG_RE.test(html)) problems.push('Add an unsubscribe link: tick "Add unsubscribe link" (Email content). Marketing email must let people unsubscribe.');
  // The email as a recipient gets it: every merge tag must be filled in (nothing like $[...]$ left).
  const hasOrgTag = /\$\[HF:ORGADDRESS\]\$/i.test(html);
  const orgAddress = hasOrgTag ? await sesCampaigns().orgAddressOf(ws(ctx)) : null;
  if (hasOrgTag && !orgAddress) problems.push('Add your business address in Mail Settings → Campaigns: the email uses $[HF:ORGADDRESS]$ (your postal address, which anti-spam laws ask for).');
  const sample = sesCampaigns().renderFor(row, { email: 'someone@example.com', first_name: 'Priya', last_name: 'Nair' },
    { orgAddress: orgAddress || (hasOrgTag ? 'address' : null), unsubscribeUrl: 'https://example.invalid/u', viewUrl: 'https://example.invalid/v' });
  if (sample.unresolved.length) problems.push(`These merge tags cannot be filled in: ${sample.unresolved.slice(0, 5).join(', ')}. Remove them or replace them with text.`);
  if (/href=["']https?:\/\/(www\.)?example\.(com|org|net)\b/i.test(html)) problems.push('Replace the sample link (example.com) with your own web page.');
  if (/<img[^>]+src=["'](?!https:\/\/|data:)/i.test(html)) warnings.push('Some images do not use https:// URLs; they may not show in mail clients.');
  if (!publicBaseUrl()) problems.push('The server needs a public https APP_BASE_URL: unsubscribe links and open/click tracking point to Marketech.ai.');
  warnings.push('Sent with Amazon SES at your account\'s sending rate. The sender address (or its domain) must be verified in Amazon SES, and the account must be out of the SES sandbox to email anyone.');

  // Deliverability: content that looks like spam, the bounce/complaint brake and the warm-up allowance.
  const dl = require('../ses/deliverability');
  for (const i of dl.contentReport({ subject: row.subject, html }).issues) warnings.push(`Deliverability: ${i.message}`);
  const hl = await dl.health(ws(ctx));
  if (hl.stopped) problems.push(hl.message);
  else if (hl.message) warnings.push(hl.message);
  if (row.from_email && (eligible || listPeople)) {
    const w = await dl.warmup(ws(ctx), dl.domainOf(row.from_email));
    const people = eligible + listPeople;
    if (w.cap !== null && people > (w.remaining || 0)) warnings.push(`Warm-up: ${w.domain} is on day ${w.day} of warm-up and may send ${w.cap} emails in 24 hours (${w.remaining} left now). This campaign sends ${w.remaining} now and the rest over the next days, automatically.`);
  }

  const cfg = await sesSettings.sesConfig(ws(ctx)).catch(() => null);
  if (!cfg) problems.push('Amazon SES is not set up: add the region and access keys in Mail Settings → Campaigns.');
  else if (checkSes && row.from_email && !PUBLIC_DOMAINS.test(row.from_email)) {
    try {
      const v = await require('../ses/sesClient').identityVerified(cfg, row.from_email);
      if (!v.verified) problems.push(`${row.from_email} is not verified in Amazon SES. Verify the address or its domain in the SES console, or use a verified sender.`);
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

// ------------------------------------------------------------------ sending (Amazon SES)

/**
 * Sends an approved campaign with Amazon SES. Claimed first (approved/failed → submitting), so it
 * runs once; the worker then emails the recipients (sesCampaigns). A failed send can be sent again:
 * it continues with the people not yet emailed, never emailing anyone twice.
 */
async function send(ctx, id, { confirm } = {}) {
  if (confirm !== true) throw httpError(400, 'Explicit confirmation (confirm: true) is required to send a campaign.', 'CONFIRMATION_REQUIRED');
  const row = await requireRow(ctx, id);
  if (!['approved', 'failed'].includes(row.status) || row.approved_version !== row.version) {
    const msg = { submitting: 'This campaign is being sent right now.', submitted: 'This campaign was already sent.' }[row.status] || 'Approve the campaign before sending it.';
    throw httpError(409, msg, row.status === 'submitted' ? 'ALREADY_SUBMITTED' : row.status === 'submitting' ? 'SUBMIT_IN_PROGRESS' : 'NOT_APPROVED');
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
  if (!claim.changes) throw httpError(409, 'This campaign is being sent right now.', 'SUBMIT_IN_PROGRESS');
  await audit(ctx, 'mail.campaign_submit_started', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { version: row.version } });
  try {
    await sesCampaigns().start(ctx, { ...row, submitted_by: ctx.auth.userId });
  } catch (err) {
    await run('UPDATE mail_campaigns SET status = ?, provider_code = ?, provider_message = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?',
      ['failed', String(err.code || 'ERROR').slice(0, 20), String(err.message || '').slice(0, 500), row.id]);
    await audit(ctx, 'mail.campaign_submit_failed', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { code: err.code || null } });
    throw err;
  }
  return getOne(ctx, row.id);
}

/** Figures from Marketech.ai's own records (SES events arrive through SNS); a waiting part is started. */
/** Whether each link in the campaign email works (on request; SSRF-safe). */
async function checkLinks(ctx, id) {
  const row = await requireRow(ctx, id);
  const links = await require('../ses/deliverability').checkLinks(row.html_content || '');
  return { links, broken: links.filter(l => !l.ok).length };
}

async function refresh(ctx, id) {
  const row = await requireRow(ctx, id);
  if (row.provider !== 'ses') return getOne(ctx, row.id);
  if (row.status === 'submitting') await sesCampaigns().kick(ws(ctx), row.id).catch(() => false);
  const report = await sesCampaigns().report(row);
  await run('UPDATE mail_campaigns SET report_json = ?, last_checked_at = UTC_TIMESTAMP() WHERE id = ?', [JSON.stringify(report), row.id]);
  return getOne(ctx, row.id);
}

// ------------------------------------------------------------------ communication history

/**
 * Everything with one campaign recipient, for "Follow up → History": the emails sent to them and
 * received from them in this workspace (Sent Mail and Inbox), and the calls made to them from this
 * workspace (by email, or by the last 9 digits of their number), with each call's transcript as a
 * conversation when it was transcribed. Read only. For roles with mail.send.
 */
async function recipientHistory(ctx, id, { email, phone } = {}) {
  await requireRow(ctx, id);
  const addr = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) || addr.length > 255) throw httpError(400, 'Give the recipient\'s email address.', 'VALIDATION_ERROR');
  const digits = String(phone || '').replace(/\D/g, '');
  const tail = digits.length >= 7 ? digits.slice(-9) : null;
  const emails = await all(
    `SELECT id, sender, sender_email, recipient_email, recipient_name, subject, body, status, smtp_status, sent_at, received_at
     FROM emails WHERE workspace_id = ? AND (LOWER(TRIM(recipient_email)) = ? OR LOWER(TRIM(sender_email)) = ?)
     ORDER BY COALESCE(received_at, sent_at) DESC, id DESC LIMIT 50`, [ws(ctx), addr, addr]);
  const logs = require('../../calling/callLogService');
  const calls = await all(
    `${logs.SELECT} WHERE l.campaign_id IN (SELECT id FROM mail_campaigns WHERE workspace_id = ?) AND (l.email = ?${tail ? " OR RIGHT(REGEXP_REPLACE(l.phone, '[^0-9]', ''), 9) = ?" : ''})
     ORDER BY l.started_at DESC, l.id DESC LIMIT 50`, tail ? [ws(ctx), addr, tail] : [ws(ctx), addr]);
  await audit(ctx, 'mail.campaign_recipient_history_viewed', { resourceType: 'mail_campaign', resourceId: Number(id), metadata: { emails: emails.length, calls: calls.length } });
  const text = v => String(v || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    emails: emails.map(e => {
      const inbound = String(e.sender_email || '').trim().toLowerCase() === addr;
      return { id: e.id, direction: inbound ? 'received' : 'sent', subject: e.subject || '(no subject)', status: e.status || null,
        at: inbound ? (e.received_at || e.sent_at) : (e.sent_at || e.received_at), preview: text(e.body).slice(0, 600) };
    }),
    // The conversation is the transcript text (empty unless the call was transcribed).
    calls: calls.map(r => ({ ...logs.present(r), campaignId: r.campaign_id || null, conversation: logs.conversation(r) }))
  };
}

// ------------------------------------------------------------------ unsubscribes

/**
 * Each email carries its recipient's own unsubscribe link to Marketech.ai's page for the campaign
 * (signed per campaign). The page asks to confirm (link scanners do not unsubscribe anyone), then adds
 * the address to the stop-list and marks it unsubscribed in every contact list. One-click
 * unsubscribe (List-Unsubscribe-Post) posts to the same address.
 */
const unsubSecret = () => process.env.SOCIAL_TOKEN_ENCRYPTION_KEY || 'marketech-unsubscribe';
const unsubSig = (workspaceId, id) => crypto.createHmac('sha256', unsubSecret()).update(`campaign-unsubscribe:${workspaceId}:${id}`).digest('hex').slice(0, 32);
const unsubToken = row => `${row.id}-${unsubSig(row.workspace_id, row.id)}`;

/** The campaign of an unsubscribe token, and whether the address was one it went to. */
async function unsubscribeTarget(token, email) {
  const m = /^(\d{1,10})-([a-f0-9]{32})$/.exec(String(token || ''));
  const addr = String(email || '').trim().toLowerCase();
  if (!m || !addr || addr.length > 255 || !addr.includes('@')) return null;
  const row = await get('SELECT id, workspace_id FROM mail_campaigns WHERE id = ?', [Number(m[1])]);
  if (!row || !crypto.timingSafeEqual(Buffer.from(unsubSig(row.workspace_id, row.id)), Buffer.from(m[2]))) return null;
  const sentTo = await get('SELECT 1 AS x FROM mail_campaign_recipients WHERE campaign_id = ? AND email = ? LIMIT 1', [row.id, addr]);
  const known = sentTo || await get('SELECT 1 AS x FROM mail_contacts WHERE workspace_id = ? AND email = ? LIMIT 1', [row.workspace_id, addr]);
  if (!known) return null;
  return { workspaceId: row.workspace_id, campaignId: row.id, email: addr };
}

/** The public page's work: confirm (apply=false) or unsubscribe (apply=true). Null: link not valid. */
async function unsubscribeFromCampaign(token, email, { apply }) {
  const t = await unsubscribeTarget(token, email);
  if (!t) return null;
  if (apply) {
    await require('../productEmails/service').applyUnsubscribe(t.workspaceId, { email: t.email, leadId: null, source: 'campaign_link', reference: `campaign:${t.campaignId}` });
    await run(`UPDATE mail_list_members mm JOIN mail_contacts c ON c.id = mm.contact_id SET mm.status = 'unsubscribed'
      WHERE c.workspace_id = ? AND c.email = ?`, [t.workspaceId, t.email]);
  }
  const s = await get('SELECT 1 AS x FROM email_suppressions WHERE workspace_id = ? AND email = ?', [t.workspaceId, t.email]);
  return { unsubscribed: !!s, email: t.email };
}

// ------------------------------------------------------------------ recipients' activity

const PAGE_SIZE = 50;

/** Per-recipient activity (sent, opened, clicked, bounced, …) from Marketech.ai's records. */
async function recipientActivity(ctx, id, { activity, page = 1 } = {}) {
  if (!sesCampaigns().ACTIVITY_SQL[activity]) throw httpError(400, `Unknown activity. Use one of: ${Object.keys(sesCampaigns().ACTIVITY_SQL).join(', ')}.`, 'VALIDATION_ERROR');
  const row = await requireRow(ctx, id);
  const p = Math.max(1, Math.min(1000, parseInt(page, 10) || 1));
  if (row.provider !== 'ses' || !['submitted', 'submitting', 'failed'].includes(row.status)) return { available: false, reason: 'not_sent', recipients: [], page: 1, pageSize: PAGE_SIZE };
  const r = await sesCampaigns().activity(row, activity, p, PAGE_SIZE);
  const recipients = (await withLeadDetails(ws(ctx), r.recipients)).map(x => ({ ...x, name: x.name || x.contactName || null }));
  await audit(ctx, 'mail.campaign_recipients_viewed', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { activity, page: p, count: recipients.length } });
  return { available: true, recipients, page: p, pageSize: PAGE_SIZE, hasMore: r.hasMore };
}

/** Adds the matching lead's details (by email): business, contact person, phone, product and status. */
async function withLeadDetails(workspaceId, contacts) {
  const emails = [...new Set(contacts.map(c => String(c.email || '').trim().toLowerCase()).filter(Boolean))];
  const byEmail = new Map();
  if (emails.length) {
    const rows = await all(
      `SELECT l.id, l.name, l.company_name, l.phone, l.status, l.product_interest, LOWER(TRIM(l.email)) AS email, p.name AS product_name
       FROM leads l LEFT JOIN digital_products p ON p.workspace_id = l.workspace_id AND p.id = l.product_id
       WHERE l.workspace_id = ? AND LOWER(TRIM(l.email)) IN (${emails.map(() => '?').join(',')}) ORDER BY l.id DESC`,
      [workspaceId, ...emails]);
    for (const r of rows) if (!byEmail.has(r.email)) byEmail.set(r.email, r);
  }
  return contacts.map(c => {
    const l = byEmail.get(String(c.email || '').trim().toLowerCase());
    return {
      ...c,
      leadId: l ? l.id : null,
      company: (l && l.company_name) || c.company || null,
      contactName: (l && l.name) || c.name || null,
      phone: (l && l.phone) || c.phone || null,
      product: l ? (l.product_name || l.product_interest || null) : null,
      leadStatus: l ? l.status || null : null
    };
  });
}

module.exports = { checkLinks,
  unsubscribeTokenOf: row => unsubToken(row), recipientHistory, unsubscribeFromCampaign, list, getOne, create, update, duplicate, remove,
  getContacts, setContactLeads, removeContacts, leadOptions, audiences, validate, approve, send, refresh, recipientActivity
};
