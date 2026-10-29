import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { ComposeReportComponent } from './compose-report.component';

export type LogTab = 'campaigns' | 'audit';

const CAMPAIGN_STATUS: Record<string, string> = {
  draft: 'Draft', ready: 'Ready', approved: 'Approved', active: 'Sending', running: 'Sending', paused: 'Paused', stopped: 'Stopped',
  completed: 'Completed', submitting: 'Submitting', submitted: 'Submitted to Zoho', failed: 'Failed', needs_review: 'Needs review'
};

/**
 * Mail Center → Logs: the campaign log (AI Campaigns and Zoho Campaigns with what they have sent)
 * and, for Owners/Admins, the Compose purpose audit. Read-only. Individual emails are in the
 * Inbox and Sent Mail tabs.
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
  /** Ask Mail Center to open another section (Campaigns). */
  @Output() openSection = new EventEmitter<string>();

  tab: LogTab = 'campaigns';

  campaignType = '';
  campaignPage = 1;
  campaigns: any = null;
  campaignsLoading = false;
  campaignsError: string | null = null;

  private seq = 0;

  constructor(private api: ApiService) {}

  ngOnInit(): void { this.loadCampaigns(1); }

  get tabs(): { id: LogTab; label: string }[] {
    const t: { id: LogTab; label: string }[] = [{ id: 'campaigns', label: 'Campaign log' }];
    if (this.canViewAudit) t.push({ id: 'audit', label: 'Compose audit' });
    return t;
  }

  select(t: LogTab): void {
    this.tab = t;
    if (t === 'campaigns' && !this.campaigns) this.loadCampaigns(1);
  }

  loadCampaigns(page = 1): void {
    const mine = ++this.seq;
    this.campaignPage = page;
    this.campaignsLoading = true;
    this.campaignsError = null;
    this.api.getCampaignLog({ type: this.campaignType, page }).subscribe({
      next: (r: any) => { if (mine !== this.seq) return; this.campaignsLoading = false; this.campaigns = r; },
      error: (e: any) => { if (mine !== this.seq) return; this.campaignsLoading = false; this.campaignsError = e?.error?.error || 'The campaign log could not be loaded.'; }
    });
  }

  statusLabel(s: string): string { return CAMPAIGN_STATUS[s] || s; }
  /** Good / attention / neutral tone for a campaign status chip. */
  tone(s: string | null): string {
    if (!s) return '';
    if (['completed', 'submitted'].includes(s)) return 'good';
    if (['failed', 'needs_review'].includes(s)) return 'bad';
    if (['paused', 'stopped'].includes(s)) return 'warn';
    return '';
  }
  n(v: number | null | undefined): string { return v === null || v === undefined ? '—' : String(v); }
}
