import { Component, EventEmitter, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { IconComponent } from '../../shared/icon.component';

/**
 * Settings → Campaigns: the Zoho API client (Client ID and Client Secret from the Zoho API
 * Console) this workspace connects with. Owners/Admins only (the server enforces mail.configure).
 * The secret is write-only: it is sent when saved, stored encrypted, and never shown again.
 */
@Component({
  selector: 'app-zoho-app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent],
  templateUrl: './zoho-app-settings.component.html',
  styleUrls: ['../command/command-center.component.css', './mail-ui.css', './zoho-app-settings.component.css']
})
export class ZohoAppSettingsComponent implements OnInit {
  @Output() toast = new EventEmitter<string>();
  /** Credentials saved or removed: the connection panel reloads its status. */
  @Output() changed = new EventEmitter<void>();

  app: any = null;
  loading = false;
  forbidden = false;
  error: string | null = null;
  saving = false;
  form = { clientId: '', clientSecret: '' };
  showSecret = false;

  constructor(private api: ApiService) {}

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading = true;
    this.error = null;
    this.api.getZohoApp().subscribe({
      next: (r: any) => { this.loading = false; this.app = r.app; },
      error: (e: any) => {
        this.loading = false;
        if (e?.status === 403) this.forbidden = true;
        else this.error = e?.error?.error || 'Zoho settings could not be loaded.';
      }
    });
  }

  get savedHere(): boolean { return this.app?.source === 'workspace'; }

  get canSave(): boolean {
    const id = this.form.clientId.trim();
    return !this.saving && !!id && (this.savedHere || !!this.form.clientSecret.trim()) && !!this.app?.encryptionReady;
  }

  save(): void {
    if (!this.canSave) return;
    if (this.savedHere && !confirm('Replace the saved Zoho credentials? If they are different, Zoho Campaigns is disconnected and must be connected again.')) return;
    this.saving = true;
    const body: { clientId: string; clientSecret?: string } = { clientId: this.form.clientId.trim() };
    if (this.form.clientSecret.trim()) body.clientSecret = this.form.clientSecret.trim();
    this.api.saveZohoApp(body).subscribe({
      next: (r: any) => {
        this.saving = false;
        this.app = r.app;
        this.form = { clientId: '', clientSecret: '' };
        this.showSecret = false;
        this.toast.emit(!r.changed ? 'Nothing changed: these credentials are already saved.'
          : r.disconnected ? 'Zoho credentials saved. Zoho Campaigns was disconnected: connect it again below.'
          : 'Zoho credentials saved. Now connect Zoho Campaigns below.');
        this.changed.emit();
      },
      error: (e: any) => { this.saving = false; this.error = e?.error?.error || 'The Zoho credentials were not saved.'; }
    });
  }

  remove(): void {
    if (!confirm('Remove the saved Zoho credentials? Zoho Campaigns is disconnected; campaigns stay in Marketech.ai.')) return;
    this.api.removeZohoApp().subscribe({
      next: (r: any) => { this.app = r.app; this.toast.emit('Zoho credentials removed.'); this.changed.emit(); },
      error: (e: any) => this.error = e?.error?.error || 'The Zoho credentials were not removed.'
    });
  }

  copy(text: string, what: string): void {
    const done = () => this.toast.emit(`${what} copied.`);
    try {
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => this.toast.emit(`Copy failed: select the ${what.toLowerCase()} and copy it.`));
      else this.toast.emit(`Select the ${what.toLowerCase()} and copy it.`);
    } catch { this.toast.emit(`Select the ${what.toLowerCase()} and copy it.`); }
  }
}
