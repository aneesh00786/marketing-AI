import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ZohoAppSettingsComponent } from './zoho-app-settings.component';

const APP = { source: null, clientIdHint: null, hasSecret: false, updatedAt: null, serverFallback: false, encryptionReady: true,
  redirectUri: 'https://app.example.com/api/v1/mail/zoho/callback', homepageUrl: 'https://app.example.com', scopes: [] };

describe('ZohoAppSettingsComponent', () => {
  let fixture: ComponentFixture<ZohoAppSettingsComponent>;
  let comp: ZohoAppSettingsComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const button = (t: string) => Array.from(el().querySelectorAll('button')).find(b => b.textContent!.includes(t)) as HTMLButtonElement | undefined;
  const set = async (id: string, v: string) => { await fixture.whenStable(); const i = el().querySelector(`#${id}`) as HTMLInputElement; i.value = v; i.dispatchEvent(new Event('input')); fixture.detectChanges(); await fixture.whenStable(); };

  function init(app: any): void {
    fixture = TestBed.createComponent(ZohoAppSettingsComponent);
    comp = fixture.componentInstance;
    fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/mail/zoho/app') && r.method === 'GET').flush({ app });
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ZohoAppSettingsComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('shows the exact Homepage URL and Redirect URI to enter in Zoho, and the setup steps', () => {
    init(APP);
    expect(el().textContent).toContain('Not set up');
    expect(el().textContent).toContain('https://app.example.com/api/v1/mail/zoho/callback');
    expect(el().textContent).toContain('Server-based Applications');
    expect(el().textContent).toContain('Multi-DC');
    expect((el().querySelector('#za-client-secret') as HTMLInputElement).type).withContext('secret hidden by default').toBe('password');
  });

  it('saves the Client ID and Secret, then clears the form (the secret is never shown again)', async () => {
    init(APP);
    expect(button('Save credentials')!.disabled).toBeTrue();
    await set('za-client-id', '1000.ABCDEFGHIJKL');
    expect(button('Save credentials')!.disabled).withContext('the first save needs the secret').toBeTrue();
    await set('za-client-secret', 'secret-1234567890');
    const changed: number[] = [];
    comp.changed.subscribe(() => changed.push(1));
    button('Save credentials')!.click();
    const req = http.expectOne(r => r.url.endsWith('/mail/zoho/app') && r.method === 'PUT');
    expect(req.request.body).toEqual({ clientId: '1000.ABCDEFGHIJKL', clientSecret: 'secret-1234567890' });
    req.flush({ saved: true, changed: true, disconnected: false, app: { ...APP, source: 'workspace', clientIdHint: '1000.A…IJKL', hasSecret: true } });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(changed.length).toBe(1);
    expect((el().querySelector('#za-client-secret') as HTMLInputElement).value).toBe('');
    expect(el().textContent).toContain('Saved in Settings');
    expect(el().textContent).toContain('1000.A…IJKL');
    expect(el().textContent).not.toContain('secret-1234567890');
  });

  it('with saved credentials, the secret can be left blank to keep it; replacing asks first', async () => {
    init({ ...APP, source: 'workspace', clientIdHint: '1000.A…IJKL', hasSecret: true });
    spyOn(window, 'confirm').and.returnValue(true);
    await set('za-client-id', '1000.ABCDEFGHIJKL');
    button('Save credentials')!.click();
    expect(window.confirm).toHaveBeenCalled();
    const req = http.expectOne(r => r.method === 'PUT');
    expect(req.request.body).toEqual({ clientId: '1000.ABCDEFGHIJKL' });
    req.flush({ saved: true, changed: false, disconnected: false, app: { ...APP, source: 'workspace', clientIdHint: '1000.A…IJKL', hasSecret: true } });
  });

  it('removing asks first and calls DELETE', () => {
    init({ ...APP, source: 'workspace', clientIdHint: '1000.A…IJKL', hasSecret: true });
    const c = spyOn(window, 'confirm').and.returnValue(false);
    button('Remove saved credentials')!.click();
    http.expectNone(r => r.method === 'DELETE');
    c.and.returnValue(true);
    button('Remove saved credentials')!.click();
    http.expectOne(r => r.method === 'DELETE').flush({ removed: true, disconnected: true, app: APP });
  });

  it('members without mail.configure see why; without server encryption saving is not possible', () => {
    fixture = TestBed.createComponent(ZohoAppSettingsComponent);
    fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/mail/zoho/app')).flush({ error: 'Forbidden' }, { status: 403, statusText: 'Forbidden' });
    fixture.detectChanges();
    expect(el().textContent).toContain('Only workspace Owners and Admins');
    expect(el().querySelector('form')).toBeNull();
    fixture.destroy();
    init({ ...APP, encryptionReady: false });
    expect(el().textContent).toContain('Credential encryption is not configured');
  });
});
