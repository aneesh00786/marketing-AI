import { leadExportRows } from './app.component';

describe('leadExportRows', () => {
  const lead = { name: 'Ravi Kumar', companyName: 'Global Quality Foods', country: 'Australia', email: 'sales@gqf.com.au', phone: '+61 3 9000 1000', productName: 'ThriveWoo',
    estimatedBudget: null, status: 'Imported', score: 72, category: 'Warm', marketingConsent: 'unknown', googlePlace: true, aiSuggestion: null,
    notes: 'Address: 1 Market Rd', createdAt: '2026-11-02T09:03:21.000Z' };

  it('has one numbered row per lead with readable column names', () => {
    const [row] = leadExportRows([lead], false);
    expect(row).toEqual({ '#': 1, Name: 'Ravi Kumar', Company: 'Global Quality Foods', Country: 'Australia', Email: 'sales@gqf.com.au', Phone: '+61 3 9000 1000', Product: 'ThriveWoo',
      Budget: '', Status: 'Imported', 'Lead score': 72, Category: 'Warm', 'Marketing consent': 'unknown', Source: 'AI Lead Discovery', 'AI advice': '',
      Notes: 'Address: 1 Market Rd', Created: '2026-11-02' });
  });

  it('in CSV, text a spreadsheet would run as a formula stays plain text; phone numbers are untouched', () => {
    const [row] = leadExportRows([{ ...lead, name: '=HYPERLINK("http://x")', companyName: '+cmd', notes: '@SUM(1)', email: '-x' }], true);
    expect([row['Name'], row['Company'], row['Notes'], row['Email']]).toEqual([`'=HYPERLINK("http://x")`, `'+cmd`, `'@SUM(1)`, `'-x`]);
    expect(row['Phone']).toBe('+61 3 9000 1000');
    expect(leadExportRows([{ ...lead, name: '=x' }], false)[0]['Name']).toBe('=x', 'Excel cells are written as text, not formulas');
  });
});
