import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LeadImportMapperComponent } from './lead-import-mapper.component';

describe('LeadImportMapperComponent: map your fields', () => {
  let fixture: ComponentFixture<LeadImportMapperComponent>;
  let last: any;
  const c = () => fixture.componentInstance;
  const cells = [
    ['Client', 'Mail', 'Cell', 'Firm', 'City', 'Source'],
    ['Ann Lee', 'ann@acme.io', '0412 345 678', 'Acme', 'Sydney', 'Expo']
  ];

  beforeEach(() => {
    try { localStorage.removeItem('marketech_lead_import_maps'); } catch { /* ignore */ }
    TestBed.configureTestingModule({ imports: [LeadImportMapperComponent] });
    fixture = TestBed.createComponent(LeadImportMapperComponent);
    fixture.componentInstance.rowsChange.subscribe(e => (last = e));
    fixture.componentInstance.sheets = [{ name: 'Sheet1', cells }];
    fixture.componentInstance.ngOnChanges();
    fixture.detectChanges();
  });

  it('lists each lead field with a column dropdown and an example value', () => {
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Map your fields');
    expect(c().fieldColumn('email')).toBe(1);
    expect(c().fieldColumn('phone')).toBe(2);
    expect(c().fieldColumn('companyName')).toBe(3);
    expect(el.textContent).toContain('ann@acme.io');
    expect(last.rows[0].email).toBe('ann@acme.io');
  });

  it('choosing a column for a field moves it there and rebuilds the leads', () => {
    expect(c().fieldColumn('name')).toBe(-1, '"Client" is not a known heading');
    c().setFieldColumn('name', 0);
    expect(last.rows[0].name).toBe('Ann Lee');
    c().setFieldColumn('companyName', 0);
    expect(c().fieldColumn('name')).toBe(-1, 'a column fills one field');
    expect(c().fieldColumn('companyName')).toBe(0);
    c().setFieldColumn('companyName', -1);
    expect(c().fieldColumn('companyName')).toBe(-1);
  });

  it('extra columns go to notes or the address; the choice is remembered for the same headings', () => {
    c().toggleMulti(5, 'notes');
    c().extraToNotes = false;
    c().emit();
    expect(last.rows[0].notes).toBe('Expo');
    expect(last.rows[0].address).toContain('Sydney');
    c().setFieldColumn('name', 0);
    const again = TestBed.createComponent(LeadImportMapperComponent).componentInstance;
    again.sheets = [{ name: 'Other file', cells }];
    again.ngOnChanges();
    expect(again.fieldColumn('name')).toBe(0);
  });
});
