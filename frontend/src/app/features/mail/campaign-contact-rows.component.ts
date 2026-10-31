import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IconComponent } from '../../shared/icon.component';

/** Contacts selected for a campaign, under the recipient they belong to (Leads or a Zoho list). */
@Component({
  selector: 'app-campaign-contact-rows',
  standalone: true,
  imports: [CommonModule, IconComponent],
  template: `
    <ul class="cc-list">
      <li *ngFor="let c of contacts" class="cc-row" [class.blocked]="!c.eligible">
        <span class="cc-who">
          <b>{{ c.name || c.email }}</b>
          <span class="muted small" *ngIf="c.name">{{ c.email }}</span>
          <span class="cc-reason" *ngIf="!c.eligible">Will be skipped: {{ c.reasons.join('. ') }}</span>
        </span>
        <button type="button" class="cc-remove" *ngIf="editable" (click)="remove.emit(c)" [disabled]="busy" [attr.aria-label]="'Remove ' + c.email"><app-icon name="x" [size]="14"></app-icon></button>
      </li>
    </ul>
  `,
  styles: [`
    .muted { color: var(--text-muted); }
    .small { font-size: 0.8rem; }
    .cc-list { list-style: none; margin: 0; padding: 0; max-height: 240px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; }
    .cc-row { display: flex; align-items: center; gap: 10px; padding: 7px 10px; }
    .cc-row + .cc-row { border-top: 1px solid var(--border); }
    .cc-who { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; font-size: 0.85rem; overflow-wrap: anywhere; }
    .cc-who b { font-weight: 600; }
    .cc-row.blocked .cc-who b { color: var(--text-muted); }
    .cc-reason { display: block; font-size: 0.76rem; color: var(--warning-text); }
    .cc-remove { flex: none; display: inline-flex; padding: 4px; border: none; border-radius: 6px; background: none; color: var(--text-muted); cursor: pointer; }
    .cc-remove:hover { background: var(--surface-2); color: var(--text); }
    .cc-remove:focus-visible { outline: 2px solid var(--accent); }
  `]
})
export class CampaignContactRowsComponent {
  @Input() contacts: any[] = [];
  @Input() editable = false;
  @Input() busy = false;
  @Output() remove = new EventEmitter<any>();
}
