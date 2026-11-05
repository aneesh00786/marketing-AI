import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IconComponent } from '../icon.component';
import { CallService } from './call.service';

const MIN_DIGITS = 7;

/** The phone icon beside a number. Hidden when the user cannot call or the number is too short. */
@Component({
  selector: 'app-call-button',
  standalone: true,
  imports: [CommonModule, IconComponent],
  template: `
    <button *ngIf="visible" type="button" class="call-btn" (click)="open($event)" [title]="'Call ' + phone" [attr.aria-label]="'Call ' + (name || phone)">
      <app-icon name="phone" [size]="14"></app-icon>
    </button>
  `,
  styles: [`
    :host { display: inline-flex; vertical-align: middle; }
    .call-btn { display: inline-flex; margin-left: 6px; padding: 4px; border: 1px solid var(--border); border-radius: 50%; background: var(--surface); color: var(--success-text); cursor: pointer; line-height: 0; }
    .call-btn:hover { background: var(--success-soft); border-color: var(--success); }
    .call-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  `]
})
export class CallButtonComponent {
  @Input() phone: string | null | undefined = '';
  @Input() name: string | null | undefined = '';
  /** The CRM contact, so the call shows on their page. */
  @Input() contactId: number | null | undefined = null;
  /** A follow-up from a campaign's results (keeps the call with that campaign and person). */
  @Input() campaignId: number | null | undefined = null;
  @Input() email: string | null | undefined = null;

  constructor(private calls: CallService) {}

  get visible(): boolean {
    return this.calls.available && String(this.phone || '').replace(/\D/g, '').length >= MIN_DIGITS;
  }

  open(ev: Event): void {
    ev.stopPropagation();
    this.calls.prepare(String(this.phone), this.name || '', this.contactId ?? null,
      this.campaignId && this.email ? { campaignId: this.campaignId, email: this.email } : null);
  }
}
