/**
 * Who may be emailed, by email type. One rule set for every sending path, enforced again inside
 * the shared sender (services/emailService.sendRealEmail) so no caller can bypass it.
 *
 *                     unsubscribed   consent withdrawn   hard bounce   spam complaint
 *   marketing         blocked        blocked             blocked       blocked
 *   transactional     allowed        allowed             blocked       blocked
 *
 * Suppression reasons (email_suppressions.reason): 'unsubscribed', 'bounced' (hard bounce or a
 * permanent rejection), 'complaint' (spam complaint). Any other or unknown reason blocks every
 * email type (fail closed). Consent withdrawal is read from Leads CRM (leads.marketing_consent).
 * Everything is per workspace.
 */
const { get } = require('../db/database');

const POLICIES = new Set(['marketing', 'transactional']);
const TRANSACTIONAL_ALLOWED = new Set(['unsubscribed']);

const MESSAGES = {
  unsubscribed: 'This address has unsubscribed.',
  bounced: 'Earlier email to this address bounced.',
  complaint: 'This recipient marked an earlier email as spam.',
  consent_withdrawn: 'This contact has withdrawn marketing consent.',
  other: 'This address is on the suppression list.'
};

const normalize = email => String(email || '').trim().toLowerCase();

/**
 * Returns { reason, message } when this email type must not be sent to the address, else null.
 * reason is one of: unsubscribed, bounced, complaint, consent_withdrawn, other.
 */
async function suppressionBlock(workspaceId, email, policy) {
  if (!POLICIES.has(policy)) throw new Error(`Unknown suppression policy "${policy}"`);
  const addr = normalize(email);
  if (!workspaceId || !addr) return null;
  const s = await get('SELECT reason FROM email_suppressions WHERE workspace_id = ? AND email = ?', [workspaceId, addr]);
  if (s) {
    const reason = MESSAGES[s.reason] && s.reason !== 'other' ? s.reason : 'other';
    if (!(policy === 'transactional' && TRANSACTIONAL_ALLOWED.has(reason))) return { reason, message: MESSAGES[reason] };
  }
  if (policy === 'marketing') {
    const withdrawn = await get("SELECT 1 AS x FROM leads WHERE workspace_id = ? AND LOWER(TRIM(email)) = ? AND marketing_consent = 'withdrawn' LIMIT 1", [workspaceId, addr]);
    if (withdrawn) return { reason: 'consent_withdrawn', message: MESSAGES.consent_withdrawn };
  }
  return null;
}

module.exports = { suppressionBlock, MESSAGES, normalize };
