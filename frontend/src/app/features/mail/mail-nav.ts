/** Load state of a list the shell hands to Mail Center (counts are shown only when 'ready'). */
export type DataState = 'loading' | 'ready' | 'error';

/** Sections of the Mail Center. Each maps to existing functionality; none adds new sending paths. */
export type MailSection = 'overview' | 'drafts' | 'approvals' | 'product-emails' | 'campaigns' | 'templates' | 'logs' | 'settings';

export const MAIL_SECTIONS: { key: MailSection; label: string; hint: string }[] = [
  { key: 'overview', label: 'Overview', hint: 'Mail at a glance and the company mailbox' },
  { key: 'drafts', label: 'Drafts', hint: 'AI drafts: create, edit and review' },
  { key: 'approvals', label: 'Approvals', hint: 'Drafts waiting for approval, ready to send, or with unknown delivery' },
  { key: 'product-emails', label: 'Product Emails', hint: 'Personalised emails to a product\'s leads' },
  { key: 'campaigns', label: 'Campaigns', hint: 'Email campaigns delivered through Zoho Campaigns' },
  { key: 'templates', label: 'Email Templates', hint: 'Reusable HTML email templates' },
  { key: 'logs', label: 'Logs', hint: 'Email log and campaign log: everything sent and received' },
  { key: 'settings', label: 'Settings', hint: 'Mailbox, marketing approval, tracking and Zoho: all mail settings in one place' }
];

/** Draft statuses that need someone with mail.send: approve, send, or confirm an unknown delivery. */
export const APPROVAL_STATUSES = ['Draft', 'Approved', 'Needs Review'];

/** Sections shown to this workspace. Product Emails exists only while its feature flag is on. */
export function visibleMailSections(opts: { productEmails: boolean }): MailSection[] {
  return MAIL_SECTIONS.map(s => s.key).filter(k => k !== 'product-emails' || opts.productEmails);
}

/**
 * Resolves a deep link (?view=…&section=…) to a Mail Center section, or null when it is not a mail link.
 * ?view=drafts is the former Mail Drafts page; section=zoho is what the Zoho sign-in callback returns.
 */
export function mailSectionFromLink(view: string | null, section: string | null): MailSection | null {
  if (view === 'drafts') return 'drafts';
  if (view !== 'mail') return null;
  if (section === 'zoho') return 'campaigns';
  return MAIL_SECTIONS.some(s => s.key === section) ? section as MailSection : 'overview';
}
