import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TeamPerformanceComponent } from './team-performance.component';

const score = (s: number | null, level: string | null) => ({ score: s, level, coverage: 100, parts: [{ key: 'conversion', label: 'Lead conversion', value: 20, points: 100, weight: 30 }] });
const row = (o: any = {}) => ({
  userId: 1, name: 'Ann', email: 'ann@x.io', role: 'Member', former: false,
  leads: { assigned: 10, won: 2, lost: 1, open: 7, conversionRate: 20, contacted: 8, contactedInPeriod: 6, wonInPeriod: 2, periodConversionRate: 33.3, created: 3, imported: 1, discovered: 0,
    assignedInPeriod: 4, updated: 6, neverContacted: 0, firstContact: { given: 4, contacted: 4, medianHours: 2 } },
  followups: { due: 5, completed: 5, onTime: 5, late: 0, cancelled: 0, pending: 0, onTimeRate: 100, completionRate: 100, overdueNow: 0, upcoming: 2, avgDelayHours: null },
  calls: { made: 8, answered: 6, missed: 2, answerRate: 75, talkMinutes: 30, avgMinutes: 5, transcribed: 6 },
  activities: { notes: 3, meetings: 1, whatsapp: 0, sms: 0, other: 0, total: 4 },
  emails: { sent: 4, productEmails: 1, delivered: 4, opened: 2, clicked: 1, openRate: 50, campaignsCreated: 0, campaignsSent: 0, campaignRecipients: 0, campaignDelivered: 0, campaignOpened: 0, campaignClicked: 0 },
  social: { campaigns: 0, posts: 2, published: 1, aiGenerations: 3 }, other: { discoverySearches: 0, aiCampaignPrograms: 0, outreachSequences: 0 },
  productivity: { workingDays: 20, actions: 22, perDay: 1.1 }, score: score(85, 'excellent'),
  ...o
});
const withPrev = (r: any, prevScore: number | null = 70) => ({ ...r, previous: { ...row(), score: score(prevScore, prevScore === null ? null : 'on_track') } });
const TOTALS = (o: any = {}) => ({ staff: 2, leads: { assigned: 20, contactedInPeriod: 12, wonInPeriod: 4, periodConversionRate: 33.3, neverContacted: 5 },
  followups: { due: 10, completed: 8, onTime: 6, onTimeRate: 75, overdueNow: 3, completionRate: 80 }, calls: { made: 16, answered: 12, answerRate: 75, talkMinutes: 60 },
  emails: { sent: 8, productEmails: 2, totalSent: 10 }, social: { posts: 2, published: 1 }, score: { average: 70, scored: 2, levels: { excellent: 1, on_track: 0, needs_improvement: 0, critical: 1 } }, ...o });
const DAILY = [{ day: '2026-11-09', calls: 2, callsConnected: 1, followupsCompleted: 1, emails: 0, activities: 1, won: 0 }, { day: '2026-11-10', calls: 3, callsConnected: 2, followupsCompleted: 0, emails: 2, activities: 0, won: 1 }];
const ALL = { team: true, compare: true, exportTeam: true, transcripts: true, targets: true, scoring: true, schedule: true };
const TEAM = () => ({ permissions: ALL, me: 1, scope: 'team', from: '2026-11-09', to: '2026-11-10', timezone: 'Asia/Kolkata', roles: ['Member', 'Marketing Manager'], daily: DAILY,
  scoring: { levels: { excellent: 80, onTrack: 60, needsImprovement: 40 }, workweek: 5, customised: false, conversionTarget: 20 },
  totals: TOTALS(), previous: { from: '2026-11-07', to: '2026-11-08', totals: TOTALS({ calls: { made: 10, answered: 6, answerRate: 60, talkMinutes: 40 }, leads: { assigned: 20, contactedInPeriod: 12, wonInPeriod: 5, periodConversionRate: 41.7 } }) },
  members: [withPrev(row()), withPrev(row({ userId: 2, name: 'Bo', role: 'Marketing Manager', score: score(30, 'critical'), followups: { ...row().followups, overdueNow: 3 }, leads: { ...row().leads, neverContacted: 5 } }), 45)] });
const DETAIL = (o: any = {}) => ({ member: { userId: 1, name: 'Ann', role: 'Member', email: 'ann@x.io', former: false }, from: '2026-11-09', to: '2026-11-10', timezone: 'UTC',
  summary: { ...withPrev(row()), previous: { ...row(), score: score(70, 'on_track'), from: '2026-11-07', to: '2026-11-08' } }, leadSources: [{ source: 'import', count: 3 }],
  callOutcomes: { transcripts: { done: 6 } }, campaigns: [], posts: [], daily: DAILY, ...o });

describe('TeamPerformanceComponent', () => {
  let fixture: ComponentFixture<TeamPerformanceComponent>;
  let http: HttpTestingController;
  let c: TeamPerformanceComponent;
  const el = () => fixture.nativeElement as HTMLElement;
  const report = () => http.expectOne(r => r.url.endsWith('/api/v1/performance'));

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [TeamPerformanceComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(TeamPerformanceComponent);
    c = fixture.componentInstance;
  });
  afterEach(() => http.verify());

  function team(data = TEAM()): void {
    fixture.detectChanges();
    report().flush(data);
    fixture.detectChanges();
  }

  it('dashboard: five headline cards (targets hidden), the leaderboard by score, trend and alerts', () => {
    team();
    expect(el().textContent).toContain('Monitor employee productivity');
    const cards = el().querySelectorAll('.tp-kpis6 .tp-k');
    expect(cards.length).toBe(5, 'no "Targets achieved" card while no targets exist');
    expect(el().querySelector('.tp-kpis6')!.textContent).not.toContain('Targets');
    expect(c.delta(c.kpis.find(k => k.key === 'connected')!)).toEqual(jasmine.objectContaining({ text: '+100%', good: true }));
    expect(c.delta(c.kpis.find(k => k.key === 'conversion')!)).toEqual(jasmine.objectContaining({ text: '-8.4 pts', good: false }));
    const rows = el().querySelectorAll('.tp-lb tbody tr');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Ann');
    expect(rows[0].querySelector('.lv-excellent')).toBeTruthy();
    expect(rows[1].querySelector('.lv-critical')!.textContent).toContain('30');
    expect(rows[0].textContent).toContain('No target');
    expect(el().querySelectorAll('.tp-alert').length).toBe(1, 'one row per person, however many issues');
    expect(c.alertGroups[0].issues.map(i => i.issue)).toEqual(['Overdue follow-ups', 'Leads never contacted']);
    expect(el().querySelector('.tp-alerts')!.textContent).toContain('3 overdue follow-ups');
    expect(el().querySelector('app-perf-trend')).toBeTruthy('one conversion recorded: the trend shows');
    expect(c.trendSeries.map(x => x.label)).toEqual(['Current period', 'Previous period']);
    expect(el().querySelector('app-perf-donut')).toBeTruthy();
    expect(c.activityMix.total).toBe(16 + 10 + 8 + 0);
    expect(c.rateClass(33.3, 'conversion')).toBe('');
  });

  it('a card with no data stays and shows a dash; an empty trend says so instead of drawing an empty chart', () => {
    const d = TEAM();
    d.totals = TOTALS({ leads: { assigned: 0, contactedInPeriod: 0, wonInPeriod: 0, periodConversionRate: null } });
    d.daily = DAILY.map(x => ({ ...x, won: 0 }));
    team(d);
    expect(c.fmt(c.kpis.find(k => k.key === 'conversion')!.value, '%')).toBe('—');
    expect(el().querySelector('app-perf-trend')).toBeNull();
    expect(el().querySelector('.tp-emptystate')!.textContent).toContain('No lead conversions recorded');
  });

  it('leaderboard: sort by a column, search, quick views; a card ranks by its measure', () => {
    team();
    c.sort('calls.answered'); c.sort('calls.answered');
    expect(c.sortDesc).toBeFalse();
    c.search = 'bo';
    expect(c.board.map(m => m.name)).toEqual(['Bo']);
    c.search = '';
    c.quick = 'attention';
    expect(c.board.map(m => m.name)).toEqual(['Bo']);
    c.quick = 'top';
    expect(c.board.map(m => m.name)).toEqual(['Ann']);
    c.openKpi(c.kpis.find(k => k.key === 'followups')!);
    expect([c.sortKey, c.quick]).toEqual(['followups.completed', 'all']);
    http.expectOne(r => r.url.endsWith('/api/v1/performance/drill') && r.params.get('kind') === 'followups_completed').flush({ title: 'Follow-ups completed', columns: [], rows: [], total: 0, page: 1 });
    expect(c.rankOf(c.data.members[1])).toBe(2);
  });

  it('role and staff filters go to the server; Compare period lists improved and declined', () => {
    team();
    c.role = 'Member';
    c.load();
    const req = report();
    expect(req.request.params.get('role')).toBe('Member');
    req.flush(TEAM());
    c.comparePeriod = true;
    fixture.detectChanges();
    expect(el().querySelector('.tp-periods')!.textContent).toContain('Calls connected');
    expect(c.improved.map(x => x.label)).toContain('Calls connected');
    expect(c.declined.map(x => x.label)).toContain('Leads converted');
    expect(c.scoreMovers.up.m.name).toBe('Ann');
    expect(c.scoreMovers.down.m.name).toBe('Bo');
    expect(c.biggestImprovement!.label).toBe('Calls connected');
    expect(c.biggestDecline!.label).toBe('Leads converted');
    expect(el().querySelector('.tp-periods')!.textContent).toContain('2 improved');
  });

  it('select 2–5 people: compare them here, or export only them', () => {
    team();
    c.toggleSelect(1); c.toggleSelect(2);
    fixture.detectChanges();
    expect(c.canCompareSelected).toBeTrue();
    (el().querySelector('.tp-selbar .btn-primary') as HTMLButtonElement).click();
    const req = http.expectOne(r => r.url.endsWith('/api/v1/performance/compare'));
    expect(req.request.params.get('ids')).toBe('1,2');
    req.flush({ from: '2026-11-09', to: '2026-11-10', previous: { from: '2026-11-07', to: '2026-11-08' }, members: c.data.members });
    fixture.detectChanges();
    expect(el().querySelector('.tp-cmp')!.textContent).toContain('Score vs previous period');
    expect(c.scoreChange(c.data.members[0])).toBe('▲ +15 (70 → 85)');
    const write = spyOn(c, 'writeWorkbook');
    c.exportExcel(true);
    const ex = http.expectOne(r => r.url.endsWith('/api/v1/performance/export'));
    expect(ex.request.params.get('ids')).toBe('1,2');
    ex.flush({ from: '2026-11-09', to: '2026-11-10', members: [row()], sheets: {} });
    expect(write).toHaveBeenCalled();
    expect(c.summaryRow(row({ former: true })).Member).toBe('Ann (former member)');
    expect(c.summaryRow(row())['Target achievement %']).toBe('No target assigned');
  });

  it('clicking someone opens their page: header, six cards, tabs loading server lists', () => {
    team();
    (el().querySelector('.tp-lb tbody tr') as HTMLElement).click();
    expect(c.view).toBe('staff');
    http.expectOne(r => r.url.endsWith('/api/v1/performance/members/1')).flush(DETAIL());
    fixture.detectChanges();
    expect(el().querySelector('.tp-staff-head')!.textContent).toContain('Ann');
    expect(el().querySelector('.tp-staff-head')!.textContent).toContain('No target assigned');
    expect(el().querySelectorAll('.tp-kpis6.staff .tp-k').length).toBe(6);
    expect(el().querySelectorAll('.tp-tabs button').length).toBe(7);
    c.tab = 'leads';
    http.expectOne(r => r.url.endsWith('/members/1/records/leads')).flush({ rows: [{ leadId: 9, leadName: 'Acme', status: 'New', firstContactAt: null, overdueFollowups: 1 }], total: 120, page: 1 });
    fixture.detectChanges();
    expect(el().textContent).toContain('Acme');
    expect(el().querySelector('.tp-pager')!.textContent).toContain('Page 1 of 3');
    c.setLeadView('never');
    expect(http.expectOne(r => r.url.endsWith('/members/1/records/leads')).request.params.get('contacted')).toBe('no');
    c.tab = 'activities';
    http.expectOne(r => r.url.endsWith('/members/1/records/timeline')).flush({ rows: [{ kind: 'call', id: 55, at: '2026-11-10T10:00:00Z', leadName: 'Acme', detail: 'Connected · 95 s', extra: 'done' }], total: 1, page: 1 });
    fixture.detectChanges();
    (el().querySelector('.tp-timeline li') as HTMLElement).click();
    http.expectOne(r => r.url.endsWith('/api/v1/performance/calls/55')).flush({ call: { id: 55, leadName: 'Acme', callerName: 'Ann', phone: '+61400', answered: true, durationSeconds: 95, transcribed: true, startedAt: '2026-11-10T10:00:00Z',
      conversation: [{ speaker: 'agent', start: 1, text: 'Hi, this is Ann.' }, { speaker: 'customer', start: 3, text: 'Send me the quote.' }] } });
    fixture.detectChanges();
    expect(el().querySelector('.tp-convo')!.textContent).toContain('00:01 Ann: Hi, this is Ann.');
    c.tab = 'targets';
    fixture.detectChanges();
    expect(el().textContent).toContain('No target assigned');
  });

  it('someone without team access goes straight to their own page', () => {
    fixture.detectChanges();
    report().flush({ ...TEAM(), scope: 'self', members: [withPrev(row())] });
    expect(c.view).toBe('staff');
    http.expectOne(r => r.url.endsWith('/api/v1/performance/members/1')).flush(DETAIL());
    fixture.detectChanges();
    expect(el().textContent).toContain('My Performance');
    expect(el().querySelector('.tp-lb')).toBeNull();
    expect(el().querySelector('.tp-views')).toBeNull();
  });

  it('report settings: scoring loads, shares add up, and saves', () => {
    team();
    c.openSettings();
    http.expectOne(r => r.url.endsWith('/api/v1/performance/schedules')).flush({ timezone: 'UTC', roles: [], members: [], schedules: [] });
    http.expectOne(r => r.url.endsWith('/api/v1/performance/scoring') && r.method === 'GET').flush({
      canEdit: true, measures: { conversion: { label: 'Conversion', unit: '%' }, followupOnTime: { label: 'On time', unit: '%' } },
      config: { customised: false, workweek: 5, levels: { excellent: 80, onTrack: 60, needsImprovement: 40 },
        measures: { conversion: { enabled: true, weight: 30, min: 0, target: 20 }, followupOnTime: { enabled: true, weight: 10, min: 50, target: 90 } } } });
    fixture.detectChanges();
    expect(el().querySelectorAll('.tp-scoring tbody tr').length).toBe(2);
    expect(c.share('conversion')).toBe('75%');
    c.saveScoring();
    const put = http.expectOne(r => r.url.endsWith('/api/v1/performance/scoring') && r.method === 'PUT');
    expect(put.request.body.config.measures.conversion.weight).toBe(30);
    put.flush({ config: { ...c.scoringCfg, customised: true } });
    report().flush(TEAM());
    expect(c.scoringCfg.customised).toBeTrue();
  });

  it('targets: a sixth card, Target % in the leaderboard, the team gauge and a person’s Targets tab', () => {
    const d = TEAM();
    const items = [{ targetId: 7, metric: 'leads_converted', label: 'Leads converted', unit: null, periodType: 'monthly', periodLabel: 'Monthly', from: 'person', target: 10,
      cycle: { from: '2026-11-01', to: '2026-11-30', label: 'Nov 2026' }, actual: 4, remaining: 6, pct: 40, status: 'at_risk', expected: 3.7, elapsed: 37 }];
    d.members[0] = { ...d.members[0], targets: { total: 1, met: 0, atRisk: 1, achievement: 40, items } };
    d.totals = TOTALS({ targets: { total: 4, met: 3, rate: 75, atRisk: 1, previous: { total: 4, met: 2, rate: 50 } } });
    (d.previous.totals as any).targets = { total: 4, met: 2, rate: 50 };
    (d as any).teamTargets = [{ metric: 'leads_converted', label: 'Leads converted', unit: null, periodType: 'monthly', periodLabel: 'Monthly', cycle: { label: 'Nov 2026' }, target: 30, actual: 24, remaining: 6, pct: 80, people: 3 }];
    (d as any).canManageTargets = true;
    team(d);
    expect(el().querySelectorAll('.tp-kpis6 .tp-k').length).toBe(6);
    const card = c.kpis.find(k => k.key === 'targets')!;
    expect([card.value, card.sub]).toEqual([75, '3 of 4 targets met']);
    expect(c.delta(card)!.text).toBe('+25 pts');
    const ann = el().querySelector('.tp-lb tbody tr')!;
    expect(ann.textContent).toContain('40%');
    expect(c.targetClass(d.members[0])).toBe('lo', 'a target at risk');
    expect(el().querySelector('app-perf-gauge')!.textContent).toContain('80%');
    expect(el().querySelector('.tp-gauge-card')!.textContent).toContain('Remaining');
    expect(c.alerts.some(a => a.issue === 'Leads converted target behind')).toBeTrue();
    // Person page, Targets tab: ring, numbers and status; a manager can add one.
    c.openMember(1, 'targets');
    http.expectOne(r => r.url.endsWith('/api/v1/performance/members/1')).flush(DETAIL({ summary: { ...d.members[0], previous: { ...row(), from: '2026-10-01', to: '2026-10-31' } } }));
    fixture.detectChanges();
    expect(el().querySelector('.tp-tcard')!.textContent).toContain('At risk');
    expect(el().querySelector('.tp-tcard')!.textContent).toContain('Nov 2026');
    expect(el().querySelector('.tp-staff-head')!.textContent).toContain('0 of 1 met');
    c.newTarget(1);
    http.expectOne(r => r.url.endsWith('/api/v1/performance/targets')).flush({ canManage: true, metrics: [{ key: 'leads_converted', label: 'Leads converted', unit: null, rate: false }],
      periods: [{ key: 'monthly', label: 'Monthly' }], roles: ['Member'], members: [{ userId: 1, name: 'Ann' }], definitions: [], totals: null, team: [] });
    c.tgForm.target = 12;
    c.saveTarget();
    const post = http.expectOne(r => r.url.endsWith('/api/v1/performance/targets') && r.method === 'POST');
    expect(post.request.body).toEqual(jasmine.objectContaining({ scope: 'member', userId: 1, metric: 'leads_converted', periodType: 'monthly', target: 12 }));
    post.flush({ target: { id: 8 } });
    http.expectOne(r => r.url.endsWith('/api/v1/performance/targets') && r.method === 'GET').flush({ canManage: true, metrics: [], periods: [], roles: [], members: [], definitions: [], totals: null, team: [] });
    report().flush(d);
    http.expectOne(r => r.url.endsWith('/api/v1/performance/members/1')).flush(DETAIL());
    expect(c.tgForm).toBeNull();
    expect(c.summaryRow(d.members[0])['Target achievement %']).toBe(40);
  });

  it('Targets & Goals page: progress table, set targets, remove one', () => {
    team();
    c.openTargets();
    http.expectOne(r => r.url.endsWith('/api/v1/performance/targets')).flush({ canManage: true, asOf: '2026-11-10', metrics: [{ key: 'calls_made', label: 'Calls made', unit: null, rate: false }],
      periods: [{ key: 'weekly', label: 'Weekly' }], roles: ['Member'], team: [],
      members: [{ userId: 1, name: 'Ann', role: 'Member', targets: { total: 1, met: 1, atRisk: 0, achievement: 120, items: [{ metric: 'calls_made', label: 'Calls made', unit: null, periodType: 'weekly', periodLabel: 'Weekly',
        cycle: { label: '9 Nov – 15 Nov' }, target: 10, actual: 12, remaining: 0, pct: 120, status: 'exceeded', from: 'role' }] } }],
      definitions: [{ id: 3, scope: 'role', role: 'Member', metric: 'calls_made', metricLabel: 'Calls made', periodType: 'weekly', periodLabel: 'Weekly', target: 10, startDate: '2026-11-01', endDate: null }],
      totals: { total: 1, met: 1, rate: 100, atRisk: 0, previous: { total: 0, met: 0, rate: null } } });
    fixture.detectChanges();
    expect(el().textContent).toContain('Targets & Goals');
    expect(el().textContent).toContain('Exceeded');
    expect(el().textContent).toContain('Everyone: Member');
    expect(c.targetBoard.map(m => m.name)).toEqual(['Ann']);
    spyOn(window, 'confirm').and.returnValue(true);
    c.deleteTarget(c.tg.definitions[0]);
    http.expectOne(r => r.url.endsWith('/api/v1/performance/targets/3') && r.method === 'DELETE').flush({ deleted: true });
    http.expectOne(r => r.url.endsWith('/api/v1/performance/targets') && r.method === 'GET').flush({ ...c.tg, definitions: [] });
    report().flush(TEAM());
  });

  it('same-span comparison for this month / quarter / year, and custom dates, go to the server', () => {
    team();
    c.preset = 'this_quarter'; c.from = '2026-10-01'; c.to = '2026-11-11';
    expect(c.comparisonRange).toEqual({ from: '2026-07-01', to: '2026-08-11' });
    c.preset = 'last_month'; c.from = '2026-10-01'; c.to = '2026-10-31';
    expect(c.comparisonRange).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    c.preset = 'this_year'; c.from = '2026-01-01'; c.to = '2026-11-11';
    expect(c.comparisonRange).toEqual({ from: '2025-01-01', to: '2025-11-11' });
    c.preset = '30d';
    expect(c.comparisonRange).toBeNull('the server picks the previous 30 days');
    c.compareWith = 'custom'; c.compareFrom = '2026-01-01'; c.compareTo = '2026-01-31';
    c.load();
    const req = report();
    expect([req.request.params.get('compareFrom'), req.request.params.get('compareTo')]).toEqual(['2026-01-01', '2026-01-31']);
    req.flush(TEAM());
  });

  it('permissions from the server hide what the person may not do', () => {
    const d = TEAM();
    (d as any).permissions = { team: true, compare: false, exportTeam: false, transcripts: false, targets: false, scoring: false, schedule: false };
    team(d);
    expect(Array.from(el().querySelectorAll('.tp-views button')).map(b => b.textContent!.trim())).not.toContain('Staff Comparison');
    expect(el().querySelector('.tp-export')).toBeNull();
    c.toggleSelect(1); c.toggleSelect(2);
    fixture.detectChanges();
    expect(el().querySelector('.tp-selbar')!.textContent).not.toContain('Compare');
    expect(el().querySelector('.tp-selbar')!.textContent).not.toContain('Export selected');
    c.detail = { member: { userId: 2 } };
    const toast = spyOn(c.toast, 'emit');
    c.openCall({ id: 9 });
    expect(toast).toHaveBeenCalled();
  });

  it('little or no data: every section stays, each with its own empty message', () => {
    const d = TEAM();
    d.totals = TOTALS({ leads: { assigned: 0, won: 0, lost: 0, contactedInPeriod: 0, wonInPeriod: 0, periodConversionRate: null }, followups: { ...TOTALS().followups, completed: 0 },
      calls: { made: 0, answered: 0, answerRate: null, talkMinutes: 0 }, emails: { sent: 0, productEmails: 0, totalSent: 0 }, activities: { total: 0 } });
    d.daily = DAILY.map(x => ({ ...x, won: 0, calls: 0, emails: 0, followupsCompleted: 0, activities: 0 }));
    team(d);
    expect(el().querySelectorAll('.tp-kpis6 .tp-k').length).toBe(5, 'all cards stay');
    expect(c.kpis.find(k => k.key === 'conversion')!.sub).toBe('no leads contacted yet');
    expect(el().querySelector('.tp-board')).toBeTruthy();
    expect(el().querySelector('app-perf-donut')).toBeTruthy('the overview stays, with its own empty text');
    expect(el().querySelector('.tp-bottom')).toBeTruthy();
    expect(el().querySelectorAll('.tp-bottom .tp-emptystate').length).toBe(2, 'trend and activity mix say there is nothing yet');
    expect(el().querySelector('.tp-periods')).toBeTruthy();
  });

  it('report settings: scheduled reports load, save and preview in a sandboxed frame', () => {
    team();
    c.openSettings();
    http.expectOne(r => r.url.endsWith('/api/v1/performance/schedules') && r.method === 'GET').flush({ timezone: 'UTC', roles: ['Member'], members: [{ userId: 1, name: 'Ann', role: 'Member' }],
      schedules: [{ id: 4, name: 'Monday report', frequency: 'weekly', weekday: 1, sendHour: 9, recipients: [1], scope: 'team', scopeMembers: [], format: 'summary', active: true, lastSentAt: null, lastError: null }] });
    http.expectOne(r => r.url.endsWith('/api/v1/performance/scoring')).flush({ canEdit: true, measures: {}, config: { customised: false, levels: { excellent: 80, onTrack: 60, needsImprovement: 40 }, measures: {} } });
    fixture.detectChanges();
    expect(el().textContent).toContain('Every Monday at 09:00 (last week)');
    expect(c.recipientNames([1])).toBe('Ann');
    c.newSchedule();
    c.toggleIn(c.schedForm.recipients, 1);
    c.saveSchedule();
    const post = http.expectOne(r => r.url.endsWith('/api/v1/performance/schedules') && r.method === 'POST');
    expect(post.request.body.recipients).toEqual([1]);
    post.flush({ schedule: { id: 5 } });
    http.expectOne(r => r.url.endsWith('/api/v1/performance/schedules') && r.method === 'GET').flush({ timezone: 'UTC', roles: [], members: [], schedules: [] });
    c.previewSchedule({ id: 4 });
    http.expectOne(r => r.url.endsWith('/schedules/4/preview')).flush({ html: '<p>Report</p>' });
    fixture.detectChanges();
    const frame = el().querySelector('iframe.tp-preview-body') as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain('Report');
  });

  it('drill-down: every figure opens a popup with the records behind it', () => {
    team();
    const drill = (kind: string) => http.expectOne(r => r.url.endsWith('/api/v1/performance/drill') && r.params.get('kind') === kind);
    const ROWS = { title: 'Calls', total: 30, page: 1, columns: [{ key: 'person', label: 'Staff', type: 'text' }, { key: 'lead', label: 'Lead', type: 'text' }, { key: 'at', label: 'When', type: 'date' }, { key: 'result', label: 'Result', type: 'text' }],
      rows: [{ userId: 1, person: 'Ann', lead: 'Acme', at: '2026-11-10T10:00:00Z', result: 'Connected', callId: 55, leadId: 9 }] };
    // A leaderboard cell: that person's records, without opening their page.
    const callsCell = Array.from(el().querySelectorAll('.tp-lb tbody tr:first-child td.dc'))[6] as HTMLElement;
    callsCell.click();
    const req = drill('calls');
    expect(req.request.params.get('userId')).toBe('1');
    req.flush(ROWS);
    fixture.detectChanges();
    expect(c.view).toBe('dashboard', 'the row did not open the staff page');
    expect(el().querySelector('.tp-pop')!.textContent).toContain('Acme');
    expect(el().querySelector('.tp-pop')!.textContent).toContain('Connected');
    expect(c.popPages).toBe(2);
    (Array.from(el().querySelectorAll('.tp-pop .tp-pager button')).find(b => b.textContent!.includes('Next')) as HTMLButtonElement).click();
    expect(drill('calls').request.params.get('page')).toBe('2');
    // A row with a call opens the transcript.
    c.popRow(ROWS.rows[0]);
    http.expectOne(r => r.url.endsWith('/api/v1/performance/calls/55')).flush({ call: { id: 55, conversation: [] } });
    c.transcript = null;
    c.onEscape();
    expect(c.pop).toBeNull();
    // Donut slice, activity row, period row, alert and trend point.
    c.leadSlice('won');
    expect(drill('leads_assigned').request.params.get('status')).toBe('won');
    c.mixClick('emails'); drill('emails_sent');
    c.periodClick('Follow-ups on time'); drill('followups_on_time');
    c.openAlert(c.alertGroups[0]);
    expect(drill('followups_overdue').request.params.get('userId')).toBe('2');
    c.trendMeasure = 'followupsCompleted';
    c.trendClick(1);
    const t = drill('followups_completed');
    expect([t.request.params.get('dayFrom'), t.request.params.get('dayTo'), t.request.params.get('by')]).toEqual(['2026-11-10', '2026-11-10', 'completed']);
    // Local lists: the score, the staff list.
    c.openScore(c.data.members[0]);
    expect(c.pop!.title).toBe('Performance score: 85');
    expect(c.pop!.rows[0].measure).toBe('Lead conversion');
    c.openKpi(c.kpis.find(k => k.key === 'staff')!);
    expect(c.pop!.rows.map(r => r.name)).toEqual(['Ann', 'Bo']);
    c.popRow(c.pop!.rows[1]);
    expect(c.view).toBe('staff');
    http.expectOne(r => r.url.endsWith('/api/v1/performance/members/2')).flush(DETAIL());
  });
});
