import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { CampaignDeliveryComponent } from './campaign-delivery.component';

const SETTINGS = (over: any = {}) => ({
  provider: 'ses', canConfigure: true,
  ses: { configured: false, source: null, region: null, accessKeyId: null, hasSecret: false, configurationSet: null, maxPerSecond: null, notificationUrl: 'https://app.test/api/v1/mail/t/webhooks/ses/abc', snsTopicArn: null, lastCheckedAt: null, lastError: null, ...(over.ses || {}) },
  ...over, ...(over.ses ? { ses: { configured: false, source: null, region: null, accessKeyId: null, hasSecret: false, configurationSet: null, maxPerSecond: null, notificationUrl: 'https://app.test/api/v1/mail/t/webhooks/ses/abc', snsTopicArn: null, ...over.ses } } : {})
});

describe('CampaignDeliveryComponent (Mail Settings → Campaigns)', () => {
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
  /** The business address is loaded with the page. */
  const flushProfile = (address: string | null = null) => http.expectOne(r => r.method === 'GET' && r.url.endsWith('/api/v1/business-profile')).flush({ businessProfile: address === null ? null : { address } });

  it('the business address is loaded, edited and saved for $[HF:ORGADDRESS]$', () => {
    flushProfile('1 Main St');
    http.expectOne(r => r.url.endsWith(url)).flush(SETTINGS());
    fixture.detectChanges();
    expect(comp.address).toBe('1 Main St');
    comp.address = 'Level 2, 10 Marine Drive\nKochi';
    comp.saveAddress();
    const put = http.expectOne(r => r.method === 'PUT' && r.url.endsWith('/api/v1/business-profile'));
    expect(put.request.body).toEqual({ address: 'Level 2, 10 Marine Drive\nKochi' });
    put.flush({ businessProfile: { address: 'Level 2, 10 Marine Drive\nKochi' } });
    expect(comp.savedAddress).toBe('Level 2, 10 Marine Drive\nKochi');
    comp.saveAddress();
    http.expectNone(r => r.method === 'PUT');
  });

  it('says what is missing until the Amazon SES connection is set up', () => {
    flushProfile(); http.expectOne(r => r.url.endsWith(url)).flush(SETTINGS());
    fixture.detectChanges();
    expect(el().querySelectorAll('input[type=radio]').length).withContext('Amazon SES is the only sender: nothing to choose').toBe(0);
    expect(el().textContent).toContain('Not set up yet: region, access key ID, secret access key are missing.');
    expect(el().textContent).withContext('the SNS steps show even before the connection is complete').toContain('Delivery reports (Amazon SNS)');
    comp.s = { ...comp.s, ses: { ...comp.s.ses, notificationUrl: 'http://localhost:8000/api/v1/mail/t/webhooks/ses/abc' } };
    fixture.detectChanges();
    expect(el().textContent).toContain('not reachable by Amazon SNS');
    expect(comp.publicUrl).toBeFalse();
  });

  it('saves the connection without ever sending an empty secret; the secret is never shown back', () => {
    flushProfile(); http.expectOne(r => r.url.endsWith(url)).flush(SETTINGS());
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

  it('the test shows the account state; the SNS endpoint is shown with the steps', () => {
    flushProfile(); http.expectOne(r => r.url.endsWith(url)).flush(SETTINGS({ ses: { configured: true, source: 'workspace', region: 'us-east-1', hasSecret: true } }));
    fixture.detectChanges();
    expect(el().textContent).toContain('https://app.test/api/v1/mail/t/webhooks/ses/abc');
    expect(el().textContent).toContain('No SNS subscription confirmed yet.');
    comp.test();
    http.expectOne(r => r.method === 'POST' && r.url.endsWith('/api/v1/mail/ses/test')).flush({ ok: true, account: { productionAccess: false }, message: 'Connected, but the account is in the SES sandbox.' });
    fixture.detectChanges();
    const result = el().querySelector('.cd-result') as HTMLElement;
    expect(result.textContent).toContain('sandbox');
    expect(result.classList.contains('ok')).toBeFalse();
  });
});
