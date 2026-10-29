import { Component, ElementRef, EventEmitter, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { MarketingDeliveryComponent } from './marketing-delivery.component';
import { MailTrackingSettingsComponent } from './mail-tracking-settings.component';

export type SettingsTab = 'sending' | 'replies' | 'marketing' | 'tracking' | 'zoho';

const BLANK = {
  provider: 'custom_smtp', smtp_host: '', smtp_port: 587, smtp_secure: false, smtp_user: '', smtp_pass: '',
  imap_host: '', imap_port: 993, imap_tls: true, imap_user: '', imap_pass: '', sender_name: '', sender_email: '',
  status: 'Not Configured', has_smtp_auth: false, has_imap_auth: false, last_synced_at: null as string | null
};

/**
 * Mail Center → Settings: every mail setting in one place, one tab per topic.
 *  Sending            — sender and outbound connection (ZeptoMail or SMTP)
 *  Replies (IMAP)     — inbound mailbox replies are synced from
 *  Marketing email    — approve the saved SMTP mailbox for marketing
 *  Tracking & privacy — open/click tracking and the ZeptoMail delivery webhook
 *  Zoho Campaigns     — where that connection lives
 * Sending and Replies save the same mailbox settings, so each has the Save button.
 * Owners/Admins (mail.configure) edit; the server enforces it. Others see what applies and why.
 */
@Component({
  selector: 'app-mail-settings',
  standalone: true,
  imports: [CommonModule, FormsModule, MarketingDeliveryComponent, MailTrackingSettingsComponent],
  templateUrl: './mail-settings.component.html',
  styleUrls: ['../command/command-center.component.css', './mail-settings.component.css']
})
export class MailSettingsComponent implements OnInit {
  @Output() toast = new EventEmitter<string>();
  /** Mail settings saved or the mailbox synced: the shell refreshes its status bar and inbox. */
  @Output() changed = new EventEmitter<void>();
  /** Ask Mail Center to open another section (e.g. Campaigns for the Zoho connection). */
  @Output() openSection = new EventEmitter<string>();

  readonly tabs: { id: SettingsTab; label: string }[] = [
    { id: 'sending', label: 'Sending' },
    { id: 'replies', label: 'Replies (IMAP)' },
    { id: 'marketing', label: 'Marketing email' },
    { id: 'tracking', label: 'Tracking & privacy' },
    { id: 'zoho', label: 'Zoho Campaigns' }
  ];
  tab: SettingsTab = 'sending';

  config: any = { ...BLANK };
  loading = false;
  /** The server refused to show the configuration (only Owners/Admins can). */
  forbidden = false;
  loadError: string | null = null;
  saving = false;
  testing = false;
  syncing = false;
  testResult: { success?: boolean; message?: string; error?: string } | null = null;
  /** Bumped after saving so the marketing panel reloads (a new SMTP account clears the approval). */
  version = 0;

  constructor(private api: ApiService, private host: ElementRef<HTMLElement>) {}

  ngOnInit(): void { this.load(); }

  get isZepto(): boolean { return this.config.provider === 'zeptomail'; }

  load(): void {
    this.loading = true;
    this.loadError = null;
    this.api.getMailConfig().subscribe({
      next: (res: any) => {
        this.loading = false;
        if (res?.config) this.config = { ...BLANK, ...res.config, smtp_pass: res.config.smtp_pass || '', imap_pass: res.config.imap_pass || '', smtp_secure: !!res.config.smtp_secure, imap_tls: !!res.config.imap_tls };
      },
      error: (e: any) => {
        this.loading = false;
        if (e?.status === 403) this.forbidden = true;
        else this.loadError = e?.error?.error || 'Mail settings could not be loaded.';
      }
    });
  }

  save(): void {
    if (this.saving) return;
    this.saving = true;
    this.api.saveMailConfig({ ...this.config, smtp_secure: this.config.smtp_secure ? 1 : 0, imap_tls: this.config.imap_tls ? 1 : 0 }).subscribe({
      next: (res: any) => {
        this.saving = false;
        if (res?.config) this.config = { ...this.config, ...res.config, smtp_secure: !!res.config.smtp_secure, imap_tls: !!res.config.imap_tls };
        this.version++;
        this.toast.emit('Mail settings saved.');
        this.changed.emit();
      },
      error: (e: any) => { this.saving = false; this.toast.emit(`Mail settings not saved: ${e?.error?.error || e?.message || 'error'}`); }
    });
  }

  test(): void {
    if (this.testing) return;
    this.testing = true;
    this.testResult = null;
    this.api.testSmtp({ ...this.config, smtp_secure: this.config.smtp_secure ? 1 : 0 }).subscribe({
      next: (res: any) => { this.testing = false; this.testResult = res; },
      error: (e: any) => { this.testing = false; this.testResult = { success: false, error: e?.error?.error || e?.message || 'Connection test failed.' }; }
    });
  }

  sync(): void {
    if (this.syncing) return;
    this.syncing = true;
    this.api.syncCompanyMail().subscribe({
      next: (res: any) => {
        this.syncing = false;
        this.toast.emit(res?.success ? (res.message || 'Mailbox synchronized.') : (res?.error || 'Inbox sync is not configured.'));
        if (res?.success) { this.changed.emit(); this.load(); }
      },
      error: (e: any) => { this.syncing = false; this.toast.emit(`Inbox sync failed: ${e?.error?.error || e?.message || 'error'}`); }
    });
  }

  select(id: SettingsTab): void { this.tab = id; }

  /** Arrow keys, Home and End move between tabs (and open them), per the WAI-ARIA tabs pattern. */
  onTabKey(ev: KeyboardEvent): void {
    const ids = this.tabs.map(t => t.id);
    const i = ids.indexOf(this.tab);
    let next = -1;
    if (ev.key === 'ArrowRight') next = (i + 1) % ids.length;
    else if (ev.key === 'ArrowLeft') next = (i - 1 + ids.length) % ids.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = ids.length - 1;
    if (next < 0) return;
    ev.preventDefault();
    this.select(ids[next]);
    setTimeout(() => this.host.nativeElement.querySelector<HTMLElement>(`#ms-tab-${ids[next]}`)?.focus());
  }
}
