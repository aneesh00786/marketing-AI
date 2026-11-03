import { Component, Input, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { apiRoot } from '../../core/api-base';
import { CONSENT_METHOD_LABELS, ImportSync } from './import-sync';

/**
 * The two optional steps of an Excel / CSV import, shown under the file preview:
 * 1. Marketing consent: only contacts with consent recorded (with proof) can be emailed or sent to Zoho.
 * 2. Zoho list: add the imported contacts to an existing Zoho Campaigns list or a new one.
 * It edits the ImportSync object it is given; the import itself is sent by the parent.
 */
@Component({
  selector: 'app-import-sync-options',
  standalone: true,
  imports: [CommonModule, FormsModule],
  // The app's input and button styles live in these shared sheets (not global).
  styleUrls: ['../command/command-center.component.css', '../mail/mail-ui.css'],
  template: `
  <div class="iso">
    <fieldset class="iso-box">
      <legend>Marketing consent</legend>
      <label class="iso-check"><input type="checkbox" [(ngModel)]="sync.consent" /> These contacts agreed to receive marketing emails, and I have proof</label>
      <p class="iso-help" *ngIf="!sync.consent">Without consent they are imported as leads only: they cannot be emailed or added to Zoho until consent is recorded.</p>
      <div class="iso-grid" *ngIf="sync.consent">
        <label>How they agreed
          <select class="hud-input" [(ngModel)]="sync.method"><option *ngFor="let m of methods" [value]="m.value">{{ m.label }}</option></select></label>
        <label>When <input class="hud-input" type="date" [(ngModel)]="sync.obtainedAt" [max]="today" /></label>
        <label class="iso-wide">Proof (where it is kept)
          <input class="hud-input" [(ngModel)]="sync.evidence" maxlength="500" placeholder="e.g. Trade show sign-up sheets, Oct 2026 (Drive › Events)" /></label>
        <label class="iso-check iso-wide"><input type="checkbox" [(ngModel)]="sync.attest" /> I confirm I hold this proof for every contact in the file. Contacts who unsubscribed or withdrew consent earlier are not changed.</label>
      </div>
    </fieldset>

    <fieldset class="iso-box" *ngIf="canZoho">
      <legend>Zoho Campaigns list</legend>
      <div class="iso-radios">
        <label><input type="radio" name="iso-list" value="none" [(ngModel)]="sync.list" /> Don't add to Zoho</label>
        <label><input type="radio" name="iso-list" value="existing" [(ngModel)]="sync.list" [disabled]="!lists.length" /> Add to a list</label>
        <label><input type="radio" name="iso-list" value="new" [(ngModel)]="sync.list" [disabled]="!!listsError" /> New list</label>
      </div>
      <select *ngIf="sync.list === 'existing'" class="hud-input" [(ngModel)]="sync.listKey" aria-label="Zoho list">
        <option value="">Choose a list…</option>
        <option *ngFor="let l of lists" [value]="l.key">{{ l.name || l.key }}{{ l.contacts != null ? ' (' + l.contacts + ')' : '' }}</option>
      </select>
      <input *ngIf="sync.list === 'new'" class="hud-input" [(ngModel)]="sync.listName" maxlength="100" placeholder="e.g. Trade show Oct 2026" aria-label="New list name" />
      <p class="iso-help" *ngIf="listsError">{{ listsError }}</p>
      <p class="iso-help" *ngIf="sync.list !== 'none' && !sync.consent">Only contacts that already have consent recorded will be added to Zoho.</p>
    </fieldset>
  </div>`,
  styles: [`
    .hud-input { width: 100%; box-sizing: border-box; }
    .iso { display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }
    .iso-box { margin: 0; padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
    .iso-box legend { padding: 0 6px; font-weight: 600; font-size: 0.9rem; }
    .iso-check { display: flex; gap: 8px; align-items: flex-start; font-size: 0.86rem; }
    .iso-check input { margin-top: 3px; }
    .iso-help { margin: 0; font-size: 0.8rem; color: var(--text-muted); }
    .iso-grid { display: grid; grid-template-columns: 1fr 180px; gap: 10px; }
    .iso-grid label:not(.iso-check) { display: flex; flex-direction: column; gap: 4px; font-size: 0.82rem; color: var(--text-muted); }
    .iso-wide { grid-column: 1 / -1; }
    .iso-radios { display: flex; flex-wrap: wrap; gap: 14px; font-size: 0.86rem; }
    .iso-radios label { display: inline-flex; align-items: center; gap: 6px; }
    @media (max-width: 600px) { .iso-grid { grid-template-columns: 1fr; } }
  `]
})
export class ImportSyncOptionsComponent implements OnInit {
  @Input({ required: true }) sync!: ImportSync;
  /** The user may add contacts to Zoho lists (mail.send). */
  @Input() canZoho = false;
  readonly methods = CONSENT_METHOD_LABELS;
  readonly today = new Date().toISOString().slice(0, 10);
  lists: { key: string; name: string | null; contacts: number | null }[] = [];
  listsError = '';

  constructor(private http: HttpClient) {}

  ngOnInit(): void {
    if (!this.canZoho) return;
    this.http.get<any>(`${apiRoot()}/api/v1/mail/campaigns/zoho-lists`).subscribe({
      next: r => {
        this.lists = (r.lists || []).filter((l: any) => !l.campaignList || l.key === this.sync.listKey);
        if (!r.canAdd) { this.listsError = 'Reconnect Zoho (Mail Center › Zoho Campaigns) to add contacts to lists.'; this.sync.list = 'none'; }
      },
      error: e => { this.listsError = e?.error?.error || 'Zoho Campaigns is not connected.'; this.sync.list = 'none'; }
    });
  }
}
