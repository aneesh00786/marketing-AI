import { Component, EventEmitter, Input, OnChanges, OnInit, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IconComponent } from '../../shared/icon.component';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { EmailPreviewComponent } from './email-preview.component';
import { EmailTrackingComponent } from './email-tracking.component';

export const SENT_STATUS: Record<string, { label: string; tone: string; hint: string }> = {
  sent: { label: 'Sent', tone: '', hint: 'Handed to the mail server. Delivery is not tracked for this email.' },
  accepted: { label: 'Accepted', tone: '', hint: 'Accepted by the mail service; no delivery event yet.' },
  delivered: { label: 'Delivered', tone: 'good', hint: 'The mail service reported delivery to the recipient\'s server.' },
  opened: { label: 'Opened', tone: 'good', hint: 'An open was recorded. This is an estimate: it does not prove a person read it.' },
  clicked: { label: 'Clicked', tone: 'good', hint: 'A tracked link was clicked.' },
  bounced: { label: 'Bounced', tone: 'bad', hint: 'The recipient\'s server rejected this email.' },
  not_sent: { label: 'Not sent', tone: 'bad', hint: 'This email was not sent.' }
};
const PURPOSE: Record<string, string> = { transactional: 'Transactional / Direct', marketing: 'Marketing' };
const SOURCE: Record<string, string> = { compose: 'Compose', draft: 'Mail Drafts', ai_campaign: 'AI Campaigns', other: 'Not recorded' };

/**
 * Mail Center → Sent Mail: emails this workspace sent or tried to send, with delivery status,
 * purpose and source as recorded, filters, and a detail pane with the delivery & tracking timeline.
 * Delivered/opened/clicked appear only from real tracking events. "Send again" and "Forward" open
 * Compose as a new email, so every send check applies again; nothing is resent automatically.
 */
@Component({
  selector: 'app-mail-sent',
  standalone: true,
  imports: [CommonModule, IconComponent, FormsModule, EmailPreviewComponent, EmailTrackingComponent],
  templateUrl: './mail-sent.component.html',
  styleUrls: ['../command/command-center.component.css', './mail-ui.css', './mailbox.css']
})
export class MailSentComponent implements OnInit, OnChanges {
  /** Pre-select a status filter (e.g. 'not_sent' from the Overview). */
  @Input() initialStatus: string | null = null;
  /** Bumped by the shell after an email is sent: reload the list. */
  @Input() refreshKey = 0;
  @Output() forward = new EventEmitter<any>();
  @Output() sendAgain = new EventEmitter<any>();

  readonly statuses = Object.entries(SENT_STATUS).map(([value, s]) => ({ value, label: s.label }));
  filters = { q: '', status: '', purpose: '', from: '', to: '' };
  page = 1;
  list: any = null;
  loading = false;
  error: string | null = null;

  selectedId: number | null = null;
  detail: any = null;
  detailLoading = false;
  detailError: string | null = null;
  private seq = 0;

  constructor(private api: ApiService) {}

  ngOnInit(): void {
    if (this.initialStatus) this.filters.status = this.initialStatus;
    this.load(1);
  }

  ngOnChanges(ch: SimpleChanges): void {
    if (ch['initialStatus'] && !ch['initialStatus'].firstChange) { this.filters.status = this.initialStatus || ''; this.load(1); }
    else if (ch['refreshKey'] && !ch['refreshKey'].firstChange) this.load(this.page);
  }

  get emails(): any[] { return this.list?.emails || []; }
  get filtered(): boolean { return !!(this.filters.q || this.filters.status || this.filters.purpose || this.filters.from || this.filters.to); }

  load(page = 1): void {
    const mine = ++this.seq;
    this.page = page;
    this.loading = true;
    this.error = null;
    this.api.getSentMail({ ...this.filters, page }).subscribe({
      next: (r: any) => { if (mine !== this.seq) return; this.loading = false; this.list = r; },
      error: (e: any) => { if (mine !== this.seq) return; this.loading = false; this.error = e?.error?.error || 'Sent mail could not be loaded.'; }
    });
  }

  clearFilters(): void {
    this.filters = { q: '', status: '', purpose: '', from: '', to: '' };
    this.load(1);
  }

  open(e: any): void {
    this.selectedId = e.id;
    this.detail = null;
    this.detailError = null;
    this.detailLoading = true;
    this.api.getEmail(e.id).subscribe({
      next: (r: any) => { if (this.selectedId !== e.id) return; this.detailLoading = false; this.detail = r.email; },
      error: (err: any) => { if (this.selectedId !== e.id) return; this.detailLoading = false; this.detailError = err?.error?.error || 'This email could not be opened.'; }
    });
  }

  close(): void { this.selectedId = null; this.detail = null; }

  onListKey(ev: KeyboardEvent): void {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    const i = this.emails.findIndex(x => x.id === this.selectedId);
    const next = this.emails[ev.key === 'ArrowDown' ? Math.min(this.emails.length - 1, i + 1) : Math.max(0, i - 1)];
    if (!next) return;
    ev.preventDefault();
    this.open(next);
    setTimeout(() => (document.getElementById(`mb-sent-${next.id}`) as HTMLElement | null)?.focus());
  }

  status(d: string | null) { return SENT_STATUS[d || 'sent'] || SENT_STATUS['sent']; }
  purposeLabel(p: string | null): string { return p ? (PURPOSE[p] || p) : 'Not recorded'; }
  sourceLabel(s: string | null): string { return s ? (SOURCE[s] || s) : '—'; }
  providerLabel(p: string | null): string { return p === 'zeptomail' ? 'ZeptoMail' : p === 'smtp' ? 'SMTP mailbox' : 'Not recorded'; }
  previewHtml(d: any): string { return d.html_body || ''; }
}
