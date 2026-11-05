const crypto = require('crypto');
const { z } = require('zod');
const { run, get, all } = require('../../../db/database');
const { audit } = require('../../../lib/audit');
const { toDbDateTime } = require('../../../lib/time');
const { unresolvedPlaceholders, TOKEN_RE } = require('../../../lib/mailContent');

/**
 * Personalization in campaigns works as in Zoho: the Merge Tags menu writes Zoho's own tags with a
 * default value ($[FNAME|there]$; email only, so no social sharing default), which Zoho fills per recipient. Older campaigns written
 * with {{first_name}} / {{last_name}} are converted to those tags when Zoho imports them.
 */
const ZOHO_MERGE = { first_name: '$[FNAME|there]$', last_name: '$[LNAME||]$' };
const PERSONAL_TOKEN_RE = /\{\{\s*(first_name|last_name)\s*\}\}/gi;
const toZohoMergeTags = text => String(text || '').replace(PERSONAL_TOKEN_RE, (m, k) => ZOHO_MERGE[k.toLowerCase()]);
const usesNames = (...parts) => parts.some(p => new RegExp(PERSONAL_TOKEN_RE.source, 'i').test(String(p || '')) || /\$\[(FNAME|LNAME)\b/i.test(String(p || '')));
const { sanitizeEmailHtml } = require('../../../lib/emailHtml');
const { workerAuthorizationProblem } = require('../../../lib/workerAuthorization');
const zoho = require('../zoho/zohoService');
const contactsSvc = require('./campaignContacts');

/**
 * Email campaigns written, approved and managed in Marketech.ai; Zoho Campaigns only delivers them.
 *
 * Marketech.ai: name, subject, sender, HTML content, the recipients (Zoho mailing lists chosen
 * from the connected account, and contacts selected one by one), validation, approval, submission
 * status and the delivery report.
 *
 * Zoho (internal, never done by the user): selected contacts are added to a new list (see
 * campaignContacts.js), createCampaign makes the delivery object Zoho needs (content imported from
 * a public, expiring content URL), then sendcampaign sends it. Each step is claimed in the database
 * first and never retried automatically after an unclear result.
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
const UPLOAD_STALL_MS = 30 * 60 * 1000;
const SENT_LIKE = new Set(['sent', 'inprogress', 'scheduled', 'sending', 'sendingshortly', 'queued']);

const fields = {
  name: z.string().trim().min(1, 'Enter a campaign name.').max(150),
  subject: z.string().trim().max(255).nullable(),
  fromName: z.string().trim().max(100).nullable(),
  fromEmail: z.union([z.literal(''), z.string().trim().email('Enter a valid sender email.').max(255)]).nullable(),
  html: z.string().max(MAX_HTML, `Content is limited to ${MAX_HTML} characters (Zoho's limit).`).nullable(),
  lists: z.array(z.object({ key: z.string().regex(KEY_RE), name: z.string().max(200).optional() }).strict()).max(20),
  // Contact lists kept in Marketech.ai: put into Zoho for the send, removed from Zoho once sent.
  mailListIds: z.array(z.number().int().positive()).max(20),
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
    mailListIds: parse(row.mail_list_ids_json, []),
    upload: row.upload_total != null ? { total: row.upload_total, done: row.upload_done || 0 } : null,
    tempListsRemoved: !!row.temp_lists_deleted_at,
    tempListsPending: !!(row.temp_lists_json || row.contact_list_key) && !row.temp_lists_deleted_at,
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
 * The chosen Marketech.ai lists with their counts: everyone who can be emailed (subscribed, not on
 * the stop-list) and how many of them are not in Zoho yet (they add to the Zoho plan's contacts).
 */
async function mailListsOf(workspaceId, ids) {
  if (!ids.length) return [];
  const rows = await all(
    `SELECT l.id, l.name,
       COUNT(DISTINCT CASE WHEN m.status = 'subscribed' AND s.email IS NULL THEN c.id END) AS reachable,
       COUNT(DISTINCT CASE WHEN m.status = 'subscribed' AND s.email IS NULL AND c.in_zoho = 0 THEN c.id END) AS new_to_zoho
     FROM mail_lists l
     LEFT JOIN mail_list_members m ON m.list_id = l.id
     LEFT JOIN mail_contacts c ON c.id = m.contact_id
     LEFT JOIN email_suppressions s ON s.workspace_id = l.workspace_id AND s.email = c.email
     WHERE l.workspace_id = ? AND l.id IN (${ids.map(() => '?').join(',')})
     GROUP BY l.id`, [workspaceId, ...ids]);
  const byId = new Map(rows.map(r => [r.id, r]));
  return ids.map(id => byId.get(id)).filter(Boolean).map(r => ({ id: r.id, name: r.name, reachable: Number(r.reachable) || 0, newToZoho: Number(r.new_to_zoho) || 0 }));
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
    // Campaign HTML is served publicly to Zoho and recipients: sanitized on every save.
    const val = k === 'html' && v[k] ? sanitizeEmailHtml(v[k]) : v[k];
    sets.push(`${col} = ?`);
    params.push(val === '' ? null : val);
  }
  if (v.mailListIds !== undefined) {
    sets.push('mail_list_ids_json = ?');
    params.push(JSON.stringify([...new Set(v.mailListIds)]));
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
  return row;
}

/** Any edit returns the campaign to draft (new version, approval cleared). */
async function resetToDraft(ctx, row, sets = [], params = []) {
  const r = await run(
    `UPDATE mail_campaigns SET ${[...sets, ''].join(', ')}status = 'draft', version = version + 1, approved_version = NULL, approved_by = NULL, approved_at = NULL,
       content_token_hash = NULL, content_token_expires_at = NULL, provider_code = NULL, provider_message = NULL, updated_by = ?, updated_at = UTC_TIMESTAMP()
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
 * own version history: no approval, Zoho campaign, contact list or results come with it.
 */
async function duplicate(ctx, id) {
  const row = await requireRow(ctx, id);
  const ins = await run(
    `INSERT INTO mail_campaigns (workspace_id, name, subject, from_name, from_email, html_content, list_keys_json, list_names_json, mail_list_ids_json, topic_id, status, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [ws(ctx), `${String(row.name).slice(0, 143)} (copy)`, row.subject, row.from_name, row.from_email, row.html_content, row.list_keys_json, row.list_names_json, row.mail_list_ids_json, row.topic_id, ctx.auth.userId, ctx.auth.userId]
  );
  const contacts = await contactsSvc.copySelection(ws(ctx), row.id, ins.lastID);
  await audit(ctx, 'mail.campaign_duplicated', { resourceType: 'mail_campaign', resourceId: ins.lastID, metadata: { from: row.id, ...contacts } });
  return { campaign: await getOne(ctx, ins.lastID), contactsDropped: contacts.dropped };
}

/**
 * Deletes a campaign from Marketech.ai. Drafts, approved and failed ones: anyone who composes.
 * Sent ones: only those who send (it removes the history here). Zoho keeps its copy and report:
 * this connection cannot delete in Zoho. Before a sent campaign goes, the unsubscribes and bounces
 * of the list it made are saved in the stop-list, so later campaigns still skip those people.
 * A submission still in progress or with an unclear outcome cannot be deleted.
 */
async function remove(ctx, id) {
  const row = await requireRow(ctx, id);
  const sent = row.status === 'submitted';
  if (!EDITABLE.includes(row.status) && !sent) throw httpError(409, 'A campaign being submitted to Zoho, or whose submission is unclear, cannot be deleted. Check its status first.', 'NOT_DELETABLE');
  if (sent && !ctx.auth.capabilities.has('mail.send')) throw httpError(403, 'Only people who can send campaigns can delete a sent campaign.', 'FORBIDDEN');
  if (sent && row.contact_list_key) {
    try {
      await contactsSvc.importOptOutsFrom(ws(ctx), [row.contact_list_key]);
    } catch (err) {
      throw httpError(502, `The campaign was not deleted: its unsubscribes could not be read from Zoho first (${err.message}). Try again later.`, 'OPT_OUTS_UNREADABLE');
    }
  }
  await run("DELETE FROM mail_campaigns WHERE id = ? AND workspace_id = ? AND status IN ('draft', 'approved', 'failed', 'submitted')", [row.id, ws(ctx)]);
  await audit(ctx, sent ? 'mail.campaign_deleted_after_send' : 'mail.campaign_deleted', { resourceType: 'mail_campaign', resourceId: row.id, metadata: sent ? { zohoCampaignKey: row.zoho_campaign_key || null } : undefined });
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
const addContactsFromZoho = (ctx, id, input) => changeContacts(ctx, id, input, contactsSvc.addFromZoho);
const removeContacts = (ctx, id, input) => changeContacts(ctx, id, input, contactsSvc.removeContacts);

/** Leads to choose from, with why each one can or cannot be emailed. */
const leadOptions = (ctx, query) => require('../productEmails/service').listRecipients(ctx, query, { maxSelect: contactsSvc.MAX_CONTACTS, maxPageSize: 2000, requireConsent: false });

/**
 * Topics of the Zoho account. Accounts with topic management must give every campaign a topic
 * (Zoho otherwise answers "Mandatory Fields are not found"); others have none.
 */
async function fetchTopics(workspaceId) {
  try {
    const t = await zoho.readCall(workspaceId, 'topics', { details: JSON.stringify({ from_index: 0, range: 100 }) });
    return (t.topicDetails || []).map(x => ({ id: String(x.topicId), name: x.topicName || null }));
  } catch (err) {
    if (err.code === 'ZOHO_REAUTH_REQUIRED' || err.code === 'ZOHO_UNAUTHORIZED') throw err;
    return []; // no topic management
  }
}

/** The topic this campaign goes out under: its own, or the account's only topic; null when there are none. */
function campaignTopic(row, topics) {
  if (row.topic_id) return row.topic_id;
  return topics.length === 1 ? topics[0].id : null;
}

function topicProblem(row, topics) {
  if (!topics.length) return null;
  if (row.topic_id && !topics.some(t => t.id === String(row.topic_id))) return 'The chosen Zoho topic no longer exists. Choose another topic (Recipients).';
  if (!campaignTopic(row, topics)) return 'Your Zoho account uses topics: choose the topic for this campaign (Recipients).';
  return null;
}

/** Mailing lists and topics of the connected Zoho account, to choose recipients from. */
async function zohoAudiences(ctx) {
  await zoho.assertReady(ws(ctx));
  const lists = (await contactsSvc.fetchLists(ws(ctx))).filter(l => !contactsSvc.isSyncList(l.name));
  const topics = await fetchTopics(ws(ctx));
  const all_ = await require('../contacts/listService').lists(ctx);
  const mailLists = all_.lists.map(l => ({ id: l.id, name: l.name, reachable: l.reachable, total: l.total, inZoho: l.inZoho }));
  return { lists, mailLists, topics, note: 'Lists and consent are managed in Zoho Campaigns. Contacts you select are added to a new Zoho list when the campaign is sent.' };
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
  const tokens = placeholders.filter(p => new RegExp(`^${TOKEN_RE.source}$`).test(p) && !new RegExp(`^${PERSONAL_TOKEN_RE.source}$`, 'i').test(p));
  const brackets = placeholders.filter(p => !new RegExp(`^${TOKEN_RE.source}$`).test(p));
  if (brackets.length) problems.push(`Replace the placeholders: ${brackets.join(', ')}.`);
  if (tokens.length) problems.push(`These personalization fields cannot be filled by Zoho: ${tokens.join(', ')}. Only {{first_name}} and {{last_name}} are supported in campaigns; replace the others with text.`);
  const keys = parse(row.list_keys_json, []);
  const contacts = contactsSvc.notOnLists(await contactsSvc.assess(ws(ctx), row.id), keys);
  const eligible = contacts.filter(c => c.eligible).length;
  const mailLists = await mailListsOf(ws(ctx), parse(row.mail_list_ids_json, []));
  const listPeople = mailLists.reduce((n, l) => n + l.reachable, 0);
  if (parse(row.mail_list_ids_json, []).length && mailLists.length !== parse(row.mail_list_ids_json, []).length) problems.push('Some chosen lists were deleted. Choose the lists again (Recipients).');
  if (!keys.length && !eligible && !listPeople) {
    problems.push(mailLists.length ? 'Nobody in the chosen lists can be emailed (all unsubscribed or bounced). Choose other lists.' : contacts.length ? 'None of the selected contacts can be emailed. Choose others or a list.' : 'Choose at least one contact list.');
  }
  if (listPeople) {
    const fresh = mailLists.reduce((n, l) => n + l.newToZoho, 0);
    warnings.push(`${listPeople.toLocaleString('en-US')} contact(s) from ${mailLists.map(l => `"${l.name}"`).join(', ')} are put into Zoho for this send; the temporary Zoho list is deleted once Zoho reports it sent.`);
    if (fresh) {
      const limit = await require('../zoho/zohoLists').contactLimitOf(ws(ctx));
      warnings.push(`${fresh.toLocaleString('en-US')} of them are not in Zoho yet and will add to your Zoho plan's contact count${limit ? ` (limit ${limit.toLocaleString('en-US')})` : ''}. They stay in Zoho after the send.`);
    }
  }
  if (eligible) warnings.push(`${eligible} selected contact(s) will be added to a new Zoho list when you send.`);
  if (usesNames(row.subject, html)) {
    warnings.push('Personalized with merge tags: each person sees their own name, and leads without a contact person see their business name (e.g. "Big Red Packaging team"). Anyone with no name in Zoho sees the tag\'s default value. Zoho does not fill merge tags in test emails; send to a list named "Test List" to check.');
    if (eligible && checkZoho) {
      const conn = await zoho.connectionRow(ws(ctx)).catch(() => null);
      if (conn && !zoho.canSyncNames(conn)) warnings.push('Reconnect Zoho Campaigns (Settings) to send your leads\' names to Zoho. Until then, selected leads see the default value instead of their name.');
    }
  }
  if (contacts.length > eligible) warnings.push(`${contacts.length - eligible} selected contact(s) cannot be emailed and will be skipped.`);
  if (html && !UNSUB_TAG_RE.test(html)) warnings.push('No unsubscribe link: tick "Add unsubscribe link" (Email content). Without it Zoho adds its default footer or holds the campaign, and unsubscribes are not kept in Marketech.ai.');
  if (/href=["']https?:\/\/(www\.)?example\.(com|org|net)\b/i.test(html)) problems.push('Replace the sample link (example.com) with your own web page.');
  if (/<img[^>]+src=["'](?!https:\/\/|data:)/i.test(html)) warnings.push('Some images do not use https:// URLs; they may not show in Zoho.');
  if (!publicBaseUrl()) problems.push('The server needs a public https APP_BASE_URL: Zoho imports the content from a Marketech.ai link.');
  warnings.push('Sending limits depend on your Zoho plan and policies; Marketech.ai cannot read them. The sender address must be verified in Zoho.');

  if (checkZoho) {
    try {
      await (contacts.length ? zoho.assertContactSync : zoho.assertReady)(ws(ctx));
      const available = new Set((await contactsSvc.fetchLists(ws(ctx))).map(l => l.key));
      const missing = keys.filter(k => !available.has(k));
      if (missing.length) problems.push(`These lists no longer exist in Zoho: ${missing.join(', ')}.`);
      const tp = topicProblem(row, await fetchTopics(ws(ctx)));
      if (tp) problems.push(tp);
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

/**
 * Zoho refuses campaign names with special characters ("CampaignName cannot contain special
 * characters"), so the name and the marker that identifies this version use only letters,
 * numbers, spaces, hyphens and underscores. The marker ends the name, so it is matched at the end.
 */
const marker = row => `Marketech ${row.id}-${row.version}`;
const zohoCampaignName = row => {
  const name = String(row.name || '').normalize('NFKC').replace(/[^\p{L}\p{N} _-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${name || 'Campaign'} - ${marker(row)}`;
};
const isOurCampaign = (name, row) => {
  const n = String(name || '').trim();
  return n.endsWith(` ${marker(row)}`) || n.includes(`(Marketech #${row.id} v${row.version})`);
};

async function setState(id, st, extra = {}) {
  const sets = ['status = ?', 'updated_at = UTC_TIMESTAMP()'];
  const params = [st];
  for (const [col, val] of Object.entries(extra)) { sets.push(`${col} = ?`); params.push(val); }
  await run(`UPDATE mail_campaigns SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
}

/**
 * Sends an approved campaign through Zoho. Claimed first (approved/failed -> submitting), so it
 * runs once. Selected contacts are added to Zoho, then step 1 creates the Zoho delivery object
 * unless this version already has one; step 2 sends it. A clear Zoho rejection leaves it "failed" (fix and send again, reusing the Zoho object
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

  // Marketech.ai lists are put into Zoho first: that takes a while for large lists, so the
  // worker does it (with progress), then delivers. Nothing is emailed before the upload finishes.
  const uploads = parse(row.mail_list_ids_json, []);
  if (uploads.length && !(row.zoho_key_version === row.version && row.zoho_campaign_key)) {
    await setState(row.id, 'submitting', { submit_stage: 'upload', upload_total: null, upload_done: 0 });
    await require('../../social/jobsService').enqueue(ws(ctx), 'zoho_campaign_upload', { campaignId: row.id, version: row.version },
      { idempotencyKey: `zoho_campaign_upload:${row.id}:${row.version}:${Date.now()}`, createdBy: ctx.auth.userId, maxAttempts: 1 });
    await require('../contacts/zohoUpload').kickUpload(ws(ctx), row.id).catch(() => false);
    return getOne(ctx, row.id);
  }
  return deliver(ctx, row);
}

/** Zoho's code for a campaign that was deleted in Zoho. */
const ZOHO_DELETED = '6503';
const zohoDeleted = err => String(err?.providerCode || '') === ZOHO_DELETED || /campaign is deleted/i.test(String(err?.message || ''));

/**
 * The campaign Zoho prepared for this send was deleted in Zoho. Not sent yet: forget it, so the next
 * Send prepares a new one. Already sent: keep the record, and stop asking Zoho about it.
 */
async function forgetDeletedZohoCampaign(ctx, row) {
  if (row.status === 'submitted') {
    await run("UPDATE mail_campaigns SET zoho_status = 'Deleted in Zoho', last_checked_at = UTC_TIMESTAMP() WHERE id = ?", [row.id]);
  } else {
    await run(`UPDATE mail_campaigns SET zoho_campaign_key = NULL, zoho_key_version = NULL, zoho_status = NULL,
      status = CASE WHEN status IN ('needs_review', 'submitting') THEN 'failed' ELSE status END, submit_stage = NULL,
      provider_code = '6503', provider_message = 'The campaign prepared in Zoho was deleted there. Nothing was sent. Send again to prepare it again.',
      updated_at = UTC_TIMESTAMP() WHERE id = ?`, [row.id]);
  }
  await audit(ctx, 'mail.campaign_zoho_deleted', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { zohoCampaignKey: row.zoho_campaign_key, sent: row.status === 'submitted' } });
}

/**
 * Creates the Zoho campaign for this version (at most once) with its lists, and sends it.
 * extraKeys: Zoho lists made for this send from Marketech.ai lists.
 */
async function deliver(ctx, row, extraKeys = [], { retried = false } = {}) {
  // Step 1: the Zoho delivery object for this version (created at most once).
  let key = row.zoho_key_version === row.version ? row.zoho_campaign_key : null;
  if (!key) {
    const keys = [...parse(row.list_keys_json, []), ...extraKeys];
    await setState(row.id, 'submitting', { submit_stage: 'sync' });
    // The topic first: an account with topic management refuses a campaign without one.
    let topicId = null;
    try {
      const topics = await fetchTopics(ws(ctx));
      const tp = topicProblem(row, topics);
      if (tp) throw httpError(400, tp, 'TOPIC_REQUIRED');
      topicId = campaignTopic(row, topics);
    } catch (err) {
      return fail(ctx, row, 'sync', err);
    }
    try {
      const contactList = await contactsSvc.syncForSend(ctx, row, { listKeys: keys.slice() });
      if (contactList) keys.push(contactList);
      if (!keys.length) throw httpError(400, 'This campaign has no list with anyone to email, so nothing was sent. Choose a contact list (Recipients).', 'NO_RECIPIENTS');
    } catch (err) {
      return fail(ctx, row, 'sync', err);
    }
    const token = crypto.randomBytes(32).toString('base64url');
    await setState(row.id, 'submitting', {
      submit_stage: 'create',
      content_token_hash: crypto.createHash('sha256').update(token).digest('hex'),
      content_token_expires_at: toDbDateTime(new Date(Date.now() + CONTENT_TTL_MS))
    });
    try {
      const res = await zoho.writeCall(ws(ctx), 'createCampaign', {
        campaignname: zohoCampaignName(row),
        from_email: row.from_email,
        ...(row.from_name ? { from_name: row.from_name } : {}),
        subject: toZohoMergeTags(row.subject),
        content_url: `${publicBaseUrl()}/api/v1/mail/campaigns/content/${token}`,
        list_details: JSON.stringify(Object.fromEntries(keys.map(k => [k, []]))),
        ...(topicId ? { topicId } : {})
      });
      key = String(res.campaignKey || res.campaign_key || '');
      const zohoId = String(res.campaignId || res.campaign_id || '');
      if (!KEY_RE.test(key)) throw Object.assign(new Error('Zoho did not return a campaign key.'), { outcomeUnknown: true, code: 'ZOHO_BAD_RESPONSE' });
      try {
        await setState(row.id, 'submitting', { submit_stage: 'send', zoho_campaign_key: key, zoho_key_version: row.version, zoho_campaign_id: /^\d{5,25}$/.test(zohoId) ? zohoId : null });
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
    if (zohoDeleted(err) && !retried) {
      // The prepared campaign was deleted in Zoho before it was sent: prepare a new one, once.
      await forgetDeletedZohoCampaign(ctx, row);
      const fresh = await get('SELECT * FROM mail_campaigns WHERE id = ?', [row.id]);
      const lists = extraKeys.length ? extraKeys : parse(fresh.temp_lists_json, []).map(t => t.key);
      return deliver(ctx, { ...fresh, status: 'submitting' }, lists, { retried: true });
    }
    if (NOT_REVIEWED_RE.test(String(err.message || ''))) {
      // Zoho reviews every campaign first: hand this one to the review (it then sends it), or wait.
      const fresh = await get('SELECT * FROM mail_campaigns WHERE id = ?', [row.id]);
      return launchForReview(ctx, { ...fresh, zoho_campaign_key: key }, err, { throwIfWaiting: true });
    }
    if (err.providerCode === '6600') {
      await setState(row.id, 'submitted', { submit_stage: null, zoho_status: 'Sent', provider_code: '6600', provider_message: 'Zoho reports the campaign was already sent.', submitted_at: toDbDateTime(new Date()) });
      await audit(ctx, 'mail.campaign_already_sent', { resourceType: 'mail_campaign', resourceId: row.id });
      throw httpError(409, 'Zoho reports that this campaign was already sent.', 'ALREADY_SENT');
    }
    return fail(ctx, row, 'send', err);
  }
  // Figures right away (Zoho may still be sending): the result never depends on this read.
  try { return await refresh(ctx, row.id); } catch { return getOne(ctx, row.id); }
}

/** Zoho's reply when the campaign's lists have nobody it can email, said in plain words. */
const NO_LISTS_RE = /no lists? (are |is )?selected/i;
/** Zoho still reviewing a new campaign's content: it can be sent once Zoho approves it. */
const NOT_REVIEWED_RE = /content (is )?not (yet )?reviewed|(content|campaign) (is )?(under|pending|awaiting) review/i;
/** A send refused only for now: Zoho is reviewing the campaign or its contacts. */
const zohoHolding = err => NO_LISTS_RE.test(String(err?.message || '')) || NOT_REVIEWED_RE.test(String(err?.message || ''));
const NO_LISTS_HELP = 'Zoho: the lists for this campaign have nobody Zoho can email yet, so nothing was sent. Contacts new to Zoho may be held for review or until they confirm by email, or the people may be unsubscribed or bounced in Zoho. Check Zoho Campaigns → Contacts, then send again.';

/**
 * Said at the send step: the campaign exists in Zoho, and Zoho often sends it by itself once it has
 * reviewed contacts new to it. So it is not "failed": it waits (no edit, no resend) until Zoho sends it,
 * which the worker and "Refresh status" pick up, or until it is checked and marked not done.
 */
const ZOHO_HELD = 'ZOHO_HELD';
const NO_LISTS_HELD = 'Waiting for Zoho: it would not send this campaign yet, usually because it is still reviewing the campaign or contacts new to it. Marketech.ai asks Zoho again every few minutes and sends this same campaign as soon as Zoho allows it, so nobody gets it twice. Do not send it again here.';

async function fail(ctx, row, stage, err) {
  if (stage === 'send' && zohoHolding(err)) Object.assign(err, { message: NO_LISTS_HELD, outcomeUnknown: true, providerCode: ZOHO_HELD, code: ZOHO_HELD });
  else if (NO_LISTS_RE.test(String(err.message || ''))) err.message = NO_LISTS_HELP;
  const unknown = !!err.outcomeUnknown;
  await setState(row.id, unknown ? 'needs_review' : 'failed', {
    submit_stage: stage,
    provider_code: String(err.providerCode || err.code || 'ERROR').slice(0, 20),
    provider_message: String(err.message || '').slice(0, 500)
  });
  await audit(ctx, unknown ? 'mail.campaign_submit_unknown' : 'mail.campaign_submit_failed', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { stage, code: err.providerCode || err.code || null } });
  throw err;
}

/**
 * The parts of Zoho's campaign details a marketer uses: when it was sent, topic, devices, email
 * clients and browsers, locations and the lists it went to (counts only, no addresses).
 */
function insightsOf(d) {
  const counts = o => (o && typeof o === 'object'
    ? Object.entries(o).map(([label, v]) => ({ label: String(label).slice(0, 60), value: Number(v) || 0 })).filter(x => x.value > 0).sort((a, b) => b.value - a.value).slice(0, 20)
    : []);
  const ua = d.useragentstats || {};
  const det = first(d['campaign-details']) || {};
  return {
    sentAt: det.sent_date_string || null,
    sentTimeZone: det.sent_time_zone_short || det.sent_time_zone || null,
    topic: det.topic_name || null,
    replyTo: det.reply_to || null,
    devices: [
      ...counts(ua.computer_percent).map(x => ({ ...x, label: `Computer · ${x.label}` })),
      ...counts(ua.mobile_percent).map(x => ({ ...x, label: `Mobile · ${x.label}` })),
      ...counts(ua.tablets_percent).map(x => ({ ...x, label: `Tablet · ${x.label}` }))
    ],
    emailClients: counts(ua.emailclients_percent),
    browsers: counts(ua.browsers_percent),
    locations: counts(d['campaign-by-location']),
    lists: (Array.isArray(d.associated_mailing_lists) ? d.associated_mailing_lists : []).slice(0, 20).map(l => ({
      name: String(l.listname || '').slice(0, 100) || null,
      contacts: Number(l.contactscount) || 0,
      bounces: Number(l.no_of_bounce) || 0,
      unsubscribes: Number(l.no_of_unsubcontacts) || 0,
      generated: contactsSvc.isSyncList(l.listname)
    }))
  };
}

const REPORT_FIELDS = ['emails_sent_count', 'delivered_count', 'delivered_percent', 'opens_count', 'open_percent', 'unopened', 'unopened_percent',
  'unique_clicks_count', 'unique_clicked_percent', 'bounces_count', 'bounce_percent', 'hardbounce_count', 'softbounce_count', 'unsub_count', 'unsubscribe_percent',
  'spams_count', 'spam_percent', 'complaints_count', 'forwards_count', 'forward_percent', 'autoreply_count', 'unsent_count'];
const first = v => (Array.isArray(v) ? v[0] || null : v || null);

/** Finds the Zoho object created for this version by its unique name marker. */
async function findCreated(ctx, row) {
  const d = await zoho.readCall(ws(ctx), 'recentcampaigns', { status: 'all', fromindex: '1', range: '100', sort: 'desc' }).catch(err => {
    if (err.providerCode === '6101') return {};
    throw err;
  });
  const listOf = Object.values(d || {}).find(v => Array.isArray(v) && v.some(x => x && 'campaign_key' in x)) || [];
  const hit = listOf.find(c => isOurCampaign(c.campaign_name, row));
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
  // An upload still waiting for the worker is started here (the page checks every few seconds).
  if (row.status === 'submitting' && row.submit_stage === 'upload') await require('../contacts/zohoUpload').kickUpload(ws(ctx), row.id).catch(() => false);
  if (row.status === 'submitting' && row.submit_stage === 'upload' && Date.now() - new Date(row.updated_at).getTime() > UPLOAD_STALL_MS) {
    // The worker stopped while uploading (nothing was emailed): it can be sent again.
    await run("UPDATE mail_campaigns SET status = 'failed', provider_message = 'Uploading the lists to Zoho stopped before sending. Nothing was emailed. Send again.' WHERE id = ? AND status = 'submitting' AND submit_stage = 'upload'", [row.id]);
    return getOne(ctx, row.id);
  }
  if (!row.zoho_campaign_key) return getOne(ctx, row.id);
  if (row.zoho_status === 'Deleted in Zoho') return getOne(ctx, row.id);
  let d;
  try {
    d = await zoho.readCall(ws(ctx), 'getcampaigndetails', { campaignkey: row.zoho_campaign_key, campaigntype: 'normal' });
  } catch (err) {
    if (!zohoDeleted(err)) throw err;
    await forgetDeletedZohoCampaign(ctx, row);
    return getOne(ctx, row.id);
  }
  const report = first(d['campaign-reports']);
  let picked = report ? Object.fromEntries(REPORT_FIELDS.filter(f => report[f] !== undefined).map(f => [f, report[f]])) : null;
  // While Zoho is still sending it has no report yet: keep what is known (how many it is going to).
  if (!picked && SENT_LIKE.has(norm(d.campaign_status))) {
    const lists = Array.isArray(d.associated_mailing_lists) ? d.associated_mailing_lists : [];
    const total = Number(d.total_subscribers_count) || lists.reduce((n, l) => n + (Number(l.contactscount) || 0), 0);
    picked = { pending: true, ...(total ? { recipients_count: total } : {}) };
  }
  if (picked) picked.insights = insightsOf(d);
  // Held by Zoho and still a draft there (e.g. Zoho has now approved it): ask Zoho to send this same campaign again.
  if (row.status === 'needs_review' && row.provider_code === ZOHO_HELD && row.zoho_key_version === row.version && norm(d.campaign_status) === 'draft') {
    await run('UPDATE mail_campaigns SET zoho_status = ?, last_checked_at = UTC_TIMESTAMP() WHERE id = ?', [d.campaign_status || null, row.id]);
    return sendHeld(ctx, row);
  }
  await run('UPDATE mail_campaigns SET zoho_status = ?, report_json = ?, last_checked_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ?',
    [d.campaign_status || null, picked ? JSON.stringify(picked) : null, row.id]);
  // Sent: the temporary Zoho lists made from Marketech.ai lists are removed (contacts stay in Zoho).
  if (norm(d.campaign_status) === 'sent' && (row.temp_lists_json || row.contact_list_key) && !row.temp_lists_deleted_at) {
    await require('../contacts/zohoUpload').cleanupTempLists(row).catch(() => false);
  }
  // Zoho sent it after all (an unclear reply, or a refusal Zoho later reversed, e.g. contacts held for review).
  const ownKey = row.zoho_key_version === row.version;
  if ((row.status === 'needs_review' || (row.status === 'failed' && ownKey)) && SENT_LIKE.has(norm(d.campaign_status))) {
    // MySQL applies SET left to right: the provider fields read the old status, so they come first.
    await run(`UPDATE mail_campaigns SET provider_message = CASE WHEN status = 'failed' OR provider_code = 'ZOHO_HELD' THEN 'Zoho sent it after first holding it.' ELSE provider_message END,
      provider_code = CASE WHEN status = 'failed' OR provider_code = 'ZOHO_HELD' THEN NULL ELSE provider_code END,
      status = 'submitted', submit_stage = NULL, submitted_at = COALESCE(submitted_at, UTC_TIMESTAMP())
      WHERE id = ? AND status IN ('needs_review', 'failed')`, [row.id]);
    await audit(ctx, 'mail.campaign_reconciled', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { stage: row.submit_stage, zohoStatus: d.campaign_status } });
  }
  return getOne(ctx, row.id);
}

/** Said when the campaign can only be sent from Zoho once its review passes. */
const pressSendInZoho = row => `Waiting for Zoho: it reviews every new campaign before it goes out, and it would not take the send request from Marketech.ai. Open "${zohoCampaignName(row)}" in Zoho Campaigns and press Send once it says the campaign is approved. Marketech.ai then marks it sent here, so do not send it again here.`;

/**
 * Zoho answered "Content not reviewed" (6611): it reviews every campaign before sending, and only its
 * newer API can hand one to that review. Handed over: Zoho sends it once approved, so it counts as
 * submitted. Not possible (no id, region, scope or Zoho refused): it waits, and the person is told to
 * press Send in Zoho. throwIfWaiting: from the Send button, which reports a refusal as an error.
 */
async function launchForReview(ctx, row, sendErr, { throwIfWaiting = false } = {}) {
  let launched = null;
  let reason = null;
  if (!row.zoho_campaign_id && process.env.ZOHO_LOG !== 'off') console.log(`[zoho] ${new Date().toISOString()} reviewandlaunch skipped: no Zoho campaign id for campaign ${row.id} (Zoho did not return one when it was created)`);
  if (row.zoho_campaign_id) {
    try {
      launched = await zoho.reviewAndLaunch(ws(ctx), row.zoho_campaign_id);
    } catch (err) {
      reason = String(err.message || '').slice(0, 200);
    }
  }
  if (launched) {
    await setState(row.id, 'submitted', { submit_stage: null, zoho_status: launched.status, provider_code: null,
      provider_message: 'Handed to Zoho\'s content review: Zoho sends it as soon as the review passes.', submitted_at: toDbDateTime(new Date()) });
    await audit(ctx, 'mail.campaign_submitted', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { zohoCampaignKey: row.zoho_campaign_key, zohoStatus: launched.status, review: true } });
    return getOne(ctx, row.id);
  }
  const message = pressSendInZoho(row) + (reason ? ` (Zoho's review request: ${reason})` : '');
  await setState(row.id, 'needs_review', { submit_stage: 'send', provider_code: ZOHO_HELD, provider_message: message.slice(0, 500), last_checked_at: toDbDateTime(new Date()) });
  if (throwIfWaiting) {
    await audit(ctx, 'mail.campaign_submit_unknown', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { stage: 'send', code: '6611' } });
    throw Object.assign(httpError(409, message, ZOHO_HELD), { providerCode: ZOHO_HELD, cause: sendErr });
  }
  return getOne(ctx, row.id);
}

/**
 * Sends a campaign Zoho held, again: the same Zoho campaign (Zoho refuses a second send of a sent
 * one, so nobody gets it twice). Still held: it keeps waiting. Another refusal: it fails, with Zoho's reason.
 */
async function sendHeld(ctx, row) {
  try {
    const res = await zoho.writeCall(ws(ctx), 'sendcampaign', { campaignkey: row.zoho_campaign_key });
    await setState(row.id, 'submitted', { submit_stage: null, zoho_status: res.campaign_status || null, provider_code: null, provider_message: 'Zoho sent it after first holding it.', submitted_at: toDbDateTime(new Date()) });
    await audit(ctx, 'mail.campaign_submitted', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { zohoCampaignKey: row.zoho_campaign_key, zohoStatus: res.campaign_status || null, afterHold: true } });
  } catch (err) {
    if (NOT_REVIEWED_RE.test(String(err.message || ''))) return launchForReview(ctx, row, err);
    if (zohoHolding(err)) return getOne(ctx, row.id);
    if (String(err.providerCode || '') === '6600') {
      await setState(row.id, 'submitted', { submit_stage: null, zoho_status: 'Sent', provider_code: null, provider_message: 'Zoho sent it after first holding it.', submitted_at: toDbDateTime(new Date()) });
    } else if (!err.outcomeUnknown) {
      await setState(row.id, 'failed', { submit_stage: 'send', provider_code: String(err.providerCode || err.code || 'ERROR').slice(0, 20), provider_message: String(err.message || '').slice(0, 500) });
      await audit(ctx, 'mail.campaign_submit_failed', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { stage: 'send', afterHold: true, code: err.providerCode || err.code || null } });
    }
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
  // A send Zoho held is known not sent (Zoho said so), so it needs no wait: Zoho's status is still checked below.
  if (row.provider_code !== ZOHO_HELD && Date.now() - new Date(row.updated_at).getTime() < REVIEW_WAIT_MS) throw httpError(409, 'Wait at least 10 minutes after the request, then check again.', 'TOO_EARLY');
  if (row.submit_stage === 'create' && !row.zoho_campaign_key) {
    const hit = await findCreated(ctx, row);
    if (hit) { await refresh(ctx, id); throw httpError(409, 'Zoho has the campaign; it was prepared. Send again to send it.', 'ALREADY_PREPARED'); }
    await run("UPDATE mail_campaigns SET status = 'failed', provider_message = 'Not prepared in Zoho (checked).', updated_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'needs_review'", [row.id]);
  } else {
    let d;
    try {
      d = await zoho.readCall(ws(ctx), 'getcampaigndetails', { campaignkey: row.zoho_campaign_key, campaigntype: 'normal' });
    } catch (err) {
      if (!zohoDeleted(err)) throw err;
      await forgetDeletedZohoCampaign(ctx, row);
      return getOne(ctx, row.id);
    }
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
    "SELECT id, workspace_id, html_content FROM mail_campaigns WHERE content_token_hash = ? AND content_token_expires_at > UTC_TIMESTAMP() AND approved_version = version AND status IN ('submitting', 'submitted', 'needs_review', 'failed')",
    [hash]
  );
  return row ? withOwnUnsubscribe(toZohoMergeTags(row.html_content), row) : null;
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

// ------------------------------------------------------------------ unsubscribes kept in Marketech.ai

/**
 * Unsubscribes are kept by Marketech.ai, not by the Zoho list (which is deleted once the campaign
 * is sent). The email's unsubscribe link ($[LI:UNSUBSCRIBE]$) is pointed at Marketech.ai's own page
 * for this campaign, with the recipient's address filled in by Zoho ($[UD:CONTACT_EMAIL]$). The
 * page asks to confirm (link scanners do not unsubscribe anyone), then adds the address to the
 * stop-list and marks it unsubscribed in every contact list here.
 */
const UNSUB_TAG = /href\s*=\s*(["'])\$\[LI:(?:UNSUBSCRIBE|ORG_OPTOUT)\]\$\1/gi;
const unsubSecret = () => process.env.SOCIAL_TOKEN_ENCRYPTION_KEY || process.env.ZOHO_CAMPAIGNS_CLIENT_SECRET || 'marketech-unsubscribe';
const unsubSig = (workspaceId, id) => crypto.createHmac('sha256', unsubSecret()).update(`campaign-unsubscribe:${workspaceId}:${id}`).digest('hex').slice(0, 32);
const unsubToken = row => `${row.id}-${unsubSig(row.workspace_id, row.id)}`;
const campaignUnsubscribeUrl = row => `${publicBaseUrl()}/api/v1/mail/unsubscribe/c/${unsubToken(row)}?e=$[UD:CONTACT_EMAIL]$`;

function withOwnUnsubscribe(html, row) {
  if (!publicBaseUrl()) return html;
  return String(html || '').replace(UNSUB_TAG, (_m, q) => `href=${q}${campaignUnsubscribeUrl(row)}${q}`);
}

/** The campaign of an unsubscribe token, and whether the address was one it went to. */
async function unsubscribeTarget(token, email) {
  const m = /^(\d{1,10})-([a-f0-9]{32})$/.exec(String(token || ''));
  const addr = String(email || '').trim().toLowerCase();
  if (!m || !addr || addr.length > 255 || !addr.includes('@')) return null;
  const row = await get('SELECT id, workspace_id, mail_list_ids_json FROM mail_campaigns WHERE id = ?', [Number(m[1])]);
  if (!row || !crypto.timingSafeEqual(Buffer.from(unsubSig(row.workspace_id, row.id)), Buffer.from(m[2]))) return null;
  const listIds = parse(row.mail_list_ids_json, []);
  const inLists = listIds.length && await get(
    `SELECT 1 AS x FROM mail_list_members mm JOIN mail_contacts c ON c.id = mm.contact_id
     WHERE c.workspace_id = ? AND c.email = ? AND mm.list_id IN (${listIds.map(() => '?').join(',')}) LIMIT 1`, [row.workspace_id, addr, ...listIds]);
  const picked = await get('SELECT 1 AS x FROM mail_campaign_contacts WHERE campaign_id = ? AND email = ? LIMIT 1', [row.id, addr]);
  const known = await get('SELECT 1 AS x FROM mail_contacts WHERE workspace_id = ? AND email = ? LIMIT 1', [row.workspace_id, addr]);
  if (!inLists && !picked && !known) return null;
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

/**
 * Per-recipient activity for a sent campaign, read from Zoho on demand (getcampaignrecipientsdata,
 * campaign.READ scope, which the connection already has). Nothing is stored. Only addresses and
 * names Zoho returns are passed on; Zoho does not document per-recipient event times here, so
 * none are invented. The route allows this to roles with mail.send only.
 */
const RECIPIENT_ACTIONS = {
  sent: 'sentcontacts', opened: 'openedcontacts', unopened: 'unopenedcontacts', clicked: 'clickedcontacts',
  hard_bounced: 'senthardbounce', soft_bounced: 'sentsoftbounce', unsubscribed: 'optoutcontacts', spam: 'spamcontacts'
};
const PAGE_SIZE = 50;

function contactsIn(data) {
  // Zoho's JSON shape for this call is not fully documented: accept a few known containers.
  const pools = [data?.list_of_details, data?.contacts, data?.['contact-details'], data?.campaign_details?.contacts, data?.response?.contacts];
  const list = pools.find(Array.isArray) || [];
  return list.flatMap(c => (c && Array.isArray(c.contact) ? c.contact : [c])).map(c => {
    // Documented JSON field: contactemailaddress (others kept for older/XML-converted shapes).
    const email = c?.contactemailaddress || c?.contact_email || c?.contactemail || c?.email || c?.['Contact Email'] || null;
    if (!email || typeof email !== 'string') return null;
    const first = c.firstname || c.contactfn || c.contact_fn || c['First Name'] || '';
    const last = c.lastname || c.contactln || c.contact_ln || c['Last Name'] || '';
    const txt = v => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null);
    const count = v => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    return {
      email: email.slice(0, 255),
      name: `${first} ${last}`.trim().slice(0, 200) || null,
      company: txt(c.companyname),
      phone: txt(c.phone) || txt(c.mobile),
      location: [txt(c.city), txt(c.state), txt(c.country)].filter(Boolean).join(', ') || txt(c.location),
      sentAt: txt(c.sentdate),
      opens: count(c.numoftimeopened),
      clicks: count(c.numoftimeclicked ?? c.numofclicks ?? c.clickcount),
      lastOpenedAt: lastReportTime(c.openreports),
      lastClickedAt: lastReportTime(c.clickreports)
    };
  }).filter(Boolean);
}

/** Zoho's "{id=Nov 04, 2026 11:33 AM, id2=…}" activity list: the latest time as shown, or null. */
function lastReportTime(v) {
  if (typeof v !== 'string' || !v.includes('=')) return null;
  const times = v.replace(/^\{|\}$/g, '').split(/,\s*(?=[^=,]+=)/).map(p => p.split('=').slice(1).join('=').trim()).filter(Boolean);
  if (!times.length) return null;
  const parsed = times.map(t => ({ t, ms: Date.parse(t) }));
  const best = parsed.filter(x => Number.isFinite(x.ms)).sort((a, b) => b.ms - a.ms)[0];
  return (best ? best.t : times[times.length - 1]).slice(0, 40);
}

async function recipientActivity(ctx, id, { activity, page = 1 } = {}) {
  const action = RECIPIENT_ACTIONS[activity];
  if (!action) throw httpError(400, `Unknown activity. Use one of: ${Object.keys(RECIPIENT_ACTIONS).join(', ')}.`, 'VALIDATION_ERROR');
  const row = await requireRow(ctx, id);
  if (!row.zoho_campaign_key || !['submitted', 'needs_review'].includes(row.status)) {
    return { available: false, reason: 'not_sent', recipients: [], page: 1, pageSize: PAGE_SIZE };
  }
  const p = Math.max(1, Math.min(1000, parseInt(page, 10) || 1));
  let data;
  try {
    data = await zoho.readCall(ws(ctx), 'getcampaignrecipientsdata', { campaignkey: row.zoho_campaign_key, action, fromindex: String((p - 1) * PAGE_SIZE + 1), range: String(PAGE_SIZE) });
  } catch (err) {
    // 6002: invalid key or not sent yet; 6303: no contacts for this activity.
    if (err.providerCode === '6303') return { available: true, recipients: [], page: p, pageSize: PAGE_SIZE, hasMore: false };
    if (err.providerCode === '6002') return { available: false, reason: 'not_sent', recipients: [], page: p, pageSize: PAGE_SIZE };
    throw err;
  }
  // Matched to Leads by email: business, contact person, phone, product and lead status.
  const recipients = (await withLeadDetails(ws(ctx), contactsIn(data))).map(r => ({ ...r, name: r.name || r.contactName || null }));
  await audit(ctx, 'mail.campaign_recipients_viewed', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { activity, page: p, count: recipients.length } });
  return { available: true, recipients, page: p, pageSize: PAGE_SIZE, hasMore: recipients.length === PAGE_SIZE };
}

const LIST_CONTACT_STATUS = { subscribed: 'active', unsubscribed: 'unsub', bounced: 'bounce' };

/**
 * Contacts of a Zoho mailing list, read on demand (one page at a time). Nothing is stored unless
 * a contact is selected for a campaign. Each view is audited, without any address.
 */
/**
 * Adds the matching lead's details (by email) to Zoho contacts: business, contact person, phone,
 * product and status, as on the Leads page. Zoho's own values are used where there is no lead.
 */
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

async function listContacts(ctx, listKey, { status = 'subscribed', page = 1 } = {}) {
  const zohoStatus = LIST_CONTACT_STATUS[status];
  if (!zohoStatus) throw httpError(400, `Unknown status. Use one of: ${Object.keys(LIST_CONTACT_STATUS).join(', ')}.`, 'VALIDATION_ERROR');
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(String(listKey || ''))) throw httpError(400, 'Invalid list.', 'VALIDATION_ERROR');
  await zoho.assertReady(ws(ctx));
  const p = Math.max(1, Math.min(1000, parseInt(page, 10) || 1));
  const read = await contactsSvc.readListPage(ws(ctx), listKey, zohoStatus, p);
  const contacts = await withLeadDetails(ws(ctx), read.contacts);
  const { hasMore } = read;
  await audit(ctx, 'mail.zoho_list_contacts_viewed', { resourceType: 'mail_provider', resourceId: 'zoho_campaigns', metadata: { status, page: p, count: contacts.length } });
  return { contacts, page: p, pageSize: contactsSvc.PAGE_SIZE, hasMore };
}

module.exports = { recipientHistory, unsubscribeFromCampaign, campaignUnsubscribeUrl, deliver, failSubmission: (...a) => fail(...a), list, getOne, create, update, duplicate, remove, getContacts, setContactLeads, addContactsFromZoho, removeContacts, leadOptions, zohoAudiences, listContacts, validate, approve, send, refresh, resolve, contentByToken, recipientActivity, RECIPIENT_ACTIONS, contactsIn, toZohoMergeTags };
