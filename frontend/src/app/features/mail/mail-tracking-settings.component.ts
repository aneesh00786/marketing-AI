import { Component, EventEmitter, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';

/**
 * Workspace email-tracking policy (opens and clicks, off by default) and the ZeptoMail webhook
 * connection. Everyone with mail access can see it; only roles with mail.configure can change it
 * (the server enforces this). The webhook key is write-only: it is never shown again.
 */
@Component({
  selector: 'app-mail-tracking-settings',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './mail-tracking-settings.component.html',
  styleUrls: ['../command/command-center.component.css', './mail-tracking-settings.component.css']
})
export class MailTrackingSettingsComponent implements OnInit {
  @Output() toast = new EventEmitter<string>();

  s: any = null;
  loading = false;
  error: string | null = null;
  busy: 'policy' | 'webhook' | null = null;
  caps: Set<string> | null = null;
  form = { trackOpens: false, trackClicks: false };
  authKey = '';
  open = false;

  constructor(private api: ApiService) {}

  ngOnInit(): void {
    this.load();
    this.api.getMe().subscribe({
      next: (me: any) => { if (Array.isArray(me?.capabilities)) this.caps = new Set(me.capabilities); },
      error: () => { this.caps = null; }
    });
  }

  get canConfigure(): boolean { return this.caps === null || this.caps.has('mail.configure'); }
  get policyDirty(): boolean { return !!this.s && (this.form.trackOpens !== this.s.trackOpens || this.form.trackClicks !== this.s.trackClicks); }

  get summary(): string {
    if (!this.s) return '';
    const on = [this.s.trackOpens && 'opens', this.s.trackClicks && 'clicks'].filter(Boolean);
    return on.length ? `Tracking ${on.join(' and ')}` : 'Open and click tracking off';
  }

  load(): void {
    this.loading = true;
    this.error = null;
    this.api.getMailTrackingSettings().subscribe({
      next: (r: any) => { this.loading = false; this.apply(r.settings); },
      error: (e: any) => { this.loading = false; this.error = e?.error?.error || 'Tracking settings could not be loaded.'; }
    });
  }

  private apply(s: any): void {
    this.s = s;
    this.form = { trackOpens: !!s.trackOpens, trackClicks: !!s.trackClicks };
  }

  savePolicy(): void {
    if (this.busy || !this.policyDirty) return;
    this.busy = 'policy';
    this.api.updateMailTrackingSettings({ ...this.form }).subscribe({
      next: (r: any) => { this.busy = null; this.apply(r.settings); this.toast.emit('Tracking settings saved. They apply to emails sent from now on.'); },
      error: (e: any) => { this.busy = null; this.toast.emit(e?.error?.error || 'Tracking settings were not saved.'); }
    });
  }

  webhook(body: { authKey?: string; enabled?: boolean; rotateUrl?: boolean }, done: string): void {
    if (this.busy) return;
    if (body.rotateUrl && !confirm('Create a new webhook URL? The old URL stops working; update it in ZeptoMail.')) return;
    this.busy = 'webhook';
    this.api.updateZeptoWebhook(body).subscribe({
      next: (r: any) => { this.busy = null; this.authKey = ''; this.apply(r.settings); this.toast.emit(done); },
      error: (e: any) => { this.busy = null; this.toast.emit(e?.error?.error || 'The webhook was not updated.'); }
    });
  }

  saveKey(): void {
    const key = this.authKey.trim();
    if (key.length < 16) { this.toast.emit('Paste the full authentication key from ZeptoMail (at least 16 characters).'); return; }
    this.webhook({ authKey: key }, 'Webhook key saved.');
  }

  copy(url: string): void {
    try { navigator.clipboard?.writeText(url); this.toast.emit('Webhook URL copied.'); } catch { /* clipboard unavailable */ }
  }
}
