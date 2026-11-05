import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface LeadCountry { country: string | null; count: number }

/**
 * Country filter for lists of leads. The value is a country name, 'none' (leads without a
 * country) or '' (all). Countries come from the API ("countries": name and how many leads).
 */
@Component({
  selector: 'app-country-filter',
  standalone: true,
  imports: [CommonModule],
  template: `
    <select class="hud-input" [value]="value" (change)="pick($any($event.target).value)" aria-label="Filter by country">
      <option value="">All countries</option>
      <ng-container *ngFor="let c of countries">
        <option *ngIf="c.country" [value]="c.country" [selected]="c.country === value">{{ c.country }}{{ showCounts ? ' (' + c.count + ')' : '' }}</option>
        <option *ngIf="!c.country" value="none" [selected]="value === 'none'">No country{{ showCounts ? ' (' + c.count + ')' : '' }}</option>
      </ng-container>
    </select>`
})
export class CountryFilterComponent {
  @Input() countries: LeadCountry[] = [];
  @Input() value = '';
  /** Counts are for all of the workspace's leads, not the current search. */
  @Input() showCounts = true;
  @Output() valueChange = new EventEmitter<string>();
  pick(v: string): void { this.value = v; this.valueChange.emit(v); }
}
