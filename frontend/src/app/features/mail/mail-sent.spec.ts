import { Component, Input } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MailSentComponent } from './mail-sent.component';
import { EmailTrackingComponent } from './email-tracking.component';

@Component({ selector: 'app-email-tracking', standalone: true, template: '<p class="stub-tracking">tracking {{ emailId }}</p>' })
class TrackingStub { @Input() emailId: number | null = null; }

const LIST = { page: 1, hasMore: false, emails: [
  { id: 9, to: 'kim@client.io', toName: 'Kim', subject: 'Order shipped', preview: 'Your order…', sentAt: '2026-10-28 10:00:00', delivery: 'opened', purpose: 'transactional', source: 'compose', provider: 'zeptomail', failure: null },
  { id: 8, to: 'lee@client.io', toName: null, subject: 'Spring offer', preview: 'Save…', sentAt: '2026-10-27 10:00:00', delivery: 'sent', purpose: 'marketing', source: 'draft', provider: null, failure: null },
  { id: 6, to: 'max@client.io', toName: null, subject: 'Setup', preview: '', sentAt: '2026-10-26 10:00:00', delivery: 'not_sent', purpose: null, source: null, provider: null, failure: 'SMTP login failed' }
] };

describe('MailSentComponent', () => {
  let fixture: ComponentFixture<MailSentComponent>;
  let comp: MailSentComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const button = (t: string) => Array.from(el().querySelectorAll('button')).find(b => b.textContent!.includes(t)) as HTMLButtonElement | undefined;
  const items = () => Array.from(el().querySelectorAll('.mb-item')) as HTMLButtonElement[];
  const sent = () => http.expectOne(r => r.url.endsWith('/emails/sent'));

  function init(initialStatus: string | null = null): void {
    fixture = TestBed.createComponent(MailSentComponent);
    comp = fixture.componentInstance;
    comp.initialStatus = initialStatus;
    fixture.componentRef.setInput('refreshKey', 0);
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [MailSentComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    TestBed.overrideComponent(MailSentComponent, { remove: { imports: [EmailTrackingComponent] }, add: { imports: [TrackingStub] } });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    http.expectNone(r => /\/send/.test(r.url));
    http.verify();
  });

  it('lists sent mail with recipient, status and purpose; statuses stay distinct', () => {
    init();
    sent().flush(LIST);
    fixture.detectChanges();
    const tags = items().map(i => Array.from(i.querySelectorAll('.mx-tag')).map(t => t.textContent!.trim()));
    expect(tags).toEqual([['Opened', 'Transactional / Direct'], ['Sent', 'Marketing'], ['Not sent', 'Not recorded']]);
    expect(items()[0].textContent).toContain('To: Kim');
    expect(el().textContent).toContain('an open does not prove a person read the email');
  });

  it('opening a sent email shows details, purpose, source and the tracking timeline', () => {
    init();
    sent().flush(LIST);
    fixture.detectChanges();
    items()[0].click();
    http.expectOne(r => r.url.endsWith('/emails/9')).flush({ email: { id: 9, direction: 'sent', subject: 'Order shipped', recipient_email: 'kim@client.io', sender_email: 'hello@a.io', sent_at: '2026-10-28 10:00:00', body: 'Shipped today', delivery: 'opened', purpose: 'transactional', source: 'compose', provider: 'zeptomail', failure: null } });
    fixture.detectChanges();
    const read = el().querySelector('.mb-read')!.textContent!;
    expect(read).toContain('Transactional / Direct');
    expect(read).toContain('Compose · via ZeptoMail');
    expect(read).toContain('Shipped today');
    expect(el().querySelector('.stub-tracking')!.textContent).toContain('9');
    expect(button('Send again')).toBeUndefined();
  });

  it('a failed email shows why, has no tracking, and "Send again" opens Compose', () => {
    init();
    sent().flush(LIST);
    fixture.detectChanges();
    items()[2].click();
    http.expectOne(r => r.url.endsWith('/emails/6')).flush({ email: { id: 6, direction: 'not_sent', subject: 'Setup', recipient_email: 'max@client.io', body: 'x', delivery: 'not_sent', failure: 'SMTP login failed' } });
    fixture.detectChanges();
    expect(el().textContent).toContain('SMTP login failed');
    expect(el().querySelector('.stub-tracking')).toBeNull();
    const again: any[] = [];
    comp.sendAgain.subscribe(e => again.push(e.id));
    button('Send again')!.click();
    expect(again).toEqual([6]);
  });

  it('filters by text, status, purpose and dates on the server; opens with a preset status', () => {
    init('not_sent');
    expect(sent().request.params.get('status')).toBe('not_sent');
    comp.filters = { q: 'kim', status: 'bounced', purpose: 'marketing', from: '2026-10-01', to: '2026-10-28' };
    comp.load(1);
    const req = sent();
    expect(['q', 'status', 'purpose', 'from', 'to'].map(k => req.request.params.get(k))).toEqual(['kim', 'bounced', 'marketing', '2026-10-01', '2026-10-28']);
    req.flush({ page: 1, hasMore: false, emails: [] });
    fixture.detectChanges();
    expect(el().textContent).toContain('No sent emails match these filters.');
  });

  it('empty and error states', () => {
    init();
    sent().flush({ page: 1, hasMore: false, emails: [] });
    fixture.detectChanges();
    expect(el().textContent).toContain('Nothing has been sent from this workspace yet.');
    comp.load(1);
    sent().flush({ error: 'Not allowed' }, { status: 403, statusText: 'x' });
    fixture.detectChanges();
    expect(el().querySelector('[role=alert]')!.textContent).toContain('Not allowed');
  });

  it('reloads when the shell reports a new send', () => {
    init();
    sent().flush(LIST);
    fixture.componentRef.setInput('refreshKey', 1);
    fixture.detectChanges();
    sent().flush(LIST);
  });
});
