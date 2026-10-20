import { ChangeDetectionStrategy, Component, EventEmitter, Input, OnChanges, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { compact } from './line-chart.component';

export interface BarItem { id?: any; label: string; value: number | null; sublabel?: string; color?: string; unavailableText?: string; }

/** Horizontal bar chart. Null values render as "Unavailable", distinct from a real zero. */
@Component({
  selector: 'app-bar-chart',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bars" role="list">
      <button type="button" *ngFor="let b of items; let i = index" class="bar-row" role="listitem" [class.clickable]="clickable"
              (click)="clickable && select.emit(b)" [attr.aria-label]="b.label + ': ' + (b.value === null ? 'unavailable' : formatter(b.value))"
              [title]="b.value === null ? (b.unavailableText || 'Not reported by the platform') : b.label + ': ' + formatter(b.value)">
        <span class="bar-label">
          <span class="name">{{ b.label }}</span>
          <span class="sub" *ngIf="b.sublabel">{{ b.sublabel }}</span>
        </span>
        <span class="track">
          <span class="fill" *ngIf="b.value !== null" [style.width.%]="pct(b.value)" [style.background]="b.color || color"></span>
          <span class="na" *ngIf="b.value === null">{{ b.unavailableText || 'Unavailable' }}</span>
        </span>
        <span class="val" [class.muted]="b.value === null">{{ b.value === null ? '—' : formatter(b.value) }}</span>
      </button>
      <div *ngIf="!items.length" class="empty">{{ emptyText }}</div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .bars { display: flex; flex-direction: column; gap: 4px; }
    .bar-row { display: grid; grid-template-columns: minmax(110px, 34%) 1fr 64px; align-items: center; gap: 12px; padding: 7px 8px; border: 0; border-radius: 8px; background: transparent; color: var(--text); font: inherit; text-align: left; }
    .bar-row.clickable { cursor: pointer; }
    .bar-row.clickable:hover, .bar-row:focus-visible { background: var(--surface-hover); }
    .bar-label { display: flex; flex-direction: column; min-width: 0; }
    .name { font-size: 0.85rem; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sub { font-size: 0.72rem; color: var(--text-subtle); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .track { position: relative; height: 10px; border-radius: 999px; background: var(--surface-2); overflow: hidden; display: flex; align-items: center; }
    .fill { height: 100%; border-radius: 999px; min-width: 3px; transition: width 0.4s var(--ease); }
    .na { font-size: 0.7rem; color: var(--text-subtle); font-style: italic; padding-left: 8px; line-height: 10px; }
    .val { text-align: right; font-weight: 600; font-size: 0.86rem; font-variant-numeric: tabular-nums; }
    .val.muted { color: var(--text-subtle); font-weight: 400; }
    .empty { color: var(--text-muted); font-size: 0.88rem; padding: 24px 8px; text-align: center; }
  `]
})
export class BarChartComponent implements OnChanges {
  @Input() items: BarItem[] = [];
  @Input() color = 'var(--chart-1)';
  @Input() clickable = false;
  @Input() emptyText = 'Nothing to compare yet.';
  @Input() formatter: (v: number) => string = v => compact(v);
  @Output() select = new EventEmitter<BarItem>();
  private max = 1;

  ngOnChanges(): void {
    const vals = this.items.map(i => i.value).filter((v): v is number => v !== null);
    this.max = vals.length ? Math.max(...vals, 0) : 1;
  }

  pct(v: number): number {
    return this.max > 0 ? Math.max((v / this.max) * 100, v > 0 ? 1.5 : 0) : 0;
  }
}
