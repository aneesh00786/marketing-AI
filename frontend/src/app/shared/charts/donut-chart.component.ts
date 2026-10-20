import { ChangeDetectionStrategy, Component, EventEmitter, Input, OnChanges, Output } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface DonutSegment { key: string; label: string; value: number; color: string; }

/** Donut chart with an interactive legend. Zero-value segments are listed but not drawn. */
@Component({
  selector: 'app-donut-chart',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="donut" *ngIf="total > 0; else empty">
      <svg viewBox="0 0 120 120" class="ring" role="img" [attr.aria-label]="centerLabel + ': ' + total">
        <circle cx="60" cy="60" r="46" class="track"/>
        <circle *ngFor="let a of arcs" cx="60" cy="60" r="46" fill="none" [attr.stroke]="a.color"
                [attr.stroke-width]="active === a.key ? 16 : 13" [attr.stroke-dasharray]="a.dash" [attr.stroke-dashoffset]="a.offset"
                transform="rotate(-90 60 60)" class="arc" (mouseenter)="active = a.key" (mouseleave)="active = null" (click)="select.emit(a.key)">
          <title>{{ a.label }}: {{ a.value }} ({{ a.pct }}%)</title>
        </circle>
        <text x="60" y="57" text-anchor="middle" class="total">{{ activeSeg ? activeSeg.value : total }}</text>
        <text x="60" y="73" text-anchor="middle" class="caption">{{ activeSeg ? activeSeg.label : centerLabel }}</text>
      </svg>
      <ul class="legend">
        <li *ngFor="let s of segments" [class.dim]="active && active !== s.key" [class.zero]="!s.value"
            (mouseenter)="s.value && (active = s.key)" (mouseleave)="active = null">
          <button type="button" (click)="select.emit(s.key)" [disabled]="!s.value">
            <span class="sw" [style.background]="s.color"></span>
            <span class="lbl">{{ s.label }}</span>
            <span class="num">{{ s.value }}</span>
            <span class="pct">{{ total ? ((s.value / total) * 100 | number:'1.0-0') : 0 }}%</span>
          </button>
        </li>
      </ul>
    </div>
    <ng-template #empty><div class="empty">{{ emptyText }}</div></ng-template>
  `,
  styles: [`
    :host { display: block; }
    .donut { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
    .ring { width: 160px; height: 160px; flex-shrink: 0; }
    .track { fill: none; stroke: var(--surface-2); stroke-width: 13; }
    .arc { cursor: pointer; transition: stroke-width 0.15s ease; }
    .total { fill: var(--text); font-size: 20px; font-weight: 700; font-family: var(--font); }
    .caption { fill: var(--text-muted); font-size: 8.5px; font-family: var(--font); text-transform: capitalize; }
    .legend { list-style: none; margin: 0; padding: 0; flex: 1; min-width: 180px; display: flex; flex-direction: column; gap: 2px; }
    .legend li { transition: opacity 0.15s ease; }
    .legend li.dim { opacity: 0.45; }
    .legend li.zero { opacity: 0.55; }
    .legend button { width: 100%; display: grid; grid-template-columns: 10px 1fr auto 40px; align-items: center; gap: 8px; padding: 5px 6px; border: 0; border-radius: 6px; background: transparent; color: var(--text); font: 500 0.82rem var(--font); cursor: pointer; text-align: left; }
    .legend button:disabled { cursor: default; }
    .legend button:hover:not(:disabled) { background: var(--surface-hover); }
    .sw { width: 10px; height: 10px; border-radius: 3px; }
    .lbl { text-transform: capitalize; }
    .num { font-weight: 600; font-variant-numeric: tabular-nums; }
    .pct { color: var(--text-subtle); text-align: right; font-size: 0.76rem; }
    .empty { color: var(--text-muted); font-size: 0.88rem; padding: 32px 8px; text-align: center; }
  `]
})
export class DonutChartComponent implements OnChanges {
  @Input() segments: DonutSegment[] = [];
  @Input() centerLabel = 'total';
  @Input() emptyText = 'No items yet.';
  @Output() select = new EventEmitter<string>();
  total = 0;
  active: string | null = null;
  arcs: (DonutSegment & { dash: string; offset: number; pct: number })[] = [];

  get activeSeg(): DonutSegment | undefined {
    return this.segments.find(s => s.key === this.active);
  }

  ngOnChanges(): void {
    this.total = this.segments.reduce((a, s) => a + (s.value || 0), 0);
    const c = 2 * Math.PI * 46;
    let acc = 0;
    const gap = this.segments.filter(s => s.value).length > 1 ? 1.5 : 0;
    this.arcs = this.segments.filter(s => s.value > 0).map(s => {
      const len = (s.value / this.total) * c;
      const arc = { ...s, dash: `${Math.max(len - gap, 0.5)} ${c}`, offset: -acc, pct: Math.round((s.value / this.total) * 100) };
      acc += len;
      return arc;
    });
  }
}
