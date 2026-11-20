import { Component, EventEmitter, HostListener, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { apiRoot } from '../../core/api-base';
import { SendersUiService } from '../../core/senders-ui.service';

/**
 * "My sender email": the person's own addresses. Adding one emails a confirmation link to it; once confirmed,
 * their campaigns and Compose emails are sent from it. Staff need one before they can send email.
 */
@Component({
  selector: 'app-my-senders',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
  <div class="ms-backdrop">
    <div class="ms-card" role="dialog" aria-modal="true" aria-labelledby="ms-title">
      <header class="ms-head">
        <span class="ms-ic" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.5 7 8.5 6 8.5-6"/></svg>
        </span>
        <div class="ms-head-text">
          <h3 id="ms-title">My sender email</h3>
          <p>The address your campaigns and emails are sent from. We email it a link to confirm it is yours.</p>
        </div>
        <button type="button" class="ms-x" (click)="close.emit()" aria-label="Close">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </header>

      <div class="ms-body">
        <p class="ms-alert" *ngIf="required && !hasVerified && !loading" role="status">
          <b>Needed to send email.</b> Add your company address and open the link we send to it.
        </p>

        <!-- Your addresses -->
        <section class="ms-section">
          <h4>Your addresses</h4>
          <p class="ms-muted" *ngIf="loading && !senders.length">Loading…</p>
          <div class="ms-empty" *ngIf="!loading && !senders.length">
            <span aria-hidden="true">📭</span>
            <div><b>No address yet</b><small>Add one below to start sending from it.</small></div>
          </div>
          <ul class="ms-list" *ngIf="senders.length">
            <li *ngFor="let s of senders" [class.ok]="s.status === 'verified'">
              <div class="ms-row">
                <span class="ms-avatar" aria-hidden="true">{{ (s.name || s.email)[0] | uppercase }}</span>
                <span class="ms-who"><b>{{ s.email }}</b><small>{{ s.name || 'No display name' }}</small></span>
                <span class="ms-badge" [class.ok]="s.status === 'verified'">{{ s.status === 'verified' ? '✓ Verified' : '⏳ Waiting for confirmation' }}</span>
              </div>
              <div class="ms-row ms-row-actions">
                <small class="ms-muted" *ngIf="s.status !== 'verified'">Open the link we emailed to this address (valid 24 hours), then press Refresh.</small>
                <small class="ms-muted" *ngIf="s.status === 'verified'">Your campaigns and emails can be sent from this address.</small>
                <span class="ms-btns">
                  <button type="button" class="ms-btn ms-btn-ghost" *ngIf="s.status !== 'verified'" (click)="resend(s)" [disabled]="busy">Send link again</button>
                  <button type="button" class="ms-btn ms-btn-danger" (click)="remove(s)" [disabled]="busy">Remove</button>
                </span>
              </div>
            </li>
          </ul>
        </section>

        <!-- Add an address -->
        <section class="ms-section">
          <h4>Add an address</h4>
          <form class="ms-add" (ngSubmit)="add()">
            <label>Your email address
              <input type="email" name="ms-email" [(ngModel)]="email" placeholder="you@yourcompany.com" autocomplete="email" required />
            </label>
            <label>Name shown to recipients <span class="ms-opt">optional</span>
              <input type="text" name="ms-name" [(ngModel)]="name" placeholder="e.g. Anita from ThriveWoo" maxlength="100" />
            </label>
            <div class="ms-add-foot">
              <small class="ms-muted">Use your company address. Gmail, Yahoo, Outlook and other public mailboxes cannot be used.</small>
              <button type="submit" class="ms-btn ms-btn-primary" [disabled]="busy || !email.trim()">
                {{ busy ? 'Sending…' : 'Send confirmation link' }}
              </button>
            </div>
          </form>
          <p class="ms-msg err" *ngIf="error" role="alert">{{ error }}</p>
          <p class="ms-msg ok" *ngIf="notice" role="status">{{ notice }}</p>
        </section>
      </div>

      <footer class="ms-foot">
        <button type="button" class="ms-btn ms-btn-ghost" (click)="load()" [disabled]="loading">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>
          Refresh
        </button>
        <button type="button" class="ms-btn ms-btn-primary" (click)="close.emit()">Done</button>
      </footer>
    </div>
  </div>`,
  styles: [`
    :host { --ms-accent: var(--accent, #5b5bd6); }
    .ms-backdrop { position: fixed; inset: 0; z-index: 1100; background: rgba(15, 18, 30, .55); display: grid; place-items: center; padding: 16px; }
    .ms-card { width: min(640px, 100%); max-height: calc(100vh - 32px); display: flex; flex-direction: column; background: var(--surface, #fff); color: var(--text, #111827);
      border: 1px solid var(--border, #e5e7eb); border-radius: 16px; box-shadow: 0 24px 60px rgba(0,0,0,.28); overflow: hidden; box-sizing: border-box; }
    .ms-head { display: flex; align-items: flex-start; gap: 12px; padding: 18px 20px 14px; border-bottom: 1px solid var(--border, #e5e7eb); }
    .ms-ic { flex: 0 0 auto; width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; color: var(--ms-accent); background: color-mix(in srgb, var(--ms-accent) 12%, transparent); }
    .ms-head-text { flex: 1 1 auto; min-width: 0; }
    .ms-head-text h3 { margin: 0 0 4px; font-size: 1.1rem; }
    .ms-head-text p { margin: 0; color: var(--text-muted, #6b7280); font-size: .86rem; line-height: 1.45; }
    .ms-x { flex: 0 0 auto; display: grid; place-items: center; width: 32px; height: 32px; border: 0; border-radius: 8px; background: none; color: var(--text-muted, #6b7280); cursor: pointer; }
    .ms-x:hover { background: var(--surface-2, #f3f4f6); color: var(--text, #111827); }

    .ms-body { padding: 16px 20px; overflow: auto; display: flex; flex-direction: column; gap: 18px; }
    .ms-section h4 { margin: 0 0 8px; font-size: .78rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--text-muted, #6b7280); }
    .ms-muted { margin: 0; color: var(--text-muted, #6b7280); font-size: .82rem; line-height: 1.4; }
    .ms-alert { margin: 0; padding: 10px 12px; border-radius: 10px; font-size: .86rem; border: 1px solid rgba(245, 158, 11, .45); background: var(--warning-soft, #fff7e6); color: var(--warning-text, #92400e); }

    .ms-empty { display: flex; align-items: center; gap: 12px; padding: 14px; border: 1px dashed var(--border, #e5e7eb); border-radius: 12px; }
    .ms-empty > span { font-size: 22px; }
    .ms-empty div { display: flex; flex-direction: column; }
    .ms-empty small { color: var(--text-muted, #6b7280); }

    .ms-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .ms-list li { border: 1px solid var(--border, #e5e7eb); border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
    .ms-list li.ok { border-color: color-mix(in srgb, #16a34a 35%, var(--border, #e5e7eb)); }
    .ms-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .ms-row-actions { justify-content: space-between; }
    .ms-row-actions .ms-muted { flex: 1 1 220px; }
    .ms-avatar { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; color: #fff; background: var(--ms-accent); flex: 0 0 auto; }
    .ms-who { display: flex; flex-direction: column; min-width: 0; flex: 1 1 200px; }
    .ms-who b { word-break: break-all; }
    .ms-who small { color: var(--text-muted, #6b7280); }
    .ms-badge { font-size: .75rem; font-weight: 700; padding: 3px 10px; border-radius: 999px; white-space: nowrap; background: var(--warning-soft, #fff7e6); color: var(--warning-text, #92400e); }
    .ms-badge.ok { background: var(--success-soft, #e7f7ee); color: var(--success-text, #157a3c); }
    .ms-btns { display: flex; gap: 6px; flex-wrap: wrap; }

    .ms-add { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .ms-add label { display: flex; flex-direction: column; gap: 6px; font-size: .82rem; font-weight: 600; color: var(--text, #111827); }
    .ms-opt { font-weight: 400; color: var(--text-muted, #6b7280); }
    .ms-add input { font: inherit; font-weight: 400; padding: 10px 12px; border: 1px solid var(--border, #d1d5db); border-radius: 10px; background: var(--surface, #fff); color: var(--text, #111827); outline: none; transition: border-color .15s, box-shadow .15s; }
    .ms-add input:focus { border-color: var(--ms-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ms-accent) 18%, transparent); }
    .ms-add-foot { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .ms-add-foot .ms-muted { flex: 1 1 240px; }
    .ms-msg { margin: 8px 0 0; padding: 8px 12px; border-radius: 10px; font-size: .85rem; }
    .ms-msg.err { background: var(--danger-soft, #fdecec); color: var(--danger-text, #b42318); }
    .ms-msg.ok { background: var(--success-soft, #e7f7ee); color: var(--success-text, #157a3c); }

    .ms-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--border, #e5e7eb); background: var(--surface-2, #f9fafb); }

    .ms-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 36px; padding: 0 14px; border-radius: 10px; font: inherit; font-size: .86rem; font-weight: 600; cursor: pointer; white-space: nowrap;
      border: 1px solid transparent; transition: background .15s, border-color .15s, box-shadow .15s, opacity .15s; }
    .ms-btn:focus-visible { outline: 2px solid var(--ms-accent); outline-offset: 2px; }
    .ms-btn:disabled { opacity: .5; cursor: not-allowed; }
    .ms-btn-primary { background: var(--ms-accent); color: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.12); }
    .ms-btn-primary:hover:not(:disabled) { filter: brightness(1.07); }
    .ms-btn-ghost { background: var(--surface, #fff); color: var(--text, #111827); border-color: var(--border, #d1d5db); }
    .ms-btn-ghost:hover:not(:disabled) { background: var(--surface-2, #f3f4f6); }
    .ms-btn-danger { background: var(--surface, #fff); color: var(--danger-text, #b42318); border-color: color-mix(in srgb, #dc2626 35%, var(--border, #d1d5db)); }
    .ms-btn-danger:hover:not(:disabled) { background: var(--danger-soft, #fdecec); }
    .ms-list .ms-btn { height: 32px; padding: 0 12px; font-size: .8rem; }

    @media (max-width: 560px) {
      .ms-add { grid-template-columns: 1fr; }
      .ms-add-foot .ms-btn { width: 100%; }
      .ms-foot .ms-btn { flex: 1 1 0; }
    }
  `]
})
export class MySendersComponent implements OnInit {
  @Output() close = new EventEmitter<void>();
  private readonly base = `${apiRoot()}/api/v1/mail/senders`;
  senders: any[] = [];
  required = false;
  get hasVerified(): boolean { return this.senders.some(s => s.status === 'verified'); }
  loading = false;
  busy = false;
  email = '';
  name = '';
  error = '';
  notice = '';

  constructor(private http: HttpClient, private ui: SendersUiService) {}

  ngOnInit(): void { this.load(); }

  @HostListener('document:keydown.escape') onEsc(): void { this.close.emit(); }

  load(): void {
    this.loading = true;
    this.http.get<any>(this.base).subscribe({
      next: r => { this.loading = false; this.senders = r.senders || []; this.required = !!r.required; this.ui.changed$.next(); },
      error: e => { this.loading = false; this.error = this.err(e); }
    });
  }

  add(): void {
    this.busy = true; this.error = ''; this.notice = '';
    this.http.post<any>(this.base, { email: this.email.trim(), name: this.name.trim() || null }).subscribe({
      next: r => {
        this.busy = false;
        this.notice = r.sender?.status === 'verified' ? `${r.sender.email} is already verified.` : `We emailed a confirmation link to ${r.sender?.email}. Open it, then press Refresh.`;
        this.email = ''; this.name = '';
        this.load();
      },
      error: e => { this.busy = false; this.error = this.err(e); }
    });
  }

  resend(s: any): void {
    this.busy = true; this.error = ''; this.notice = '';
    this.http.post<any>(`${this.base}/${s.id}/resend`, {}).subscribe({
      next: () => { this.busy = false; this.notice = `A new link was emailed to ${s.email}.`; this.load(); },
      error: e => { this.busy = false; this.error = this.err(e); }
    });
  }

  remove(s: any): void {
    if (!confirm(`Remove ${s.email}? Campaigns and emails can no longer be sent from it.`)) return;
    this.busy = true; this.error = '';
    this.http.delete<any>(`${this.base}/${s.id}`).subscribe({
      next: () => { this.busy = false; this.load(); },
      error: e => { this.busy = false; this.error = this.err(e); }
    });
  }

  private err(e: any): string { return e?.error?.error || e?.message || 'Something went wrong.'; }
}
