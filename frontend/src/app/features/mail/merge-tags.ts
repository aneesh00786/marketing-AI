/**
 * Campaign merge tags: the contact's first and last name, each with a default value used when the
 * contact has none ($[FNAME|Customer]$; a blank default is written $[LNAME||]$). Marketech.ai fills
 * them in for each recipient when it sends with Amazon SES, with the unsubscribe and "View in browser"
 * links ($[LI:UNSUBSCRIBE]$, $[LI:VIEWINBROWSER]$) and the business address ($[HF:ORGADDRESS]$).
 */
/** No "full name": the space between two tags would stay even without a last name ("Hi Priya ,"). */
export type ContactField = 'first' | 'last';

export interface LinkTag { key: string; label: string; tag: string; text: string; help: string; }

export const CONTACT_FIELDS: { key: ContactField; label: string; fallback: string; help: string }[] = [
  { key: 'first', label: 'First name', fallback: 'there', help: 'e.g. “Hi Priya,”' },
  { key: 'last', label: 'Last name', fallback: '', help: 'e.g. “Dear Ms Nair,”' }
];

/** Link tags filled per recipient (besides the unsubscribe link, which has its own checkbox). */
export const LINK_TAGS: LinkTag[] = [
  { key: 'viewinbrowser', label: 'View in browser link', tag: '$[LI:VIEWINBROWSER]$', text: 'View in browser', help: 'Opens this person\'s email as a web page' }
];

/** Organization details filled in from Mail Settings → Campaigns. */
export const INFO_TAGS: { key: string; label: string; tag: string; help: string }[] = [
  { key: 'orgaddress', label: 'Your company address', tag: '$[HF:ORGADDRESS]$', help: 'Your business address (Mail Settings → Campaigns); often required by anti-spam law' }
];

/** A default value cannot contain the characters that end or split a tag. */
export function cleanFallback(v: string): string {
  return String(v ?? '').replace(/[|$[\]{}<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

/** The merge tag for a contact field with its default value, e.g. $[FNAME|there]$ (blank: $[FNAME||]$). */
export function contactTag(field: ContactField, fallback: string): string {
  const fb = cleanFallback(fallback);
  const one = (name: string, f: string) => f ? `$[${name}|${f}]$` : `$[${name}||]$`;
  return one(field === 'first' ? 'FNAME' : 'LNAME', fb);
}

const SAMPLE: Record<ContactField, { noun: string; value: string }> = {
  first: { noun: 'first name', value: 'Priya' },
  last: { noun: 'last name', value: 'Nair' }
};

/** The plain-language question shown above the default value box. */
export function fallbackQuestion(field: ContactField): string {
  return field === 'last'
    ? "If we don't know a contact's last name, what should the email say instead?"
    : "If we don't have any name for a contact, what should the email say instead?";
}

/**
 * Worked examples of what recipients see, updated as the default value is typed. Leads without a
 * contact person are greeted as the business ("Big Red Packaging team"), so only contacts with no
 * name at all see the default value.
 */
export function fallbackExample(field: ContactField, fallback: string): string {
  const fb = cleanFallback(fallback);
  if (field === 'last') return `Example: Nair → “Nair” · no last name → ${fb ? `“${fb}”` : 'nothing (left out)'}`;
  return `Example: Priya → “Hi Priya,” · business lead with no contact person → “Hi Big Red Packaging team,” · no name at all → “Hi${fb ? ' ' + fb : ''},”`;
}
