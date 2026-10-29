import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MailActivityChartsComponent } from './mail-activity-charts.component';

const days = (n: number, fill: (i: number) => any = () => ({})) => Array.from({ length: n }, (_, i) => ({
  date: new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10), mailbox: 0, campaigns: 0, received: 0, ...fill(i)
}));
const SUMMARY = {
  range: { from: '2026-10-01', to: '2026-10-07', days: 7 },
  totals: { sentMailbox: 5, sentCampaigns: 12, received: 3, notSent: 1, campaignFailed: 0 },
  daily: days(7, i => (i === 6 ? { mailbox: 3, campaigns: 12, received: 2 } : i === 2 ? { mailbox: 2, received: 1 } : {})),
  delivery: { tracked: 4, delivered: 3, opened: 2, clicked: 1, bounced: 1, complained: 0, opensTracked: 4, clicksTracked: 0 }
};

describe('MailActivityChartsComponent', () => {
  let fixture: ComponentFixture<MailActivityChartsComponent>;
  let comp: MailActivityChartsComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const button = (t: string) => Array.from(el().querySelectorAll('button')).find(b => b.textContent!.includes(t)) as HTMLButtonElement;
  const flush = (days: number, body: any) => { http.expectOne(r => r.url.endsWith('/mail/activity/summary') && r.params.get('days') === String(days)).flush(body); fixture.detectChanges(); };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [MailActivityChartsComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(MailActivityChartsComponent);
    comp = fixture.componentInstance;
    fixture.detectChanges();
  });
  afterEach(() => http.verify());

  it('shows totals, a stacked column per day on a rounded axis, and a legend', () => {
    flush(30, SUMMARY);
    const stats = Array.from(el().querySelectorAll('.ma-stat strong')).map(s => s.textContent!.trim());
    expect(stats).toEqual(['17', '3', '1']);
    expect(el().querySelectorAll('.ma-col').length).toBe(7);
    expect(comp.yMax).withContext('peak 15 rounds up to 20').toBe(20);
    const last = el().querySelectorAll('.ma-col')[6];
    expect(last.querySelectorAll('.seg').length).toBe(2);
    expect((last.querySelector('.seg.s2') as HTMLElement).style.height).toBe('60%');
    expect(el().querySelector('.ma-legend')!.textContent).toContain('AI campaigns');
  });

  it('hovering or focusing a day shows its counts', () => {
    flush(30, SUMMARY);
    (el().querySelectorAll('.ma-col')[6] as HTMLElement).dispatchEvent(new Event('focus'));
    fixture.detectChanges();
    const tip = el().querySelector('.ma-tip')!.textContent!.replace(/\s+/g, ' ');
    expect(tip).toContain('Mailbox 3');
    expect(tip).toContain('AI campaigns 12');
    expect(tip).toContain('Received 2');
  });

  it('delivery bars show only what is tracked (no click bar when click tracking is off) and bounces', () => {
    flush(30, SUMMARY);
    const labels = Array.from(el().querySelectorAll('.ma-bar .lbl')).map(l => l.textContent!.trim());
    expect(labels).toEqual(['Delivered', 'Opened']);
    expect(el().querySelector('.ma-bar .val')!.textContent).toContain('3 (75%)');
    expect(el().querySelector('.ma-status')!.textContent).toContain('1 bounced');
  });

  it('switching the range reloads; the table view lists the same numbers', () => {
    flush(30, SUMMARY);
    button('7 days').click();
    flush(7, SUMMARY);
    button('Show as table').click();
    fixture.detectChanges();
    expect(el().querySelector('.ma-plot')).toBeNull();
    const first = Array.from(el().querySelector('.ma-table tbody tr')!.querySelectorAll('td')).map(c => c.textContent!.trim());
    expect(first).withContext('newest day first').toEqual(['3', '12', '2']);
  });

  it('empty periods say so instead of drawing empty charts', () => {
    flush(30, { ...SUMMARY, totals: { sentMailbox: 0, sentCampaigns: 0, received: 0, notSent: 0, campaignFailed: 0 }, daily: days(30), delivery: { tracked: 0 } });
    expect(el().querySelector('.ma-plot')).toBeNull();
    expect(el().textContent).toContain('No emails were sent in this period.');
    expect(el().textContent).toContain('No tracked emails in this period.');
  });
});
