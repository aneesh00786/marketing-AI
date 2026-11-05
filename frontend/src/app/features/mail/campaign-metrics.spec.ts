import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { CampaignMetricsComponent, num, rate } from './campaign-metrics.component';
import { ComposeRequestService } from '../../core/compose-request.service';

describe('CampaignMetricsComponent', () => {
  let fixture: ComponentFixture<CampaignMetricsComponent>;
  let comp: CampaignMetricsComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const tile = (label: string) => Array.from(el().querySelectorAll('.cm-tile')).find(t => t.querySelector('span')!.textContent === label)!;
  const sum = (label: string) => Array.from(el().querySelectorAll('.cm-sum')).find(t => t.querySelector('span')!.textContent === label) as HTMLElement;

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
    expect(sum('Sent').querySelector('b')!.textContent).toBe('200');
    expect(sum('Delivered').textContent).toContain('95.0%');
    expect(sum('Unopened').querySelector('b')!.textContent).withContext('delivered − opened when Zoho gives no figure').toBe('133');
    expect(tile('Delivery rate').querySelector('b')!.textContent).toBe('95.0%');
    expect(tile('Open rate').querySelector('b')!.textContent).toBe('30.0%');
    expect(sum('Clicked').querySelector('b')!.textContent).toBe('—');
    expect(tile('Click rate').querySelector('b')!.textContent).toBe('Unavailable');
    expect(sum('Unsubscribes').querySelector('b')!.textContent).toBe('—');
    expect(sum('Marked spam').querySelector('b')!.textContent).toBe('—');
    expect(sum('Forwards').querySelector('b')!.textContent).toBe('—');
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
    expect(el().textContent).toContain('click Refresh');
    fixture.destroy();
    init({ report: null, status: 'draft' });
    expect(el().textContent).toContain('Results appear after the campaign is sent');
    expect(el().textContent).not.toContain('recipient activity');
  });

  it('recipient activity: only for mail.send roles; a popup loads people from Zoho with full details, tabs and paging', () => {
    init({ report: {}, canViewRecipients: false });
    expect(el().textContent).toContain('visible to owners, admins, marketing managers and approvers');
    expect(Array.from(el().querySelectorAll('button')).some(b => b.textContent!.includes('View recipients'))).toBeFalse();
    fixture.destroy();
    init({ report: { emails_sent_count: '2', opens_count: '1', forwards_count: '0' }, canViewRecipients: true });
    (Array.from(el().querySelectorAll('button')).find(b => b.textContent!.includes('View recipients')) as HTMLButtonElement).click();
    let req = http.expectOne(r => r.url.endsWith('/mail/campaigns/7/recipients'));
    expect(req.request.params.get('activity')).toBe('sent');
    req.flush({ available: true, recipients: [{ email: 'ann@acme.io', name: 'Ann Lee', company: 'Acme', phone: '0400', location: 'Sydney', opens: 2, lastOpenedAt: 'Nov 05, 2026 09:10 AM', leadStatus: 'Contacted' }], hasMore: true });
    fixture.detectChanges();
    const pop = () => el().querySelector('.cm-pop') as HTMLElement;
    expect(pop().querySelector('h3')!.textContent).toContain('Sent');
    const cells = Array.from(pop().querySelectorAll('tbody tr:first-child td')).map(td => td.textContent!.trim());
    expect(cells.slice(0, 10)).toEqual(['1', 'Ann Lee', 'Acme', 'ann@acme.io', '0400', 'Sydney', '2', 'Nov 05, 2026 09:10 AM', '—', 'Contacted']);
    // Follow up by email: Compose opens with the person and a follow-up subject (nothing is sent).
    let asked: any = null;
    TestBed.inject(ComposeRequestService).requests$.subscribe(x => asked = x);
    comp.campaignSubject = 'A quick idea for $[FNAME|you]$';
    (pop().querySelector('.cm-follow .cm-act') as HTMLButtonElement).click();
    expect(asked).toEqual({ email: 'ann@acme.io', name: 'Ann Lee', subject: 'Following up: A quick idea for', body: 'Hi Ann,\n\n' });
    expect(pop().querySelector('.cm-follow app-call-button')).withContext('the call button sits beside it').toBeTruthy();
    (Array.from(pop().querySelectorAll('.cm-pop-foot button')).find(b => b.textContent!.includes('Next')) as HTMLButtonElement).click();
    req = http.expectOne(r => r.url.endsWith('/mail/campaigns/7/recipients'));
    expect(req.request.params.get('page')).toBe('2');
    req.flush({ available: true, recipients: [], hasMore: false });
    fixture.detectChanges();
    expect(pop().textContent).toContain('No one in this group on this page');
    // Tabs switch the group; Delivered reads Zoho's sent list; Forwards has no list.
    (Array.from(pop().querySelectorAll('.cm-tabs button')).find(b => b.textContent!.includes('Delivered')) as HTMLButtonElement).click();
    http.expectOne(r => r.params.get('activity') === 'sent' && r.params.get('page') === '1').flush({ available: true, recipients: [], hasMore: false });
    (Array.from(pop().querySelectorAll('.cm-tabs button')).find(b => b.textContent!.includes('Forwards')) as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(pop().textContent).toContain('does not say who forwarded');
    comp.selectActivity('clicked');
    http.expectOne(r => r.params.get('activity') === 'clicked').flush({ error: 'x' }, { status: 403, statusText: 'x' });
    fixture.detectChanges();
    expect(pop().textContent).toContain('cannot see recipient activity');
    (pop().querySelector('.cm-x') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el().querySelector('.cm-pop')).toBeNull();
  });

  it('insights: devices, email apps, browsers, locations and lists from Zoho; zero entries are left out', () => {
    init({ report: { emails_sent_count: '2', insights: { sentAt: '04 Nov 2026, 11:33 AM', sentTimeZone: 'IST', topic: 'Marketing',
      devices: [{ label: 'Computer · Others', value: 1 }], emailClients: [], browsers: [{ label: 'Chrome', value: 1 }],
      locations: [{ label: 'India', value: 1 }, { label: 'United States of America', value: 1 }],
      lists: [{ name: 'Marketech campaign 9 v7 abc', contacts: 1, bounces: 0, unsubscribes: 0, generated: true }, { name: 'test', contacts: 34, bounces: 1, unsubscribes: 0, generated: false }] } } });
    const text = el().querySelector('.cm-insights')!.textContent!;
    expect(text).toContain('04 Nov 2026, 11:33 AM IST');
    expect(text).toContain('Marketing');
    expect(text).toContain('Chrome');
    expect(text).toContain('United States of America');
    expect(text).toContain('not identified any email app');
    expect(text).toContain('Selected contacts');
    expect(text).toContain('34 contact(s) · 1 bounced');
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
      expect(sum('Sent').querySelector('b')!.textContent).toBe('7,229');
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
      expect(el().querySelector('.cm-pop .cm-table')!.textContent).toContain('ann@acme.io');
      expect(comp.activity).toBe('opened');
    });

    it('figures open their list too; those with no list, or nothing reported, stay plain', () => {
      init({ report: { ...REPORT, unsub_count: undefined }, canViewRecipients: true });
      expect(tile('Open rate').tagName).toBe('DIV');
      expect(sum('Unsubscribes').tagName).withContext('Unavailable').toBe('DIV');
      expect(sum('Delivered').tagName).withContext('every reported figure opens its people').toBe('BUTTON');
      expect(sum('Opened').tagName).toBe('BUTTON');
      expect(row('Delivered').tagName).toBe('BUTTON');
      (tile('Bounced') as HTMLElement).click();
      const req = recipients();
      expect(req.request.params.get('activity')).toBe('hard_bounced');
      req.flush({ available: true, recipients: [], hasMore: false });
    });

    it('roles that cannot see addresses, and unsent campaigns, get the charts without links', () => {
      init({ report: REPORT, canViewRecipients: false });
      expect(el().querySelector('.cm-charts')).toBeTruthy();
      expect(el().querySelector('button.cm-bar, button.cm-tile, button.cm-sum')).toBeNull();
      expect(el().textContent).not.toContain('Click a bar');
      fixture.destroy();
      init({ report: REPORT, canViewRecipients: true, status: 'failed' });
      expect(el().querySelector('button.cm-bar')).toBeNull();
    });
  });

  it('summary row matches Zoho\'s report (plus Bounced) with Zoho\'s percentages; Refresh asks the page', () => {
    init({ report: { emails_sent_count: '2', delivered_count: '2', delivered_percent: '100.0', opens_count: '1', open_percent: '50.0', unopened: '1', unopened_percent: '50.0',
      unique_clicks_count: '0', unique_clicked_percent: '0.0', unsub_count: '0', unsubscribe_percent: '0.0', spams_count: '0', spam_percent: '0.0', forwards_count: '0', forward_percent: '0.0' } });
    expect(comp.summary.map(x => [x.label, x.value, x.sub])).toEqual([
      ['Sent', '2', null], ['Delivered', '2', '100%'], ['Opened', '1', '50%'], ['Unopened', '1', '50%'],
      ['Clicked', '0', '0%'], ['Bounced', '—', null], ['Unsubscribes', '0', '0%'], ['Marked spam', '0', '0%'], ['Forwards', '0', '0%']
    ]);
    let asked = 0;
    comp.refresh.subscribe(() => asked++);
    (Array.from(el().querySelectorAll('button')).find(b => b.textContent!.includes('Refresh')) as HTMLButtonElement).click();
    expect(asked).toBe(1);
  });

  it('while Zoho is still sending: the row shows how many it goes to and 0 so far; no charts yet', () => {
    init({ report: { pending: true, recipients_count: 2, insights: { lists: [] } }, canViewRecipients: true });
    expect(el().querySelector('.cm-sending')!.textContent).toContain('Zoho is sending this campaign to 2 contact(s)');
    expect(comp.summary.map(x => [x.label, x.value])).toEqual([['Sending to', '2'], ['Delivered', '0'], ['Opened', '0'], ['Unopened', '0'], ['Clicked', '0'],
      ['Bounced', '0'], ['Unsubscribes', '0'], ['Marked spam', '0'], ['Forwards', '0']]);
    expect(el().textContent).not.toContain('Campaign reach');
    expect(el().querySelector('.cm-grid')).toBeNull();
    expect(el().textContent).not.toContain('No figures from Zoho yet');
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
