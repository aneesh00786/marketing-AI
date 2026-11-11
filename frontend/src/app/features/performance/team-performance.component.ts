import { Component, EventEmitter, HostListener, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import * as XLSX from 'xlsx';
import { apiRoot } from '../../core/api-base';
import { StaffComparisonComponent } from './staff-comparison.component';
import { PerfColumnsComponent, PerfDonutComponent, PerfFunnelComponent, PerfGaugeComponent, PerfGroupedComponent, PerfRingComponent, PerfTrendComponent, ColumnPoint, DonutSlice, MetricGroup, TrendSeries, seriesStyle } from './perf-charts';

type Preset = '7d' | '30d' | 'month' | 'last_month' | 'quarter' | 'this_quarter' | 'this_year' | 'custom';
export type View = 'dashboard' | 'staff' | 'compare' | 'targets' | 'settings';
export type StaffTab = 'overview' | 'leads' | 'followups' | 'calls' | 'emails' | 'activities' | 'targets';
type Level = 'excellent' | 'on_track' | 'needs_improvement' | 'critical';

/** One summary card: this period, the comparison period, and where a click goes. */
export interface Kpi { key: string; label: string; value: number | null; previous: number | null; unit?: '%'; sub?: string; spark?: number[]; sort: string; }
export interface Alert { userId: number; name: string; issue: string; value: string; severity: 'crit' | 'warn'; tab: StaffTab; text?: string; }
/** Alerts of one person, worst first: one row per person in "Needs attention". */
export interface AlertGroup { userId: number; name: string; severity: 'crit' | 'warn'; issues: Alert[]; }

export const LEVELS: Record<Level, { label: string; short: string; icon: string }> = {
  excellent: { label: 'Excellent', short: 'Excellent', icon: '★' },
  on_track: { label: 'On track', short: 'On Track', icon: '✓' },
  needs_improvement: { label: 'Needs improvement', short: 'Needs Work', icon: '◷' },
  critical: { label: 'Critical attention', short: 'Critical', icon: '!' }
};

/** Target statuses: label and style (always shown as text, never colour alone). */
export const TARGET_STATUS: Record<string, { label: string; cls: string }> = {
  not_started: { label: 'Not started', cls: 'ts-none' }, on_track: { label: 'On track', cls: 'ts-track' }, at_risk: { label: 'At risk', cls: 'ts-risk' },
  achieved: { label: 'Achieved', cls: 'ts-ok' }, exceeded: { label: 'Exceeded', cls: 'ts-top' }, missed: { label: 'Missed', cls: 'ts-miss' }
};

/** Line icons (our own static markup) for the summary cards and the activity mix. */
const ICONS: Record<string, string> = {
  staff: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="16.5" cy="9" r="2.6"/><path d="M15.5 14.2c2.6-.3 4.5 1.3 5 4.3"/></svg>',
  converted: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1.2"/><path d="m17 7 3-3"/></svg>',
  conversion: '<svg viewBox="0 0 24 24"><path d="M4 20h16"/><path d="M7 16v-4M12 16V8M17 16V5"/></svg>',
  followups: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M4 10h16M9 3v4M15 3v4"/><path d="m9 15 2 2 4-4"/></svg>',
  connected: '<svg viewBox="0 0 24 24"><path d="M6.5 4h3l1.5 4-2 1.3a10 10 0 0 0 5.7 5.7L16 13l4 1.5v3a2 2 0 0 1-2 2A15 15 0 0 1 4.5 6a2 2 0 0 1 2-2z"/></svg>',
  targets: '<svg viewBox="0 0 24 24"><path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M9 20h6"/></svg>',
  calls: '<svg viewBox="0 0 24 24"><path d="M6.5 4h3l1.5 4-2 1.3a10 10 0 0 0 5.7 5.7L16 13l4 1.5v3a2 2 0 0 1-2 2A15 15 0 0 1 4.5 6a2 2 0 0 1 2-2z"/></svg>',
  emails: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4 7 8 6 8-6"/></svg>',
  fu: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>',
  notes: '<svg viewBox="0 0 24 24"><rect x="5" y="4" width="14" height="16" rx="2"/><path d="M9 9h6M9 13h6M9 17h3"/></svg>'
};

/**
 * Workspace → Team Performance. A staff performance dashboard: five or six headline figures, the staff
 * leaderboard (ranked by the configurable performance score, never by activity volume alone), a compact
 * comparison, the trend and the alerts that need management attention. Clicking someone opens their own
 * performance page. Everything is counted from recorded activity; missing data is said, not shown as zero.
 * Staff without team access see only their own page.
 */
@Component({
  selector: 'app-team-performance',
  standalone: true,
  imports: [CommonModule, FormsModule, StaffComparisonComponent, PerfColumnsComponent, PerfDonutComponent, PerfFunnelComponent, PerfGaugeComponent, PerfGroupedComponent, PerfRingComponent, PerfTrendComponent],
  styleUrls: ['../command/command-center.component.css', './team-performance.component.css'],
  templateUrl: './team-performance.component.html'
})
export class TeamPerformanceComponent implements OnInit {
  @Output() openLead = new EventEmitter<number>();
  @Output() toast = new EventEmitter<string>();

  readonly LEVELS = LEVELS;
  readonly TS = TARGET_STATUS;
  readonly icons: Record<string, SafeHtml>;
  view: View = 'dashboard';
  preset: Preset = '30d';
  from = '';
  to = '';
  role = '';
  staff = '';
  /** Compare Period: shows what improved and declined against the comparison period. */
  comparePeriod = true;
  data: any = null;
  loading = false;
  error = '';
  exporting = false;
  private base = `${apiRoot()}/api/v1/performance`;

  readonly presets: [Preset, string][] = [['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['month', 'This month'], ['last_month', 'Last month'],
    ['quarter', 'Last 90 days'], ['this_quarter', 'This quarter'], ['this_year', 'This year'], ['custom', 'Custom']];
  /** Compare with: the previous period of the same length, the same span of the previous month/quarter/year, or custom dates. */
  compareWith: 'previous' | 'custom' = 'previous';
  compareFrom = '';
  compareTo = '';

  // Leaderboard
  sortKey = 'score.score';
  sortDesc = true;
  search = '';
  quick: 'all' | 'top' | 'attention' = 'all';
  selected = new Set<number>();
  readonly columns: [string, string, string][] = [
    ['leads.assigned', 'Leads', 'Assigned to them now'], ['leads.contactedInPeriod', 'Contacted', 'Distinct leads contacted in the period'],
    ['leads.wonInPeriod', 'Converted', 'Leads won in the period'], ['leads.periodConversionRate', 'Conv. %', 'Won ÷ contacted in the period'],
    ['followups.completed', 'Follow-ups', 'Completed of those due in the period'], ['followups.onTimeRate', 'On-time %', 'Completed by the due time'],
    ['calls.answered', 'Calls', 'Connected of all calls made'], ['targets.achievement', 'Target %', 'Average achievement of their targets this period'], ['score.score', 'Performance', 'Score from the configured measures']
  ];

  // Compact comparison (from the leaderboard selection)
  compareData: any = null;
  compareLoading = false;

  // Trend
  trendMeasure: 'won' | 'followupsCompleted' | 'callsConnected' | 'emails' = 'won';
  readonly trendMeasures: [string, string][] = [['won', 'Lead conversions'], ['followupsCompleted', 'Follow-ups completed'], ['callsConnected', 'Calls connected'], ['emails', 'Emails sent']];

  // Individual staff page
  detail: any = null;
  detailLoading = false;
  private _tab: StaffTab = 'overview';
  get tab(): StaffTab { return this._tab; }
  set tab(v: StaffTab) {
    this._tab = v;
    const kind = this.kindOf(v);
    if (this.detail && kind) this.loadRecords(kind, 1);
  }
  recs: Record<string, { rows: any[]; total: number; page: number; loading: boolean } | undefined> = {};
  readonly pageSize = 50;
  leadView = '';
  leadQ: Record<string, string> = { source: '', createdFrom: '', createdTo: '', assignedFrom: '', assignedTo: '' };
  showLeadFilters = false;
  followupFilter = '';
  callQ: Record<string, string> = { answered: '', transcript: '' };
  emailQ: Record<string, string> = { kind: '', engagement: '' };
  timelineType = '';
  day: any = null;
  dayLoading = false;
  dayPick = '';
  transcript: any = null;
  transcriptLoading = false;
  transcriptSearch = '';

  // Report settings (scoring)
  scoringCfg: any = null;
  scoringMeta: any = null;
  scoringSaving = false;
  scoringError = '';

  constructor(private http: HttpClient, sanitizer: DomSanitizer) {
    // Static icon markup defined above (never user data).
    this.icons = Object.fromEntries(Object.entries(ICONS).map(([k, v]) => [k, sanitizer.bypassSecurityTrustHtml(v)]));
  }

  ngOnInit(): void { this.setPreset('30d'); }

  // ------------------------------------------------------------------ period, filters, loading

  private ymd(d: Date): string { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

  setPreset(p: Preset): void {
    this.preset = p;
    const today = new Date();
    const back = (days: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - days);
    if (p === '7d') { this.from = this.ymd(back(6)); this.to = this.ymd(today); }
    if (p === '30d') { this.from = this.ymd(back(29)); this.to = this.ymd(today); }
    if (p === 'quarter') { this.from = this.ymd(back(89)); this.to = this.ymd(today); }
    if (p === 'month') { this.from = this.ymd(new Date(today.getFullYear(), today.getMonth(), 1)); this.to = this.ymd(today); }
    if (p === 'last_month') { this.from = this.ymd(new Date(today.getFullYear(), today.getMonth() - 1, 1)); this.to = this.ymd(new Date(today.getFullYear(), today.getMonth(), 0)); }
    if (p === 'this_quarter') { this.from = this.ymd(new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3, 1)); this.to = this.ymd(today); }
    if (p === 'this_year') { this.from = this.ymd(new Date(today.getFullYear(), 0, 1)); this.to = this.ymd(today); }
    if (p !== 'custom') this.load();
  }

  /**
   * The comparison range: custom dates; else, for this month / last month / this quarter / this year, the same span of
   * the month, quarter or year before (1–11 Nov vs 1–11 Oct); else the server's previous period of the same length.
   */
  get comparisonRange(): { from: string; to: string } | null {
    if (this.compareWith === 'custom') return this.compareFrom && this.compareTo ? { from: this.compareFrom, to: this.compareTo } : null;
    const months = ({ month: 1, last_month: 1, this_quarter: 3, this_year: 12 } as Record<string, number>)[this.preset];
    if (!months || !this.from || !this.to) return null;
    const shift = (s: string, end = false) => {
      const [y, m, d] = s.split('-').map(Number);
      const last = new Date(y, m - 1 - months + 1, 0).getDate();
      return this.ymd(new Date(y, m - 1 - months, end && this.preset === 'last_month' ? last : Math.min(d, last)));
    };
    return { from: shift(this.from), to: shift(this.to, true) };
  }

  private params(extra: Record<string, string> = {}): Record<string, string> {
    const p: Record<string, string> = { from: this.from, to: this.to, ...extra };
    const c = this.comparisonRange;
    if (c) { p['compareFrom'] = c.from; p['compareTo'] = c.to; }
    if (this.role) p['role'] = this.role;
    if (this.staff) p['staff'] = this.staff;
    return p;
  }

  /** Everyone visible, kept from the unfiltered report so the staff filter can always list them. */
  private everyone: any[] = [];

  load(): void {
    if (!this.from || !this.to) return;
    this.loading = true;
    this.error = '';
    this.http.get<any>(this.base, { params: this.params() }).subscribe({
      next: r => {
        this.loading = false;
        this.data = r;
        this.compareData = null;
        if (!this.role && !this.staff) this.everyone = r.members.map((m: any) => ({ userId: m.userId, name: m.name, former: m.former }));
        if (r.scope === 'self') { this.view = 'staff'; if (r.members[0]) this.openDetail(r.members[0]); }
        else if (this.detail) {
          const m = r.members.find((x: any) => x.userId === this.detail.member.userId);
          if (m) this.openDetail(m); else { this.detail = null; if (this.view === 'staff') this.view = 'dashboard'; }
        }
      },
      error: e => { this.loading = false; this.error = e?.error?.error || 'Could not load the performance report.'; }
    });
  }

  get isTeam(): boolean { return this.data?.scope === 'team'; }
  /** What this person may do (from the server, which enforces it). */
  get can(): { compare: boolean; exportTeam: boolean; transcripts: boolean; targets: boolean; scoring: boolean; schedule: boolean } {
    const p = this.data?.permissions || {};
    return { compare: !!p.compare, exportTeam: !!p.exportTeam, transcripts: !!p.transcripts, targets: !!p.targets, scoring: !!p.scoring, schedule: !!p.schedule };
  }
  /** Export is the team report for team viewers (needs permission), or one's own figures. */
  get canExport(): boolean { return this.isTeam ? this.can.exportTeam : true; }
  /** May open this call's transcript: their own, or anyone's with the transcripts permission. */
  canOpenCall(c: any): boolean { return !this.detail || this.detail.member.userId === this.ownId || this.can.transcripts; }
  get ownId(): number | null { return this.data?.scope === 'self' ? this.data.members[0]?.userId ?? null : this.data?.me ?? null; }
  get staffOptions(): any[] { return this.everyone.length ? this.everyone : (this.data?.members || []); }

  // ------------------------------------------------------------------ summary cards

  /** Daily values of one measure, for a card's sparkline. */
  private sparkOf(key: string): number[] { return (this.data?.daily || []).map((d: any) => Number(d[key]) || 0); }

  /** The headline figures; a card whose data does not exist is not shown. */
  get kpis(): Kpi[] {
    const t = this.data?.totals; const p = this.data?.previous?.totals;
    if (!t) return [];
    const k = (key: string, label: string, get: (x: any) => number | null, o: Partial<Kpi> & { sort: string }): Kpi => ({ key, label, value: get(t), previous: p ? get(p) : null, ...o });
    const cards = [
      k('staff', 'Total staff', x => x.staff, { sort: 'score.score' }),
      k('converted', 'Leads converted', x => x.leads.wonInPeriod, { sort: 'leads.wonInPeriod' }),
      k('conversion', 'Conversion rate', x => x.leads.periodConversionRate, { unit: '%', sort: 'leads.periodConversionRate', sub: t.leads.periodConversionRate === null ? 'no leads contacted yet' : undefined }),
      k('followups', 'Follow-ups completed', x => x.followups.completed, { sort: 'followups.completed', sub: t.followups.onTimeRate === null ? undefined : `${t.followups.onTimeRate}% on time` }),
      k('connected', 'Calls connected', x => x.calls.answered, { sort: 'calls.answered' }),
      // Shown only when targets exist: the share of targets met in their current period.
      ...(t.targets?.total ? [k('targets', 'Targets achieved', x => x.targets?.total ? x.targets.rate : null, { unit: '%', sort: 'targets.achievement', sub: `${t.targets.met} of ${t.targets.total} targets met` })] : [])
    ];
    // Every card stays in place; a card without data shows "—" and says why.
    return cards;
  }

  get levelSummary(): string {
    const L = this.data?.totals?.score?.levels;
    if (!L) return '';
    const parts = [L.excellent && `${L.excellent} excellent`, L.critical && `${L.critical} critical`].filter(Boolean);
    return parts.length ? parts.join(' · ') : `${this.data.totals.score.scored} with a score`;
  }

  /** Change against the comparison period, with an accessible text label. */
  delta(k: { value: number | null; previous: number | null; unit?: string }, lowerIsBetter = false): { text: string; dir: 'up' | 'down' | 'flat'; good: boolean | null; label: string } | null {
    if (k.previous === null || k.previous === undefined || k.value === null || k.value === undefined) return null;
    const cur = Number(k.value); const prev = Number(k.previous);
    if (cur === prev) return { text: 'no change', dir: 'flat', good: null, label: 'No change from the comparison period' };
    const dir = cur > prev ? 'up' : 'down';
    const good = (dir === 'up') !== lowerIsBetter;
    const text = k.unit === '%' || k.unit === 'pt' ? `${dir === 'up' ? '+' : ''}${Math.round((cur - prev) * 10) / 10} pts`
      : !prev ? 'new' : `${dir === 'up' ? '+' : ''}${Math.round(((cur - prev) / prev) * 1000) / 10}%`;
    return { text, dir, good, label: `${dir === 'up' ? 'Up' : 'Down'} ${text.replace(/^[+-]/, '')} from ${this.fmt(prev, k.unit)}` };
  }

  fmt(v: number | null | undefined, unit?: string): string { return v === null || v === undefined ? '—' : unit === '%' ? `${v}%` : String(v); }
  /** Opens can only be counted for emails sent with open tracking. */
  opensText(m: any): string { return m.emails.openTracked ? `${m.emails.opened} (${this.pct(m.emails.openRate)}, an estimate)` : 'not tracked'; }
  pct(v: number | null | undefined): string { return v === null || v === undefined ? '—' : `${v}%`; }

  /** A card opens the records behind it in a popup (and ranks the leaderboard by it). */
  openKpi(k: Kpi): void {
    this.sortKey = k.sort;
    this.sortDesc = true;
    this.quick = 'all';
    const kinds: Record<string, string> = { converted: 'leads_converted', conversion: 'leads_contacted', followups: 'followups_completed', connected: 'calls_connected' };
    if (kinds[k.key]) this.openDrill(kinds[k.key], { title: k.key === 'conversion' ? 'Leads contacted (conversion = won ÷ contacted)' : undefined });
    else if (k.key === 'staff') this.openStaffList();
    else if (k.key === 'targets') this.openTargetList();
  }

  // ------------------------------------------------------------------ drill-down popup

  /** The popup: server records behind a figure (kind), or a list built here (local). */
  pop: { title: string; subtitle: string; columns: { key: string; label: string; type: string }[]; rows: any[]; total: number; page: number; loading: boolean;
    kind?: string; params?: Record<string, string>; userId?: number | null; error?: string } | null = null;
  readonly popPageSize = 25;

  /** Records behind a figure, for everyone shown or one person, the whole period or one day / bucket. */
  openDrill(kind: string, o: { userId?: number; status?: string; dayFrom?: string; dayTo?: string; type?: string; by?: string; title?: string } = {}): void {
    const params: Record<string, string> = this.params({ kind });
    if (o.userId) params['userId'] = String(o.userId);
    for (const k of ['status', 'dayFrom', 'dayTo', 'type', 'by'] as const) if (o[k]) params[k] = o[k]!;
    const who = o.userId ? this.memberById(o.userId)?.name : null;
    const range = o.dayFrom ? (o.dayTo && o.dayTo !== o.dayFrom ? `${this.dlabel(o.dayFrom)} – ${this.dlabel(o.dayTo)}` : this.dlabel(o.dayFrom)) : `${this.dlabel(this.data?.from)} – ${this.dlabel(this.data?.to)}`;
    this.pop = { title: o.title || '', subtitle: [who, range].filter(Boolean).join(' · '), columns: [], rows: [], total: 0, page: 1, loading: true, kind, params, userId: o.userId ?? null };
    this.loadPop(1);
  }
  loadPop(page: number): void {
    const p = this.pop;
    if (!p?.kind) return;
    p.loading = true;
    this.http.get<any>(`${this.base}/drill`, { params: { ...p.params, page: String(page), pageSize: String(this.popPageSize) } }).subscribe({
      next: r => { if (this.pop !== p) return; Object.assign(p, { title: p.title || r.title, columns: r.columns, rows: r.rows, total: r.total, page: r.page, loading: false }); },
      error: e => { if (this.pop === p) Object.assign(p, { loading: false, error: e?.error?.error || 'Could not load the records.' }); }
    });
  }
  openLocal(title: string, subtitle: string, columns: [string, string, string?][], rows: any[], userId: number | null = null): void {
    this.pop = { title, subtitle, columns: columns.map(([key, label, type]) => ({ key, label, type: type || 'text' })), rows, total: rows.length, page: 1, loading: false, userId };
  }
  get popPages(): number { return this.pop?.kind ? Math.max(1, Math.ceil(this.pop.total / this.popPageSize)) : 1; }
  private dlabel(d?: string): string { return d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
  closePop(): void { this.pop = null; }
  @HostListener('document:keydown.escape') onEscape(): void { if (this.pop) this.closePop(); }

  /** A row opens its call (transcript) or its lead. */
  popRow(row: any): void {
    if (row.callId) {
      if (row.userId !== this.ownId && !this.can.transcripts && this.isTeam) { this.toast.emit('Opening other people\'s call transcripts needs the "View call transcripts" permission.'); return; }
      this.openCall({ id: row.callId });
      return;
    }
    if (row.memberId) { this.closePop(); this.openMember(row.memberId, row.tab || 'overview'); return; }
    if (row.leadId) { this.closePop(); this.openLead.emit(row.leadId); }
  }
  popRowClickable(row: any): boolean { return !!(row.callId || row.leadId || row.memberId); }
  openPopMember(): void { const id = this.pop?.userId; if (id) { this.closePop(); this.openMember(id); } }

  /** Leaderboard cell → its records for that person. */
  cell(ev: Event, m: any, what: string): void {
    ev.stopPropagation();
    const u = m.userId;
    const kinds: Record<string, [string, any?]> = {
      'leads.assigned': ['leads_assigned'], 'leads.contactedInPeriod': ['leads_contacted'], 'leads.wonInPeriod': ['leads_converted'],
      'leads.periodConversionRate': ['leads_contacted', { title: 'Leads contacted (conversion = won ÷ contacted)' }], 'followups.completed': ['followups_completed'],
      'followups.onTimeRate': ['followups_completed', { title: 'Follow-ups completed (on time or late)' }], 'calls.answered': ['calls']
    };
    if (kinds[what]) { const [kind, o] = kinds[what]; this.openDrill(kind, { userId: u, ...(o || {}) }); return; }
    if (what === 'targets.achievement') { this.openTargetList(m); return; }
    if (what === 'score.score') this.openScore(m);
  }
  openStaffList(): void {
    this.openLocal('Staff', `${this.dlabel(this.data?.from)} – ${this.dlabel(this.data?.to)}`, [['name', 'Name'], ['role', 'Role'], ['score', 'Score'], ['level', 'Level'], ['target', 'Target %']],
      (this.data?.members || []).map((m: any) => ({ memberId: m.userId, name: m.name + (m.former ? ' (former)' : ''), role: m.role, score: m.score?.score ?? '—',
        level: m.score?.level ? LEVELS[m.score.level as Level].label : 'No data yet', target: m.targets?.total ? `${m.targets.achievement}%` : 'No target' })));
  }
  /** Targets of one person, or of everyone (optionally one measure). */
  openTargetList(m: any = null, metric: string | null = null): void {
    const people = m ? [m] : (this.data?.members || []);
    const rows = people.flatMap((p: any) => (p.targets?.items || []).filter((i: any) => !metric || i.metric === metric).map((i: any) => ({
      memberId: p.userId, tab: 'targets', person: p.name, measure: i.label, period: `${i.periodLabel} · ${i.cycle.label}`, target: this.fmtUnit(i.target, i.unit),
      achieved: this.fmtUnit(i.actual, i.unit), remaining: i.remaining === null ? '—' : this.fmtUnit(i.remaining, i.unit), pct: this.pct(i.pct), status: TARGET_STATUS[i.status]?.label || i.status })));
    this.openLocal(metric ? `Targets: ${rows[0]?.measure || ''}` : 'Targets', m ? m.name : 'Everyone with a target',
      [...(m ? [] : [['person', 'Staff'] as [string, string]]), ['measure', 'Target'], ['period', 'Period'], ['target', 'Target'], ['achieved', 'Achieved'], ['remaining', 'Remaining'], ['pct', '%'], ['status', 'Status']], rows, m?.userId ?? null);
  }
  openScore(m: any): void {
    const rows = (m.score?.parts || []).map((p: any) => ({ measure: p.label, value: p.value === null ? 'no data (fewer than 3 cases)' : p.value, points: p.points ?? '—', weight: p.weight }));
    this.openLocal(`Performance score: ${m.score?.score ?? 'not enough data'}`, `${m.name} · ${m.score?.level ? LEVELS[m.score.level as Level].label : 'No data yet'}`,
      [['measure', 'Measure'], ['value', 'Value'], ['points', 'Points (0–100)'], ['weight', 'Weight']], rows, m.userId);
  }
  /** Needs attention → the records behind the person's main issue. */
  openAlert(g: AlertGroup): void {
    const a = g.issues[0];
    const map: Record<string, string> = { 'Overdue follow-ups': 'followups_overdue', 'Leads never contacted': 'never_contacted', 'Low follow-up completion': 'followups_due', 'Slow first contact': 'leads_contacted' };
    if (map[a.issue]) this.openDrill(map[a.issue], { userId: g.userId });
    else if (a.issue.endsWith('target behind')) this.openTargetList(this.memberById(g.userId));
    else this.openDrill('leads_contacted', { userId: g.userId });
  }
  /** Trend point → that day / week / month. */
  trendClick(i: number): void {
    const pts = this.trendLine;
    const from = pts[i]?.day;
    if (!from) return;
    const next = pts[i + 1]?.day;
    const end = next ? new Date(new Date(`${next}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10) : this.data.to;
    const to = end > this.data.to ? this.data.to : end;
    const kinds: Record<string, [string, string?]> = { won: ['leads_converted'], followupsCompleted: ['followups_completed', 'completed'], callsConnected: ['calls_connected'], emails: ['emails_sent'] };
    const [kind, by] = kinds[this.trendMeasure];
    this.openDrill(kind, { dayFrom: from < this.data.from ? this.data.from : from, dayTo: to, by });
  }
  mixClick(key: string): void {
    const kinds: Record<string, string> = { calls: 'calls', emails: 'emails_sent', fu: 'followups_completed', notes: 'activities' };
    this.openDrill(kinds[key]);
  }
  periodClick(label: string): void {
    const kinds: Record<string, [string, string?]> = { 'Leads contacted': ['leads_contacted'], 'Leads converted': ['leads_converted'], 'Conversion rate': ['leads_contacted', 'Leads contacted (conversion = won ÷ contacted)'],
      'Follow-ups completed': ['followups_completed'], 'Follow-ups on time': ['followups_on_time'], 'Calls connected': ['calls_connected'], 'Talk time (min)': ['calls_connected'], 'Emails sent': ['emails_sent'] };
    if (kinds[label]) this.openDrill(kinds[label][0], { title: kinds[label][1] });
    else if (label === 'Average score') this.openStaffList();
  }

  // ------------------------------------------------------------------ period comparison

  /** Team measures, now against the comparison period: improved, declined, unchanged. */
  get periodChanges(): { label: string; now: number | null; before: number | null; unit?: string; d: ReturnType<TeamPerformanceComponent['delta']> }[] {
    const t = this.data?.totals; const p = this.data?.previous?.totals;
    if (!t || !p) return [];
    const m = (label: string, get: (x: any) => number | null, unit?: string, lower = false) => {
      const now = get(t); const before = get(p);
      return { label, now, before, unit, d: this.delta({ value: now, previous: before, unit }, lower) };
    };
    return [
      m('Leads contacted', x => x.leads.contactedInPeriod), m('Leads converted', x => x.leads.wonInPeriod),
      m('Conversion rate', x => x.leads.periodConversionRate, '%'), m('Follow-ups completed', x => x.followups.completed),
      m('Follow-ups on time', x => x.followups.onTimeRate, '%'), m('Calls connected', x => x.calls.answered),
      m('Talk time (min)', x => x.calls.talkMinutes), m('Emails sent', x => x.emails.totalSent), m('Average score', x => x.score?.average ?? null, 'pt')
    ].filter(x => x.now !== null || x.before !== null);
  }
  /** Improved first, then declined, then unchanged. */
  get periodRows() { const o = (c: any) => (c.d?.good === true ? 0 : c.d?.good === false ? 1 : 2); return [...this.periodChanges].sort((a, b) => o(a) - o(b)); }
  private size(c: any): number {
    const now = Number(c.now) || 0; const before = Number(c.before) || 0;
    return c.unit ? Math.abs(now - before) : before ? Math.abs((now - before) / before) * 100 : now ? 1e9 : 0;
  }
  get biggestImprovement() { return [...this.improved].sort((a, b) => this.size(b) - this.size(a))[0] || null; }
  get biggestDecline() { return [...this.declined].sort((a, b) => this.size(b) - this.size(a))[0] || null; }
  get improved() { return this.periodChanges.filter(c => c.d?.good === true); }
  get declined() { return this.periodChanges.filter(c => c.d?.good === false); }
  get unchanged() { return this.periodChanges.filter(c => !c.d || c.d.good === null); }
  /** Staff whose score moved most against the comparison period. */
  /** Top three improvers and decliners by score change. */
  get scoreMoversTop(): { up: any[]; down: any[] } {
    const moved = (this.data?.members || []).filter((m: any) => m.score?.score != null && m.previous?.score?.score != null).map((m: any) => ({ m, d: m.score.score - m.previous.score.score }));
    return { up: moved.filter((x: any) => x.d > 0).sort((a: any, b: any) => b.d - a.d).slice(0, 3), down: moved.filter((x: any) => x.d < 0).sort((a: any, b: any) => a.d - b.d).slice(0, 3) };
  }
  get scoreMovers(): { up: any | null; down: any | null } {
    const moved = (this.data?.members || []).filter((m: any) => m.score?.score !== null && m.score?.score !== undefined && m.previous?.score?.score !== null && m.previous?.score?.score !== undefined)
      .map((m: any) => ({ m, d: m.score.score - m.previous.score.score }));
    const up = moved.filter((x: any) => x.d > 0).sort((a: any, b: any) => b.d - a.d)[0] || null;
    const down = moved.filter((x: any) => x.d < 0).sort((a: any, b: any) => a.d - b.d)[0] || null;
    return { up, down };
  }

  // ------------------------------------------------------------------ leaderboard

  private val(r: any, path: string): number | null {
    const v = path.split('.').reduce((o, k) => o?.[k], r);
    return v === null || v === undefined ? null : Number(v);
  }

  get board(): any[] {
    const q = this.search.trim().toLowerCase();
    const alerted = new Set(this.alerts.map(a => a.userId));
    let list = [...(this.data?.members || [])].filter((m: any) => !q || m.name.toLowerCase().includes(q) || String(m.role || '').toLowerCase().includes(q));
    if (this.quick === 'top') list = list.filter((m: any) => m.score?.level === 'excellent' || m.score?.level === 'on_track');
    if (this.quick === 'attention') list = list.filter((m: any) => alerted.has(m.userId) || m.score?.level === 'critical' || m.score?.level === 'needs_improvement');
    // Unknown values (no data) always sort last, whichever the direction.
    return list.sort((a, b) => {
      const va = this.val(a, this.sortKey); const vb = this.val(b, this.sortKey);
      if (va === null && vb === null) return a.name.localeCompare(b.name);
      if (va === null) return 1;
      if (vb === null) return -1;
      return (va - vb) * (this.sortDesc ? -1 : 1) || a.name.localeCompare(b.name);
    });
  }
  /** Rank by performance score (people without a score are not ranked). */
  rankOf(m: any): number | null {
    if (m.score?.score === null || m.score?.score === undefined) return null;
    return 1 + (this.data?.members || []).filter((x: any) => (x.score?.score ?? -1) > m.score.score).length;
  }
  sort(key: string): void {
    if (this.sortKey === key) this.sortDesc = !this.sortDesc; else { this.sortKey = key; this.sortDesc = true; }
  }
  sortMark(key: string): string { return this.sortKey === key ? (this.sortDesc ? ' ▼' : ' ▲') : ''; }
  ariaSort(key: string): string | null { return this.sortKey === key ? (this.sortDesc ? 'descending' : 'ascending') : null; }

  toggleSelect(id: number, ev?: Event): void {
    ev?.stopPropagation();
    const s = new Set(this.selected);
    if (s.has(id)) s.delete(id); else s.add(id);
    this.selected = s;
  }
  get canCompareSelected(): boolean { return this.selected.size >= 2 && this.selected.size <= 5; }

  initials(name: string): string { return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join(''); }
  levelOf(m: any): Level | null { return m?.score?.level || null; }

  // ------------------------------------------------------------------ needs attention

  get alerts(): Alert[] {
    if (!this.isTeam) return [];
    const target = this.data?.scoring?.conversionTarget;
    const out: Alert[] = [];
    for (const m of this.data?.members || []) {
      if (m.followups.overdueNow) out.push({ userId: m.userId, name: m.name, issue: 'Overdue follow-ups', value: String(m.followups.overdueNow), severity: m.followups.overdueNow >= 5 ? 'crit' : 'warn', tab: 'followups' });
      if (m.leads.neverContacted) out.push({ userId: m.userId, name: m.name, issue: 'Leads never contacted', value: String(m.leads.neverContacted), severity: m.leads.neverContacted >= 10 ? 'crit' : 'warn', tab: 'leads' });
      const fc = m.leads.firstContact?.medianHours;
      if (fc !== null && fc !== undefined && fc > 48) out.push({ userId: m.userId, name: m.name, issue: 'Slow first contact', value: this.hours(fc), severity: fc > 120 ? 'crit' : 'warn', tab: 'leads' });
      if (m.followups.due >= 3 && m.followups.completionRate !== null && m.followups.completionRate < 50) out.push({ userId: m.userId, name: m.name, issue: 'Low follow-up completion', value: `${m.followups.completionRate}%`, severity: m.followups.completionRate < 25 ? 'crit' : 'warn', tab: 'followups' });
      for (const ti of (m.targets?.items || []).filter((x: any) => x.status === 'at_risk')) {
        out.push({ userId: m.userId, name: m.name, issue: `${ti.label} target behind`, value: `${ti.pct ?? 0}%`, severity: (ti.pct ?? 0) < ti.elapsed / 2 ? 'crit' : 'warn', tab: 'targets',
          text: `${ti.label}: ${this.fmtUnit(ti.actual, ti.unit)} of ${this.fmtUnit(ti.target, ti.unit)} (${ti.cycle.label})` });
      }
      if (target !== null && target !== undefined && m.leads.contactedInPeriod >= 5 && m.leads.periodConversionRate !== null && m.leads.periodConversionRate < target) {
        out.push({ userId: m.userId, name: m.name, issue: `Conversion below ${target}%`, value: `${m.leads.periodConversionRate}%`, severity: 'warn', tab: 'leads' });
      }
    }
    const plural = (n: string, one: string, many: string) => `${n} ${Number(n) === 1 ? one : many}`;
    for (const a of out) {
      if (a.text) continue;
      a.text = a.issue === 'Overdue follow-ups' ? plural(a.value, 'overdue follow-up', 'overdue follow-ups')
        : a.issue === 'Leads never contacted' ? plural(a.value, 'lead never contacted', 'leads never contacted')
        : a.issue === 'Slow first contact' ? `First contact after ${a.value}`
        : a.issue === 'Low follow-up completion' ? `Follow-ups completed: ${a.value}`
        : `${a.issue}: ${a.value}`;
    }
    return out.sort((a, b) => (a.severity === b.severity ? a.name.localeCompare(b.name) : a.severity === 'crit' ? -1 : 1));
  }
  showAllAlerts = false;
  get alertGroups(): AlertGroup[] {
    const by = new Map<number, AlertGroup>();
    for (const a of this.alerts) {
      const g = by.get(a.userId) || { userId: a.userId, name: a.name, severity: 'warn', issues: [] };
      g.issues.push(a);
      if (a.severity === 'crit') g.severity = 'crit';
      by.set(a.userId, g);
    }
    for (const g of by.values()) g.issues.sort((x, y) => (x.severity === y.severity ? 0 : x.severity === 'crit' ? -1 : 1));
    return [...by.values()].sort((a, b) => (a.severity === b.severity ? b.issues.length - a.issues.length || a.name.localeCompare(b.name) : a.severity === 'crit' ? -1 : 1));
  }
  get shownAlerts(): AlertGroup[] { return this.showAllAlerts ? this.alertGroups : this.alertGroups.slice(0, 3); }
  get unchangedLabels(): string { return this.unchanged.map(u => u.label).join(', '); }
  get boardEmpty(): string {
    if (this.search) return `No one matches “${this.search}”.`;
    if (this.quick === 'top') return 'No one is Excellent or On track in this period.';
    if (this.quick === 'attention') return 'No one needs attention. 👍';
    return 'No staff in this period.';
  }
  clearSelection(): void { this.selected = new Set(); }
  issueText(g: AlertGroup): string { return g.issues.map(a => a.text || `${a.issue} ${a.value}`).join(', '); }

  readonly staffTabs: [StaffTab, string][] = [['overview', 'Overview'], ['leads', 'Leads'], ['followups', 'Follow-ups'], ['calls', 'Calls'], ['emails', 'Emails'], ['activities', 'Activities'], ['targets', 'Targets']];
  readonly leadViews: [string, string][] = [['', 'Assigned'], ['contacted', 'Contacted'], ['never', 'Never contacted'], ['Won', 'Won'], ['Lost', 'Lost'], ['open', 'Open']];
  readonly followupViews: [string, string][] = [['on_time', 'On time'], ['late', 'Late'], ['pending', 'Pending'], ['overdue', 'Overdue'], ['cancelled', 'Cancelled']];
  readonly timelineViews: [string, string][] = [['', 'All'], ['call', 'Calls'], ['email', 'Emails'], ['note', 'Notes'], ['meeting', 'Meetings'], ['whatsapp', 'WhatsApp'], ['sms', 'SMS'], ['lead_update', 'Lead updates']];

  // ------------------------------------------------------------------ trend

  /** Buckets that fit the period: days up to a month, weeks up to ~4 months, months beyond. */
  get trendBucket(): 'day' | 'week' | 'month' { const n = (this.data?.daily || []).length; return n <= 14 ? 'day' : n <= 120 ? 'week' : 'month'; }
  get trendPoints(): ColumnPoint[] {
    const days: any[] = this.data?.daily || [];
    const k = this.trendMeasure;
    const label = (d: string, b: string) => { const dt = new Date(`${d}T00:00:00`); return b === 'month' ? dt.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }) : dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); };
    if (this.trendBucket === 'day') return days.map(d => ({ label: label(d.day, 'day'), value: Number(d[k]) || 0 }));
    const groups = new Map<string, number>();
    for (const d of days) {
      const t = new Date(`${d.day}T00:00:00Z`);
      const key = this.trendBucket === 'week' ? new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10) : d.day.slice(0, 7) + '-01';
      groups.set(key, (groups.get(key) || 0) + (Number(d[k]) || 0));
    }
    return [...groups].map(([key, value]) => ({ label: (this.trendBucket === 'week' ? 'w/c ' : '') + label(key, this.trendBucket), value }));
  }
  get trendTotal(): number { return this.trendPoints.reduce((a, p) => a + p.value, 0); }

  /** Sum a daily series into the chosen buckets, keyed by the bucket's first day. */
  private bucketed(days: any[], k: string): { key: string; value: number }[] {
    if (this.trendBucket === 'day') return days.map(d => ({ key: d.day, value: Number(d[k]) || 0 }));
    const groups = new Map<string, number>();
    for (const d of days) {
      const t = new Date(`${d.day}T00:00:00Z`);
      const key = this.trendBucket === 'week' ? new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10) : d.day.slice(0, 7) + '-01';
      groups.set(key, (groups.get(key) || 0) + (Number(d[k]) || 0));
    }
    return [...groups].map(([key, value]) => ({ key, value }));
  }
  /** This period, and (when comparing) the previous period lined up bucket for bucket. */
  get trendLine(): any[] {
    const cur = this.bucketed(this.data?.daily || [], this.trendMeasure);
    const prev = this.bucketed(this.data?.previous?.daily || [], this.trendMeasure);
    return cur.map((c, i) => ({ day: c.key, cur: c.value, ...(this.comparePeriod ? { prev: prev[i]?.value ?? 0 } : {}) }));
  }
  get trendSeries(): TrendSeries[] {
    const s: TrendSeries[] = [{ key: 'cur', label: 'Current period', color: '--s1' }];
    if (this.comparePeriod) s.push({ key: 'prev', label: 'Previous period', color: '--s7', dash: true });
    return s;
  }
  get periodDays(): number { return (this.data?.daily || []).length || 30; }

  /** Leads assigned now: won, open, lost. */
  get leadSlices(): DonutSlice[] {
    const t = this.data?.totals?.leads;
    if (!t) return [];
    const open = Math.max(0, t.assigned - t.won - t.lost);
    return [{ key: 'won', label: 'Won', value: t.won, color: '--good' }, { key: 'open', label: 'Open', value: open, color: '--s1' }, { key: 'lost', label: 'Lost', value: t.lost, color: '--crit' }];
  }
  leadSlice(key: string): void { this.openDrill('leads_assigned', { status: key, title: `Leads assigned now: ${key === 'won' ? 'won' : key === 'lost' ? 'lost' : 'open'}` }); }

  /** The share of each kind of recorded action in the period. */
  get activityMix(): { total: number; rows: { key: string; label: string; value: number; share: number; color: string }[] } {
    const t = this.data?.totals;
    if (!t) return { total: 0, rows: [] };
    const rows = [
      { key: 'calls', label: 'Calls', value: t.calls.made, color: '--s1' },
      { key: 'emails', label: 'Emails', value: t.emails.totalSent ?? (t.emails.sent + t.emails.productEmails), color: '--s7' },
      { key: 'fu', label: 'Follow-ups', value: t.followups.completed, color: '--s3' },
      { key: 'notes', label: 'Notes & Activities', value: t.activities?.total ?? 0, color: '--s5' }
    ];
    const total = rows.reduce((a, x) => a + x.value, 0);
    return { total, rows: rows.map(x => ({ ...x, share: total ? Math.round((x.value / total) * 100) : 0 })) };
  }

  /** Colour a rate: at or above its scoring target, or below its minimum. */
  rateClass(v: number | null, measure: 'conversion' | 'followupOnTime'): string {
    const t = this.data?.scoring?.thresholds?.[measure];
    if (v === null || v === undefined || !t) return '';
    return v >= t.target ? 'hi' : v < t.min ? 'lo' : '';
  }
  get trendLabel(): string { return this.trendMeasures.find(m => m[0] === this.trendMeasure)?.[1] || ''; }

  // ------------------------------------------------------------------ compact comparison

  compareSelected(): void {
    if (!this.canCompareSelected) return;
    this.compareLoading = true;
    this.http.get<any>(`${this.base}/compare`, { params: { ids: [...this.selected].join(','), from: this.from, to: this.to, workweek: String(this.data?.scoring?.workweek || 5) } }).subscribe({
      next: r => { this.compareLoading = false; this.compareData = r; setTimeout(() => document.querySelector('.tp-cmp')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30); },
      error: e => { this.compareLoading = false; this.toast.emit(e?.error?.error || 'Could not compare.'); }
    });
  }
  get compareSeries() { return (this.compareData?.members || []).map((m: any, i: number) => ({ key: String(m.userId), label: m.name, ...seriesStyle(i) })); }
  readonly compareMetrics: { label: string; get: (m: any) => number | null; unit?: string; bar?: boolean }[] = [
    { label: 'Leads assigned', get: m => m.leads.assigned, bar: true },
    { label: 'Leads contacted', get: m => m.leads.contactedInPeriod, bar: true },
    { label: 'Leads converted', get: m => m.leads.wonInPeriod, bar: true },
    { label: 'Conversion %', get: m => m.leads.periodConversionRate, unit: '%' },
    { label: 'Follow-ups completed', get: m => m.followups.completed, bar: true },
    { label: 'On-time follow-ups', get: m => m.followups.onTimeRate, unit: '%' },
    { label: 'Calls connected', get: m => m.calls.answered, bar: true },
    { label: 'Average call', get: m => m.calls.avgMinutes, unit: 'min' },
    { label: 'Emails sent', get: m => m.emails.sent + m.emails.productEmails, bar: true },
    { label: 'Performance score', get: m => m.score?.score ?? null }
  ];
  get compareGroups(): MetricGroup[] {
    return this.compareMetrics.filter(k => k.bar).map(k => ({
      key: k.label, label: k.label,
      values: Object.fromEntries((this.compareData?.members || []).map((m: any) => [String(m.userId), k.get(m)])),
      display: Object.fromEntries((this.compareData?.members || []).map((m: any) => [String(m.userId), this.fmtUnit(k.get(m), k.unit)]))
    }));
  }
  fmtUnit(v: number | null | undefined, unit?: string): string { return v === null || v === undefined ? '—' : unit === '%' ? `${v}%` : unit === 'min' ? `${v} min` : String(v); }
  /** Score change against the comparison period, for the comparison table. */
  scoreChange(m: any): string {
    const a = m.score?.score; const b = m.previous?.score?.score;
    if (a === null || a === undefined || b === null || b === undefined) return 'not enough data';
    const d = a - b;
    return d === 0 ? 'no change' : `${d > 0 ? '▲ +' : '▼ '}${d} (${b} → ${a})`;
  }
  openFullComparison(): void { this.view = 'compare'; }
  get preselectIds(): number[] { return [...this.selected]; }

  // ------------------------------------------------------------------ individual staff page

  openMember(id: number, tab: StaffTab = 'overview'): void {
    const m = this.memberById(id);
    if (!m) return;
    this.view = 'staff';
    this._tab = tab;
    this.openDetail(m);
    setTimeout(() => window.scrollTo?.({ top: 0, behavior: 'smooth' }), 30);
  }
  memberById(id: number): any { return this.data?.members.find((m: any) => m.userId === id); }
  backToDashboard(): void { this.view = 'dashboard'; }

  openDetail(m: any): void {
    if (!m) { this.detail = null; return; }
    this.detailLoading = true;
    this.http.get<any>(`${this.base}/members/${m.userId}`, { params: { from: this.from, to: this.to } }).subscribe({
      next: r => {
        this.detailLoading = false;
        this.detail = { ...r, row: m };
        this.recs = {};
        this.day = null;
        const kind = this.kindOf(this.tab);
        if (kind) this.loadRecords(kind, 1);
      },
      error: e => { this.detailLoading = false; this.toast.emit(e?.error?.error || 'Could not load this member.'); }
    });
  }

  /** The server list behind a tab. */
  kindOf(t: StaffTab): string | null { return ({ leads: 'leads', followups: 'followups', calls: 'calls', emails: 'emails', activities: 'timeline' } as Record<string, string>)[t] || null; }

  private recordFilters(kind: string): Record<string, string> {
    let f: Record<string, string> = {};
    if (kind === 'leads') {
      f = { ...this.leadQ };
      if (this.leadView === 'contacted') f['contacted'] = 'yes';
      if (this.leadView === 'never') f['contacted'] = 'no';
      if (['Won', 'Lost', 'open'].includes(this.leadView)) f['status'] = this.leadView;
    }
    if (kind === 'followups') f = { status: this.followupFilter };
    if (kind === 'calls') f = this.callQ;
    if (kind === 'emails') f = this.emailQ;
    if (kind === 'timeline') f = { type: this.timelineType };
    return Object.fromEntries(Object.entries(f).filter(([, v]) => !!v));
  }

  loadRecords(kind: string, page = 1): void {
    if (!this.detail) return;
    const uid = this.detail.member.userId;
    this.recs[kind] = { rows: this.recs[kind]?.rows || [], total: this.recs[kind]?.total || 0, page, loading: true };
    const params = { from: this.from, to: this.to, page: String(page), pageSize: String(this.pageSize), ...this.recordFilters(kind) };
    this.http.get<any>(`${this.base}/members/${uid}/records/${kind}`, { params }).subscribe({
      next: r => { if (this.detail?.member.userId === uid) this.recs[kind] = { rows: r.rows, total: r.total, page: r.page, loading: false }; },
      error: e => { this.recs[kind] = { rows: [], total: 0, page, loading: false }; this.toast.emit(e?.error?.error || 'Could not load the list.'); }
    });
  }
  list(kind: string): any[] { return this.recs[kind]?.rows || []; }
  listTotal(kind: string): number { return this.recs[kind]?.total ?? 0; }
  pages(kind: string): number { return Math.max(1, Math.ceil(this.listTotal(kind) / this.pageSize)); }
  setLeadView(v: string): void { this.leadView = v; this.loadRecords('leads', 1); }
  setFollowupFilter(v: string): void { this.followupFilter = v; this.loadRecords('followups', 1); }
  setTimelineType(v: string): void { this.timelineType = v; this.loadRecords('timeline', 1); }
  clearLeadFilters(): void { Object.keys(this.leadQ).forEach(k => this.leadQ[k] = ''); this.leadView = ''; this.loadRecords('leads', 1); }

  /** Lead conversion funnel: assigned now → contacted → won. */
  funnel(m: any): { label: string; value: number }[] {
    return [{ label: 'Assigned', value: m.leads.assigned }, { label: 'Contacted', value: m.leads.contacted }, { label: 'Converted', value: m.leads.won }];
  }
  /** The staff page's six headline figures (target shown as "No target assigned"). */
  staffCards(m: any): { label: string; value: string; prev: number | null; cur: number | null; unit?: '%'; sub?: string }[] {
    const p = m.previous;
    return [
      { label: 'Leads converted', value: String(m.leads.wonInPeriod), cur: m.leads.wonInPeriod, prev: p?.leads.wonInPeriod ?? null, sub: `of ${m.leads.contactedInPeriod} contacted` },
      { label: 'Conversion rate', value: this.pct(m.leads.periodConversionRate), cur: m.leads.periodConversionRate, prev: p?.leads.periodConversionRate ?? null, unit: '%', sub: m.leads.periodConversionRate === null ? 'no leads contacted in the period' : 'won ÷ contacted' },
      { label: 'Follow-ups completed', value: String(m.followups.completed), cur: m.followups.completed, prev: p?.followups.completed ?? null, sub: `of ${m.followups.due} due` },
      { label: 'On-time follow-ups', value: this.pct(m.followups.onTimeRate), cur: m.followups.onTimeRate, prev: p?.followups.onTimeRate ?? null, unit: '%', sub: m.followups.onTimeRate === null ? 'none completed in the period' : `${m.followups.onTime} on time` },
      { label: 'Connected calls', value: String(m.calls.answered), cur: m.calls.answered, prev: p?.calls.answered ?? null, sub: `of ${m.calls.made} calls` },
      m.targets?.total
        ? { label: 'Target achievement', value: this.pct(m.targets.achievement), cur: m.targets.achievement, prev: p?.targets?.achievement ?? null, unit: '%', sub: `${m.targets.met} of ${m.targets.total} targets met` }
        : { label: 'Target achievement', value: 'No target assigned', cur: null, prev: null }
    ];
  }
  /** Daily recorded actions for the staff page trend. */
  staffTrend(d: any): ColumnPoint[] {
    const days: any[] = d.daily || [];
    return days.map(x => ({ label: new Date(`${x.day}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), value: x.calls + x.followupsCompleted + x.emails + x.activities }));
  }
  staffTrendTotal(d: any): number { return this.staffTrend(d).reduce((a, p) => a + p.value, 0); }
  /** Measures against the comparison period, for the staff page. */
  staffChanges(m: any): { label: string; now: number | null; before: number | null; unit?: string }[] {
    const p = m.previous || {};
    return [
      { label: 'Performance score', now: m.score?.score ?? null, before: p.score?.score ?? null, unit: 'pt' },
      { label: 'Leads contacted', now: m.leads.contactedInPeriod, before: p.leads?.contactedInPeriod ?? null },
      { label: 'Leads converted', now: m.leads.wonInPeriod, before: p.leads?.wonInPeriod ?? null },
      { label: 'Follow-ups completed', now: m.followups.completed, before: p.followups?.completed ?? null },
      { label: 'On-time follow-ups', now: m.followups.onTimeRate, before: p.followups?.onTimeRate ?? null, unit: '%' },
      { label: 'Calls connected', now: m.calls.answered, before: p.calls?.answered ?? null },
      { label: 'Emails sent', now: m.emails.sent + m.emails.productEmails, before: p.emails ? p.emails.sent + p.emails.productEmails : null }
    ];
  }
  fuSegments(m: any): { key: string; label: string; value: number; color: string }[] {
    return [
      { key: 'onTime', label: 'On time', value: m.followups.onTime, color: '--good' },
      { key: 'late', label: 'Late', value: m.followups.late, color: '--warn' },
      { key: 'overdue', label: 'Overdue now', value: m.followups.overdueNow, color: '--crit' },
      { key: 'pending', label: 'Upcoming', value: m.followups.upcoming, color: '--neutral' }
    ].filter(s => s.value > 0);
  }
  segTotal(segs: { value: number }[]): number { return segs.reduce((a, s) => a + s.value, 0); }

  openDay(date: string): void {
    if (!this.detail || !date) return;
    this.dayLoading = true;
    this.http.get<any>(`${this.base}/members/${this.detail.member.userId}/day`, { params: { date } }).subscribe({
      next: r => { this.dayLoading = false; this.day = r; },
      error: e => { this.dayLoading = false; this.toast.emit(e?.error?.error || 'Could not load that day.'); }
    });
  }
  dayCount(d: any): number { return d.leadsCreated.length + d.leadsAssigned.length + d.calls.length + d.followupsCompleted.length + d.emails.length + d.activities.length; }
  readonly timelineIcons: Record<string, string> = { call: '📞', email: '✉', product_email: '✉', note: '📝', meeting: '👥', whatsapp: '💬', sms: '💬', lead_update: '✎' };
  timelineLabel(k: string): string {
    return ({ call: 'Call', email: 'Email', product_email: 'Product email', note: 'Note', meeting: 'Meeting', whatsapp: 'WhatsApp', sms: 'SMS', lead_update: 'Lead updated', general: 'Activity' } as Record<string, string>)[k] || k;
  }
  openTimelineItem(x: any): void {
    if (x.kind === 'call') this.openCall(x);
    else if (x.leadId) this.openLead.emit(x.leadId);
  }

  hours(h: number | null | undefined): string {
    if (h === null || h === undefined) return '—';
    if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
    if (h < 48) return `${Math.round(h * 10) / 10} h`;
    return `${Math.round(h / 24 * 10) / 10} days`;
  }
  dur(s: number | null): string { return !s ? '—' : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`; }

  // ------------------------------------------------------------------ call transcript

  openCall(c: any): void {
    if (!this.canOpenCall(c)) { this.toast.emit('Opening other people\'s call transcripts needs the "View call transcripts" permission.'); return; }
    this.transcript = null;
    this.transcriptSearch = '';
    this.transcriptLoading = true;
    this.http.get<any>(`${this.base}/calls/${c.id}`).subscribe({
      next: r => { this.transcriptLoading = false; this.transcript = r.call; },
      error: e => { this.transcriptLoading = false; this.toast.emit(e?.error?.error || 'Could not open this call.'); }
    });
  }
  get transcriptLines(): any[] {
    const q = this.transcriptSearch.trim().toLowerCase();
    const lines = this.transcript?.conversation || [];
    return q ? lines.filter((l: any) => String(l.text).toLowerCase().includes(q)) : lines;
  }
  get transcriptTimed(): boolean { return (this.transcript?.conversation || []).some((l: any) => Number(l.start) > 0); }
  speaker(l: any): string { return l.speaker === 'agent' ? (this.transcript?.callerName || 'Agent') : (this.transcript?.leadName || this.transcript?.name || 'Customer'); }
  transcriptText(): string { return this.transcriptLines.map(l => `${this.transcriptTimed ? `[${this.mmss(l.start)}] ` : ''}${this.speaker(l)}: ${l.text}`).join('\n'); }
  mmss(sec: number): string { const s = Math.floor(Number(sec) || 0); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }
  copyTranscript(): void { navigator.clipboard?.writeText(this.transcriptText()).then(() => this.toast.emit('Transcript copied.'), () => this.toast.emit('Copy failed.')); }
  downloadTranscript(): void {
    const t = this.transcript;
    const head = `Call with ${t.leadName || t.name || t.phone} (${t.phone}) on ${new Date(t.startedAt).toLocaleString()}\nBy ${t.callerName || '—'} · ${this.dur(t.durationSeconds)}\n\n`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([head + this.transcriptText() + '\n'], { type: 'text/plain' }));
    a.download = `call-${(t.leadName || t.phone || 'call')}-${String(t.startedAt).slice(0, 10)}.txt`.replace(/[^\w.-]+/g, '-');
    a.click();
  }

  // ------------------------------------------------------------------ report settings (scoring)

  // Scheduled reports
  sched: any = null;
  schedForm: any = null;
  schedError = '';
  schedSaving = false;
  schedPreview: string | null = null;
  readonly weekdays: [number, string][] = [[1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'], [4, 'Thursday'], [5, 'Friday'], [6, 'Saturday'], [7, 'Sunday']];
  loadSchedules(): void {
    if (!this.can.schedule) return;
    this.http.get<any>(`${this.base}/schedules`).subscribe({ next: r => this.sched = r, error: e => this.schedError = e?.error?.error || 'Could not load the scheduled reports.' });
  }
  newSchedule(): void {
    this.schedError = '';
    this.schedForm = { id: null, name: 'Weekly team report', frequency: 'weekly', weekday: 1, dayOfMonth: 1, sendHour: 9, recipients: [], scope: 'team', scopeRole: '', scopeMembers: [], format: 'summary', active: true };
  }
  editSchedule(s: any): void { this.schedError = ''; this.schedForm = JSON.parse(JSON.stringify(s)); }
  toggleIn(list: number[], id: number): void { const i = list.indexOf(id); if (i >= 0) list.splice(i, 1); else list.push(id); }
  saveSchedule(): void {
    const f = this.schedForm;
    this.schedSaving = true;
    this.schedError = '';
    const req = f.id ? this.http.put<any>(`${this.base}/schedules/${f.id}`, f) : this.http.post<any>(`${this.base}/schedules`, f);
    req.subscribe({
      next: () => { this.schedSaving = false; this.schedForm = null; this.toast.emit('Report schedule saved.'); this.loadSchedules(); },
      error: e => { this.schedSaving = false; this.schedError = e?.error?.error || 'Could not save.'; }
    });
  }
  deleteSchedule(s: any): void {
    if (!confirm(`Stop and remove “${s.name}”?`)) return;
    this.http.delete<any>(`${this.base}/schedules/${s.id}`).subscribe({ next: () => this.loadSchedules(), error: e => this.toast.emit(e?.error?.error || 'Could not remove it.') });
  }
  previewSchedule(s: any): void {
    this.http.get<any>(`${this.base}/schedules/${s.id}/preview`).subscribe({ next: r => this.schedPreview = r.html, error: e => this.toast.emit(e?.error?.error || 'Could not build the preview.') });
  }
  testSchedule(s: any): void {
    this.http.post<any>(`${this.base}/schedules/${s.id}/send-test`, {}).subscribe({
      next: r => this.toast.emit(`Test report for ${r.from} – ${r.to} sent to ${r.sentTo}.`),
      error: e => this.toast.emit(e?.error?.error || 'Could not send the test report.')
    });
  }
  recipientNames(ids: number[]): string { return (ids || []).map(id => (this.sched?.members || []).find((m: any) => m.userId === id)?.name || `#${id}`).join(', '); }
  schedWhen(s: any): string {
    const h = `${String(s.sendHour).padStart(2, '0')}:00`;
    return s.frequency === 'weekly' ? `Every ${this.weekdays.find(w => w[0] === s.weekday)?.[1]} at ${h} (last week)` : `Monthly on day ${s.dayOfMonth} at ${h} (last month)`;
  }
  /** The preview is shown in a sandboxed frame (no scripts, no same-origin access). */
  get previewDoc(): boolean { return !!this.schedPreview; }

  openSettings(): void {
    this.view = 'settings';
    this.scoringError = '';
    this.loadSchedules();
    this.http.get<any>(`${this.base}/scoring`).subscribe({
      next: r => { this.scoringMeta = r; this.scoringCfg = JSON.parse(JSON.stringify(r.config)); },
      error: e => { this.scoringError = e?.error?.error || 'Could not load the scoring settings.'; }
    });
  }
  get measureKeys(): string[] { return Object.keys(this.scoringMeta?.measures || {}); }
  get weightTotal(): number { return Object.values(this.scoringCfg?.measures || {}).reduce((a: number, m: any) => a + (m.enabled ? Number(m.weight) || 0 : 0), 0); }
  share(k: string): string { const m = this.scoringCfg.measures[k]; const t = this.weightTotal; return m.enabled && t ? `${Math.round((m.weight / t) * 100)}%` : '—'; }
  saveScoring(reset = false): void {
    if (reset && !confirm('Go back to the default scoring?')) return;
    this.scoringSaving = true;
    this.scoringError = '';
    this.http.put<any>(`${this.base}/scoring`, reset ? { reset: true } : { config: this.scoringCfg }).subscribe({
      next: r => { this.scoringSaving = false; this.scoringCfg = JSON.parse(JSON.stringify(r.config)); this.scoringMeta = { ...this.scoringMeta, config: r.config }; this.toast.emit('Scoring saved.'); this.load(); },
      error: e => { this.scoringSaving = false; this.scoringError = e?.error?.error || 'Could not save.'; }
    });
  }

  // ------------------------------------------------------------------ targets

  teamTargetIdx = 0;
  get teamTarget(): any { const t = this.data?.teamTargets || []; return t[Math.min(this.teamTargetIdx, t.length - 1)] || null; }
  targetClass(m: any): string {
    const t = m.targets;
    if (!t?.total || t.achievement === null) return '';
    return t.achievement >= 100 ? 'hi' : t.atRisk ? 'lo' : '';
  }
  /** Ring colour of a target status (always shown with its status label). */
  statusColor(st: string): string { return ({ on_track: '--s1', at_risk: '--warn', achieved: '--good', exceeded: '--good', missed: '--crit' } as Record<string, string>)[st] || '--neutral'; }
  get canManageTargets(): boolean { return !!(this.tg?.canManage ?? this.data?.canManageTargets); }

  /** Targets & Goals page. */
  tg: any = null;
  tgLoading = false;
  tgError = '';
  tgForm: any = null;
  tgSaving = false;
  readonly fallbackMetrics: { key: string; label: string; unit: string | null; rate: boolean }[] = [];

  openTargets(): void { this.view = 'targets'; this.loadTargets(); }
  loadTargets(): void {
    this.tgLoading = true;
    this.http.get<any>(`${this.base}/targets`, { params: { from: this.from, to: this.to } }).subscribe({
      next: r => { this.tgLoading = false; this.tg = r; },
      error: e => { this.tgLoading = false; this.tgError = e?.error?.error || 'Could not load the targets.'; }
    });
  }
  /** A new target, for a person (e.g. from their page) or a role. */
  newTarget(userId: number | null = null): void {
    this.tgError = '';
    this.tgForm = { id: null, scope: userId ? 'member' : 'member', userId: userId ? String(userId) : '', role: '', metric: 'leads_converted', periodType: 'monthly', target: null, startDate: '', endDate: '', note: '' };
    if (!this.tg) this.loadTargets();
  }
  editTarget(def: any): void { this.tgError = ''; this.tgForm = { ...def, userId: def.userId ? String(def.userId) : '', role: def.role || '', startDate: def.startDate || '', endDate: def.endDate || '', note: def.note || '' }; }
  metricInfo(key: string): any { return (this.tg?.metrics || []).find((m: any) => m.key === key) || { label: key, unit: null, rate: false }; }
  saveTarget(): void {
    const f = this.tgForm;
    if (!f) return;
    this.tgSaving = true;
    this.tgError = '';
    const body: any = { scope: f.scope, metric: f.metric, periodType: f.periodType, target: Number(f.target), note: f.note || null };
    if (f.scope === 'member') body.userId = Number(f.userId); else body.role = f.role;
    if (f.startDate) body.startDate = f.startDate;
    if (f.endDate) body.endDate = f.endDate;
    const req = f.id ? this.http.put<any>(`${this.base}/targets/${f.id}`, body) : this.http.post<any>(`${this.base}/targets`, body);
    req.subscribe({
      next: () => { this.tgSaving = false; this.tgForm = null; this.toast.emit('Target saved.'); this.refreshAfterTargets(); },
      error: e => { this.tgSaving = false; this.tgError = e?.error?.error || 'Could not save the target.'; }
    });
  }
  deleteTarget(def: any): void {
    if (!confirm(`Remove the ${def.periodLabel.toLowerCase()} ${def.metricLabel.toLowerCase()} target?`)) return;
    this.http.delete<any>(`${this.base}/targets/${def.id}`).subscribe({
      next: () => { this.toast.emit('Target removed.'); this.refreshAfterTargets(); },
      error: e => this.toast.emit(e?.error?.error || 'Could not remove the target.')
    });
  }
  private refreshAfterTargets(): void { this.loadTargets(); this.load(); }
  /** Definitions that apply to one person (their own and their role's). */
  defsFor(userId: number, role: string): any[] { return (this.tg?.definitions || []).filter((t: any) => (t.scope === 'member' && t.userId === userId) || (t.scope === 'role' && t.role === role)); }
  whoOf(def: any): string { return def.scope === 'role' ? `Everyone: ${def.role}` : (this.tg?.members || []).find((m: any) => m.userId === def.userId)?.name || `Member ${def.userId}`; }
  /** Members with targets, best achievement first (for the comparison bars). */
  get targetBoard(): any[] {
    return (this.tg?.members || []).filter((m: any) => m.targets?.total).sort((a: any, b: any) => (b.targets.achievement ?? -1) - (a.targets.achievement ?? -1));
  }

  // ------------------------------------------------------------------ export

  /** One row of the summary sheet per member. */
  summaryRow(m: any): any {
    return {
      Rank: this.rankOf(m) ?? '', Member: m.name + (m.former ? ' (former member)' : ''), Email: m.email, Role: m.role,
      'Performance score': m.score?.score ?? 'Not enough data', Level: m.score?.level ? LEVELS[m.score.level as Level].label : '',
      'Target achievement %': m.targets?.total ? (m.targets.achievement ?? '') : 'No target assigned', 'Targets met': m.targets?.total ? `${m.targets.met} of ${m.targets.total}` : '',
      'Leads assigned': m.leads.assigned, 'Contacted in period': m.leads.contactedInPeriod, 'Converted in period': m.leads.wonInPeriod, 'Conversion %': m.leads.periodConversionRate ?? '',
      'Won (now)': m.leads.won, 'Lost (now)': m.leads.lost, 'Leads created': m.leads.created, Imported: m.leads.imported, 'From AI Discovery': m.leads.discovered, 'Given in period': m.leads.assignedInPeriod,
      'Never contacted': m.leads.neverContacted, 'First contact (median hours)': m.leads.firstContact.medianHours ?? '', 'Leads updated': m.leads.updated,
      'Follow-ups due': m.followups.due, Completed: m.followups.completed, 'On time': m.followups.onTime, Late: m.followups.late, 'On-time %': m.followups.onTimeRate ?? '',
      'Overdue now': m.followups.overdueNow, Upcoming: m.followups.upcoming,
      Calls: m.calls.made, Connected: m.calls.answered, 'Answer %': m.calls.answerRate ?? '', 'Talk minutes': m.calls.talkMinutes, Transcribed: m.calls.transcribed,
      Notes: m.activities.notes, Meetings: m.activities.meetings, WhatsApp: m.activities.whatsapp, SMS: m.activities.sms, 'Other activities': m.activities.other,
      'Working days': m.productivity?.workingDays ?? '', 'Actions per working day': m.productivity?.perDay ?? '',
      'Emails sent (individual)': m.emails.sent, 'Emails delivered': m.emails.delivered ?? '', 'Emails opened': m.emails.opened ?? '', 'Email open %': m.emails.openRate ?? '',
      'Emails clicked': m.emails.clicked ?? '', 'Product emails': m.emails.productEmails, 'Campaigns created': m.emails.campaignsCreated, 'Campaigns sent': m.emails.campaignsSent,
      'Campaign recipients': m.emails.campaignRecipients, 'Campaign delivered': m.emails.campaignDelivered, 'Campaign opened': m.emails.campaignOpened, 'Campaign clicked': m.emails.campaignClicked,
      'Social campaigns': m.social.campaigns, 'Posts created': m.social.posts, 'Posts published': m.social.published, 'AI content generated': m.social.aiGenerations
    };
  }

  /** Excel: summary plus the records behind it; only the selected staff when asked. */
  exportExcel(onlySelected = false): void {
    this.exporting = true;
    const extra: Record<string, string> = onlySelected && this.selected.size ? { ids: [...this.selected].join(',') } : {};
    this.http.get<any>(`${this.base}/export`, { params: this.params(extra) }).subscribe({
      next: r => { this.exporting = false; this.writeWorkbook(r); },
      error: e => { this.exporting = false; this.error = e?.error?.error || 'Could not export the report.'; }
    });
  }

  writeWorkbook(r: any): void {
    const names = new Map<number, string>((r.members || []).map((m: any) => [m.userId, m.name]));
    const who = (id: number) => names.get(id) || `Member ${id}`;
    const d = (v: any) => v ? new Date(v).toLocaleString(undefined, { timeZone: r.timezone || undefined }) : '';
    const wb = XLSX.utils.book_new();
    const head = [[`Team performance ${r.from} to ${r.to}`], [`Times in ${r.timezone || 'UTC'}. Compared with ${r.previous?.from || '—'} to ${r.previous?.to || '—'}. Exported ${new Date().toLocaleString()}.`], []];
    const add = (name: string, rows: any[], note?: string) => {
      const sheet = XLSX.utils.aoa_to_sheet(note ? [...head, [note], []] : head);
      XLSX.utils.sheet_add_json(sheet, rows.length ? rows : [{ '': 'No records in this period.' }], { origin: -1 });
      XLSX.utils.book_append_sheet(wb, sheet, name);
    };
    const cut = (s: any) => s?.truncated ? `Only the first ${r.exportLimit} rows are included; narrow the period for the rest.` : undefined;
    const S = r.sheets || {};
    const t = r.totals || {};
    const summary = (r.members || []).map((m: any) => this.summaryRow(m));
    if (summary.length) summary.push({ Member: 'TEAM TOTAL', 'Contacted in period': t.leads?.contactedInPeriod, 'Converted in period': t.leads?.wonInPeriod, 'Conversion %': t.leads?.periodConversionRate ?? '',
      'Follow-ups due': t.followups?.due, Completed: t.followups?.completed, 'On time': t.followups?.onTime, 'Overdue now': t.followups?.overdueNow, Calls: t.calls?.made, Connected: t.calls?.answered, 'Talk minutes': t.calls?.talkMinutes });
    add('Summary', summary);
    add('Leads', (S.leads?.rows || []).map((x: any) => ({ Member: who(x.userId), Lead: x.name, Company: x.company || '', Email: x.email || '', Phone: x.phone || '',
      Status: x.status, Source: x.source || '', Created: d(x.createdAt), 'Last contact': d(x.lastContact && !String(x.lastContact).startsWith('1970') ? x.lastContact : null) })), cut(S.leads));
    add('Follow-ups', (S.followups?.rows || []).map((x: any) => ({ Member: who(x.userId), Lead: x.leadName, Title: x.title, Type: x.type, Priority: x.priority,
      Status: x.status === 'pending' && new Date(x.dueAt) < new Date() ? 'overdue' : x.status, Due: d(x.dueAt), Completed: d(x.completedAt), Notes: x.completionNotes || '' })), cut(S.followups));
    add('Calls', (S.calls?.rows || []).map((x: any) => ({ Member: who(x.userId), Lead: x.leadName || '', Phone: x.phone, Started: d(x.startedAt),
      Answered: x.answered ? 'Yes' : 'No', 'Duration (s)': x.durationSeconds || 0, Transcript: x.transcriptStatus || '' })), cut(S.calls));
    add('Emails', (S.emails?.rows || []).map((x: any) => ({ Member: who(x.userId), Kind: x.kind, To: x.recipient, Subject: x.subject, Sent: d(x.sentAt),
      Delivered: d(x.deliveredAt), Bounced: d(x.bouncedAt), Opened: d(x.openedAt), Clicked: d(x.clickedAt) })), cut(S.emails));
    add('Notes & activities', (S.activities?.rows || []).map((x: any) => ({ Member: who(x.userId), Lead: x.leadName, Type: x.type, Title: x.title || '',
      Description: x.description || '', When: d(x.at), 'Minutes': x.durationMinutes ?? '' })), cut(S.activities));
    const tRows = (r.members || []).flatMap((m: any) => (m.targets?.items || []).map((i: any) => ({ Member: m.name, Measure: i.label, Period: `${i.periodLabel} · ${i.cycle.label}`,
      'Set for': i.from === 'role' ? 'Role' : 'Person', Target: i.target, Achieved: i.actual ?? '', Remaining: i.remaining ?? '', 'Achievement %': i.pct ?? '', Status: TARGET_STATUS[i.status]?.label || i.status })));
    add('Targets', tRows);
    // Period comparison: the team, then each person's score.
    const P = r.previous?.totals || {};
    const pr = (label: string, a: any, b: any) => ({ Measure: label, 'This period': a ?? '', 'Comparison period': b ?? '', Change: a != null && b != null ? Math.round((a - b) * 10) / 10 : '' });
    add('Period comparison', [
      pr('Leads contacted', t.leads?.contactedInPeriod, P.leads?.contactedInPeriod), pr('Leads converted', t.leads?.wonInPeriod, P.leads?.wonInPeriod),
      pr('Conversion rate %', t.leads?.periodConversionRate, P.leads?.periodConversionRate), pr('Follow-ups completed', t.followups?.completed, P.followups?.completed),
      pr('Follow-ups on time %', t.followups?.onTimeRate, P.followups?.onTimeRate), pr('Calls connected', t.calls?.answered, P.calls?.answered),
      pr('Talk minutes', t.calls?.talkMinutes, P.calls?.talkMinutes), pr('Emails sent', t.emails?.totalSent, P.emails?.totalSent), pr('Average score', t.score?.average, P.score?.average),
      ...(r.members || []).map((m: any) => pr(`Score: ${m.name}`, m.score?.score, m.previous?.score?.score))
    ], `Comparison period: ${r.previous?.from || '—'} to ${r.previous?.to || '—'}.`);
    // Staff comparison: one column per person.
    const metrics: [string, (m: any) => any][] = [['Performance score', m => m.score?.score], ['Leads assigned', m => m.leads.assigned], ['Contacted in period', m => m.leads.contactedInPeriod],
      ['Converted in period', m => m.leads.wonInPeriod], ['Conversion %', m => m.leads.periodConversionRate], ['Follow-ups completed', m => m.followups.completed], ['On-time %', m => m.followups.onTimeRate],
      ['Calls connected', m => m.calls.answered], ['Talk minutes', m => m.calls.talkMinutes], ['Emails sent', m => m.emails.sent + m.emails.productEmails], ['Target achievement %', m => m.targets?.achievement],
      ['Working days', m => m.productivity?.workingDays], ['Actions per working day', m => m.productivity?.perDay]];
    add('Staff comparison', metrics.map(([label, get]) => Object.fromEntries([['Measure', label], ...(r.members || []).map((m: any) => [m.name, get(m) ?? ''])])));
    XLSX.writeFile(wb, `team-performance-${r.from}-to-${r.to}.xlsx`);
  }
}
