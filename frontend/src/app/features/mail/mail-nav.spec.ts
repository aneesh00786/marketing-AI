import { mailSectionFromLink, visibleMailSections } from './mail-nav';

describe('Mail Center navigation links', () => {
  it('the former Mail Drafts link opens the Drafts section', () => {
    expect(mailSectionFromLink('drafts', null)).toBe('drafts');
  });

  it('?view=mail opens the requested section, the overview by default, and Campaigns after Zoho sign-in', () => {
    expect(mailSectionFromLink('mail', null)).toBe('overview');
    expect(mailSectionFromLink('mail', 'approvals')).toBe('approvals');
    expect(mailSectionFromLink('mail', 'templates')).toBe('templates');
    expect(mailSectionFromLink('mail', 'settings')).toBe('settings');
    expect(mailSectionFromLink('mail', 'inbox')).toBe('inbox');
    expect(mailSectionFromLink('mail', 'sent')).toBe('sent');
    expect(mailSectionFromLink('mail', 'zoho')).toBe('campaigns');
    expect(mailSectionFromLink('mail', 'nonsense')).toBe('overview');
  });

  it('other links are not mail links', () => {
    expect(mailSectionFromLink('social', 'zoho')).toBeNull();
    expect(mailSectionFromLink(null, null)).toBeNull();
  });

  it('Product Emails is listed only while its feature is enabled', () => {
    expect(visibleMailSections({ productEmails: false })).toEqual(['overview', 'inbox', 'sent', 'drafts', 'approvals', 'campaigns', 'templates', 'logs', 'settings']);
    expect(visibleMailSections({ productEmails: true })).toContain('product-emails');
  });
});
