import { Component, EventEmitter, Input, OnChanges, Output } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * Charts for Team Performance, drawn as plain SVG (no chart library).
 * Colours: the validated categorical slots 1–8 in fixed order (blue, orange, aqua, yellow, magenta, green, violet, red); a 9th
 * and 10th series reuse slots 1–2 with a dashed line / hatched bar (never an unmarked repeat). The status palette
 * (good / warning / critical) for on-time / late / overdue, always with a legend and labels, so colour
 * never carries the meaning alone. Light and dark steps are set per theme.
 */
const VIZ_STYLES = `
  :host { display: block; --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100; --s5: #e87ba4; --s6: #008300; --s7: #6250d6; --s8: #e34948; --good: #0ca30c; --warn: #fab219; --crit: #d03b3b; --neutral: #c3c2b7;
    --grid: #e1e0d9; --axis: #c3c2b7; --ink: var(--text); --ink2: var(--text-muted); --surf: var(--surface); }
  :host-context([data-theme='dark']) { --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #008300; --s7: #9085e9; --s8: #e66767; --neutral: #4a4a46; --grid: #2c2c2a; --axis: #383835; }
  .viz-legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 0.8rem; color: var(--ink2); margin-bottom: 6px; }
  .viz-key { display: inline-flex; align-items: center; gap: 6px; }
  .viz-sw { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
  .viz-sw.line { height: 3px; border-radius: 2px; width: 16px; }
  .viz-sw.line.dash { background: repeating-linear-gradient(90deg, currentColor 0 5px, transparent 5px 8px); }
  .viz-sw.hatch { background: repeating-linear-gradient(45deg, currentColor 0 2px, transparent 2px 4px) !important; border: 1px solid currentColor; }
  .viz-wrap { position: relative; }
  svg { width: 100%; height: auto; display: block; overflow: visible; font-family: inherit; }
  .viz-tip { position: absolute; pointer-events: none; background: var(--surf); border: 1px solid var(--border-strong, rgba(0,0,0,.12)); border-radius: 8px;
    padding: 8px 10px; font-size: 0.78rem; color: var(--ink); box-shadow: 0 6px 18px rgba(0,0,0,.12); white-space: nowrap; z-index: 2; transform: translate(-50%, -100%); }
  .viz-tip b { display: block; margin-bottom: 4px; }
  .viz-tip .row { display: flex; align-items: center; gap: 6px; }
  .viz-tip .row span:last-child { margin-left: auto; padding-left: 12px; font-variant-numeric: tabular-nums; }
  .viz-empty { color: var(--ink2); font-size: 0.85rem; padding: 18px 0; }
`;

export interface TrendPoint { day: string; [k: string]: any; }
export interface TrendSeries { key: string; label: string; color: string; dash?: boolean; }

/** Series colour for the i-th compared member: slots 1–8 in order, then 1–2 again dashed / hatched. */
export function seriesStyle(i: number): { color: string; dash: boolean } { return { color: `--s${(i % 8) + 1}`, dash: i >= 8 }; }

@Component({
  selector: 'app-perf-trend',
  standalone: true,
  imports: [CommonModule],
  styles: [VIZ_STYLES, ` .viz-wrap svg { max-height: 260px; } `],
  template: `
    <div class="viz-legend" *ngIf="series.length > 1">
      <span class="viz-key" *ngFor="let s of series"><i class="viz-sw line" [class.dash]="s.dash" [style.background]="s.dash ? null : 'var(' + s.color + ')'" [style.color]="'var(' + s.color + ')'"></i>{{ s.label }}</span>
    </div>
    <p class="viz-empty" *ngIf="!hasData">Nothing recorded in this period.</p>
    <div class="viz-wrap" *ngIf="hasData" (mouseleave)="hover = null">
      <svg [attr.viewBox]="'0 0 ' + W + ' ' + H" role="img" [attr.aria-label]="ariaLabel">
        <!-- gridlines and y ticks -->
        <g *ngFor="let t of yTicks">
          <line [attr.x1]="L" [attr.x2]="W - R" [attr.y1]="y(t)" [attr.y2]="y(t)" stroke="var(--grid)" stroke-width="1" />
          <text [attr.x]="L - 8" [attr.y]="y(t) + 4" text-anchor="end" font-size="11" fill="var(--ink2)">{{ t }}</text>
        </g>
        <line [attr.x1]="L" [attr.x2]="W - R" [attr.y1]="y(0)" [attr.y2]="y(0)" stroke="var(--axis)" stroke-width="1" />
        <!-- x labels -->
        <text *ngFor="let i of xTickIdx" [attr.x]="x(i)" [attr.y]="H - 6" text-anchor="middle" font-size="11" fill="var(--ink2)">{{ dayLabel(points[i].day) }}</text>
        <!-- lines -->
        <path *ngFor="let s of series" [attr.d]="path(s.key)" fill="none" [attr.stroke]="'var(' + s.color + ')'" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" [attr.stroke-dasharray]="s.dash ? '6 4' : null" />
        <!-- end labels (direct labels) -->
        <ng-container *ngFor="let s of series; let k = index">
          <circle [attr.cx]="x(points.length - 1)" [attr.cy]="y(points[points.length - 1][s.key])" r="4" [attr.fill]="'var(' + s.color + ')'" stroke="var(--surf)" stroke-width="2" />
        </ng-container>
        <!-- crosshair -->
        <ng-container *ngIf="hover !== null">
          <line [attr.x1]="x(hover)" [attr.x2]="x(hover)" [attr.y1]="T" [attr.y2]="y(0)" stroke="var(--axis)" stroke-width="1" stroke-dasharray="3 3" />
          <circle *ngFor="let s of series" [attr.cx]="x(hover)" [attr.cy]="y(points[hover][s.key])" r="4.5" [attr.fill]="'var(' + s.color + ')'" stroke="var(--surf)" stroke-width="2" />
        </ng-container>
        <!-- hit areas: one column per day -->
        <rect *ngFor="let p of points; let i = index" [attr.x]="x(i) - colW / 2" [attr.y]="T" [attr.width]="colW" [attr.height]="y(0) - T" fill="transparent"
              (mouseenter)="hover = i" (click)="hover = i; select.emit(i)" [style.cursor]="clickable ? 'pointer' : null" />
      </svg>
      <div class="viz-tip" *ngIf="hover !== null" [style.left.%]="(x(hover) / W) * 100" [style.top.%]="(T / H) * 100">
        <b>{{ points[hover].day | date:'EEE d MMM' }}</b>
        <div class="row" *ngFor="let s of series"><i class="viz-sw" [style.background]="'var(' + s.color + ')'"></i><span>{{ s.label }}</span><span>{{ points[hover][s.key] }}</span></div>
      </div>
    </div>`
})
export class PerfTrendComponent implements OnChanges {
  /** Click on a day (or bucket): its index. */
  @Output() select = new EventEmitter<number>();
  @Input() clickable = false;
  @Input() points: TrendPoint[] = [];
  @Input() series: TrendSeries[] = [];
  @Input() ariaLabel = 'Activity per day';
  readonly W = 720; readonly H = 230; readonly L = 36; readonly R = 16; readonly T = 12; readonly B = 26;
  hover: number | null = null;
  max = 1;
  yTicks: number[] = [];
  xTickIdx: number[] = [];

  get hasData(): boolean { return this.points.some(p => this.series.some(s => Number(p[s.key]) > 0)); }
  get colW(): number { return this.points.length > 1 ? (this.W - this.L - this.R) / (this.points.length - 1) : 40; }

  ngOnChanges(): void {
    this.hover = null;
    const top = Math.max(1, ...this.points.flatMap(p => this.series.map(s => Number(p[s.key]) || 0)));
    const step = top <= 5 ? 1 : top <= 10 ? 2 : top <= 25 ? 5 : top <= 50 ? 10 : Math.ceil(top / 5 / 10) * 10;
    this.max = Math.ceil(top / step) * step;
    this.yTicks = Array.from({ length: this.max / step + 1 }, (_, i) => i * step);
    const n = this.points.length;
    const every = Math.max(1, Math.ceil(n / 7));
    this.xTickIdx = n ? [...new Set([...Array.from({ length: Math.ceil(n / every) }, (_, i) => i * every), n - 1])].filter(i => i < n) : [];
  }

  x(i: number): number { const n = this.points.length; return n <= 1 ? (this.L + this.W - this.R) / 2 : this.L + (i / (n - 1)) * (this.W - this.L - this.R); }
  y(v: number): number { return this.T + (1 - (Number(v) || 0) / this.max) * (this.H - this.T - this.B); }
  path(key: string): string { return this.points.map((p, i) => `${i ? 'L' : 'M'}${this.x(i).toFixed(1)},${this.y(p[key]).toFixed(1)}`).join(' '); }
  dayLabel(d: string): string { const dt = new Date(`${d}T00:00:00`); return dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); }
}

export interface BarRow { id: number; label: string; values: Record<string, number>; }
export interface BarSegment { key: string; label: string; color: string; }

@Component({
  selector: 'app-perf-bars',
  standalone: true,
  imports: [CommonModule],
  styles: [VIZ_STYLES + `
    .bars { display: flex; flex-direction: column; gap: 8px; }
    .bar-row { display: grid; grid-template-columns: minmax(90px, 160px) 1fr auto; gap: 10px; align-items: center; background: none; border: none; padding: 2px 0; text-align: left; cursor: pointer; color: var(--ink); font: inherit; width: 100%; }
    .bar-row:hover .bar-name, .bar-row:focus-visible .bar-name { color: var(--accent-text, var(--ink)); text-decoration: underline; }
    .bar-name { font-size: 0.84rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bar-track { display: flex; gap: 2px; height: 16px; align-items: stretch; min-width: 0; }
    .bar-seg { height: 100%; min-width: 2px; }
    .bar-seg:first-child { border-radius: 4px 0 0 4px; }
    .bar-seg:last-child { border-radius: 0 4px 4px 0; }
    .bar-seg:only-child { border-radius: 4px; }
    .bar-total { font-size: 0.8rem; color: var(--ink2); font-variant-numeric: tabular-nums; min-width: 28px; text-align: right; }
  `],
  template: `
    <div class="viz-legend">
      <span class="viz-key" *ngFor="let s of segments"><i class="viz-sw" [style.background]="'var(' + s.color + ')'"></i>{{ s.label }}</span>
    </div>
    <p class="viz-empty" *ngIf="!max">Nothing recorded in this period.</p>
    <div class="bars viz-wrap" *ngIf="max" (mouseleave)="tip = null">
      <button type="button" class="bar-row" *ngFor="let r of rows" (click)="select.emit(r.id)" [attr.aria-label]="r.label + ': ' + describe(r)"
              (mousemove)="showTip($event, r)" (focus)="tip = { row: r, x: 50, y: 0 }" (blur)="tip = null">
        <span class="bar-name">{{ r.label }}</span>
        <span class="bar-track" [style.width.%]="(total(r) / max) * 100">
          <i class="bar-seg" *ngFor="let s of segments" [hidden]="!r.values[s.key]" [style.flex-grow]="r.values[s.key] || 0" [style.background]="'var(' + s.color + ')'"></i>
        </span>
        <span class="bar-total">{{ total(r) }}</span>
      </button>
      <div class="viz-tip" *ngIf="tip" [style.left.px]="tip.x" [style.top.px]="tip.y">
        <b>{{ tip.row.label }}</b>
        <div class="row" *ngFor="let s of segments"><i class="viz-sw" [style.background]="'var(' + s.color + ')'"></i><span>{{ s.label }}</span><span>{{ tip.row.values[s.key] || 0 }}</span></div>
      </div>
    </div>`
})
export class PerfBarsComponent implements OnChanges {
  @Input() rows: BarRow[] = [];
  @Input() segments: BarSegment[] = [];
  @Output() select = new EventEmitter<number>();
  max = 0;
  tip: { row: BarRow; x: number; y: number } | null = null;

  ngOnChanges(): void { this.max = Math.max(0, ...this.rows.map(r => this.total(r))); }
  total(r: BarRow): number { return this.segments.reduce((a, s) => a + (Number(r.values[s.key]) || 0), 0); }
  describe(r: BarRow): string { return this.segments.map(s => `${s.label} ${r.values[s.key] || 0}`).join(', '); }
  showTip(ev: MouseEvent, r: BarRow): void {
    const host = (ev.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
    this.tip = { row: r, x: ev.clientX - host.left, y: ev.clientY - host.top - 8 };
  }
}

export interface DonutSlice { key: string; label: string; value: number; color: string; }

/**
 * Donut: how one whole splits, at a glance (≤ 4–5 parts). The legend lists every part with its
 * number and share, so reading never depends on comparing slice sizes or on colour alone.
 */
@Component({
  selector: 'app-perf-donut',
  standalone: true,
  imports: [CommonModule],
  styles: [VIZ_STYLES + `
    .donut { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
    .donut svg { width: 150px; height: 150px; flex: 0 0 150px; }
    .donut-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; flex: 1 1 140px; min-width: 0; }
    .donut-list li { display: grid; grid-template-columns: 12px 1fr auto auto; gap: 8px; align-items: center; font-size: 0.8rem; color: var(--ink); cursor: pointer; padding: 2px 4px; border-radius: 6px; }
    .donut-list li:hover, .donut-list li.on { background: var(--accent-soft, rgba(0,0,0,.05)); }
    .donut-list li span.n { font-variant-numeric: tabular-nums; font-weight: 600; }
    .donut-list li span.p { color: var(--ink2); font-variant-numeric: tabular-nums; min-width: 38px; text-align: right; }
    .seg { cursor: pointer; transition: opacity .15s; }
    .seg.dim { opacity: 0.35; }
  `],
  template: `
    <p class="viz-empty" *ngIf="!total">{{ empty }}</p>
    <div class="donut" *ngIf="total">
      <svg viewBox="0 0 120 120" role="img" [attr.aria-label]="ariaLabel">
        <circle cx="60" cy="60" [attr.r]="r" fill="none" stroke="var(--grid)" [attr.stroke-width]="w" />
        <circle *ngFor="let a of arcs" class="seg" [class.dim]="hover && hover !== a.key" cx="60" cy="60" [attr.r]="r" fill="none"
                [attr.stroke]="'var(' + a.color + ')'" [attr.stroke-width]="w" [attr.stroke-dasharray]="a.dash" [attr.stroke-dashoffset]="a.offset"
                transform="rotate(-90 60 60)" (mouseenter)="hover = a.key" (mouseleave)="hover = null" (click)="select.emit(a.key)" />
        <text x="60" y="58" text-anchor="middle" font-size="22" font-weight="700" fill="var(--ink)">{{ hoverSlice ? hoverSlice.value : total }}</text>
        <text x="60" y="76" text-anchor="middle" font-size="9.5" fill="var(--ink2)">{{ hoverSlice ? hoverSlice.label : centerLabel }}</text>
      </svg>
      <ul class="donut-list">
        <li *ngFor="let s of slices" [class.on]="hover === s.key" (mouseenter)="hover = s.key" (mouseleave)="hover = null" (click)="select.emit(s.key)">
          <i class="viz-sw" [style.background]="'var(' + s.color + ')'"></i><span>{{ s.label }}</span><span class="n">{{ s.value }}</span><span class="p">{{ share(s.value) }}</span>
        </li>
      </ul>
    </div>`
})
export class PerfDonutComponent implements OnChanges {
  @Input() slices: DonutSlice[] = [];
  @Input() centerLabel = 'total';
  @Input() ariaLabel = '';
  @Input() empty = 'Nothing recorded in this period.';
  @Output() select = new EventEmitter<string>();
  readonly r = 46; readonly w = 18;
  total = 0;
  arcs: { key: string; color: string; dash: string; offset: number }[] = [];
  hover: string | null = null;

  get hoverSlice(): DonutSlice | undefined { return this.slices.find(s => s.key === this.hover); }
  share(v: number): string { return this.total ? `${Math.round((v / this.total) * 100)}%` : '—'; }

  ngOnChanges(): void {
    this.total = this.slices.reduce((a, s) => a + (Number(s.value) || 0), 0);
    const C = 2 * Math.PI * this.r;
    const gap = this.slices.filter(s => s.value > 0).length > 1 ? 2 : 0; // 2px surface gap between parts
    let at = 0;
    this.arcs = this.slices.filter(s => s.value > 0).map(s => {
      const len = (s.value / this.total) * C;
      const arc = { key: s.key, color: s.color, dash: `${Math.max(len - gap, 0.5)} ${C}`, offset: -at };
      at += len;
      return arc;
    });
  }
}

/** Ring meter: one ratio against its whole (e.g. 82% on time). The fill shows severity; the label says it. */
@Component({
  selector: 'app-perf-ring',
  standalone: true,
  imports: [CommonModule],
  styles: [VIZ_STYLES + `
    :host { display: inline-flex; }
    .ring { display: flex; flex-direction: column; align-items: center; gap: 4px; min-width: 96px; }
    .ring svg { width: 84px; height: 84px; }
    .ring small { font-size: 0.75rem; color: var(--ink2); text-align: center; line-height: 1.25; max-width: 120px; }
    .ring.sm svg { width: 46px; height: 46px; }
    .ring.sm { min-width: 0; flex-direction: row; gap: 6px; }
    .ring.sm small { text-align: left; font-size: 0.72rem; }
  `],
  template: `
    <div class="ring" [class.sm]="small" [attr.title]="label + ': ' + (value === null ? 'no data' : value + '%')">
      <svg viewBox="0 0 60 60" role="img" [attr.aria-label]="label + ': ' + (value === null ? 'no data' : value + '%')">
        <circle cx="30" cy="30" r="24" fill="none" stroke="var(--grid)" stroke-width="7" />
        <circle *ngIf="value !== null && value > 0" cx="30" cy="30" r="24" fill="none" [attr.stroke]="'var(' + tone + ')'" stroke-width="7" stroke-linecap="round"
                [attr.stroke-dasharray]="(value / 100) * 150.8 + ' 151'" transform="rotate(-90 30 30)" />
        <text x="30" y="34.5" text-anchor="middle" [attr.font-size]="small ? 15 : 13" font-weight="700" fill="var(--ink)">{{ value === null ? '—' : value + '%' }}</text>
      </svg>
      <small *ngIf="label">{{ label }}</small>
    </div>`
})
export class PerfRingComponent {
  @Input() value: number | null = null;
  @Input() label = '';
  @Input() small = false;
  /** Thresholds: at or above `good` is good, at or above `warn` is warning, else critical. */
  @Input() good = 80;
  @Input() warn = 50;
  /** A fixed colour (e.g. a target's status colour) instead of the thresholds. */
  @Input() color: string | null = null;
  get tone(): string { if (this.color) return this.color; const v = this.value ?? 0; return v >= this.good ? '--good' : v >= this.warn ? '--warn' : '--crit'; }
}

/** Funnel: each step as a bar from one baseline, one hue, with its share of the first step. */
@Component({
  selector: 'app-perf-funnel',
  standalone: true,
  imports: [CommonModule],
  styles: [VIZ_STYLES + `
    .fn { display: flex; flex-direction: column; gap: 8px; }
    .fn-row { display: grid; grid-template-columns: 90px 1fr 92px; gap: 10px; align-items: center; font-size: 0.82rem; border-radius: 6px; }
    .fn-row.click { cursor: pointer; } .fn-row.click:hover { background: rgba(148, 163, 184, .1); }
    .fn-track { height: 18px; }
    .fn-bar { height: 100%; background: var(--s1); border-radius: 0 4px 4px 0; min-width: 2px; }
    .fn-val { text-align: right; font-variant-numeric: tabular-nums; }
    .fn-val small { color: var(--ink2); margin-left: 4px; }
  `],
  template: `
    <p class="viz-empty" *ngIf="!steps.length || !steps[0].value">{{ empty }}</p>
    <div class="fn" *ngIf="steps.length && steps[0].value">
      <div class="fn-row" *ngFor="let s of steps; let i = index" [class.click]="clickable" (click)="clickable && select.emit(i)" [attr.role]="clickable ? 'button' : null" [attr.tabindex]="clickable ? 0 : null" (keydown.enter)="clickable && select.emit(i)">
        <span>{{ s.label }}</span>
        <span class="fn-track"><i class="fn-bar" [style.display]="'block'" [style.width.%]="(s.value / steps[0].value) * 100"></i></span>
        <span class="fn-val">{{ s.value }}<small>{{ s === steps[0] ? '' : (s.value / steps[0].value * 100 | number:'1.0-0') + '%' }}</small></span>
      </div>
    </div>`
})
export class PerfFunnelComponent {
  @Input() clickable = false;
  /** Click on a step: its index. */
  @Output() select = new EventEmitter<number>();
  @Input() steps: { label: string; value: number }[] = [];
  @Input() empty = 'No email campaigns sent in this period.';
}

export interface GroupedSeries { key: string; label: string; color: string; dash?: boolean; }
export interface MetricGroup { key: string; label: string; values: Record<string, number | null>; display: Record<string, string>; lowerIsBetter?: boolean; }

/**
 * Grouped bars: one group per measure, one thin bar per compared member (same colour as everywhere else),
 * each bar labelled with its value; the best in each group is marked ★. Bars scale within their group.
 */
@Component({
  selector: 'app-perf-grouped',
  standalone: true,
  imports: [CommonModule],
  styles: [VIZ_STYLES + `
    .grp { margin-bottom: 14px; }
    .grp h4 { margin: 0 0 6px; font-size: 0.8rem; font-weight: 600; color: var(--ink); }
    .gb { display: grid; grid-template-columns: minmax(80px, 140px) 1fr minmax(56px, auto); gap: 8px; align-items: center; font-size: 0.78rem; margin: 3px 0; }
    .gb-name { color: var(--ink2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gb-track { height: 10px; position: relative; }
    .gb-bar { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 0 4px 4px 0; min-width: 2px; }
    .gb-bar.hatch { background-image: repeating-linear-gradient(45deg, var(--surf) 0 2px, transparent 2px 5px); }
    .gb-val { color: var(--ink); font-variant-numeric: tabular-nums; text-align: right; }
    .gb-val.na { color: var(--ink2); }
  `],
  template: `
    <div class="viz-legend" role="list">
      <span class="viz-key" role="listitem" *ngFor="let s of series"><i class="viz-sw" [class.hatch]="s.dash" [style.background]="s.dash ? null : 'var(' + s.color + ')'" [style.color]="'var(' + s.color + ')'"></i>{{ s.label }}</span>
    </div>
    <div class="grp" *ngFor="let g of groups" role="group" [attr.aria-label]="g.label">
      <h4>{{ g.label }}</h4>
      <div class="gb" *ngFor="let s of series" [title]="s.label + ' · ' + g.label + ': ' + (g.display[s.key] || '—')">
        <span class="gb-name">{{ s.label }}</span>
        <span class="gb-track"><i class="gb-bar" *ngIf="g.values[s.key] !== null && g.values[s.key] !== undefined" [class.hatch]="s.dash"
          [style.width.%]="width(g, s.key)" [style.background-color]="'var(' + s.color + ')'"></i></span>
        <span class="gb-val" [class.na]="g.values[s.key] === null || g.values[s.key] === undefined">{{ g.display[s.key] || '—' }}{{ best(g) === s.key ? ' ★' : '' }}</span>
      </div>
    </div>`
})
export class PerfGroupedComponent {
  @Input() groups: MetricGroup[] = [];
  @Input() series: GroupedSeries[] = [];
  private max(g: MetricGroup): number { return Math.max(0, ...this.series.map(s => Number(g.values[s.key]) || 0)); }
  width(g: MetricGroup, key: string): number { const m = this.max(g); return m ? (Math.max(0, Number(g.values[key]) || 0) / m) * 100 : 0; }
  /** The single best member of a group (none on a tie or when nothing is recorded). */
  best(g: MetricGroup): string | null {
    const vals = this.series.map(s => ({ k: s.key, v: g.values[s.key] })).filter(x => x.v !== null && x.v !== undefined) as { k: string; v: number }[];
    if (vals.length < 2) return null;
    const top = g.lowerIsBetter ? Math.min(...vals.map(x => x.v)) : Math.max(...vals.map(x => x.v));
    const at = vals.filter(x => x.v === top);
    return at.length === 1 && (g.lowerIsBetter || top > 0) ? at[0].k : null;
  }
}

export interface RadarAxis { key: string; label: string; }
export interface RadarSeries { key: string; label: string; color: string; dash?: boolean; values: Record<string, number | null>; }

/**
 * Radar of rates (each axis 0–100 %, the same scale for everyone, so it compares quality, not volume).
 * A missing rate (nothing to measure) sits at the centre with a hollow marker and reads "no data".
 */
@Component({
  selector: 'app-perf-radar',
  standalone: true,
  imports: [CommonModule],
  styles: [VIZ_STYLES + `
    .rd { max-width: 440px; margin: 0 auto; }
    .ax { font-size: 11px; fill: var(--ink2); }
    .hit { cursor: default; }
  `],
  template: `
    <div class="viz-legend" role="list">
      <span class="viz-key" role="listitem" *ngFor="let s of series"><i class="viz-sw line" [class.dash]="s.dash" [style.background]="s.dash ? null : 'var(' + s.color + ')'" [style.color]="'var(' + s.color + ')'"></i>{{ s.label }}</span>
    </div>
    <div class="viz-wrap rd">
      <svg [attr.viewBox]="'0 0 ' + S + ' ' + S" role="img" [attr.aria-label]="ariaLabel">
        <polygon *ngFor="let lv of [25, 50, 75, 100]" [attr.points]="ring(lv)" fill="none" stroke="var(--grid)" stroke-width="1" />
        <line *ngFor="let a of axes; let i = index" [attr.x1]="C" [attr.y1]="C" [attr.x2]="pt(i, 100).x" [attr.y2]="pt(i, 100).y" stroke="var(--grid)" stroke-width="1" />
        <text *ngFor="let a of axes; let i = index" class="ax" [attr.x]="pt(i, 118).x" [attr.y]="pt(i, 118).y" text-anchor="middle" dominant-baseline="middle">{{ a.label }}</text>
        <text class="ax" [attr.x]="C + 3" [attr.y]="pt(0, 50).y" dominant-baseline="middle">50%</text>
        <g *ngFor="let s of series">
          <polygon [attr.points]="shape(s)" [attr.fill]="'var(' + s.color + ')'" fill-opacity="0.06" [attr.stroke]="'var(' + s.color + ')'" stroke-width="2"
            stroke-linejoin="round" [attr.stroke-dasharray]="s.dash ? '6 4' : null" [attr.stroke-opacity]="tip && tip.s !== s.key ? 0.25 : 1" />
          <g *ngFor="let a of axes; let i = index">
            <circle [attr.cx]="pt(i, val(s, a.key)).x" [attr.cy]="pt(i, val(s, a.key)).y" r="4" [attr.fill]="s.values[a.key] === null || s.values[a.key] === undefined ? 'var(--surf)' : 'var(' + s.color + ')'"
              [attr.stroke]="'var(' + s.color + ')'" stroke-width="2" />
            <circle class="hit" [attr.cx]="pt(i, val(s, a.key)).x" [attr.cy]="pt(i, val(s, a.key)).y" r="11" fill="transparent"
              (mouseenter)="show(s, a, i)" (mouseleave)="tip = null" />
          </g>
        </g>
      </svg>
      <div class="viz-tip" *ngIf="tip" [style.left.%]="tip.x" [style.top.%]="tip.y">
        <b>{{ tip.label }}</b><div class="row"><span>{{ tip.axis }}</span><span>{{ tip.value }}</span></div>
      </div>
    </div>`
})
export class PerfRadarComponent {
  @Input() axes: RadarAxis[] = [];
  @Input() series: RadarSeries[] = [];
  @Input() ariaLabel = 'Rates compared';
  readonly S = 360; readonly C = 180; readonly R = 120;
  tip: { s: string; label: string; axis: string; value: string; x: number; y: number } | null = null;
  val(s: RadarSeries, k: string): number { return Math.max(0, Math.min(100, Number(s.values[k]) || 0)); }
  pt(i: number, v: number): { x: number; y: number } {
    const ang = -Math.PI / 2 + (i / Math.max(1, this.axes.length)) * Math.PI * 2;
    const r = (v / 100) * this.R;
    return { x: this.C + r * Math.cos(ang), y: this.C + r * Math.sin(ang) };
  }
  ring(v: number): string { return this.axes.map((_, i) => { const p = this.pt(i, v); return `${p.x.toFixed(1)},${p.y.toFixed(1)}`; }).join(' '); }
  shape(s: RadarSeries): string { return this.axes.map((a, i) => { const p = this.pt(i, this.val(s, a.key)); return `${p.x.toFixed(1)},${p.y.toFixed(1)}`; }).join(' '); }
  show(s: RadarSeries, a: RadarAxis, i: number): void {
    const p = this.pt(i, this.val(s, a.key));
    const v = s.values[a.key];
    this.tip = { s: s.key, label: s.label, axis: a.label, value: v === null || v === undefined ? 'no data' : `${v}%`, x: (p.x / this.S) * 100, y: (p.y / this.S) * 100 - 2 };
  }
}

export interface ColumnPoint { label: string; value: number; }

/**
 * Compact column chart for a trend (days, weeks or months). Columns, not a line: a day with nothing recorded
 * is a real zero, and no line is drawn across gaps. Hover a column for its value.
 */
@Component({
  selector: 'app-perf-columns',
  standalone: true,
  imports: [CommonModule],
  styles: [VIZ_STYLES],
  template: `
    <div class="viz-wrap">
      <svg [attr.viewBox]="'0 0 ' + W + ' ' + H" role="img" [attr.aria-label]="ariaLabel" (mouseleave)="hover = null">
        <g *ngFor="let t of ticks">
          <line [attr.x1]="L" [attr.x2]="W - R" [attr.y1]="y(t)" [attr.y2]="y(t)" stroke="var(--grid)" stroke-width="1" />
          <text [attr.x]="L - 6" [attr.y]="y(t)" text-anchor="end" dominant-baseline="middle" font-size="10" fill="var(--ink2)">{{ t }}</text>
        </g>
        <g *ngFor="let p of points; let i = index">
          <rect [attr.x]="x(i)" [attr.y]="y(p.value)" [attr.width]="bw" [attr.height]="Math.max(0, y(0) - y(p.value))" rx="3" [attr.fill]="'var(' + color + ')'"
            [attr.opacity]="hover === null || hover === i ? 1 : 0.45" />
          <rect class="hit" [attr.x]="x(i) - gap / 2" [attr.y]="T" [attr.width]="bw + gap" [attr.height]="H - T - B" fill="transparent" (mouseenter)="hover = i" (click)="select.emit(i)" [style.cursor]="clickable ? 'pointer' : null" />
          <text *ngIf="showLabel(i)" [attr.x]="x(i) + bw / 2" [attr.y]="H - 8" text-anchor="middle" font-size="10" fill="var(--ink2)">{{ p.label }}</text>
        </g>
        <line [attr.x1]="L" [attr.x2]="W - R" [attr.y1]="y(0)" [attr.y2]="y(0)" stroke="var(--axis)" stroke-width="1" />
      </svg>
      <div class="viz-tip" *ngIf="hover !== null && points[hover]" [style.left.%]="((x(hover) + bw / 2) / W) * 100" [style.top.%]="(y(points[hover].value) / H) * 100">
        <b>{{ points[hover].label }}</b><div class="row"><span>{{ unitLabel }}</span><span>{{ points[hover].value }}</span></div>
      </div>
    </div>`
})
export class PerfColumnsComponent implements OnChanges {
  @Input() clickable = false;
  /** Click on a column: its index. */
  @Output() select = new EventEmitter<number>();
  @Input() points: ColumnPoint[] = [];
  @Input() color = '--s1';
  @Input() unitLabel = '';
  @Input() ariaLabel = 'Trend';
  readonly Math = Math;
  readonly W = 640; readonly H = 150; readonly L = 30; readonly R = 8; readonly T = 8; readonly B = 22;
  hover: number | null = null;
  max = 1; ticks: number[] = []; bw = 10; gap = 2;
  ngOnChanges(): void {
    this.hover = null;
    const top = Math.max(1, ...this.points.map(p => p.value || 0));
    const step = top <= 4 ? 1 : top <= 10 ? 2 : top <= 25 ? 5 : top <= 50 ? 10 : Math.ceil(top / 4 / 10) * 10;
    this.max = Math.ceil(top / step) * step;
    this.ticks = Array.from({ length: this.max / step + 1 }, (_, i) => i * step);
    const n = Math.max(1, this.points.length);
    const slot = (this.W - this.L - this.R) / n;
    this.gap = Math.max(2, slot * 0.25);
    this.bw = Math.min(28, Math.max(2, slot - this.gap));
  }
  x(i: number): number { const slot = (this.W - this.L - this.R) / Math.max(1, this.points.length); return this.L + i * slot + (slot - this.bw) / 2; }
  y(v: number): number { return this.T + (1 - (Number(v) || 0) / this.max) * (this.H - this.T - this.B); }
  showLabel(i: number): boolean { const n = this.points.length; const every = Math.max(1, Math.ceil(n / 8)); return i % every === 0 || i === n - 1 && n <= 8; }
}

/** A tiny trend line for a KPI card (no axes; the card states the numbers). */
@Component({
  selector: 'app-perf-spark',
  standalone: true,
  imports: [CommonModule],
  styles: [VIZ_STYLES + ` :host { display: inline-block; } svg { width: 72px; height: 22px; }`],
  template: `<svg viewBox="0 0 72 22" aria-hidden="true" *ngIf="values.length > 1"><polyline [attr.points]="pts" fill="none" [attr.stroke]="'var(' + color + ')'" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" /></svg>`
})
export class PerfSparkComponent implements OnChanges {
  @Input() values: number[] = [];
  @Input() color = '--s1';
  pts = '';
  ngOnChanges(): void {
    const max = Math.max(1, ...this.values);
    const n = this.values.length;
    this.pts = this.values.map((v, i) => `${((i / Math.max(1, n - 1)) * 70 + 1).toFixed(1)},${(20 - (v / max) * 18).toFixed(1)}`).join(' ');
  }
}

/** Half-ring gauge for target achievement: the arc fills to 100 %; the number can go past it. */
@Component({
  selector: 'app-perf-gauge',
  standalone: true,
  imports: [CommonModule],
  styles: [VIZ_STYLES + `
    :host { display: block; }
    .g { position: relative; width: 180px; max-width: 100%; }
    .g svg { width: 100%; height: auto; }
    .g-txt { position: absolute; left: 0; right: 0; bottom: 4px; text-align: center; line-height: 1.15; }
    .g-txt b { display: block; font-size: 1.6rem; font-variant-numeric: tabular-nums; color: var(--ink); }
    .g-txt small { font-size: 0.78rem; color: var(--ink2); }
  `],
  template: `
    <div class="g" role="img" [attr.aria-label]="label + ': ' + (value === null ? 'no data' : value + '%')">
      <svg viewBox="0 0 120 68" aria-hidden="true">
        <path d="M10 62 A50 50 0 0 1 110 62" fill="none" stroke="var(--grid)" stroke-width="12" stroke-linecap="round" />
        <path *ngIf="value !== null && value > 0" d="M10 62 A50 50 0 0 1 110 62" fill="none" [attr.stroke]="'var(' + color + ')'" stroke-width="12" stroke-linecap="round"
          pathLength="100" [attr.stroke-dasharray]="Math.min(100, value) + ' 100'" />
      </svg>
      <div class="g-txt"><b>{{ value === null ? '—' : value + '%' }}</b><small>{{ label }}</small></div>
    </div>`
})
export class PerfGaugeComponent {
  @Input() value: number | null = null;
  @Input() label = '';
  readonly Math = Math;
  get color(): string { return this.value === null ? '--neutral' : this.value >= 100 ? '--good' : this.value >= 70 ? '--s1' : '--warn'; }
}
