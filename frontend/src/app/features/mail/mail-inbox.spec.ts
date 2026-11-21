import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MailInboxComponent } from './mail-inbox.component';
import { SendersUiService } from '../../core/senders-ui.service';

const LIST = { page: 1, hasMore: true, unread: 1, emails: [
  { id: 7, from: 'kim@client.io', fromName: 'Kim', to: 'hello@a.io', subject: 'Question about pricing', preview: 'Hi, could you…', receivedAt: '2026-10-28 10:00:00', read: false, urgent: true, hasHtml: false },
  { id: 5, from: 'lee@client.io', fromName: null, to: 'hello@a.io', subject: 'Thanks', preview: 'Got it', receivedAt: '2026-10-27 09:00:00', read: true, urgent: false, hasHtml: true }
] };
const DETAIL = { id: 7, direction: 'received', read: false, sender: 'Kim', sender_email: 'kim@client.io', recipient_email: 'hello@a.io', subject: 'Question about pricing', body: 'Hi, could you send prices?', received_at: '2026-10-28 10:00:00', ai_summary: 'Asks for prices', ai_replies: ['Sure, here they are'] };

describe('MailInboxComponent', () => {
  let fixture: ComponentFixture<MailInboxComponent>;
  let comp: MailInboxComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const button = (t: string) => Array.from(el().querySelectorAll('button')).find(b => b.textContent!.includes(t)) as HTMLButtonElement | undefined;
  const items = () => Array.from(el().querySelectorAll('.mb-item')) as HTMLButtonElement[];
  const inbox = () => http.expectOne(r => r.url.endsWith('/emails/inbox'));
  const senders = () => http.expectOne(r => r.url.endsWith('/mail/senders') && r.method === 'GET');
  const CONNECTED = { senders: [{ id: 1, email: 'anita@a-co.io', status: 'verified', inbox: { connected: true, host: 'imap.zoho.com', status: 'connected', error: null } }] };
  const NOT_CONNECTED = { senders: [{ id: 1, email: 'anita@a-co.io', status: 'verified', inbox: { connected: false } }] };

  function init(imapReady: boolean | null = true, list: any = LIST, mine: any = CONNECTED): void {
    fixture = TestBed.createComponent(MailInboxComponent);
    comp = fixture.componentInstance;
    comp.imapReady = imapReady;
    comp.canConfigure = true;
    fixture.detectChanges();
    inbox().flush(JSON.parse(JSON.stringify(list)));
    senders().flush(JSON.parse(JSON.stringify(mine)));
    fixture.detectChanges();
  }
  function openFirst(): void {
    items()[0].click();
    http.expectOne(r => r.url.endsWith('/emails/7') && r.method === 'GET').flush({ email: { ...DETAIL } });
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [MailInboxComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    // The inbox never sends mail.
    http.expectNone(r => /\/send/.test(r.url));
    http.verify();
  });

  it('lists received mail with sender, subject, preview, time and unread state', () => {
    init();
    expect(items().length).toBe(2);
    expect(items()[0].classList).toContain('unread');
    expect(items()[1].classList).not.toContain('unread');
    expect(items()[0].textContent).toContain('Kim');
    expect(items()[0].textContent).toContain('Question about pricing');
    expect(items()[0].textContent).toContain('Urgent');
    expect(el().textContent).toContain('Select an email to read it.');
  });

  it('opening an unread email shows it and marks it read; the unread count follows', () => {
    init();
    const counts: number[] = [];
    comp.changed.subscribe(n => counts.push(n));
    items()[0].click();
    http.expectOne(r => r.url.endsWith('/emails/7')).flush({ email: { ...DETAIL } });
    const mark = http.expectOne(r => r.url.endsWith('/emails/7/read') && r.method === 'PUT');
    expect(mark.request.body).toEqual({ read: true });
    mark.flush({ success: true, id: 7, read: true });
    fixture.detectChanges();
    expect(el().querySelector('.mb-read h3')!.textContent).toContain('Question about pricing');
    expect(el().textContent).toContain('Hi, could you send prices?');
    expect(el().textContent).toContain('Asks for prices');
    expect(items()[0].classList).not.toContain('unread');
    expect(counts).toEqual([0]);
    button('Mark as unread')!.click();
    http.expectOne(r => r.url.endsWith('/emails/7/read')).flush({ success: true, id: 7, read: false });
    expect(counts).toEqual([0, 1]);
  });

  it('reply, forward and suggested replies are handed to Compose', () => {
    init();
    items()[0].click();
    http.expectOne(r => r.url.endsWith('/emails/7')).flush({ email: { ...DETAIL, read: true } });
    fixture.detectChanges();
    const got: any[] = [];
    comp.reply.subscribe(e => got.push(['reply', e.id]));
    comp.forward.subscribe(e => got.push(['forward', e.id]));
    comp.smartReply.subscribe(e => got.push(['smart', e.reply]));
    button('Reply')!.click();
    button('Forward')!.click();
    button('Sure, here they are')!.click();
    expect(got).toEqual([['reply', 7], ['forward', 7], ['smart', 'Sure, here they are']]);
  });

  it('search, read filter and dates go to the server; empty results offer to clear filters', () => {
    init();
    comp.filters = { q: 'pricing', read: 'unread', folder: '', from: '2026-10-01', to: '2026-10-28' };
    button('Search')!.click();
    const req = inbox();
    expect(['q', 'read', 'from', 'to'].map(k => req.request.params.get(k))).toEqual(['pricing', 'unread', '2026-10-01', '2026-10-28']);
    req.flush({ page: 1, hasMore: false, unread: 0, emails: [] });
    fixture.detectChanges();
    expect(el().textContent).toContain('No emails match these filters.');
    button('Clear filters')!.click();
    expect(inbox().request.params.keys()).withContext('filters cleared').toEqual(['page']);
  });

  it('pages through older mail', () => {
    init();
    button('Older')!.click();
    expect(inbox().request.params.get('page')).toBe('2');
  });

  it('without a reply mailbox it explains that nothing is received and links to setup (no sync button)', () => {
    init(false, { page: 1, hasMore: false, unread: 0, emails: [] }, NOT_CONNECTED);
    expect(el().textContent).toContain('New mail is not being received.');
    expect(el().textContent).toContain('ZeptoMail and Amazon SES only send email');
    expect(button('Sync inbox')).toBeUndefined();
    let opened = false;
    comp.openSettings.subscribe(() => opened = true);
    button('Set up replies (IMAP)')!.click();
    expect(opened).toBeTrue();
  });

  it('load errors show a retry', () => {
    fixture = TestBed.createComponent(MailInboxComponent);
    comp = fixture.componentInstance;
    fixture.detectChanges();
    inbox().flush({ error: 'Database unavailable' }, { status: 500, statusText: 'x' });
    senders().flush(CONNECTED);
    fixture.detectChanges();
    expect(el().querySelector('[role=alert]')!.textContent).toContain('Database unavailable');
    button('Try again')!.click();
    inbox().flush(LIST);
  });

  it('sync fetches new mail from the mailbox, then reloads', () => {
    init();
    button('Sync inbox')!.click();
    http.expectOne(r => r.url.endsWith('/mail/sync')).flush({ success: true, message: 'Synced 2' });
    inbox().flush(LIST);
    senders().flush(CONNECTED);
  });

  it('without your own inbox connected it says where replies go and opens "My sender email" to connect it', () => {
    init(true, LIST, NOT_CONNECTED);
    expect(el().textContent).toContain('Your inbox is not connected.');
    expect(el().textContent).toContain('Replies to your emails go to anita@a-co.io');
    const ui = TestBed.inject(SendersUiService);
    let opened = 0;
    ui.open$.subscribe(() => opened++);
    button('Connect my inbox')!.click();
    button('Set up my inbox')!.click();
    expect(opened).toBe(2);
    // Connected in the window: the Inbox reloads it and the reminder goes.
    ui.changed$.next();
    senders().flush(CONNECTED);
    fixture.detectChanges();
    expect(el().textContent).not.toContain('Your inbox is not connected.');
    expect(button('My inbox')).toBeDefined();
  });

  it('with only your own inbox (no workspace mailbox) Sync syncs your inbox; a sync problem is shown with a fix link', () => {
    init(false, LIST, CONNECTED);
    expect(el().textContent).not.toContain('New mail is not being received.');
    button('Sync inbox')!.click();
    http.expectOne(r => r.url.endsWith('/mail/senders/inbox/sync') && r.method === 'POST').flush({ synced: 1, failed: 0, fetchedCount: 2 });
    inbox().flush(LIST);
    senders().flush({ senders: [{ id: 1, email: 'anita@a-co.io', status: 'verified', inbox: { connected: true, status: 'error', error: 'Mailbox authentication failed.' } }] });
    fixture.detectChanges();
    expect(el().textContent).toContain('Your inbox could not be synced.');
    expect(button('Fix inbox settings')).toBeDefined();
  });

  it('arrow keys move through the list', fakeAsync(() => {
    init();
    openFirst();
    http.expectOne(r => r.url.endsWith('/emails/7/read')).flush({ success: true });
    el().querySelector('.mb-list')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    tick();
    http.expectOne(r => r.url.endsWith('/emails/5')).flush({ email: { ...DETAIL, id: 5, read: true, subject: 'Thanks' } });
    expect(comp.selectedId).toBe(5);
  }));

  it('Spam is a folder of its own; an email shows its attachments, which download as files', () => {
    init();
    comp.filters.folder = 'spam';
    comp.load(1);
    expect(inbox().request.params.get('folder')).toBe('spam');
    items()[0].click();
    http.expectOne(r => r.url.endsWith('/emails/7') && r.method === 'GET').flush({ email: { ...DETAIL, spam: true, inReplyTo: { id: 3, subject: 'Our offer', sentAt: '2026-10-20T10:00:00Z' },
      attachments: [{ id: 11, filename: 'invoice.pdf', contentType: 'application/pdf', size: 2048, stored: true }, { id: 12, filename: 'huge.zip', size: 40 * 1024 * 1024, stored: false }] } });
    http.expectOne(r => r.url.endsWith('/emails/7/read')).flush({ success: true });
    fixture.detectChanges();
    expect(el().textContent).toContain('was in the Spam folder');
    expect(el().textContent).toContain('Your email “Our offer”');
    expect(el().textContent).toContain('too large to keep here');
    spyOn(URL, 'createObjectURL').and.returnValue('blob:x');
    button('invoice.pdf')!.click();
    const dl = http.expectOne(r => r.url.endsWith('/emails/7/attachments/11'));
    expect(dl.request.responseType).toBe('blob');
    dl.flush(new Blob(['%PDF']));
  });
});
