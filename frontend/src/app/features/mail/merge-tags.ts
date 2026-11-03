/**
 * Zoho Campaigns merge tags, offered the way Zoho's own editor offers them: a Merge Tags menu
 * grouped into Contact, Links and Organization. Contact tags carry a default value used when the
 * contact's field is empty ($[FNAME|Customer]$). Campaigns here are email only, so Zoho's second
 * (social sharing) default is not used; a blank default is written $[LNAME||]$ as Zoho documents it.
 * Syntax from Zoho's help pages (Predefined Merge Tags, Campaign customization).
 */
/** No "full name": Zoho prints the space between two tags even without a last name ("Hi Priya ,"). */
export type ContactField = 'first' | 'last';

export interface LinkTag { key: string; label: string; tag: string; text: string; help: string; }

export const CONTACT_FIELDS: { key: ContactField; label: string; fallback: string; help: string }[] = [
  { key: 'first', label: 'First name', fallback: 'there', help: 'e.g. “Hi Priya,”' },
  { key: 'last', label: 'Last name', fallback: '', help: 'e.g. “Dear Ms Nair,”' }
];

/**
 * Links Zoho fills in for each recipient. Unsubscribe has its own checkbox; Subscribe (they are
 * already subscribed) and the mailing list name (internal) are left out as confusing.
 */
export const LINK_TAGS: LinkTag[] = [
  { key: 'viewinbrowser', label: 'View in browser link', tag: '$[LI:VIEWINBROWSER]$', text: 'View in browser', help: 'Opens the email as a web page' },
  { key: 'updateprofile', label: 'Update profile link', tag: '$[LI:UPDATEPROFILE]$', text: 'Update your profile', help: 'Lets them change their details' },
  { key: 'tellafriend', label: 'Forward to a friend link', tag: '$[LI:TELLAFRIEND]$', text: 'Forward to a friend', help: 'Lets them share the email' }
];

/** Text Zoho replaces with your organization's details. */
export const INFO_TAGS: { key: string; label: string; tag: string; help: string }[] = [
  { key: 'orgaddress', label: 'Your company address', tag: '$[HF:ORGADDRESS]$', help: 'From your Zoho company profile; often required by anti-spam law' }
];

/** A default value cannot contain the characters that end or split a Zoho tag. */
export function cleanFallback(v: string): string {
  return String(v ?? '').replace(/[|$[\]{}<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

/** The Zoho tag for a contact field with its default value, e.g. $[FNAME|there]$ (blank: $[FNAME||]$). */
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
