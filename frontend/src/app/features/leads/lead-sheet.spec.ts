import { autoMap, buildLeadRows, detectHeaderRow, guessField, headingsOf } from './lead-sheet';

describe('lead-sheet: any layout and headings', () => {
  it('recognises many heading names', () => {
    expect(['Full Name', 'E-mail ID', 'Mobile No.', 'Organisation', 'Surname', 'Given name', 'Zip code', 'Remarks', 'Customer E-mail', 'Deal Value', 'Product Code']
      .map(guessField)).toEqual(['name', 'email', 'phone', 'companyName', 'lastName', 'firstName', 'city', 'notes', 'email', 'estimatedBudget', 'productId']);
    expect(guessField('Random column')).toBe('');
  });

  it('finds headings below a title row and builds leads with first/last names, cleaned emails and extra columns in notes', () => {
    const cells = [
      ['Trade show leads – October', '', '', '', '', ''],
      ['', '', '', '', '', ''].map(() => ''),
      ['First Name', 'Surname', 'Work Email', 'Mobile', 'Organisation', 'Stand visited'],
      ['Ann', 'Lee', 'Ann Lee <ANN@Acme.io>', '0412 345 678', 'Acme', 'Hall B'],
      ['', '', '', '', 'Solo Pty Ltd', ''],
      ['', '', 'only@mail.io', '', '', '']
    ].filter(r => r.some(c => c));
    const header = detectHeaderRow(cells);
    expect(header).toBe(1);
    const headings = headingsOf(cells, header);
    const mapping = autoMap(headings);
    expect(mapping).toEqual(['firstName', 'lastName', 'email', 'phone', 'companyName', '']);
    const { rows, skippedNoName } = buildLeadRows(cells, header, mapping);
    expect(skippedNoName).toBe(0);
    expect(rows[0]).toEqual(jasmine.objectContaining({ name: 'Ann Lee', email: 'ann@acme.io', phone: '0412 345 678', companyName: 'Acme', notes: 'Stand visited: Hall B' }));
    expect(rows[1].name).toBe('Solo Pty Ltd', 'company becomes the name');
    expect(rows[2].name).toBe('only', 'email becomes the name');
    expect(buildLeadRows(cells, header, mapping, { extraToNotes: false }).rows[0].notes).toBe('');
  });

  it('a field taken by one column is not given to a second one', () => {
    expect(autoMap(['Email', 'Email Address', 'Notes', 'Comments'])).toEqual(['email', '', 'notes', 'notes']);
  });
});
