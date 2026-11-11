import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { apiRoot } from '../../core/api-base';
import { PerfGroupedComponent, PerfRadarComponent, PerfTrendComponent, MetricGroup, RadarAxis, seriesStyle } from './perf-charts';

type Mode = 'absolute' | 'percent' | 'perDay' | 'target';
type Kind = 'count' | 'rate' | 'minutes' | 'hours';
interface Metric { key: string; label: string; kind: Kind; get: (m: any) => number | null; lowerIsBetter?: boolean; }

const pctOf = (a: number, b: number): number | null => (b ? Math.round((a / b) * 1000) / 10 : null);

/** The measures compared, by category (every one from recorded activity). */
export const COMPARE_CATEGORIES: { key: string; label: string; metrics: Metric[] }[] = [
  { key: 'leads', label: 'Leads', metrics: [
    { key: 'assigned', label: 'Assigned now', kind: 'count', get: m => m.leads.assigned },
    { key: 'created', label: 'Created', kind: 'count', get: m => m.leads.created },
    { key: 'contacted', label: 'Contacted in period', kind: 'count', get: m => m.leads.contactedInPeriod },
    { key: 'converted', label: 'Converted (won in period)', kind: 'count', get: m => m.leads.wonInPeriod },
    { key: 'lost', label: 'Lost (now)', kind: 'count', get: m => m.leads.lost }
  ] },
  { key: 'conversion', label: 'Conversion', metrics: [
    { key: 'rate', label: 'Conversion rate (won ÷ contacted in the period)', kind: 'rate', get: m => m.leads.periodConversionRate },
    { key: 'time', label: 'Average time to convert', kind: 'hours', get: m => m.conversion?.avgHours ?? null, lowerIsBetter: true },
    { key: 'firstContact', label: 'Time to first contact (median)', kind: 'hours', get: m => m.leads.firstContact.medianHours, lowerIsBetter: true }
  ] },
  { key: 'followups', label: 'Follow-ups', metrics: [
    { key: 'completed', label: 'Completed', kind: 'count', get: m => m.followups.completed },
    { key: 'overdue', label: 'Overdue now', kind: 'count', get: m => m.followups.overdueNow, lowerIsBetter: true },
    { key: 'onTime', label: 'On time', kind: 'rate', get: m => m.followups.onTimeRate }
  ] },
  { key: 'calls', label: 'Calls', metrics: [
    { key: 'made', label: 'Calls made', kind: 'count', get: m => m.calls.made },
    { key: 'answered', label: 'Connected', kind: 'count', get: m => m.calls.answered },
    { key: 'rate', label: 'Answer rate', kind: 'rate', get: m => m.calls.answerRate },
    { key: 'talk', label: 'Talk time', kind: 'minutes', get: m => m.calls.talkMinutes }
  ] },
  { key: 'emails', label: 'Emails', metrics: [
    { key: 'sent', label: 'Sent (individual + product)', kind: 'count', get: m => m.emails.sent + m.emails.productEmails },
    { key: 'delivered', label: 'Delivered', kind: 'count', get: m => m.emails.delivered },
    { key: 'opened', label: 'Opened', kind: 'count', get: m => m.emails.opened },
    { key: 'clicked', label: 'Clicked', kind: 'count', get: m => m.emails.clicked }
  ] },
  { key: 'campaigns', label: 'Campaigns', metrics: [
    { key: 'recipients', label: 'Recipients', kind: 'count', get: m => m.emails.campaignRecipients },
    { key: 'delivered', label: 'Delivered', kind: 'count', get: m => m.emails.campaignDelivered },
    { key: 'opened', label: 'Opened', kind: 'count', get: m => m.emails.campaignOpened },
    { key: 'clicked', label: 'Clicked', kind: 'count', get: m => m.emails.campaignClicked }
  ] },
  { key: 'productivity', label: 'Productivity', metrics: [
    { key: 'actions', label: 'Recorded actions', kind: 'count', get: m => (m.daily || []).reduce((a: number, d: any) => a + d.total, 0) },
    { key: 'activeDays', label: 'Days with activity', kind: 'count', get: m => m.activeDays },
    { key: 'notes', label: 'Notes & activities', kind: 'count', get: m => m.activities.total }
  ] }
];

/**
 * Staff Comparison: 2–10 members side by side for the period. Counts can be shown as numbers, as a share of the
 * selected group, or per working day (so people who joined later are not ranked down for it); rates stay rates.
 */
@Component({
  selector: 'app-staff-comparison',
  standalone: true,
  imports: [CommonModule, FormsModule, PerfGroupedComponent, PerfRadarComponent, PerfTrendComponent],
  styleUrls: ['./team-performance.component.css'],
  styles: [`
    :host { display: block; --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100; --s5: #e87ba4; --s6: #008300; --s7: #6250d6; --s8: #e34948; }
    :host-context([data-theme='dark']) { --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #008300; --s7: #9085e9; --s8: #e66767; }
    .sc-pick { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
    .sc-pick label { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border: 1px solid var(--border); border-radius: 999px; font-size: 0.8rem; cursor: pointer; }
    .sc-pick label.on { border-color: var(--accent, #2a78d6); background: var(--accent-soft); }
    .sc-pick label.off { opacity: .5; cursor: not-allowed; }
    .sc-bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 8px 0 12px; }
    .sc-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px; margin-bottom: 14px; }
    .sc-card { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; font-size: 0.8rem; }
    .sc-card header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .sc-card header button { background: none; border: none; padding: 0; font: inherit; font-weight: 600; color: var(--text); cursor: pointer; text-align: left; }
    .sc-card dl { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; margin: 0; }
    .sc-card dt { color: var(--text-muted); }
    .sc-card dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
    .sw { width: 12px; height: 12px; border-radius: 3px; display: inline-block; flex: none; }
    .sw.hatch { background-image: repeating-linear-gradient(45deg, var(--surface) 0 2px, transparent 2px 5px); }
    .up { color: #0a7d0a; } .down { color: #b42f2f; }
    :host-context([data-theme='dark']) .up { color: #3fbf3f; } :host-context([data-theme='dark']) .down { color: #e66767; }
    .sc-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 14px; }
    .sc-table td.best { font-weight: 700; }
    .sc-table th.cat td, .sc-table tr.cat td { background: var(--surface-hover, rgba(148,163,184,.08)); font-weight: 600; font-size: 0.74rem; text-transform: uppercase; letter-spacing: .03em; }
    .sc-table td:not(:first-child), .sc-table th:not(:first-child) { text-align: right; font-variant-numeric: tabular-nums; }
    .sc-wrap { overflow-x: auto; }
  `],
  template: `
    <p class="muted small">Pick 2 to 10 people. Counts can be shown per working day, so someone who joined during the period is not ranked down for it.</p>
    <div class="sc-pick" role="group" aria-label="Staff to compare">
      <label *ngFor="let m of members" [class.on]="selected.has(m.userId)" [class.off]="!selected.has(m.userId) && selected.size >= 10">
        <input type="checkbox" [checked]="selected.has(m.userId)" [disabled]="!selected.has(m.userId) && selected.size >= 10" (change)="toggle(m.userId)" />
        {{ m.name }}<small class="muted" *ngIf="m.former"> (former)</small>
      </label>
    </div>
    <div class="sc-bar">
      <button type="button" class="btn btn-primary btn-sm" (click)="load()" [disabled]="selected.size < 2 || loading">{{ loading ? 'Comparing…' : 'Compare ' + selected.size }}</button>
      <div class="tp-toggle" role="group" aria-label="Show as">
        <button type="button" *ngFor="let o of modes" [class.on]="mode === o[0]" (click)="mode = o[0]">{{ o[1] }}</button>
      </div>
      <label class="small">Working week
        <select class="hud-input sm" [(ngModel)]="workweek" (ngModelChange)="data && load()" aria-label="Working week">
          <option [ngValue]="5">Mon–Fri</option><option [ngValue]="6">Mon–Sat</option><option [ngValue]="7">Every day</option>
        </select></label>
      <span class="muted small" *ngIf="data">{{ data.from | date:'d MMM' }} – {{ data.to | date:'d MMM y' }} · growth against {{ data.previous.from | date:'d MMM' }} – {{ data.previous.to | date:'d MMM' }}</span>
    </div>
    <div class="note error" *ngIf="error" role="alert">{{ error }}</div>

    <ng-container *ngIf="data">
      <ng-container *ngIf="mode === 'target'">
        <p class="tp-cut" *ngIf="!hasTargets">None of these people has a target in this period. Targets are set under Targets &amp; Goals.</p>
        <section class="tp-chart wide" *ngIf="hasTargets">
          <h3>Target achievement</h3>
          <app-perf-grouped [groups]="targetGroups" [series]="series"></app-perf-grouped>
          <div class="sc-wrap">
            <table class="tp-list sc-table">
              <thead><tr><th>Target</th><th *ngFor="let m of data.members">{{ m.name }}</th></tr></thead>
              <tbody>
                <tr><td><b>Average achievement</b></td><td *ngFor="let m of data.members">{{ m.targets?.total ? (m.targets.achievement ?? '—') + '%' : 'No target' }}</td></tr>
                <tr><td>Targets met</td><td *ngFor="let m of data.members">{{ m.targets?.total ? m.targets.met + ' of ' + m.targets.total : '—' }}</td></tr>
                <tr *ngFor="let k of targetKeys"><td>{{ k.label }} <small class="muted">{{ k.period }}</small></td>
                  <td *ngFor="let m of data.members">{{ targetCell(m, k.key) }}</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      </ng-container>
      <ng-container *ngIf="mode !== 'target'">
        <!-- KPI comparison cards -->
        <div class="sc-cards">
          <article class="sc-card" *ngFor="let m of data.members; let i = index">
            <header><i class="sw" [class.hatch]="style(i).dash" [style.background-color]="'var(' + style(i).color + ')'"></i>
              <button type="button" (click)="openMember.emit(m.userId)">{{ m.name }}</button></header>
            <dl>
              <dt>Working days</dt><dd>{{ m.workingDays }} <small class="muted">({{ m.activeDays }} active)</small></dd>
              <dt>Leads contacted</dt><dd>{{ show(m, metric('leads', 'contacted')) }}</dd>
              <dt>Converted</dt><dd>{{ show(m, metric('leads', 'converted')) }}</dd>
              <dt>Conversion rate</dt><dd>{{ show(m, metric('conversion', 'rate')) }}</dd>
              <dt>Follow-ups on time</dt><dd>{{ show(m, metric('followups', 'onTime')) }}</dd>
              <dt>Calls / connected</dt><dd>{{ show(m, metric('calls', 'made')) }} / {{ show(m, metric('calls', 'answered')) }}</dd>
              <dt>Emails sent</dt><dd>{{ show(m, metric('emails', 'sent')) }}</dd>
              <dt>Actions vs before</dt><dd [class.up]="growth(m) !== null && growth(m)! > 0" [class.down]="growth(m) !== null && growth(m)! < 0">{{ growthText(m) }}</dd>
            </dl>
          </article>
        </div>

        <div class="sc-grid">
          <section class="tp-chart">
            <h3>Side by side
              <select class="hud-input sm" [(ngModel)]="category" aria-label="Category">
                <option *ngFor="let c of categories" [value]="c.key">{{ c.label }}</option></select></h3>
            <app-perf-grouped [groups]="groups" [series]="series"></app-perf-grouped>
          </section>
          <section class="tp-chart">
            <h3>Rates <small class="muted">same 0–100 % scale for everyone · hover a point</small></h3>
            <app-perf-radar [axes]="radarAxes" [series]="radarSeries" ariaLabel="Contacted, conversion, follow-ups on time, follow-ups completed, calls answered and emails opened, per person"></app-perf-radar>
          </section>
        </div>

        <section class="tp-chart wide">
          <h3>Over time
            <select class="hud-input sm" [(ngModel)]="lineMeasure" aria-label="Measure"><option *ngFor="let o of lineMeasures" [value]="o[0]">{{ o[1] }}</option></select>
            <span class="tp-toggle" role="group" aria-label="Grouping">
              <button type="button" [class.on]="lineBy === 'week'" (click)="lineBy = 'week'">Weekly</button>
              <button type="button" [class.on]="lineBy === 'day'" (click)="lineBy = 'day'">Daily</button></span></h3>
          <app-perf-trend [points]="linePoints" [series]="lineSeries" [ariaLabel]="'Per person over time'"></app-perf-trend>
        </section>

        <!-- Ranking / comparison table: every measure, the best marked -->
        <section class="tp-chart wide">
          <h3>Ranking
            <select class="hud-input sm" [(ngModel)]="rankBy" aria-label="Rank by"><option *ngFor="let o of rankOptions" [value]="o.id">{{ o.label }}</option></select></h3>
          <div class="sc-wrap">
            <table class="tp-list sc-table">
              <thead><tr><th>Measure</th><th *ngFor="let m of ranked; let r = index">#{{ r + 1 }} {{ m.name }}</th></tr></thead>
              <tbody>
                <ng-container *ngFor="let c of categories">
                  <tr class="cat"><td [attr.colspan]="ranked.length + 1">{{ c.label }}</td></tr>
                  <tr *ngFor="let k of c.metrics">
                    <td>{{ k.label }}<small *ngIf="mode === 'perDay' && k.kind === 'count'" class="muted"> per working day</small><small *ngIf="mode === 'percent' && k.kind === 'count'" class="muted"> % of group</small></td>
                    <td *ngFor="let m of ranked" [class.best]="isBest(k, m)">{{ show(m, k) }}{{ isBest(k, m) ? ' ★' : '' }}</td>
                  </tr>
                </ng-container>
                <tr class="cat"><td [attr.colspan]="ranked.length + 1">Growth vs previous period</td></tr>
                <tr *ngFor="let g of growthRows"><td>{{ g.label }}</td>
                  <td *ngFor="let m of ranked" [class.up]="change(g.get(m), g.get(m.previous)) > 0" [class.down]="change(g.get(m), g.get(m.previous)) < 0">{{ changeText(g.get(m), g.get(m.previous)) }}</td></tr>
              </tbody>
            </table>
          </div>
          <p class="muted small">★ best of the selected people. Rates are not shown per day. "Converted" counts wins recorded as a status change in the period; average time to convert uses only those ({{ measuredText }}). Working days exclude the chosen weekend days before someone joined; leave and holidays are not recorded in the system.</p>
        </section>
      </ng-container>
    </ng-container>
  `
})
export class StaffComparisonComponent {
  @Input() members: any[] = [];
  @Input() from = '';
  @Input() to = '';
  @Output() openMember = new EventEmitter<number>();
  /** People to start with (e.g. selected in the leaderboard); compared straight away when there are 2+. */
  @Input() set preselect(ids: number[] | null) {
    if (!ids?.length) return;
    this.selected = new Set(ids.slice(0, 10));
    if (this.selected.size >= 2) setTimeout(() => this.load());
  }

  selected = new Set<number>();
  mode: Mode = 'absolute';
  workweek = 5;
  category = 'leads';
  lineMeasure = 'total';
  lineBy: 'week' | 'day' = 'week';
  rankBy = 'conversion.rate';
  data: any = null;
  loading = false;
  error = '';
  private base = `${apiRoot()}/api/v1/performance`;

  readonly categories = COMPARE_CATEGORIES;
  readonly modes: [Mode, string][] = [['absolute', 'Numbers'], ['percent', '% of group'], ['perDay', 'Per working day'], ['target', 'Target achievement']];
  readonly lineMeasures: [string, string][] = [['total', 'All recorded actions'], ['calls', 'Calls'], ['followupsCompleted', 'Follow-ups completed'], ['emails', 'Emails'], ['activities', 'Notes & activities'], ['leadsCreated', 'Leads created']];
  readonly radarAxes: RadarAxis[] = [
    { key: 'contacted', label: 'Leads contacted' }, { key: 'conversion', label: 'Conversion' }, { key: 'onTime', label: 'On time' },
    { key: 'completion', label: 'Follow-ups done' }, { key: 'answer', label: 'Calls answered' }, { key: 'open', label: 'Emails opened' }
  ];
  readonly growthRows: { label: string; get: (m: any) => number }[] = [
    { label: 'Leads contacted', get: m => m?.leads?.contactedInPeriod ?? 0 },
    { label: 'Follow-ups completed', get: m => m?.followups?.completed ?? 0 },
    { label: 'Calls made', get: m => m?.calls?.made ?? 0 },
    { label: 'Emails sent', get: m => (m?.emails?.sent ?? 0) + (m?.emails?.productEmails ?? 0) }
  ];

  constructor(private http: HttpClient) {}

  toggle(id: number): void {
    if (this.selected.has(id)) this.selected.delete(id);
    else if (this.selected.size < 10) this.selected.add(id);
  }

  load(): void {
    if (this.selected.size < 2) return;
    this.loading = true;
    this.error = '';
    this.http.get<any>(`${this.base}/compare`, { params: { ids: [...this.selected].join(','), from: this.from, to: this.to, workweek: String(this.workweek) } }).subscribe({
      next: r => { this.loading = false; this.data = r; },
      error: e => { this.loading = false; this.error = e?.error?.error || 'Could not compare.'; }
    });
  }

  style(i: number) { return seriesStyle(i); }
  get series() { return (this.data?.members || []).map((m: any, i: number) => ({ key: String(m.userId), label: m.name, ...seriesStyle(i) })); }
  metric(cat: string, key: string): Metric { return COMPARE_CATEGORIES.find(c => c.key === cat)!.metrics.find(k => k.key === key)!; }

  /** The value of a measure for a member in the current mode (counts change; rates and times do not). */
  value(m: any, k: Metric): number | null {
    const v = k.get(m);
    if (v === null || v === undefined) return null;
    if (k.kind !== 'count') return v;
    if (this.mode === 'perDay') return m.workingDays ? Math.round((v / m.workingDays) * 100) / 100 : null;
    if (this.mode === 'percent') {
      const sum = (this.data?.members || []).reduce((a: number, x: any) => a + (Number(k.get(x)) || 0), 0);
      return pctOf(v, sum);
    }
    return v;
  }
  show(m: any, k: Metric): string {
    const v = this.value(m, k);
    if (v === null) return '—';
    if (k.kind === 'rate' || (k.kind === 'count' && this.mode === 'percent')) return `${v}%`;
    if (k.kind === 'minutes') return `${v} min`;
    if (k.kind === 'hours') return v < 1 ? `${Math.max(1, Math.round(v * 60))} min` : v < 48 ? `${Math.round(v * 10) / 10} h` : `${Math.round((v / 24) * 10) / 10} d`;
    return String(v);
  }
  isBest(k: Metric, m: any): boolean {
    const vals = (this.data?.members || []).map((x: any) => this.value(x, k)).filter((v: number | null) => v !== null) as number[];
    const v = this.value(m, k);
    if (v === null || vals.length < 2) return false;
    const top = k.lowerIsBetter ? Math.min(...vals) : Math.max(...vals);
    return v === top && vals.filter(x => x === top).length === 1 && (k.lowerIsBetter || top > 0);
  }

  get groups(): MetricGroup[] {
    const cat = COMPARE_CATEGORIES.find(c => c.key === this.category) || COMPARE_CATEGORIES[0];
    return cat.metrics.map(k => ({
      key: k.key, label: k.label + (k.kind === 'count' && this.mode === 'perDay' ? ' (per working day)' : k.kind === 'count' && this.mode === 'percent' ? ' (% of group)' : ''),
      lowerIsBetter: k.lowerIsBetter,
      values: Object.fromEntries((this.data?.members || []).map((m: any) => [String(m.userId), this.value(m, k)])),
      display: Object.fromEntries((this.data?.members || []).map((m: any) => [String(m.userId), this.show(m, k)]))
    }));
  }

  get radarSeries() {
    return (this.data?.members || []).map((m: any, i: number) => ({
      key: String(m.userId), label: m.name, ...seriesStyle(i),
      values: {
        contacted: pctOf(m.leads.contacted, m.leads.assigned), conversion: m.leads.periodConversionRate, onTime: m.followups.onTimeRate,
        completion: m.followups.completionRate, answer: m.calls.answerRate, open: m.emails.openRate
      }
    }));
  }

  get lineSeries() { return (this.data?.members || []).map((m: any, i: number) => ({ key: `u${m.userId}`, label: m.name, ...seriesStyle(i) })); }
  get linePoints(): any[] {
    const ms = this.data?.members || [];
    if (!ms.length) return [];
    const src = (m: any) => (this.lineBy === 'week' ? m.weekly.map((w: any) => ({ ...w, day: w.week })) : m.daily);
    return src(ms[0]).map((p: any, i: number) => {
      const row: any = { day: p.day };
      for (const m of ms) row[`u${m.userId}`] = src(m)[i]?.[this.lineMeasure] ?? 0;
      return row;
    });
  }

  get rankOptions(): { id: string; label: string }[] {
    return COMPARE_CATEGORIES.flatMap(c => c.metrics.map(k => ({ id: `${c.key}.${k.key}`, label: `${c.label}: ${k.label}` })));
  }
  get ranked(): any[] {
    const [cat, key] = this.rankBy.split('.');
    const k = this.metric(cat, key);
    const ms = [...(this.data?.members || [])];
    return ms.sort((a, b) => {
      const va = this.value(a, k); const vb = this.value(b, k);
      if (va === null && vb === null) return a.name.localeCompare(b.name);
      if (va === null) return 1;
      if (vb === null) return -1;
      return (k.lowerIsBetter ? va - vb : vb - va) || a.name.localeCompare(b.name);
    });
  }

  change(cur: number, prev: number): number { return prev ? ((cur - prev) / prev) * 100 : cur ? Infinity : 0; }
  changeText(cur: number, prev: number): string {
    if (!prev && !cur) return 'no activity';
    if (!prev) return `new (${cur})`;
    const c = Math.round(this.change(cur, prev));
    return `${c > 0 ? '▲ +' : c < 0 ? '▼ ' : ''}${c}% (${prev} → ${cur})`;
  }
  private actions(m: any): number { return this.growthRows.reduce((a, g) => a + g.get(m), 0); }
  growth(m: any): number | null { const p = this.actions(m.previous); return p ? Math.round(((this.actions(m) - p) / p) * 100) : null; }
  growthText(m: any): string { const g = this.growth(m); return g === null ? (this.actions(m) ? 'new' : '—') : `${g > 0 ? '▲ +' : g < 0 ? '▼ ' : ''}${g}%`; }
  get hasTargets(): boolean { return (this.data?.members || []).some((m: any) => m.targets?.total); }
  /** Each measure and period anyone compared has a target for. */
  get targetKeys(): { key: string; label: string; period: string }[] {
    const seen = new Map<string, { key: string; label: string; period: string }>();
    for (const m of this.data?.members || []) for (const i of m.targets?.items || []) seen.set(`${i.metric}|${i.periodType}`, { key: `${i.metric}|${i.periodType}`, label: i.label, period: i.periodLabel });
    return [...seen.values()];
  }
  targetCell(m: any, key: string): string {
    const i = (m.targets?.items || []).find((x: any) => `${x.metric}|${x.periodType}` === key);
    if (!i) return '—';
    const u = (v: any) => (v === null || v === undefined ? '—' : i.unit === '%' ? `${v}%` : i.unit === 'min' ? `${v} min` : String(v));
    return `${u(i.actual)} of ${u(i.target)} (${i.pct ?? 0}%)`;
  }
  get targetGroups(): MetricGroup[] {
    return [{ key: 'ach', label: 'Average target achievement (%)',
      values: Object.fromEntries((this.data?.members || []).map((m: any) => [String(m.userId), m.targets?.total ? m.targets.achievement : null])),
      display: Object.fromEntries((this.data?.members || []).map((m: any) => [String(m.userId), m.targets?.total ? `${m.targets.achievement ?? '—'}%` : 'No target'])) }];
  }
  get measuredText(): string {
    const n = (this.data?.members || []).reduce((a: number, m: any) => a + (m.conversion?.measured || 0), 0);
    return n ? `${n} measured win${n > 1 ? 's' : ''}` : 'none measured yet';
  }
}
