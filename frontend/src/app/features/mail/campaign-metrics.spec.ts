import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { CampaignMetricsComponent, num, rate } from './campaign-metrics.component';

describe('CampaignMetricsComponent', () => {
  let fixture: ComponentFixture<CampaignMetricsComponent>;
  let comp: CampaignMetricsComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const tile = (label: string) => Array.from(el().querySelectorAll('.cm-tile')).find(t => t.querySelector('span')!.textContent === label)!;

  function init(o: Partial<CampaignMetricsComponent>): void {
    fixture = TestBed.createComponent(CampaignMetricsComponent);
    comp = fixture.componentInstance;
    Object.assign(comp, { campaignId: 7, status: 'submitted', ...o });
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [CampaignMetricsComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('missing Zoho figures are "Unavailable", never 0; rates are computed only from reported figures', () => {
    init({ report: { emails_sent_count: '200', delivered_count: '190', opens_count: '57', bounces_count: '10', hardbounce_count: '6', softbounce_count: '4' } });
    expect(tile('Sent').querySelector('b')!.textContent).toBe('200');
    expect(tile('Delivery rate').querySelector('b')!.textContent).toBe('95.0%');
    expect(tile('Open rate').querySelector('b')!.textContent).toBe('30.0%');
    expect(tile('Unique clickers').querySelector('b')!.textContent).toBe('Unavailable');
    expect(tile('Click rate').querySelector('b')!.textContent).toBe('Unavailable');
    expect(tile('Unsubscribes').querySelector('b')!.textContent).toBe('Unavailable');
    expect(tile('Spam complaints').querySelector('b')!.textContent).toBe('Unavailable');
    expect(tile('Bounced').textContent).toContain('Hard 6 · Soft 4');
    expect(el().textContent).toContain('estimate');
  });

  it('uses Zoho\'s own percentages when reported', () => {
    init({ report: { emails_sent_count: 100, delivered_count: 90, delivered_percent: '91.5', open_percent: '40%', opens_count: 36 } });
    expect(tile('Delivery rate').querySelector('b')!.textContent).toBe('91.5%');
    expect(tile('Open rate').querySelector('b')!.textContent).toBe('40%');
  });

  it('without a report it says what to do instead of showing zeros', () => {
    init({ report: null });
    expect(el().querySelectorAll('.cm-tile').length).toBe(0);
    expect(el().textContent).toContain('Refresh status');
    fixture.destroy();
    init({ report: null, status: 'draft' });
    expect(el().textContent).toContain('Results appear after the campaign is sent');
    expect(el().textContent).not.toContain('recipient activity');
  });

  it('recipient activity: only for mail.send roles; loaded from Zoho on demand with paging', () => {
    init({ report: {}, canViewRecipients: false });
    expect(el().textContent).toContain('visible to owners, admins, marketing managers and approvers');
    expect(Array.from(el().querySelectorAll('button')).some(b => b.textContent!.includes('Show recipient activity'))).toBeFalse();
    fixture.destroy();
    init({ report: {}, canViewRecipients: true });
    (Array.from(el().querySelectorAll('button')).find(b => b.textContent!.includes('Show recipient activity')) as HTMLButtonElement).click();
    let req = http.expectOne(r => r.url.endsWith('/mail/campaigns/7/recipients'));
    expect(req.request.params.get('activity')).toBe('opened');
    expect(req.request.params.get('page')).toBe('1');
    req.flush({ available: true, recipients: [{ email: 'ann@acme.io', name: 'Ann Lee' }], hasMore: true });
    fixture.detectChanges();
    expect(el().querySelector('.cm-list')!.textContent).toContain('ann@acme.io');
    (Array.from(el().querySelectorAll('.cm-pager button')).find(b => b.textContent!.includes('Next')) as HTMLButtonElement).click();
    req = http.expectOne(r => r.url.endsWith('/mail/campaigns/7/recipients'));
    expect(req.request.params.get('page')).toBe('2');
    req.flush({ available: true, recipients: [], hasMore: false });
    fixture.detectChanges();
    expect(el().textContent).toContain('No recipients in this group on this page');
    comp.activity = 'clicked';
    comp.loadRecipients(1);
    http.expectOne(r => r.url.endsWith('/mail/campaigns/7/recipients') && r.params.get('activity') === 'clicked').flush({ error: 'x' }, { status: 403, statusText: 'x' });
    fixture.detectChanges();
    expect(el().textContent).toContain('cannot see recipient activity');
  });

  describe('charts and click to view', () => {
    const REPORT = { emails_sent_count: '200', delivered_count: '190', opens_count: '57', unique_clicks_count: '19', bounces_count: '10', hardbounce_count: '6', softbounce_count: '4', unsub_count: '3', spams_count: '0' };
    const row = (label: string) => Array.from(el().querySelectorAll('.cm-bar')).find(r => r.querySelector('.cm-bar-label')!.textContent === label) as HTMLElement;
    const width = (label: string) => (row(label).querySelector('.cm-track i') as HTMLElement).style.width;
    const recipients = () => http.expectOne(r => r.url.endsWith('/mail/campaigns/7/recipients'));

    it('draws reach and problems to scale with their counts; a missing figure has no bar', () => {
      init({ report: { ...REPORT, unique_clicks_count: undefined } });
      expect(el().querySelectorAll('.cm-card').length).toBe(2);
      expect(width('Sent')).toBe('100%');
      expect(width('Delivered')).toBe('95%');
      expect(row('Clicked')).toBeUndefined();
      expect(row('Hard bounced').textContent).toContain('6');
      expect(width("Soft bounced")).toBe("66.6667%");
      expect(row('Spam complaints').querySelector('.cm-track i')!.classList.contains('some')).toBeFalse();
    });

    it('large figures read the same in the tiles and the charts', () => {
      init({ report: { emails_sent_count: '7229' } });
      expect(tile('Sent').querySelector('b')!.textContent).toBe('7,229');
      expect(row('Sent').querySelector('.cm-bar-value')!.textContent).toBe('7,229');
    });

    it('with only a total for bounces it shows one Bounced bar', () => {
      init({ report: { emails_sent_count: '10', bounces_count: '2' } });
      expect(row('Bounced')).toBeTruthy();
      expect(row('Hard bounced')).toBeUndefined();
    });

    it('nothing reported means no chart', () => {
      init({ report: {} });
      expect(el().querySelector('.cm-charts')).toBeNull();
    });

    it('clicking a bar opens the people behind it, and keeps the button in place', () => {
      init({ report: REPORT, canViewRecipients: true });
      const bar = row('Opened');
      bar.click();
      const req = recipients();
      expect(req.request.params.get('activity')).toBe('opened');
      req.flush({ available: true, recipients: [{ email: 'ann@acme.io' }], hasMore: false });
      fixture.detectChanges();
      expect(row('Opened')).withContext('not re-created, so focus stays').toBe(bar);
      expect(bar.getAttribute('aria-pressed')).toBe('true');
      expect(el().querySelector('.cm-list')!.textContent).toContain('ann@acme.io');
      expect(comp.activity).toBe('opened');
    });

    it('figures open their list too; those with no list, or nothing reported, stay plain', () => {
      init({ report: { ...REPORT, unsub_count: undefined }, canViewRecipients: true });
      expect(tile('Open rate').tagName).toBe('DIV');
      expect(tile('Unsubscribes').tagName).withContext('Unavailable').toBe('DIV');
      expect(tile('Delivered').tagName).toBe('DIV');
      expect(row('Delivered').tagName).toBe('DIV');
      (tile('Bounced') as HTMLElement).click();
      const req = recipients();
      expect(req.request.params.get('activity')).toBe('hard_bounced');
      req.flush({ available: true, recipients: [], hasMore: false });
    });

    it('roles that cannot see addresses, and unsent campaigns, get the charts without links', () => {
      init({ report: REPORT, canViewRecipients: false });
      expect(el().querySelector('.cm-charts')).toBeTruthy();
      expect(el().querySelector('button.cm-bar, button.cm-tile')).toBeNull();
      expect(el().textContent).not.toContain('Click a bar');
      fixture.destroy();
      init({ report: REPORT, canViewRecipients: true, status: 'failed' });
      expect(el().querySelector('button.cm-bar')).toBeNull();
    });
  });

  it('num() and rate() never invent values', () => {
    expect(num(undefined)).toBeNull();
    expect(num('')).toBeNull();
    expect(num('abc')).toBeNull();
    expect(num('12')).toBe(12);
    expect(rate(5, 0)).toBeNull();
    expect(rate(null, 10)).toBeNull();
    expect(rate(1, 3)).toBe('33.3%');
  });
});
