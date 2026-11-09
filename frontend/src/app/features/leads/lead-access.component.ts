import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { apiRoot } from '../../core/api-base';

/**
 * Leads → a lead → "👤 Assign" (workspace Owners/Admins): who created the lead, who it is assigned
 * to, and reassigning it to a member. The assigned member sees and works on the lead; reassigning
 * moves it. The server enforces it.
 */
@Component({
  selector: 'app-lead-access',
  standalone: true,
  imports: [CommonModule, FormsModule],
  styleUrls: ['../command/command-center.component.css'],
  template: `
  <div class="la-backdrop" (click)="close.emit()">
    <div class="la-card" role="dialog" aria-modal="true" aria-labelledby="la-title" (click)="$event.stopPropagation()">
      <div class="la-head">
        <h3 id="la-title">Assign lead<span *ngIf="data"> · {{ data.leadName }}</span></h3>
        <button type="button" class="la-x" (click)="close.emit()" aria-label="Close">✕</button>
      </div>
      <p class="la-muted" *ngIf="loading">Loading…</p>
      <p class="la-error" *ngIf="error" role="alert">{{ error }}</p>

      <ng-container *ngIf="data">
        <dl class="la-facts">
          <div><dt>Created by</dt><dd>{{ person(data.createdBy) }}</dd></div>
          <div><dt>Lead Assigned</dt><dd>{{ data.owner ? person(data.owner) : 'Unassigned (only Owners/Admins see it)' }}<span class="la-tag warn" *ngIf="data.owner && !data.owner.active">no longer a member</span></dd></div>
          <div><dt>Source</dt><dd>{{ sourceLabel(data.source) }}</dd></div>
        </dl>

        <section class="la-sec" *ngIf="data.canManageAccess">
          <h4>Assign to</h4>
          <div class="la-row">
            <select class="hud-input" [(ngModel)]="ownerChoice" aria-label="Assign to">
              <option [ngValue]="null">Unassigned</option>
              <option *ngFor="let m of data.members" [ngValue]="m.userId">{{ m.name }} ({{ m.role }})</option>
            </select>
            <button type="button" class="btn btn-primary btn-sm" (click)="changeOwner()" [disabled]="busy || ownerChoice === (data.owner?.userId ?? null)">Assign</button>
          </div>
          <p class="la-muted">The assigned member sees and works on this lead. Workspace Owners and Admins always see every lead. Reassigning moves it to the new member.</p>
        </section>
        <p class="la-muted" *ngIf="!data.canManageAccess">Only workspace Owners and Admins can assign leads.</p>
      </ng-container>
    </div>
  </div>`,
  styles: [`
    .la-backdrop { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 16px; background: var(--scrim, rgba(0,0,0,.45)); }
    .la-card { width: 100%; max-width: 640px; max-height: 92vh; overflow-y: auto; background: var(--surface); border: 1px solid var(--border-strong); border-radius: 14px; padding: 18px 20px; display: flex; flex-direction: column; gap: 12px; box-shadow: var(--shadow-lg); }
    .la-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .la-head h3 { margin: 0; font-size: 1rem; }
    .la-x { background: none; border: none; color: var(--text-muted); font-size: 1rem; cursor: pointer; }
    .la-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px 16px; margin: 0; }
    .la-facts dt { font-size: 0.75rem; color: var(--text-muted); }
    .la-facts dd { margin: 2px 0 0; font-weight: 600; font-size: 0.88rem; }
    .la-sec { border-top: 1px solid var(--border); padding-top: 10px; display: flex; flex-direction: column; gap: 8px; }
    .la-sec h4 { margin: 0; font-size: 0.9rem; }
    .la-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .la-row select { flex: 1 1 200px; min-width: 0; }
    .la-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    .la-table th, .la-table td { text-align: left; padding: 6px 4px; border-top: 1px solid var(--border); vertical-align: middle; }
    .la-right { text-align: right; }
    .la-members { display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto; }
    .la-member { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px; cursor: pointer; font-size: 0.86rem; }
    .la-member.on { border-color: var(--accent); background: var(--accent-soft); }
    .la-muted { color: var(--text-muted); font-size: 0.8rem; margin: 0; }
    .la-error { color: var(--danger-text); margin: 0; }
    .la-tag { display: inline-block; margin-left: 6px; padding: 1px 8px; border-radius: 999px; font-size: 0.72rem; background: var(--accent-soft); }
    .la-tag.warn { background: var(--warning-soft); color: var(--warning-text); }
  `]
})
export class LeadAccessComponent implements OnInit {
  @Input({ required: true }) leadId!: number;
  @Output() close = new EventEmitter<void>();
  /** Emitted after a change, so the list can refresh. */
  @Output() changed = new EventEmitter<string>();

  data: any = null;
  loading = true;
  busy = false;
  error = '';
  ownerChoice: number | null = null;
  private base = `${apiRoot()}/api/v1/leads`;

  constructor(private http: HttpClient) {}

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading = true;
    this.http.get<any>(`${this.base}/${this.leadId}/access`).subscribe({
      next: r => this.apply(r),
      error: e => { this.loading = false; this.error = e?.error?.error || 'Could not load this lead.'; }
    });
  }

  private apply(r: any): void {
    this.loading = false;
    this.busy = false;
    this.data = r.access || r;
    this.ownerChoice = this.data.owner?.userId ?? null;
  }

  person(p: any): string {
    if (!p) return 'Not recorded';
    return `${p.name || p.email || 'User #' + p.userId}${p.role ? ' · ' + p.role : ''}`;
  }

  sourceLabel(s: string | null): string {
    return ({ manual: 'Added by hand', import: 'Excel / CSV import', discovery: 'AI Lead Discovery', social: 'Social media enquiry', phone: 'Phone call', api: 'API' } as any)[s || ''] || 'Not recorded';
  }

  changeOwner(): void {
    this.busy = true;
    const name = this.data.members?.find((m: any) => m.userId === this.ownerChoice)?.name;
    this.http.put<any>(`${this.base}/${this.leadId}/owner`, { ownerUserId: this.ownerChoice, previousOwnerAccess: 'none' }).subscribe({
      next: r => { this.apply(r); this.changed.emit(name ? `Lead assigned to ${name}.` : 'Lead unassigned.'); },
      error: e => { this.busy = false; this.error = e?.error?.error || 'The change was not saved.'; }
    });
  }
}
