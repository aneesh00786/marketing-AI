import { Component, OnInit, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';

export const PURPOSE_REASON_LABELS: Record<string, string> = {
  purpose_missing: 'No purpose given',
  declared_marketing: 'Marked as marketing',
  template_unknown: 'Unknown template',
  template_marketing_category: 'Marketing template',
  matches_marketing_template: 'Contains a marketing template',
  zoho_merge_tags: 'Zoho merge tags',
  unsubscribe_wording: 'Unsubscribe wording',
  promotional_phrases: 'Promotional wording',
  transactional_not_permitted: 'No permission for transactional',
  unsubscribed: 'Unsubscribed',
  bounced: 'Bounced earlier',
  complaint: 'Spam complaint',
  consent_withdrawn: 'Consent withdrawn',
  MARKETING_PROVIDER_BLOCKED: 'No marketing mailbox (ZeptoMail only)',
  MARKETING_SMTP_REQUIRED: 'No marketing mailbox',
  MARKETING_NOT_APPROVED: 'Mailbox not approved for marketing'
};

/**
 * Compose send report for Owners/Admins (mail.configure): who sent what kind of Compose email when,
 * to a masked recipient, with the declared and applied purpose and why. No message content.
 */
@Component({
  selector: 'app-compose-report',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './compose-report.component.html',
  styleUrls: ['../command/command-center.component.css', './mail-ui.css', './compose-report.component.css']
})
export class ComposeReportComponent implements OnInit {
  /** Show the log expanded and loaded (in Mail Center → Logs). */
  @Input() startOpen = false;
  open = false;
  filters = { from: '', to: '', purpose: '' };
  page = 1;
  data: any = null;
  loading = false;
  error: string | null = null;
  private seq = 0;

  constructor(private api: ApiService) {}

  ngOnInit(): void { if (this.startOpen) this.toggle(); }

  toggle(): void {
    this.open = !this.open;
    if (this.open && !this.data) this.load(1);
  }

  load(page = 1): void {
    const mine = ++this.seq;
    this.page = page;
    this.loading = true;
    this.error = null;
    this.api.getComposeReport({ ...this.filters, page }).subscribe({
      next: (r: any) => { if (mine !== this.seq) return; this.loading = false; this.data = r; },
      error: (e: any) => {
        if (mine !== this.seq) return;
        this.loading = false;
        this.error = e?.status === 403 ? 'Only workspace Owners and Admins can see this report.' : (e?.error?.error || 'The report could not be loaded.');
      }
    });
  }

  label(code: string): string { return PURPOSE_REASON_LABELS[code] || code; }
  reasonsText(codes: string[]): string { return codes?.length ? codes.map(c => this.label(c)).join(', ') : '—'; }
  purposeLabel(p: string | null): string {
    return p === 'transactional' ? 'Transactional' : p === 'marketing' ? 'Marketing' : p === 'not_recorded' ? 'Not recorded' : '—';
  }
}
