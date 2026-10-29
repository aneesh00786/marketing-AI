import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { ComposeReportComponent } from './compose-report.component';

export type LogTab = 'emails' | 'campaigns' | 'audit';

const SOURCE: Record<string, string> = { compose: 'Compose', draft: 'Mail draft', ai_campaign: 'AI campaign', other: 'Other' };
const DELIVERY: Record<string, string> = {
  sent: 'Sent', accepted: 'Accepted', delivered: 'Delivered', opened: 'Opened', clicked: 'Clicked', bounced: 'Bounced', not_sent: 'Not sent'
};
const CAMPAIGN_STATUS: Record<string, string> = {
  draft: 'Draft', ready: 'Ready', approved: 'Approved', active: 'Sending', running: 'Sending', paused: 'Paused', stopped: 'Stopped',
  completed: 'Completed', submitting: 'Submitting', submitted: 'Submitted to Zoho', failed: 'Failed', needs_review: 'Needs review'
};

/**
 * Mail Center → Logs: the email log (every email sent, not sent or received), the campaign log
 * (AI Campaigns and Zoho Campaigns with what they have sent) and, for Owners/Admins, the Compose
 * purpose audit. Read-only.
 */
@Component({
  selector: 'app-mail-logs',
  standalone: true,
  imports: [CommonModule, FormsModule, ComposeReportComponent],
  templateUrl: './mail-logs.component.html',
  styleUrls: ['../command/command-center.component.css', './mail-logs.component.css']
})
export class MailLogsComponent implements OnInit {
  /** Owners/Admins (mail.configure) also get the Compose audit; the server enforces it too. */
  @Input() canViewAudit = false;
  /** Ask Mail Center to open another section (Campaigns). */
  @Output() openSection = new EventEmitter<string>();

  tab: LogTab = 'emails';

  emailFilters = { direction: '', q: '' };
  emailPage = 1;
  emails: any = null;
  emailsLoading = false;
  emailsError: string | null = null;

  campaignType = '';
  campaignPage = 1;
  campaigns: any = null;
  campaignsLoading = false;
  campaignsError: string | null = null;

  private seq = { emails: 0, campaigns: 0 };

  constructor(private api: ApiService) {}

  ngOnInit(): void { this.loadEmails(1); }

  get tabs(): { id: LogTab; label: string }[] {
    const t: { id: LogTab; label: string }[] = [{ id: 'emails', label: 'Email log' }, { id: 'campaigns', label: 'Campaign log' }];
    if (this.canViewAudit) t.push({ id: 'audit', label: 'Compose audit' });
    return t;
  }

  select(t: LogTab): void {
    this.tab = t;
    if (t === 'campaigns' && !this.campaigns) this.loadCampaigns(1);
  }

  loadEmails(page = 1): void {
    const mine = ++this.seq.emails;
    this.emailPage = page;
    this.emailsLoading = true;
    this.emailsError = null;
    this.api.getEmailLog({ ...this.emailFilters, page }).subscribe({
      next: (r: any) => { if (mine !== this.seq.emails) return; this.emailsLoading = false; this.emails = r; },
      error: (e: any) => { if (mine !== this.seq.emails) return; this.emailsLoading = false; this.emailsError = e?.error?.error || 'The email log could not be loaded.'; }
    });
  }

  loadCampaigns(page = 1): void {
    const mine = ++this.seq.campaigns;
    this.campaignPage = page;
    this.campaignsLoading = true;
    this.campaignsError = null;
    this.api.getCampaignLog({ type: this.campaignType, page }).subscribe({
      next: (r: any) => { if (mine !== this.seq.campaigns) return; this.campaignsLoading = false; this.campaigns = r; },
      error: (e: any) => { if (mine !== this.seq.campaigns) return; this.campaignsLoading = false; this.campaignsError = e?.error?.error || 'The campaign log could not be loaded.'; }
    });
  }

  sourceLabel(s: string | null): string { return s ? (SOURCE[s] || s) : '—'; }
  deliveryLabel(d: string | null): string { return d ? (DELIVERY[d] || d) : 'Received'; }
  statusLabel(s: string): string { return CAMPAIGN_STATUS[s] || s; }
  /** Good / attention / neutral tone for a delivery or campaign status chip. */
  tone(s: string | null): string {
    if (!s) return 'neutral';
    if (['delivered', 'opened', 'clicked', 'completed', 'submitted'].includes(s)) return 'good';
    if (['bounced', 'not_sent', 'failed', 'needs_review'].includes(s)) return 'bad';
    if (['paused', 'stopped'].includes(s)) return 'warn';
    return 'neutral';
  }
  n(v: number | null | undefined): string { return v === null || v === undefined ? '—' : String(v); }
}
