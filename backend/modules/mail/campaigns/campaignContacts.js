const { z } = require('zod');
const { run, all } = require('../../../db/database');
const { audit } = require('../../../lib/audit');
const emailService = require('../../../services/emailService');
const { withEligibility, LEAD_COLUMNS } = require('../productEmails/service');

/**
 * Contacts chosen one by one (from Leads) for a campaign, next to its contact lists.
 *
 * Nobody is emailed on the browser's word. A lead must not have
 * opted out (unsubscribed, bounced, spam complaint, consent withdrawn), with a valid address, when
 * chosen and again when the campaign is sent (sesCampaigns.prepare).
 */
const ws = ctx => ctx.auth.workspaceId;
const httpError = (status, message, code) => Object.assign(new Error(message), { status, code, expose: true });

const MAX_CONTACTS = 1000;
const placeholders = n => Array(n).fill('?').join(',');
const normalize = e => String(e || '').trim().toLowerCase();

const leadsSchema = z.object({ leadIds: z.array(z.number().int().positive()).max(MAX_CONTACTS) }).strict();
const removeSchema = z.union([z.object({ all: z.literal(true) }).strict(), z.object({ ids: z.array(z.number().int().positive()).min(1).max(MAX_CONTACTS) }).strict()]);

/** Addresses no marketing email may reach: suppressed, or a lead who withdrew consent. */
async function blockedAddresses(workspaceId) {
  const rows = await all(
    `SELECT LOWER(TRIM(email)) AS email FROM email_suppressions WHERE workspace_id = ?
     UNION SELECT LOWER(TRIM(email)) FROM leads WHERE workspace_id = ? AND marketing_consent = 'withdrawn' AND email IS NOT NULL`,
    [workspaceId, workspaceId]
  );
  return new Set(rows.map(r => r.email));
}

/** The campaign's selection with today's eligibility. A lead's current email address is used. */
async function assess(workspaceId, campaignId) {
  const rows = await all('SELECT * FROM mail_campaign_contacts WHERE workspace_id = ? AND campaign_id = ? ORDER BY id', [workspaceId, campaignId]);
  if (!rows.length) return [];
  const leadIds = rows.filter(r => r.lead_id).map(r => r.lead_id);
  const leads = leadIds.length ? await all(`SELECT ${LEAD_COLUMNS} FROM leads WHERE workspace_id = ? AND id IN (${placeholders(leadIds.length)})`, [workspaceId, ...leadIds]) : [];
  // Campaigns are marketing email: a picked lead needs recorded consent (see contacts/consent.js).
  const byLead = new Map((await withEligibility(workspaceId, leads, { requireConsent: false })).map(l => [l.id, l]));
  const blocked = rows.some(r => !r.lead_id) ? await blockedAddresses(workspaceId) : new Set();
  return rows.map(r => {
    const lead = r.lead_id ? byLead.get(r.lead_id) : null;
    const reasons = lead ? lead.reasons : [];
    if (r.lead_id && !lead) reasons.push('Lead no longer available');
    if (!r.lead_id && (blocked.has(r.email) || !emailService.isValidRecipient(r.email))) reasons.push('Unsubscribed, bounced or invalid');
    return {
      id: r.id,
      leadId: r.lead_id,
      email: lead?.email ? normalize(lead.email) : r.email,
      name: lead ? lead.name : r.name,
      company: lead ? lead.company : r.company,
      source: r.source,
      eligible: reasons.length === 0,
      reasons
    };
  });
}

function present(contacts) {
  return {
    contacts,
    total: contacts.length,
    eligible: contacts.filter(c => c.eligible).length,
    max: MAX_CONTACTS
  };
}

async function selection(ctx, campaignId) {
  return present(await assess(ws(ctx), campaignId));
}

async function insertRows(workspaceId, campaignId, rows, conflict) {
  for (let i = 0; i < rows.length; i += 200) {
    const part = rows.slice(i, i + 200);
    await run(
      `INSERT ${conflict === 'ignore' ? 'IGNORE ' : ''}INTO mail_campaign_contacts (workspace_id, campaign_id, lead_id, email, name, company, source, source_list_key, created_at)
       VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())').join(', ')}
       ${conflict === 'ignore' ? '' : "ON DUPLICATE KEY UPDATE lead_id = VALUES(lead_id), name = VALUES(name), company = VALUES(company), source = 'lead', source_list_key = NULL"}`,
      part.flatMap(r => [workspaceId, campaignId, r.leadId || null, r.email, r.name || null, r.company || null, r.source || 'lead', null])
    );
  }
}

async function emailsFromOtherSources(workspaceId, campaignId, source) {
  const rows = await all('SELECT LOWER(email) AS email FROM mail_campaign_contacts WHERE workspace_id = ? AND campaign_id = ? AND source <> ?', [workspaceId, campaignId, source]);
  return new Set(rows.map(r => r.email));
}

/**
 * Replaces the leads chosen for a campaign. Leads that may not be emailed are refused here, with
 * the count returned; `touch` runs before anything changes (it clears the approval).
 */
async function setLeads(ctx, row, input, touch) {
  const { leadIds } = leadsSchema.parse(input || {});
  const ids = [...new Set(leadIds)];
  const leads = ids.length ? await all(`SELECT ${LEAD_COLUMNS} FROM leads WHERE workspace_id = ? AND id IN (${placeholders(ids.length)})`, [ws(ctx), ...ids]) : [];
  const assessed = await withEligibility(ws(ctx), leads, { requireConsent: false });
  const seen = new Set();
  const rows = [];
  for (const l of assessed) {
    const email = normalize(l.email);
    if (!l.eligible || seen.has(email)) continue;
    seen.add(email);
    rows.push({ leadId: l.id, email, name: l.name, company: l.company, source: 'lead' });
  }
  const others = await emailsFromOtherSources(ws(ctx), row.id, 'lead');
  if (new Set([...others, ...seen]).size > MAX_CONTACTS) throw httpError(400, `A campaign can have up to ${MAX_CONTACTS} selected contacts. Use a contact list for larger audiences.`, 'TOO_MANY_CONTACTS');
  await touch();
  await run("DELETE FROM mail_campaign_contacts WHERE workspace_id = ? AND campaign_id = ? AND source = 'lead'", [ws(ctx), row.id]);
  await insertRows(ws(ctx), row.id, rows);
  await audit(ctx, 'mail.campaign_contacts_changed', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { source: 'lead', selected: rows.length, refused: ids.length - rows.length } });
  return { ...(await selection(ctx, row.id)), added: rows.length, refused: ids.length - rows.length };
}

/** Copies a selection to a new campaign: only contacts that can still be emailed, checked now. */
async function copySelection(workspaceId, fromId, toId) {
  const contacts = await assess(workspaceId, fromId);
  const seen = new Set();
  const rows = contacts.filter(c => {
    if (!c.eligible || seen.has(c.email)) return false;
    seen.add(c.email);
    return true;
  });
  await insertRows(workspaceId, toId, rows, 'ignore');
  return { copied: rows.length, dropped: contacts.length - rows.length };
}

async function removeContacts(ctx, row, input, touch) {
  const v = removeSchema.parse(input || {});
  await touch();
  const r = v.all
    ? await run('DELETE FROM mail_campaign_contacts WHERE workspace_id = ? AND campaign_id = ?', [ws(ctx), row.id])
    : await run(`DELETE FROM mail_campaign_contacts WHERE workspace_id = ? AND campaign_id = ? AND id IN (${placeholders(v.ids.length)})`, [ws(ctx), row.id, ...v.ids]);
  await audit(ctx, 'mail.campaign_contacts_changed', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { removed: r.changes } });
  return selection(ctx, row.id);
}

/** Words that show a "name" is really a business (Google often puts the business in the name). */
const BUSINESS_WORD_RE = /\b(pty|ltd|limited|llc|llp|inc|corp|corporation|company|group|holdings|packaging|foods?|bakery|distribut\w*|wholesale|supplies|supply|services?|solutions|trading|traders|enterprises?|industries|international|australia|restaurant|cafe|store|shop|studio|agency|clinic|hotel|team|sales|support|office|enquiries|reception|admin)\b/i;
/** The stand-in name lead discovery gives a place Google returned without a name ("Prospect 3: Packaging supplier (Sydney)"). */
const PROSPECT_RE = /^prospect\s+\d+\s*:/i;
/** Legal endings dropped from a business name in a greeting ("Khushboo Foods Pty Ltd" → "Khushboo Foods"). */
const LEGAL_SUFFIX_RE = /[\s,]+(pty\.?\s*ltd\.?|proprietary\s+limited|pvt\.?\s*ltd\.?|private\s+limited|ltd\.?|limited|llc|llp|plc|inc\.?|incorporated|corp\.?|corporation|co\.|gmbh)\s*$/i;

/**
 * The person's first and last name for the name merge tags, or null when the lead has no
 * person name: no name, the name is the business or the email (Google leads without a contact
 * person), or the name is clearly a business ("Nimbin Bakery").
 */
function personName(c) {
  const name = String(c?.name || '').replace(/\s+/g, ' ').trim();
  if (!name || name.length > 100) return null;
  const same = v => v && name.toLowerCase() === String(v).trim().toLowerCase();
  if (same(c.company) || same(c.email) || /@/.test(name) || PROSPECT_RE.test(name) || BUSINESS_WORD_RE.test(name)) return null;
  const [first, ...rest] = name.split(' ');
  return { first: first.slice(0, 50), last: rest.join(' ').slice(0, 50) };
}

/**
 * A business name tidied for a greeting: Google's extras after "|", " - " or "(" and legal endings
 * are dropped ("Pacific Packaging Australia | Melbourne" → "Pacific Packaging Australia",
 * "A & J Australia Pty Ltd - Packaging Supplies Sydney" → "A & J Australia"). Null when nothing
 * usable is left or it is too long for a greeting.
 */
function businessName(raw) {
  let n = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!n || /@|https?:|www\./i.test(n) || PROSPECT_RE.test(n)) return null;
  n = n.split(/\s+[|–—-]\s+|\s*\(|\s*\|\s*/)[0].trim();
  for (let i = 0; i < 3 && LEGAL_SUFFIX_RE.test(n); i++) n = n.replace(LEGAL_SUFFIX_RE, '').trim();
  n = n.replace(/[\s,.;:&-]+$/, '').replace(/^THE\b/, 'The');
  if (n.length < 2 || n.length > 40) return null;
  return n;
}

/**
 * The name the First name tag shows for a lead: the person's name, or for a business lead
 * without a contact person, the business ("Big Red Packaging team"). Null: the tag's default is used.
 */
function greetingName(c) {
  const person = personName(c);
  if (person) return person;
  const biz = businessName(c?.company) || businessName(c?.name);
  if (!biz) return null;
  return { first: /\bteam$/i.test(biz) ? biz : `${biz} team`, last: '', business: true };
}

module.exports = { MAX_CONTACTS, personName, businessName, greetingName, assess, selection, setLeads, copySelection, removeContacts, blockedAddresses };
