import { Component, Input } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MailLogsComponent } from './mail-logs.component';
import { ComposeReportComponent } from './compose-report.component';

@Component({ selector: 'app-compose-report', standalone: true, template: '<p class="stub-audit">audit</p>' })
class AuditStub { @Input() startOpen = false; }

const CAMPAIGNS = { page: 1, hasMore: false, campaigns: [
  { type: 'ai', id: 1, name: 'Spring sequence', status: 'active', recipients: 3, sent: 2, failed: 1, replied: 1, bounced: 1, opened: null, lastActivityAt: '2026-10-28 10:00:00' },
  { type: 'zoho', id: 6, name: 'Newsletter', status: 'submitted', recipients: null, sent: 120, failed: null, replied: null, bounced: 2, opened: 40, lastActivityAt: '2026-10-20 10:00:00' }
] };

describe('MailLogsComponent', () => {
  let fixture: ComponentFixture<MailLogsComponent>;
  let comp: MailLogsComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const tab = (t: string) => Array.from(el().querySelectorAll('[role=tab]')).find(b => b.textContent!.trim() === t) as HTMLButtonElement | undefined;
  const rows = () => Array.from(el().querySelectorAll('tbody tr')).map(r => r.textContent!.replace(/\s+/g, ' ').trim());

  function init(canViewAudit = false): void {
    fixture = TestBed.createComponent(MailLogsComponent);
    comp = fixture.componentInstance;
    comp.canViewAudit = canViewAudit;
    fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/mail/activity/campaigns')).flush(CAMPAIGNS);
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [MailLogsComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    TestBed.overrideComponent(MailLogsComponent, { remove: { imports: [ComposeReportComponent] }, add: { imports: [AuditStub] } });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('the campaign log lists AI and Zoho campaigns; unavailable numbers show as —', () => {
    init();
    expect(tab('Campaign log')!.getAttribute('aria-selected')).toBe('true');
    const cells = (i: number) => Array.from(el().querySelectorAll('tbody tr')[i].querySelectorAll('td')).slice(0, 9).map(c => c.textContent!.trim());
    expect(cells(0)).toEqual(['Spring sequence', 'AI Campaign', 'Sending', '3', '2', '—', '1', '1', '1']);
    expect(cells(1)).toEqual(['Newsletter', 'Zoho', 'Submitted to Zoho', '—', '120', '40', '—', '2', '—']);
    const opened: string[] = [];
    comp.openSection.subscribe(s => opened.push(s));
    Array.from(el().querySelectorAll('button')).find(b => b.textContent!.includes('Open Campaigns'))!.click();
    expect(opened).toEqual(['campaigns']);
  });

  it('the type filter reloads from the server', () => {
    init();
    comp.campaignType = 'zoho';
    comp.loadCampaigns(1);
    const req = http.expectOne(r => r.url.endsWith('/mail/activity/campaigns'));
    expect(req.request.params.get('type')).toBe('zoho');
    req.flush({ page: 1, hasMore: false, campaigns: [] });
    fixture.detectChanges();
    expect(el().textContent).toContain('No campaigns yet.');
  });

  it('the Compose audit tab is offered to Owners/Admins only', () => {
    init();
    expect(tab('Compose audit')).toBeUndefined();
    fixture.destroy();
    init(true);
    tab('Compose audit')!.click();
    fixture.detectChanges();
    expect(el().querySelector('.stub-audit')).toBeTruthy();
  });
});
