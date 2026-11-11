import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { StaffComparisonComponent } from './staff-comparison.component';
import { seriesStyle } from './perf-charts';

const member = (id: number, name: string, o: any = {}) => ({
  userId: id, name, workingDays: 10, activeDays: 8, conversion: { avgHours: null, measured: 0 },
  leads: { assigned: 10, created: 4, contacted: 8, contactedInPeriod: 6, wonInPeriod: 2, lost: 1, conversionRate: 20, firstContact: { medianHours: 3 } },
  followups: { completed: 5, overdueNow: 1, onTimeRate: 80, completionRate: 90 },
  calls: { made: 20, answered: 10, answerRate: 50, talkMinutes: 40 },
  emails: { sent: 6, productEmails: 4, delivered: 9, opened: 3, clicked: 1, openRate: 30, campaignRecipients: 0, campaignDelivered: 0, campaignOpened: 0, campaignClicked: 0 },
  activities: { total: 7 },
  daily: [{ day: '2026-11-09', calls: 10, followupsCompleted: 2, emails: 5, activities: 3, leadsCreated: 2, total: 22 }, { day: '2026-11-10', calls: 10, followupsCompleted: 3, emails: 5, activities: 4, leadsCreated: 2, total: 24 }],
  weekly: [{ week: '2026-11-09', calls: 20, followupsCompleted: 5, emails: 10, activities: 7, leadsCreated: 4, total: 46 }],
  previous: { leads: { contactedInPeriod: 3 }, followups: { completed: 5 }, calls: { made: 10 }, emails: { sent: 2, productEmails: 0 } },
  ...o
});

describe('StaffComparisonComponent', () => {
  let fixture: ComponentFixture<StaffComparisonComponent>;
  let http: HttpTestingController;
  let c: StaffComparisonComponent;
  const el = () => fixture.nativeElement as HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [StaffComparisonComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(StaffComparisonComponent);
    c = fixture.componentInstance;
    c.members = [{ userId: 1, name: 'Ann' }, { userId: 2, name: 'Bo' }, { userId: 3, name: 'Cy' }];
    c.from = '2026-11-09'; c.to = '2026-11-10';
    fixture.detectChanges();
  });
  afterEach(() => http.verify());

  function compare(): void {
    c.toggle(1); c.toggle(2);
    fixture.detectChanges();
    (el().querySelector('.sc-bar .btn-primary') as HTMLButtonElement).click();
    const req = http.expectOne(r => r.url.endsWith('/api/v1/performance/compare'));
    expect(req.request.params.get('ids')).toBe('1,2');
    expect(req.request.params.get('workweek')).toBe('5');
    req.flush({ from: '2026-11-09', to: '2026-11-10', previous: { from: '2026-11-07', to: '2026-11-08' }, workweek: 5, targets: null,
      members: [member(1, 'Ann'), member(2, 'Bo', { workingDays: 5, calls: { made: 15, answered: 12, answerRate: 80, talkMinutes: 30 } })] });
    fixture.detectChanges();
  }

  it('needs two people, then shows cards, grouped bars, radar, lines and the ranking', () => {
    expect((el().querySelector('.sc-bar .btn-primary') as HTMLButtonElement).disabled).toBeTrue();
    compare();
    expect(el().querySelectorAll('.sc-card').length).toBe(2);
    expect(el().querySelector('app-perf-grouped')).toBeTruthy();
    expect(el().querySelectorAll('app-perf-radar polygon[fill-opacity]').length).toBe(2);
    expect(el().querySelectorAll('app-perf-trend path').length).toBe(2);
    expect(el().querySelector('.sc-table')!.textContent).toContain('Growth vs previous period');
  });

  it('per working day evens out fewer days; % of group shares the total; rates stay rates', () => {
    compare();
    const calls = c.metric('calls', 'made');
    const [ann, bo] = c.data.members;
    expect(c.value(ann, calls)).toBe(20);
    c.mode = 'perDay';
    expect(c.value(ann, calls)).toBe(2);
    expect(c.value(bo, calls)).toBe(3, 'Bo worked 5 days: 15 calls is more per day');
    expect(c.isBest(calls, bo)).toBeTrue();
    c.mode = 'percent';
    expect(c.value(bo, calls)).toBe(42.9);
    expect(c.value(bo, c.metric('calls', 'rate'))).toBe(80);
    c.mode = 'target';
    fixture.detectChanges();
    expect(el().textContent).toContain('None of these people has a target');
    c.data.members[0].targets = { total: 2, met: 1, atRisk: 1, achievement: 75, items: [{ metric: 'calls_made', periodType: 'monthly', label: 'Calls made', periodLabel: 'Monthly', unit: null, target: 20, actual: 15, pct: 75 }] };
    fixture.detectChanges();
    expect(c.hasTargets).toBeTrue();
    expect(c.targetCell(c.data.members[0], 'calls_made|monthly')).toBe('15 of 20 (75%)');
    expect(c.targetCell(c.data.members[1], 'calls_made|monthly')).toBe('—');
    expect(el().querySelector('.sc-table')!.textContent).toContain('No target');
  });

  it('ranking orders by the chosen measure; growth says how each moved; at most 10 can be picked', () => {
    compare();
    c.rankBy = 'calls.rate';
    expect(c.ranked.map(m => m.name)).toEqual(['Bo', 'Ann']);
    c.rankBy = 'conversion.firstContact';
    expect(c.ranked.length).toBe(2);
    expect(c.changeText(6, 3)).toBe('▲ +100% (3 → 6)');
    expect(c.changeText(0, 0)).toBe('no activity');
    expect(c.growthText(c.data.members[0])).toBe('▲ +105%', '6+5+20+10 = 41 actions against 3+5+10+2 = 20');
    for (let i = 4; i <= 14; i++) c.toggle(i);
    expect(c.selected.size).toBe(10);
  });

  it('a 9th and 10th person reuse the first colours with a dashed / hatched mark', () => {
    expect(seriesStyle(0)).toEqual({ color: '--s1', dash: false });
    expect(seriesStyle(7)).toEqual({ color: '--s8', dash: false });
    expect(seriesStyle(8)).toEqual({ color: '--s1', dash: true });
    expect(seriesStyle(9)).toEqual({ color: '--s2', dash: true });
  });
});
