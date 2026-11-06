import { Component, EventEmitter, Input, Output } from '@angular/core';
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MailSettingsComponent } from './mail-settings.component';
import { MarketingDeliveryComponent } from './marketing-delivery.component';
import { MailTrackingSettingsComponent } from './mail-tracking-settings.component';
import { CampaignDeliveryComponent } from './campaign-delivery.component';

// The marketing and tracking panels are tested in their own specs.
@Component({ selector: 'app-marketing-delivery', standalone: true, template: '<p class="stub-marketing">marketing</p>' })
class MarketingStub { static last: MarketingStub | null = null; @Input() refreshKey = 0; @Output() toast = new EventEmitter<string>(); constructor() { MarketingStub.last = this; } }
@Component({ selector: 'app-mail-tracking-settings', standalone: true, template: '<p class="stub-tracking">tracking</p>' })
class TrackingStub { static last: TrackingStub | null = null; @Input() startOpen = false; @Output() toast = new EventEmitter<string>(); constructor() { TrackingStub.last = this; } }

// The Amazon SES connection: tested in campaign-delivery.spec.ts.
@Component({ selector: 'app-campaign-delivery', standalone: true, template: '<p class="stub-delivery">campaign sending</p>' })
class DeliveryStub { @Output() toast = new EventEmitter<string>(); }

const CONFIG = { provider: 'custom_smtp', smtp_host: 'smtp.acme.io', smtp_port: 587, smtp_secure: 0, smtp_user: 'hello@acme.io', imap_tls: 1, sender_email: 'hello@acme.io', has_smtp_auth: true, has_imap_auth: false, status: 'Connected' };

describe('MailSettingsComponent', () => {
  let fixture: ComponentFixture<MailSettingsComponent>;
  let comp: MailSettingsComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const button = (t: string) => Array.from(el().querySelectorAll('button')).find(b => b.textContent!.includes(t)) as HTMLButtonElement | undefined;

  function init(respond: (r: any) => void): void {
    fixture = TestBed.createComponent(MailSettingsComponent);
    comp = fixture.componentInstance;
    fixture.detectChanges();
    respond(http.expectOne(r => r.url.endsWith('/mail/config') && r.method === 'GET'));
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [MailSettingsComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    TestBed.overrideComponent(MailSettingsComponent, {
      remove: { imports: [MarketingDeliveryComponent, MailTrackingSettingsComponent, CampaignDeliveryComponent] },
      add: { imports: [MarketingStub, TrackingStub, DeliveryStub] }
    });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    // Opening and saving settings never sends mail.
    http.expectNone(r => /send/i.test(r.url));
    http.verify();
  });

  const tabs = () => Array.from(el().querySelectorAll('[role=tab]')) as HTMLButtonElement[];
  const openTab = (label: string) => { tabs().find(t => t.textContent!.trim() === label)!.click(); fixture.detectChanges(); };

  it('each setting has its own tab: Sending, Replies, Marketing, Tracking, Campaigns; only the open one is shown', async () => {
    init(r => r.flush({ config: CONFIG }));
    expect(tabs().map(t => t.textContent!.trim())).toEqual(['Sending', 'Replies (IMAP)', 'Marketing email', 'Tracking & privacy', 'Campaigns']);
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
    await fixture.whenStable();
    expect((el().querySelector('input[name=smtp_host]') as HTMLInputElement).value).toBe('smtp.acme.io');
    expect(el().querySelector('input[name=imap_host]')).withContext('IMAP is on its own tab').toBeNull();
    expect(el().querySelector('.stub-marketing')).toBeNull();
    expect(el().textContent).toContain('Sending set up');

    openTab('Replies (IMAP)');
    expect(el().querySelector('input[name=imap_host]')).toBeTruthy();
    expect(el().querySelector('input[name=smtp_host]')).toBeNull();
    expect(el().textContent).toContain('Not connected');

    openTab('Marketing email');
    expect(el().querySelector('.stub-marketing')).toBeTruthy();
    expect(el().querySelector('form')).toBeNull();

    openTab('Tracking & privacy');
    expect(TrackingStub.last!.startOpen).withContext('tracking is expanded in its tab').toBeTrue();
  });

  it('arrow keys move between the settings tabs', fakeAsync(() => {
    init(r => r.flush({ config: CONFIG }));
    tabs()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    fixture.detectChanges();
    tick();
    expect(comp.tab).toBe('campaigns');
    expect(tabs().map(t => t.tabIndex)).toEqual([-1, -1, -1, -1, 0]);
  }));

  it('saving the mailbox tells the shell and reloads the marketing approval (a new account clears it)', () => {
    init(r => r.flush({ config: CONFIG }));
    let changed = 0;
    comp.changed.subscribe(() => changed++);
    const before = comp.version;
    button('Save mailbox settings')!.click();
    const req = http.expectOne(r => r.url.endsWith('/mail/config') && r.method === 'POST');
    expect(req.request.body.smtp_host).toBe('smtp.acme.io');
    expect(req.request.body.smtp_secure).toBe(0);
    expect(req.request.body.imap_tls).toBe(1);
    req.flush({ config: CONFIG });
    fixture.detectChanges();
    expect(changed).toBe(1);
    openTab('Marketing email');
    expect(MarketingStub.last!.refreshKey).toBe(before + 1);
  });

  it('ZeptoMail is a choice, hides SMTP host fields and explains marketing needs an SMTP mailbox', () => {
    init(r => r.flush({ config: { ...CONFIG, provider: 'zeptomail' } }));
    expect(el().querySelector('input[name=smtp_host]')).toBeNull();
    expect(el().textContent).toContain('Marketing email');
    expect(el().textContent).toContain('needs your own SMTP mailbox');
  });

  it('a connection test shows its result next to the button', () => {
    init(r => r.flush({ config: CONFIG }));
    button('Test connection')!.click();
    http.expectOne(r => r.url.includes('/mail/config/test') || r.url.includes('test-smtp')).flush({ success: false, error: 'Authentication failed' });
    fixture.detectChanges();
    expect(el().querySelector('.ms-result.bad')!.textContent).toContain('Authentication failed');
  });

  it('members who cannot configure mail see why instead of an empty form', () => {
    init(r => r.flush({ error: 'Forbidden' }, { status: 403, statusText: 'Forbidden' }));
    expect(el().querySelector('form')).toBeNull();
    expect(el().textContent).toContain('Only workspace Owners and Admins');
    openTab('Marketing email');
    expect(el().querySelector('.stub-marketing')).withContext('marketing status is still shown').toBeTruthy();
  });

  it('the Campaigns tab holds the Amazon SES connection and links to Campaigns', () => {
    init(r => r.flush({ config: CONFIG }));
    openTab('Campaigns');
    expect(el().querySelector('.stub-delivery')).toBeTruthy();
    const opened: string[] = [];
    comp.openSection.subscribe(s => opened.push(s));
    (el().querySelector('.ms-campaigns .link-btn') as HTMLButtonElement).click();
    expect(opened).toEqual(['campaigns']);
  });

  it('can open straight on the Campaigns tab (from the Campaigns "Set up Amazon SES" link)', () => {
    fixture = TestBed.createComponent(MailSettingsComponent);
    comp = fixture.componentInstance;
    comp.initialTab = 'campaigns';
    fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/mail/config')).flush({ config: CONFIG });
    fixture.detectChanges();
    expect(comp.tab).toBe('campaigns');
    expect(el().querySelector('.stub-delivery')).toBeTruthy();
  });
});
