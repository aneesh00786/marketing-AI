import { Component, EventEmitter, Input, OnChanges, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { apiRoot } from '../../core/api-base';

/** How consent was given (the backend's CONSENT_METHODS, productEmails/service.js). */
export const CONSENT_METHODS = [
  { value: 'web_form', label: 'Website sign-up form' },
  { value: 'double_opt_in', label: 'Double opt-in (confirmed by email)' },
  { value: 'checkbox_at_signup', label: 'Consent checkbox at account sign-up' },
  { value: 'written', label: 'Written / signed consent' },
  { value: 'event_signup', label: 'Event or trade-show sign-up' },
  { value: 'customer_request', label: 'Customer asked to receive emails' },
  { value: 'imported_with_proof', label: 'Imported list with proof of consent' }
];

/** A lead's marketing consent as a short label (granted needs how, when and evidence to count). */
export function consentLabel(ld: any): string {
  if (ld?.marketingConsent === 'withdrawn') return 'Withdrawn';
  if (ld?.marketingConsent === 'granted') return ld.marketingConsentProven ? 'Given' : 'Given (no evidence)';
  return 'Not recorded';
}

/**
 * Records a lead's marketing consent. Granting needs how and when it was given and an evidence
 * reference, and the person confirms they hold that evidence: a note alone is not consent.
 * Withdrawn stops all marketing email to them. Only leads with proven consent get email campaigns.
 */
@Component({
  selector: 'app-lead-consent',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="lc-backdrop" (click)="close.emit()">
      <div class="lc-card" role="dialog" aria-modal="true" aria-labelledby="lc-title" (click)="$event.stopPropagation()">
        <h3 id="lc-title">Marketing consent: {{ lead?.name }}</h3>
        <p class="muted small">Now: <b>{{ current }}</b>{{ lead?.email ? ' · ' + lead.email : '' }}. Campaigns go only to people whose consent is recorded with evidence.</p>
        <label class="lc-field">Consent
          <select class="hud-input" name="status" [(ngModel)]="status">
            <option value="granted">Given: they agreed to marketing emails</option>
            <option value="withdrawn">Withdrawn: they asked not to be emailed</option>
            <option value="unknown">Not recorded</option>
          </select>
        </label>
        <ng-container *ngIf="status === 'granted'">
          <p class="muted small">Only record consent you can prove.</p>
          <label class="lc-field">How was consent given?
            <select class="hud-input" name="method" [(ngModel)]="method">
              <option *ngFor="let m of methods" [value]="m.value">{{ m.label }}</option>
            </select>
          </label>
          <label class="lc-field">Date consent was given <input class="hud-input" type="date" name="obtainedAt" [(ngModel)]="obtainedAt" [max]="today" /></label>
          <label class="lc-field">Evidence reference (form submission id, signed document, URL…)
            <input class="hud-input" name="evidence" [(ngModel)]="evidence" maxlength="500" />
          </label>
          <label class="check"><input type="checkbox" name="attest" [(ngModel)]="attest" /> I confirm we hold this evidence for this person.</label>
        </ng-container>
        <label class="lc-field" *ngIf="status !== 'granted'">Note (optional) <input class="hud-input" name="note" [(ngModel)]="note" maxlength="255" /></label>
        <p class="lc-error" *ngIf="error" role="alert">{{ error }}</p>
        <div class="lc-actions">
          <button type="button" class="btn btn-secondary btn-sm" (click)="close.emit()">Cancel</button>
          <button type="button" class="btn btn-primary btn-sm" (click)="save()" [disabled]="!ready || saving">{{ saving ? 'Saving…' : 'Save' }}</button>
        </div>
      </div>
    </div>`,
  styles: [`
    .lc-backdrop { position: fixed; inset: 0; z-index: 1000; background: rgba(15, 23, 42, 0.45); display: flex; align-items: center; justify-content: center; padding: 16px; }
    .lc-card { background: var(--surface, #fff); color: var(--text, inherit); border-radius: 12px; box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25); width: 100%; max-width: 520px; max-height: calc(100vh - 32px); overflow: auto; padding: 20px; display: flex; flex-direction: column; gap: 10px; }
    .lc-card h3 { margin: 0; font-size: 17px; }
    .check { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; }
    .muted { color: var(--text-muted, #64748b); } .small { font-size: 12.5px; margin: 0; }
    .lc-field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
    .lc-error { color: var(--danger-text, #b42318); font-size: 13px; margin: 0; }
    .lc-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
  `]
})
export class LeadConsentComponent implements OnChanges {
  @Input() lead: any = null;
  @Output() saved = new EventEmitter<{ leadId: number; status: string }>();
  @Output() close = new EventEmitter<void>();

  readonly methods = CONSENT_METHODS;
  readonly today = new Date().toISOString().slice(0, 10);
  status: 'granted' | 'withdrawn' | 'unknown' = 'granted';
  method = 'web_form';
  obtainedAt = '';
  evidence = '';
  attest = false;
  note = '';
  saving = false;
  error = '';

  constructor(private http: HttpClient) {}

  ngOnChanges(): void {
    const l = this.lead || {};
    this.status = l.marketingConsent === 'withdrawn' ? 'withdrawn' : 'granted';
    this.method = l.marketingConsentMethod || 'web_form';
    this.obtainedAt = l.marketingConsentObtainedAt ? String(l.marketingConsentObtainedAt).slice(0, 10) : '';
    this.evidence = '';
    this.attest = false;
    this.note = '';
    this.error = '';
  }

  get current(): string { return consentLabel(this.lead); }

  get ready(): boolean {
    if (this.status !== 'granted') return true;
    return !!this.method && /^\d{4}-\d{2}-\d{2}$/.test(this.obtainedAt) && this.obtainedAt <= this.today && this.evidence.trim().length >= 3 && this.attest;
  }

  save(): void {
    if (!this.lead || !this.ready || this.saving) return;
    const body: any = this.status === 'granted'
      ? { leadIds: [this.lead.id], status: 'granted', method: this.method, obtainedAt: this.obtainedAt, evidence: this.evidence.trim(), attest: true }
      : { leadIds: [this.lead.id], status: this.status, ...(this.note.trim() ? { note: this.note.trim() } : {}) };
    this.saving = true;
    this.error = '';
    this.http.post<any>(`${apiRoot()}/api/v1/leads/consent`, body).subscribe({
      next: () => { this.saving = false; this.saved.emit({ leadId: this.lead.id, status: this.status }); },
      error: e => { this.saving = false; this.error = e?.error?.error || e?.message || 'Consent could not be saved.'; }
    });
  }
}
