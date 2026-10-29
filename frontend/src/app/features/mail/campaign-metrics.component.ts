import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';

export interface Metric { label: string; value: string; hint?: string; unavailable?: boolean }

const ACTIVITIES = [
  { key: 'opened', label: 'Opened' },
  { key: 'clicked', label: 'Clicked' },
  { key: 'unopened', label: 'Not opened' },
  { key: 'hard_bounced', label: 'Hard bounced' },
  { key: 'soft_bounced', label: 'Soft bounced' },
  { key: 'unsubscribed', label: 'Unsubscribed' },
  { key: 'spam', label: 'Marked as spam' },
  { key: 'sent', label: 'Sent to' }
];

/** Zoho reports numbers as strings or numbers; anything else is "not reported". */
export function num(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace('%', ''));
  return Number.isFinite(n) ? n : null;
}

export function rate(part: number | null, whole: number | null): string | null {
  if (part === null || whole === null || whole <= 0) return null;
  return `${(Math.round((part / whole) * 1000) / 10).toFixed(1)}%`;
}

/**
 * Campaign figures from Zoho's campaign report (refreshed with "Refresh status"), and, for roles
 * with mail.send, per-recipient lists read from Zoho on demand. Figures Zoho did not report are
 * "Unavailable", never 0. Zoho gives campaign totals and recipient lists, not per-recipient times.
 */
@Component({
  selector: 'app-campaign-metrics',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './campaign-metrics.component.html',
  styleUrls: ['../command/command-center.component.css', './mail-ui.css', './campaign-metrics.component.css']
})
export class CampaignMetricsComponent implements OnChanges {
  @Input() campaignId: number | null = null;
  @Input() report: any = null;
  @Input() zohoStatus: string | null = null;
  @Input() status: string | null = null;
  /** Owner, Admin, Marketing Manager and Approver (mail.send); the server enforces it too. */
  @Input() canViewRecipients = false;

  readonly activities = ACTIVITIES;
  activity = 'opened';
  page = 1;
  recipients: any[] = [];
  hasMore = false;
  loading = false;
  error: string | null = null;
  notSent = false;
  showRecipients = false;
  private seq = 0;

  constructor(private api: ApiService) {}

  ngOnChanges(ch: SimpleChanges): void {
    if (ch['campaignId'] && !ch['campaignId'].firstChange) { this.showRecipients = false; this.recipients = []; this.error = null; this.page = 1; }
  }

  get sent(): boolean { return this.status === 'submitted' || this.status === 'needs_review'; }

  get metrics(): Metric[] {
    const r = this.report || {};
    const sent = num(r.emails_sent_count);
    const delivered = num(r.delivered_count);
    const bounced = num(r.bounces_count);
    const opens = num(r.opens_count);
    const clicks = num(r.unique_clicks_count);
    const show = (v: number | null) => (v === null ? 'Unavailable' : String(v));
    const pct = (zoho: any, computed: string | null) => (num(zoho) !== null ? `${num(zoho)}%` : computed ?? 'Unavailable');
    const hard = num(r.hardbounce_count);
    const soft = num(r.softbounce_count);
    return [
      { label: 'Sent', value: show(sent) },
      { label: 'Delivered', value: show(delivered), unavailable: delivered === null },
      { label: 'Delivery rate', value: pct(r.delivered_percent, rate(delivered, sent)) },
      { label: 'Bounced', value: show(bounced), hint: hard !== null || soft !== null ? `Hard ${show(hard)} · Soft ${show(soft)}` : undefined },
      { label: 'Not sent', value: show(num(r.unsent_count)), hint: 'Zoho could not send to these addresses' },
      { label: 'Opens', value: show(opens), hint: 'As Zoho counts them (unique opens). An estimate, not proof of reading.' },
      { label: 'Open rate', value: pct(r.open_percent, rate(opens, delivered)) },
      { label: 'Unique clickers', value: show(clicks) },
      { label: 'Click rate', value: rate(clicks, delivered) ?? 'Unavailable', hint: 'Unique clickers ÷ delivered' },
      { label: 'Unsubscribes', value: show(num(r.unsub_count)) },
      { label: 'Spam complaints', value: show(num(r.spams_count) ?? num(r.complaints_count)) }
    ].map(m => ({ ...m, unavailable: m.value === 'Unavailable' }));
  }

  loadRecipients(page = 1): void {
    if (!this.campaignId) return;
    const mine = ++this.seq;
    this.page = page;
    this.loading = true;
    this.error = null;
    this.api.getCampaignRecipients(this.campaignId, this.activity, page).subscribe({
      next: (r: any) => {
        if (mine !== this.seq) return;
        this.loading = false;
        this.notSent = r.available === false;
        this.recipients = r.recipients || [];
        this.hasMore = !!r.hasMore;
      },
      error: (e: any) => {
        if (mine !== this.seq) return;
        this.loading = false;
        this.recipients = [];
        this.error = e?.status === 403 ? 'Your role cannot see recipient activity.' : (e?.error?.error || 'Recipient activity could not be loaded from Zoho.');
      }
    });
  }

  openRecipients(): void {
    this.showRecipients = true;
    this.loadRecipients(1);
  }
}
