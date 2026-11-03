import { cleanFallback, contactTag, fallbackExample, fallbackQuestion } from './merge-tags';

describe('Zoho merge tags', () => {
  it('builds Zoho contact tags with the default value for email and social', () => {
    expect(contactTag('first', 'there')).toBe('$[FNAME|there]$');
    expect(contactTag('last', '')).toBe('$[LNAME||]$');
    expect(contactTag('last', 'Customer')).toBe('$[LNAME|Customer]$');
  });
  it('removes characters that would break the tag from the default value', () => {
    expect(cleanFallback(' Dear  $[friend]|{x}<b> ')).toBe('Dear friendxb');
    expect(cleanFallback('x'.repeat(60)).length).toBe(40);
  });
  it('explains the default value in plain words with examples, including business leads', () => {
    expect(fallbackQuestion('first')).toBe("If we don't have any name for a contact, what should the email say instead?");
    expect(fallbackQuestion('last')).toBe("If we don't know a contact's last name, what should the email say instead?");
    expect(fallbackExample('first', 'there')).toBe('Example: Priya → “Hi Priya,” · business lead with no contact person → “Hi Big Red Packaging team,” · no name at all → “Hi there,”');
    expect(fallbackExample('first', '')).toContain('no name at all → “Hi,”');
    expect(fallbackExample('last', '')).toBe('Example: Nair → “Nair” · no last name → nothing (left out)');
  });
});
