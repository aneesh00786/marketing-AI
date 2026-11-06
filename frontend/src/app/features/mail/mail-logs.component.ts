import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { ComposeReportComponent } from './compose-report.component';

export type LogTab = 'campaigns' | 'emails' | 'audit';

const CAMPAIGN_STATUS: Record<string, string> = {
  active: 'Sending', running: 'Sending', paused: 'Paused', stopped: 'Stopped', completed: 'Completed',
  submitted: 'Sent', needs_review: 'Outcome unknown — check'
};
const PURPOSE: Record<string, string> = { transactional: 'Transactional / Direct', marketing: 'Marketing' };
const SOURCE: Record<string, string> = { compose: 'Compose', draft: 'Mail Drafts', ai_campaign: 'AI Campaigns', other: 'Not recorded' };
const DELIVERY: Record<string, string> = { sent: 'Sent', accepted: 'Accepted', delivered: 'Delivered', opened: 'Opened', clicked: 'Clicked', bounced: 'Bounced' };

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Mail Center → Logs: a record of what was actually sent, filtered by date.
 *  - Sent campaigns: AI Campaigns that sent emails and email campaigns sent with Amazon SES (no drafts,
 *    approved-but-unsent or failed campaigns).
 *  - Sent emails: every email that went out (failed attempts are in Sent Mail).
 *  - Compose audit (Owners/Admins): the purpose recorded for each Compose send.
 * Read-only.
 */
@Component({
  selector: 'app-mail-logs',
  standalone: true,
  imports: [CommonModule, FormsModule, ComposeReportComponent],
  templateUrl: './mail-logs.component.html',
  styleUrls: ['../command/command-center.component.css', './mail-ui.css', './mail-logs.component.css']
})
export class MailLogsComponent implements OnInit {
  /** Owners/Admins (mail.configure) also get the Compose audit; the server enforces it too. */
  @Input() canViewAudit = false;
  /** Ask Mail Center to open another section (Campaigns, Sent Mail). */
  @Output() openSection = new EventEmitter<string>();

  tab: LogTab = 'campaigns';
  /** Date range shared by both logs (YYYY-MM-DD; empty = no limit). */
  range = { from: '', to: '' };
  readonly presets = [7, 30, 90];

  campaignType = '';
  campaignPage = 1;
  campaigns: any = null;
  campaignsLoading = false;
  campaignsError: string | null = null;

  emailQuery = '';
  emailPage = 1;
  emails: any = null;
  emailsLoading = false;
  emailsError: string | null = null;

  private seq = { campaigns: 0, emails: 0 };

  constructor(private api: ApiService) {}

  ngOnInit(): void { this.loadCampaigns(1); }

  get tabs(): { id: LogTab; label: string }[] {
    const t: { id: LogTab; label: string }[] = [{ id: 'campaigns', label: 'Sent campaigns' }, { id: 'emails', label: 'Sent emails' }];
    if (this.canViewAudit) t.push({ id: 'audit', label: 'Compose audit' });
    return t;
  }

  get rangeInvalid(): boolean { return !!(this.range.from && this.range.to && this.range.from > this.range.to); }

  select(t: LogTab): void {
    this.tab = t;
    if (t === 'campaigns' && !this.campaigns) this.loadCampaigns(1);
    if (t === 'emails' && !this.emails) this.loadEmails(1);
  }

  /** The date range changed: reload the open log (the other reloads when opened). */
  applyRange(): void {
    if (this.rangeInvalid) return;
    this.campaigns = this.tab === 'campaigns' ? this.campaigns : null;
    this.emails = this.tab === 'emails' ? this.emails : null;
    if (this.tab === 'campaigns') this.loadCampaigns(1);
    if (this.tab === 'emails') this.loadEmails(1);
  }

  /** Last N days, today included. */
  preset(days: number): void {
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 86400000);
    this.range = { from: isoDay(from), to: isoDay(to) };
    this.applyRange();
  }

  isPreset(days: number): boolean {
    const to = new Date();
    return this.range.to === isoDay(to) && this.range.from === isoDay(new Date(to.getTime() - (days - 1) * 86400000));
  }

  clearRange(): void {
    this.range = { from: '', to: '' };
    this.applyRange();
  }

  loadCampaigns(page = 1): void {
    const mine = ++this.seq.campaigns;
    this.campaignPage = page;
    this.campaignsLoading = true;
    this.campaignsError = null;
    this.api.getCampaignLog({ type: this.campaignType, from: this.range.from, to: this.range.to, page }).subscribe({
      next: (r: any) => { if (mine !== this.seq.campaigns) return; this.campaignsLoading = false; this.campaigns = r; },
      error: (e: any) => { if (mine !== this.seq.campaigns) return; this.campaignsLoading = false; this.campaignsError = e?.error?.error || 'The campaign log could not be loaded.'; }
    });
  }

  loadEmails(page = 1): void {
    const mine = ++this.seq.emails;
    this.emailPage = page;
    this.emailsLoading = true;
    this.emailsError = null;
    this.api.getSentMail({ sentOnly: '1', q: this.emailQuery.trim(), from: this.range.from, to: this.range.to, page }).subscribe({
      next: (r: any) => { if (mine !== this.seq.emails) return; this.emailsLoading = false; this.emails = r; },
      error: (e: any) => { if (mine !== this.seq.emails) return; this.emailsLoading = false; this.emailsError = e?.error?.error || 'The email log could not be loaded.'; }
    });
  }

  statusLabel(s: string): string { return CAMPAIGN_STATUS[s] || s; }
  /** Good / attention / neutral tone for a status chip. */
  tone(s: string | null): string {
    if (!s) return '';
    if (['completed', 'submitted', 'delivered', 'opened', 'clicked'].includes(s)) return 'good';
    if (['needs_review', 'bounced'].includes(s)) return 'bad';
    if (['paused', 'stopped'].includes(s)) return 'warn';
    return '';
  }
  purposeLabel(p: string | null): string { return p ? (PURPOSE[p] || p) : 'Not recorded'; }
  sourceLabel(s: string | null): string { return s ? (SOURCE[s] || s) : '—'; }
  deliveryLabel(d: string | null): string { return DELIVERY[d || 'sent'] || 'Sent'; }
  n(v: number | null | undefined): string { return v === null || v === undefined ? '—' : String(v); }
}
