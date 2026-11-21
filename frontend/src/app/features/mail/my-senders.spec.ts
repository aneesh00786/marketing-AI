import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MySendersComponent } from './my-senders.component';

describe('MySendersComponent ("My sender email")', () => {
  let fixture: ComponentFixture<MySendersComponent>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [MySendersComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(MySendersComponent);
    fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/mail/senders')).flush({ senders: [{ id: 1, email: 'anita@thrive-co.io', name: 'Anita', status: 'pending' }], required: true });
    fixture.detectChanges();
  });
  afterEach(() => http.verify());

  it('lists addresses with their status; adding one sends the confirmation link; resend for a pending one', () => {
    expect(el().textContent).toContain('anita@thrive-co.io');
    expect(el().textContent).toContain('Waiting for confirmation');
    expect(el().querySelector('.ms-alert')!.textContent).toContain('Needed to send email');
    const c = fixture.componentInstance;
    c.email = 'ravi@thrive-co.io'; c.name = 'Ravi';
    c.add();
    const req = http.expectOne(r => r.method === 'POST' && r.url.endsWith('/mail/senders'));
    expect(req.request.body).toEqual({ email: 'ravi@thrive-co.io', name: 'Ravi' });
    req.flush({ sender: { id: 2, email: 'ravi@thrive-co.io', status: 'pending' } });
    http.expectOne(r => r.method === 'GET' && r.url.endsWith('/mail/senders')).flush({ senders: [], required: true });
    expect(c.notice).toContain('confirmation link');
    c.resend({ id: 1, email: 'anita@thrive-co.io' });
    http.expectOne(r => r.method === 'POST' && r.url.endsWith('/mail/senders/1/resend')).flush({});
    http.expectOne(r => r.method === 'GET' && r.url.endsWith('/mail/senders')).flush({ senders: [], required: true });
  });

  it('a verified address can connect its own inbox: the login is that address, the password is sent once and cleared', () => {
    const c = fixture.componentInstance;
    c.load();
    http.expectOne(r => r.method === 'GET' && r.url.endsWith('/mail/senders')).flush({ senders: [{ id: 1, email: 'anita@thrive-co.io', status: 'verified', inbox: { connected: false } }], required: true });
    fixture.detectChanges();
    expect(el().textContent).toContain('Connect inbox');
    c.editInbox(c.senders[0]);
    expect(c.inboxHost).toBe('imap.zoho.com');
    c.inboxPassword = 'app-pass';
    c.saveInbox(c.senders[0]);
    const req = http.expectOne(r => r.method === 'PUT' && r.url.endsWith('/mail/senders/1/inbox'));
    expect(req.request.body).toEqual({ host: 'imap.zoho.com', port: 993, tls: true, password: 'app-pass' });
    req.flush({ sender: { id: 1, email: 'anita@thrive-co.io', status: 'verified', inbox: { connected: true, status: 'connected', host: 'imap.zoho.com', port: 993, login: 'anita@thrive-co.io' } } });
    expect(c.inboxPassword).toBe('');
    expect(c.notice).toContain('connected');
    http.expectOne(r => r.method === 'GET' && r.url.endsWith('/mail/senders')).flush({ senders: [{ id: 1, email: 'anita@thrive-co.io', status: 'verified', inbox: { connected: true, status: 'connected', host: 'imap.zoho.com', port: 993, login: 'anita@thrive-co.io' } }], required: true });
    fixture.detectChanges();
    expect(el().textContent).toContain('signs in as anita@thrive-co.io');
  });
});
