import { Component, Input } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MailLogsComponent } from './mail-logs.component';
import { ComposeReportComponent } from './compose-report.component';

@Component({ selector: 'app-compose-report', standalone: true, template: '<p class="stub-audit">audit</p>' })
class AuditStub { @Input() startOpen = false; }

const CAMPAIGNS = { page: 1, hasMore: false, campaigns: [
  { type: 'ai', id: 1, name: 'Spring sequence', status: 'active', recipients: 3, sent: 2, failed: 1, replied: 1, bounced: 1, opened: null, sentAt: '2026-10-28 10:00:00' },
  { type: 'zoho', id: 6, name: 'Newsletter', status: 'submitted', recipients: null, sent: 120, failed: null, replied: null, bounced: 2, opened: 40, sentAt: '2026-10-20 10:00:00' }
] };
const EMAILS = { page: 1, hasMore: true, emails: [
  { id: 9, to: 'kim@client.io', toName: 'Kim', subject: 'Order shipped', sentAt: '2026-10-28 10:00:00', delivery: 'opened', purpose: 'transactional', source: 'compose' }
] };
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

describe('MailLogsComponent', () => {
  let fixture: ComponentFixture<MailLogsComponent>;
  let comp: MailLogsComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const tab = (t: string) => Array.from(el().querySelectorAll('[role=tab]')).find(b => b.textContent!.trim() === t) as HTMLButtonElement | undefined;
  const button = (t: string) => Array.from(el().querySelectorAll('button')).find(b => b.textContent!.trim() === t) as HTMLButtonElement | undefined;
  const campaignsReq = () => http.expectOne(r => r.url.endsWith('/mail/activity/campaigns'));
  const emailsReq = () => http.expectOne(r => r.url.endsWith('/emails/sent'));

  function init(canViewAudit = false): void {
    fixture = TestBed.createComponent(MailLogsComponent);
    comp = fixture.componentInstance;
    comp.canViewAudit = canViewAudit;
    fixture.detectChanges();
    campaignsReq().flush(CAMPAIGNS);
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [MailLogsComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    TestBed.overrideComponent(MailLogsComponent, { remove: { imports: [ComposeReportComponent] }, add: { imports: [AuditStub] } });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('has Sent campaigns and Sent emails (and the Compose audit for Owners/Admins only)', () => {
    init();
    expect(Array.from(el().querySelectorAll('[role=tab]')).map(t => t.textContent!.trim())).toEqual(['Sent campaigns', 'Sent emails']);
    fixture.destroy();
    init(true);
    tab('Compose audit')!.click();
    fixture.detectChanges();
    expect(el().querySelector('.stub-audit')).toBeTruthy();
    expect(el().querySelector('.ml-dates')).withContext('the audit has its own dates').toBeNull();
  });

  it('the sent campaign log shows when each was sent; unavailable numbers show as —', () => {
    init();
    const cells = (i: number) => Array.from(el().querySelectorAll('tbody tr')[i].querySelectorAll('td')).slice(1, 10).map(c => c.textContent!.trim());
    expect(cells(0)).toEqual(['Spring sequence', 'AI Campaign', 'Sending', '3', '2', '—', '1', '1', '1']);
    expect(cells(1)).toEqual(['Newsletter', 'Zoho', 'Submitted to Zoho', '—', '120', '40', '—', '2', '—']);
    expect(el().querySelector('tbody td')!.textContent).toContain('Oct 28, 2026');
  });

  it('From/To dates filter the sent campaigns on the server; the column says "Sent in period"', () => {
    init();
    comp.range = { from: '2026-10-01', to: '2026-10-28' };
    comp.applyRange();
    const req = campaignsReq();
    expect([req.request.params.get('from'), req.request.params.get('to')]).toEqual(['2026-10-01', '2026-10-28']);
    req.flush({ page: 1, hasMore: false, campaigns: [] });
    fixture.detectChanges();
    expect(el().textContent).toContain('No campaign sent in this period.');
  });

  it('quick ranges set the dates (today included) and All dates clears them', () => {
    init();
    button('Last 7 days')!.click();
    const req = campaignsReq();
    const today = new Date();
    expect(req.request.params.get('to')).toBe(isoDay(today));
    expect(req.request.params.get('from')).toBe(isoDay(new Date(today.getTime() - 6 * 86400000)));
    req.flush(CAMPAIGNS);
    fixture.detectChanges();
    expect(button('Last 7 days')!.getAttribute('aria-pressed')).toBe('true');
    button('All dates')!.click();
    const all = campaignsReq();
    expect(all.request.params.has('from')).toBeFalse();
    all.flush(CAMPAIGNS);
  });

  it('a From date after the To date is refused without a request', () => {
    init();
    comp.range = { from: '2026-10-28', to: '2026-10-01' };
    comp.applyRange();
    fixture.detectChanges();
    expect(el().textContent).toContain('The From date is after the To date.');
    http.expectNone(r => r.url.endsWith('/mail/activity/campaigns'));
  });

  it('Sent emails lists only emails that went out (sentOnly), with the same dates and a search', () => {
    init();
    comp.range = { from: '2026-10-01', to: '2026-10-28' };
    tab('Sent emails')!.click();
    const req = emailsReq();
    expect(['sentOnly', 'from', 'to'].map(k => req.request.params.get(k))).toEqual(['1', '2026-10-01', '2026-10-28']);
    req.flush(EMAILS);
    fixture.detectChanges();
    const cells = Array.from(el().querySelector('tbody tr')!.querySelectorAll('td')).map(c => c.textContent!.trim());
    expect(cells.slice(1)).toEqual(['Kim · kim@client.io', 'Order shipped', 'Transactional / Direct', 'Compose', 'Opened']);
    comp.emailQuery = 'kim';
    comp.loadEmails(1);
    expect(emailsReq().request.params.get('q')).toBe('kim');
  });

  it('the type filter and links work', () => {
    init();
    comp.campaignType = 'zoho';
    comp.loadCampaigns(1);
    expect(campaignsReq().request.params.get('type')).toBe('zoho');
    const opened: string[] = [];
    comp.openSection.subscribe(s => opened.push(s));
    Array.from(el().querySelectorAll('button')).find(b => b.textContent!.includes('Open Campaigns'))!.click();
    expect(opened).toEqual(['campaigns']);
  });
});
