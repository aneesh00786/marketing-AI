import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MailTrackingSettingsComponent } from './mail-tracking-settings.component';

const settings = (o: any = {}) => ({
  configured: true, trackOpens: false, trackClicks: false, publicLinksAvailable: true, retentionDays: 395,
  zeptomail: { serverAllowsWebhook: false, endpoint: null }, ...o
});

describe('MailTrackingSettingsComponent', () => {
  let fixture: ComponentFixture<MailTrackingSettingsComponent>;
  let comp: MailTrackingSettingsComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const button = (t: string) => Array.from(el().querySelectorAll('button')).find(b => b.textContent!.trim().startsWith(t)) as HTMLButtonElement | undefined;

  function init(s: any = settings(), caps: string[] = ['mail.view', 'mail.configure']): void {
    fixture = TestBed.createComponent(MailTrackingSettingsComponent);
    comp = fixture.componentInstance;
    fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/mail/tracking/settings')).flush({ settings: s });
    http.expectOne(r => r.url.endsWith('/auth/me')).flush({ capabilities: caps });
    comp.open = true;
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [MailTrackingSettingsComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('is off by default and says so; saving sends only the two switches', async () => {
    init();
    expect(el().textContent).toContain('Open and click tracking off');
    const boxes = Array.from(el().querySelectorAll('.ts-policy input[type=checkbox]')) as HTMLInputElement[];
    await fixture.whenStable();
    expect(boxes.every(b => !b.checked)).toBeTrue();
    expect(button('Save')!.disabled).withContext('nothing changed').toBeTrue();
    comp.form.trackOpens = true;
    fixture.detectChanges();
    button('Save')!.click();
    const req = http.expectOne(r => r.method === 'PUT' && r.url.endsWith('/mail/tracking/settings'));
    expect(req.request.body).toEqual({ trackOpens: true, trackClicks: false });
    req.flush({ settings: settings({ trackOpens: true }) });
    fixture.detectChanges();
    expect(el().textContent).toContain('Tracking opens');
  });

  it('roles without mail.configure can read but not change anything', () => {
    init(settings(), ['mail.view', 'mail.send']);
    expect((el().querySelector('fieldset.ts-policy') as HTMLFieldSetElement).disabled).toBeTrue();
    expect(button('Save')).toBeUndefined();
    expect(el().textContent).toContain('Only workspace owners and admins can change tracking');
    expect(el().querySelector('input[type=password]')).toBeNull();
  });

  it('explains that the ZeptoMail webhook is off on this server and keeps "Turn on" disabled', () => {
    init(settings({ zeptomail: { serverAllowsWebhook: false, endpoint: { url: 'https://app.test/api/v1/mail/t/webhooks/zeptomail/' + 'a'.repeat(32), enabled: false, hasKey: true } } }));
    expect(el().textContent).toContain('Not available yet on this server');
    expect(button('Turn on')!.disabled).toBeTrue();
    expect(el().textContent).toContain('/api/v1/mail/t/webhooks/zeptomail/');
  });

  it('the webhook URL can be created before the key; the key is sent once and cleared, never shown', () => {
    init();
    button('Create webhook URL')!.click();
    let req = http.expectOne(r => r.method === 'PUT' && r.url.endsWith('/mail/tracking/zeptomail-webhook'));
    expect(req.request.body).toEqual({});
    req.flush({ settings: settings({ zeptomail: { serverAllowsWebhook: true, endpoint: { url: 'https://app.test/x', enabled: false, hasKey: false } } }) });
    fixture.detectChanges();
    comp.authKey = 'k'.repeat(24);
    fixture.detectChanges();
    button('Save key')!.click();
    req = http.expectOne(r => r.method === 'PUT' && r.url.endsWith('/mail/tracking/zeptomail-webhook'));
    expect(req.request.body).toEqual({ authKey: 'k'.repeat(24) });
    req.flush({ settings: settings({ zeptomail: { serverAllowsWebhook: true, endpoint: { url: 'https://app.test/x', enabled: false, hasKey: true } } }) });
    fixture.detectChanges();
    expect(comp.authKey).toBe('');
    expect(el().textContent).toContain('Key saved');
    button('Turn on')!.click();
    http.expectOne(r => r.method === 'PUT' && r.url.endsWith('/mail/tracking/zeptomail-webhook') && r.body.enabled === true).flush({ settings: settings() });
  });

  it('warns when SMTP opens/clicks cannot work without a public https address', () => {
    init(settings({ publicLinksAvailable: false }));
    comp.form.trackClicks = true;
    fixture.detectChanges();
    expect(el().textContent).toContain('need a public https address');
  });
});
