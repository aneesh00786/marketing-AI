const { unverifiedClaims } = require('../modules/social/campaignService');

/**
 * Flags customer-facing claims that are not backed by the supplied facts, so a person
 * verifies them before anything is sent: prices and statistics (shared with Social
 * campaigns) plus offer language (free trials/pilots, discounts, grants, guarantees).
 */
const OFFER_PATTERN = /\b(free (?:trial|pilot|demo|audit|setup|month)s?|\d+[- ]day (?:free )?(?:trial|pilot)|money[- ]back|guarantee[ds]?|grants?\b|discount|\d+\s?% off|off (?:your|the) first)\b/gi;

function unverifiedOffers(text, factsText) {
  const haystack = String(factsText || '').toLowerCase();
  return [...new Set((String(text).match(OFFER_PATTERN) || []).filter(m => !haystack.includes(m.toLowerCase())).map(m => m.trim()))];
}

function unverified(text, factsText) {
  return [...new Set([...unverifiedClaims(text, String(factsText || '')), ...unverifiedOffers(text, factsText)])];
}

module.exports = { unverified, unverifiedOffers, unverifiedClaims };
