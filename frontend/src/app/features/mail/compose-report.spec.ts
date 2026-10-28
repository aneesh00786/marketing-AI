import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComposeReportComponent } from './compose-report.component';

const REPORT = {
  range: { from: '2026-09-28', to: '2026-10-28' }, page: 1, hasMore: true,
  sends: [
    { id: 2, at: '2026-10-28T06:00:00Z', status: 'sent', sender: { userId: 5, name: 'Ana' }, recipient: 'k***@client.io', emailId: 9, declaredPurpose: 'transactional', appliedPurpose: 'marketing', reasons: ['promotional_phrases'] },
    { id: 1, at: '2026-10-01T06:00:00Z', status: 'sent', sender: null, recipient: null, emailId: null, declaredPurpose: null, appliedPurpose: 'not_recorded', reasons: [] }
  ],
  refused: [{ at: '2026-10-28T07:00:00Z', sender: { userId: 6, name: 'Bo' }, reason: 'transactional_not_permitted', declaredPurpose: 'transactional', appliedPurpose: 'transactional', reasons: [] }]
};

describe('ComposeReportComponent', () => {
  let fixture: ComponentFixture<ComposeReportComponent>;
  let comp: ComposeReportComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ComposeReportComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ComposeReportComponent);
    comp = fixture.componentInstance;
    fixture.detectChanges();
  });
  afterEach(() => http.verify());

  it('loads only when opened; shows masked recipients, declared vs applied purpose, reasons and refused attempts; legacy rows "Not recorded"', () => {
    http.expectNone(r => r.url.includes('compose-report'));
    comp.toggle();
    http.expectOne(r => r.url.endsWith('/mail/compose-report') && r.params.get('page') === '1').flush(REPORT);
    fixture.detectChanges();
    const rows = Array.from(el().querySelectorAll('.cr-table tbody tr'));
    expect(rows[0].textContent).toContain('k***@client.io');
    expect(rows[0].textContent).toContain('Transactional');
    expect(rows[0].textContent).toContain('Marketing');
    expect(rows[0].textContent).toContain('Promotional wording');
    expect(rows[0].classList).toContain('reclassified');
    expect(rows[1].textContent).toContain('Not recorded');
    expect(el().textContent).toContain('No permission for transactional');
    expect(el().textContent).toContain('up to 50, newest first');
  });

  it('says when the refused list is cut at 50', () => {
    comp.toggle();
    http.expectOne(r => r.url.endsWith('/mail/compose-report')).flush({ ...REPORT, refusedTruncated: true });
    fixture.detectChanges();
    expect(el().textContent).toContain('Showing the latest 50 refused attempts in this range; there are more');
  });

  it('sends the filters and pages through the server', () => {
    comp.toggle();
    http.expectOne(r => r.url.endsWith('/mail/compose-report')).flush(REPORT);
    comp.filters = { from: '2026-10-01', to: '2026-10-28', purpose: 'marketing' };
    comp.load(1);
    const req = http.expectOne(r => r.url.endsWith('/mail/compose-report'));
    expect(req.request.params.get('from')).toBe('2026-10-01');
    expect(req.request.params.get('to')).toBe('2026-10-28');
    expect(req.request.params.get('purpose')).toBe('marketing');
    req.flush(REPORT);
    fixture.detectChanges();
    (Array.from(el().querySelectorAll('.cr-pager button')).find(b => b.textContent!.includes('Next')) as HTMLButtonElement).click();
    expect(http.expectOne(r => r.url.endsWith('/mail/compose-report')).request.params.get('page')).toBe('2');
  });

  it('a 403 explains that only Owners and Admins can see it', () => {
    comp.toggle();
    http.expectOne(r => r.url.endsWith('/mail/compose-report')).flush({ error: 'x' }, { status: 403, statusText: 'x' });
    fixture.detectChanges();
    expect(el().textContent).toContain('Only workspace Owners and Admins');
  });
});
