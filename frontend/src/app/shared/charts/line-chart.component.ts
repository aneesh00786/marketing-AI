import { AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, Input, OnChanges, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface LinePoint { label: string; value: number | null; note?: string; }

/**
 * Responsive SVG line/area chart. Null values are drawn as gaps (no data),
 * never as zero. Hover or arrow keys show a tooltip for the nearest point.
 */
@Component({
  selector: 'app-line-chart',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap" [style.height.px]="height" tabindex="0" role="img" [attr.aria-label]="ariaLabel"
         (mousemove)="onMove($event)" (mouseleave)="hover = null" (keydown)="onKey($event)" (blur)="hover = null">
      <svg *ngIf="width > 0" [attr.width]="width" [attr.height]="height">
        <defs>
          <linearGradient [attr.id]="gradId" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" [attr.stop-color]="color" stop-opacity="0.28"/>
            <stop offset="100%" [attr.stop-color]="color" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <g *ngFor="let t of yTicks">
          <line [attr.x1]="pad.l" [attr.x2]="width - pad.r" [attr.y1]="y(t)" [attr.y2]="y(t)" class="grid"/>
          <text [attr.x]="pad.l - 8" [attr.y]="y(t) + 4" text-anchor="end" class="axis">{{ format(t) }}</text>
        </g>
        <text *ngFor="let i of xTickIdx" [attr.x]="x(i)" [attr.y]="height - 6" text-anchor="middle" class="axis">{{ shortLabel(points[i].label) }}</text>
        <path *ngFor="let a of areas" [attr.d]="a" [attr.fill]="'url(#' + gradId + ')'"/>
        <path *ngFor="let l of lines" [attr.d]="l" fill="none" [attr.stroke]="color" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round"/>
        <ng-container *ngFor="let p of points; let i = index">
          <circle *ngIf="p.value !== null && (isolated(i) || hover === i)" [attr.cx]="x(i)" [attr.cy]="y(p.value)" [attr.r]="hover === i ? 5.5 : 4"
                  [attr.fill]="color" class="dot"/>
        </ng-container>
        <line *ngIf="hover !== null" [attr.x1]="x(hover)" [attr.x2]="x(hover)" [attr.y1]="pad.t" [attr.y2]="height - pad.b" class="guide"/>
      </svg>
      <div *ngIf="hover !== null && points[hover]" class="tip" [style.left.px]="tipLeft()" [style.top.px]="pad.t">
        <div class="tip-label">{{ points[hover].label }}</div>
        <div class="tip-value">
          <span class="swatch" [style.background]="color"></span>
          {{ points[hover].value === null ? 'No data' : format(points[hover].value!) }} <span class="muted">{{ seriesLabel }}</span>
        </div>
        <div class="muted small" *ngIf="points[hover].note">{{ points[hover].note }}</div>
      </div>
      <div *ngIf="!hasData" class="empty">{{ emptyText }}</div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .wrap { position: relative; width: 100%; outline: none; }
    .wrap:focus-visible { box-shadow: 0 0 0 2px var(--accent); border-radius: 8px; }
    svg { display: block; overflow: visible; }
    .grid { stroke: var(--chart-grid); stroke-width: 1; }
    .guide { stroke: var(--border-strong); stroke-dasharray: 3 3; }
    .axis { fill: var(--text-subtle); font-size: 11px; font-family: var(--font); }
    .dot { stroke: var(--surface); stroke-width: 2; transition: r 0.1s ease; }
    .tip { position: absolute; pointer-events: none; transform: translateX(-50%); background: var(--surface); border: 1px solid var(--border-strong); border-radius: 10px; padding: 8px 10px; box-shadow: var(--shadow-lg); font-size: 0.8rem; white-space: nowrap; z-index: 2; }
    .tip-label { color: var(--text-muted); font-size: 0.74rem; margin-bottom: 2px; }
    .tip-value { font-weight: 600; color: var(--text); display: flex; align-items: center; gap: 6px; }
    .swatch { width: 8px; height: 8px; border-radius: 50%; }
    .muted { color: var(--text-muted); font-weight: 400; }
    .small { font-size: 0.72rem; }
    .empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--text-muted); font-size: 0.88rem; text-align: center; padding: 0 20px; }
  `]
})
export class LineChartComponent implements OnChanges, AfterViewInit, OnDestroy {
  @Input() points: LinePoint[] = [];
  @Input() color = 'var(--chart-1)';
  @Input() height = 260;
  @Input() seriesLabel = '';
  @Input() emptyText = 'No data for this period.';
  @Input() formatter: (v: number) => string = v => compact(v);
  @Input() ariaLabel = 'Line chart';

  width = 0;
  hover: number | null = null;
  readonly pad = { t: 14, r: 12, b: 26, l: 48 };
  readonly gradId = `lg-${Math.random().toString(36).slice(2, 9)}`;
  yTicks: number[] = [];
  xTickIdx: number[] = [];
  lines: string[] = [];
  areas: string[] = [];
  hasData = false;
  private max = 1;
  private ro?: ResizeObserver;

  constructor(private el: ElementRef<HTMLElement>, private cdr: ChangeDetectorRef) {}

  ngAfterViewInit(): void {
    this.ro = new ResizeObserver(entries => {
      const w = Math.floor(entries[0].contentRect.width);
      // The observer callback can run outside Angular's change detection: render directly.
      if (w !== this.width) { this.width = w; this.compute(); this.cdr.detectChanges(); }
    });
    this.ro.observe(this.el.nativeElement);
  }

  ngOnChanges(): void { this.hover = null; this.compute(); }
  ngOnDestroy(): void { this.ro?.disconnect(); this.ro = undefined; }

  format(v: number): string { return this.formatter(v); }

  x(i: number): number {
    const n = Math.max(this.points.length - 1, 1);
    return this.pad.l + (i / n) * (this.width - this.pad.l - this.pad.r);
  }

  y(v: number): number {
    return this.pad.t + (1 - v / this.max) * (this.height - this.pad.t - this.pad.b);
  }

  isolated(i: number): boolean {
    const p = this.points;
    return p[i].value !== null && (p[i - 1]?.value ?? null) === null && (p[i + 1]?.value ?? null) === null;
  }

  shortLabel(label: string): string {
    const d = new Date(`${label}T00:00:00`);
    return Number.isNaN(d.getTime()) ? label : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  tipLeft(): number {
    const x = this.x(this.hover!);
    return Math.min(Math.max(x, 70), this.width - 70);
  }

  onMove(ev: MouseEvent): void {
    if (!this.points.length || this.width === 0) return;
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const rel = (ev.clientX - rect.left - this.pad.l) / (this.width - this.pad.l - this.pad.r);
    this.hover = Math.min(Math.max(Math.round(rel * (this.points.length - 1)), 0), this.points.length - 1);
  }

  onKey(ev: KeyboardEvent): void {
    if (!this.points.length) return;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
      ev.preventDefault();
      const cur = this.hover ?? (ev.key === 'ArrowRight' ? -1 : this.points.length);
      this.hover = Math.min(Math.max(cur + (ev.key === 'ArrowRight' ? 1 : -1), 0), this.points.length - 1);
    }
  }

  private compute(): void {
    const vals = this.points.map(p => p.value).filter((v): v is number => v !== null);
    this.hasData = vals.length > 0;
    const rawMax = vals.length ? Math.max(...vals) : 0;
    this.max = niceMax(rawMax);
    this.yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => Number((this.max * f).toFixed(2)));
    const n = this.points.length;
    const want = Math.min(n, this.width < 480 ? 4 : 7);
    this.xTickIdx = n <= 1 ? [0] : Array.from({ length: want }, (_, k) => Math.round((k * (n - 1)) / Math.max(want - 1, 1)));
    this.lines = [];
    this.areas = [];
    if (this.width === 0 || !this.hasData) return;
    let seg: number[] = [];
    const flush = () => {
      if (seg.length > 1) {
        const d = seg.map((i, k) => `${k ? 'L' : 'M'}${this.x(i).toFixed(1)},${this.y(this.points[i].value!).toFixed(1)}`).join(' ');
        this.lines.push(d);
        const base = this.y(0).toFixed(1);
        this.areas.push(`${d} L${this.x(seg[seg.length - 1]).toFixed(1)},${base} L${this.x(seg[0]).toFixed(1)},${base} Z`);
      }
      seg = [];
    };
    this.points.forEach((p, i) => (p.value === null ? flush() : seg.push(i)));
    flush();
  }
}

export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

export function compact(v: number): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${(v / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
