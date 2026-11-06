import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { CampaignDeliveryComponent } from './campaign-delivery.component';

const SETTINGS = (over: any = {}) => ({
  provider: 'zoho', canConfigure: true,
  ses: { configured: false, source: null, region: null, accessKeyId: null, hasSecret: false, configurationSet: null, maxPerSecond: null, notificationUrl: 'https://app.test/api/v1/mail/t/webhooks/ses/abc', snsTopicArn: null, lastCheckedAt: null, lastError: null, ...(over.ses || {}) },
  ...over, ...(over.ses ? { ses: { configured: false, source: null, region: null, accessKeyId: null, hasSecret: false, configurationSet: null, maxPerSecond: null, notificationUrl: 'https://app.test/api/v1/mail/t/webhooks/ses/abc', snsTopicArn: null, ...over.ses } } : {})
});

describe('CampaignDeliveryComponent (Mail Settings → Campaign sending)', () => {
  let fixture: ComponentFixture<CampaignDeliveryComponent>;
  let comp: CampaignDeliveryComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const url = '/api/v1/mail/ses/settings';

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [CampaignDeliveryComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(CampaignDeliveryComponent);
    comp = fixture.componentInstance;
    fixture.detectChanges();
  });
  afterEach(() => http.verify());

  it('Zoho is the default; Amazon SES can be chosen only once its connection is set up', () => {
    http.expectOne(r => r.url.endsWith(url)).flush(SETTINGS());
    fixture.detectChanges();
    const radios = Array.from(el().querySelectorAll('input[type=radio]')) as HTMLInputElement[];
    expect(radios.map(r => r.checked)).toEqual([true, false]);
    expect(radios[1].disabled).withContext('SES not set up').toBeTrue();
    expect(el().textContent).toContain('Set up the connection below first.');
  });

  it('saves the connection without ever sending an empty secret; the secret is never shown back', () => {
    http.expectOne(r => r.url.endsWith(url)).flush(SETTINGS());
    comp.form = { region: 'ap-south-1', accessKeyId: 'AKIATESTKEY0000001', secretAccessKey: 's3cret/abcdefghijklmnop', configurationSet: 'marketech-events', maxPerSecond: 14 };
    comp.save();
    const put = http.expectOne(r => r.method === 'PUT' && r.url.endsWith(url));
    expect(put.request.body).toEqual({ region: 'ap-south-1', accessKeyId: 'AKIATESTKEY0000001', secretAccessKey: 's3cret/abcdefghijklmnop', configurationSet: 'marketech-events', maxPerSecond: 14 });
    put.flush(SETTINGS({ ses: { configured: true, source: 'workspace', region: 'ap-south-1', accessKeyId: 'AKIA…0001', hasSecret: true, configurationSet: 'marketech-events', maxPerSecond: 14 } }));
    fixture.detectChanges();
    expect(comp.form.secretAccessKey).toBe('', 'cleared after saving');
    expect((el().querySelector('input[name=secret]') as HTMLInputElement).placeholder).toContain('Saved');
    // Saving again without typing a secret keeps the saved one (none is sent).
    comp.save();
    const again = http.expectOne(r => r.method === 'PUT' && r.url.endsWith(url));
    expect('secretAccessKey' in again.request.body).toBeFalse();
    again.flush(SETTINGS({ ses: { configured: true, source: 'workspace', hasSecret: true } }));
  });

  it('choosing Amazon SES asks first; the test shows the account state; the SNS endpoint is shown with the steps', () => {
    http.expectOne(r => r.url.endsWith(url)).flush(SETTINGS({ ses: { configured: true, source: 'workspace', region: 'us-east-1', hasSecret: true } }));
    fixture.detectChanges();
    expect(el().textContent).toContain('https://app.test/api/v1/mail/t/webhooks/ses/abc');
    expect(el().textContent).toContain('No SNS subscription confirmed yet.');
    spyOn(window, 'confirm').and.returnValue(true);
    comp.setProvider('ses');
    const put = http.expectOne(r => r.method === 'PUT' && r.url.endsWith(url));
    expect(put.request.body).toEqual({ provider: 'ses' });
    put.flush(SETTINGS({ provider: 'ses', ses: { configured: true } }));
    comp.test();
    http.expectOne(r => r.method === 'POST' && r.url.endsWith('/api/v1/mail/ses/test')).flush({ ok: true, account: { productionAccess: false }, message: 'Connected, but the account is in the SES sandbox.' });
    fixture.detectChanges();
    const result = el().querySelector('.cd-result') as HTMLElement;
    expect(result.textContent).toContain('sandbox');
    expect(result.classList.contains('ok')).toBeFalse();
  });
});
