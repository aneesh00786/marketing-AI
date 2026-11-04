import { Component, ElementRef, EventEmitter, Input, OnChanges, Output, SimpleChanges, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';

export interface Metric { label: string; value: string; hint?: string; unavailable?: boolean; activity?: string }
export interface SummaryItem { label: string; value: string; sub: string | null; activity?: string; unavailable: boolean }
export interface BarRow { label: string; value: number; pct: number; activity?: string }

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

/** Bars for the figures Zoho reported, scaled to the largest. A missing figure gets no bar, never 0. */
function bars(rows: { label: string; value: number | null; activity?: string }[]): BarRow[] {
  const known = rows.filter(r => r.value !== null) as (BarRow & { value: number })[];
  const max = Math.max(0, ...known.map(r => r.value));
  return known.map(r => ({ label: r.label, value: r.value, activity: r.activity, pct: max ? (r.value / max) * 100 : 0 }));
}

/**
 * Campaign figures from Zoho's campaign report (read when a sent campaign is opened, or with "Refresh status"), and, for roles
 * with mail.send, per-recipient lists read from Zoho on demand: a chart row or figure opens the
 * list of those people. Figures Zoho did not report are
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
  @Input() lastCheckedAt: string | null = null;
  /** Owner, Admin, Marketing Manager and Approver (mail.send); the server enforces it too. */
  @Input() canViewRecipients = false;
  /** Fetching the latest figures from Zoho right now (the parent does the request). */
  @Input() refreshing = false;
  @Output() refresh = new EventEmitter<void>();

  readonly activities = ACTIVITIES;
  activity = 'opened';
  page = 1;
  recipients: any[] = [];
  hasMore = false;
  loading = false;
  error: string | null = null;
  notSent = false;
  showRecipients = false;
  @ViewChild('recips') private recipsRef?: ElementRef<HTMLElement>;
  private seq = 0;

  constructor(private api: ApiService) {}

  ngOnChanges(ch: SimpleChanges): void {
    if (ch['campaignId'] && !ch['campaignId'].firstChange) { this.showRecipients = false; this.recipients = []; this.error = null; this.page = 1; }
  }

  get sent(): boolean { return this.status === 'submitted' || this.status === 'needs_review'; }

  /** The headline row, as in Zoho's report summary: count, and its share of sent or delivered. */
  get summary(): SummaryItem[] {
    const r = this.report || {};
    const sent = num(r.emails_sent_count);
    const delivered = num(r.delivered_count);
    const opened = num(r.opens_count);
    const unopened = num(r.unopened) ?? (delivered !== null && opened !== null ? Math.max(0, delivered - opened) : null);
    const share = (zohoPct: any, part: number | null, whole: number | null) => (num(zohoPct) !== null ? `${num(zohoPct)}%` : rate(part, whole));
    const item = (label: string, v: number | null, sub: string | null, activity?: string): SummaryItem =>
      ({ label, value: v === null ? '—' : v.toLocaleString('en-US'), sub: v === null ? null : sub, activity, unavailable: v === null });
    return [
      item('Sent', sent, null, 'sent'),
      item('Delivered', delivered, share(r.delivered_percent, delivered, sent)),
      item('Opened', opened, share(r.open_percent, opened, delivered), 'opened'),
      item('Unopened', unopened, share(r.unopened_percent, unopened, delivered), 'unopened'),
      item('Clicked', num(r.unique_clicks_count), share(r.unique_clicked_percent, num(r.unique_clicks_count), delivered), 'clicked'),
      item('Unsubscribes', num(r.unsub_count), share(r.unsubscribe_percent, num(r.unsub_count), delivered), 'unsubscribed'),
      item('Marked spam', num(r.spams_count) ?? num(r.complaints_count), share(r.spam_percent, num(r.spams_count), delivered), 'spam'),
      item('Forwards', num(r.forwards_count), share(r.forward_percent, num(r.forwards_count), delivered))
    ];
  }

  get metrics(): Metric[] {
    const r = this.report || {};
    const sent = num(r.emails_sent_count);
    const delivered = num(r.delivered_count);
    const bounced = num(r.bounces_count);
    const opens = num(r.opens_count);
    const clicks = num(r.unique_clicks_count);
    const show = (v: number | null) => (v === null ? 'Unavailable' : v.toLocaleString('en-US'));
    const pct = (zoho: any, computed: string | null) => (num(zoho) !== null ? `${num(zoho)}%` : computed ?? 'Unavailable');
    const hard = num(r.hardbounce_count);
    const soft = num(r.softbounce_count);
    return [
      { label: 'Delivery rate', value: pct(r.delivered_percent, rate(delivered, sent)) },
      { label: 'Bounced', value: show(bounced), hint: hard !== null || soft !== null ? `Hard ${show(hard)} · Soft ${show(soft)}` : undefined, activity: 'hard_bounced' },
      { label: 'Not sent', value: show(num(r.unsent_count)), hint: 'Zoho could not send to these addresses' },
      { label: 'Open rate', value: pct(r.open_percent, rate(opens, delivered)), hint: 'Unique opens ÷ delivered. An estimate, not proof of reading.' },
      { label: 'Click rate', value: rate(clicks, delivered) ?? 'Unavailable', hint: 'Unique clickers ÷ delivered' },
      { label: 'Auto-replies', value: show(num(r.autoreply_count)) }
    ].map(m => ({ ...m, unavailable: m.value === 'Unavailable' }));
  }

  /** From Sent down to Clicked. Delivered has no list: Zoho has no such recipient group. */
  get reach(): BarRow[] {
    const r = this.report || {};
    return bars([
      { label: 'Sent', value: num(r.emails_sent_count), activity: 'sent' },
      { label: 'Delivered', value: num(r.delivered_count) },
      { label: 'Opened', value: num(r.opens_count), activity: 'opened' },
      { label: 'Clicked', value: num(r.unique_clicks_count), activity: 'clicked' }
    ]);
  }

  get problems(): BarRow[] {
    const r = this.report || {};
    const hard = num(r.hardbounce_count);
    const soft = num(r.softbounce_count);
    const bounced = hard !== null || soft !== null
      ? [{ label: 'Hard bounced', value: hard, activity: 'hard_bounced' }, { label: 'Soft bounced', value: soft, activity: 'soft_bounced' }]
      : [{ label: 'Bounced', value: num(r.bounces_count), activity: 'hard_bounced' }];
    return bars([
      ...bounced,
      { label: 'Unsubscribed', value: num(r.unsub_count), activity: 'unsubscribed' },
      { label: 'Spam complaints', value: num(r.spams_count) ?? num(r.complaints_count), activity: 'spam' }
    ]);
  }

  get canOpenLists(): boolean { return this.sent && this.canViewRecipients; }
  canOpen(activity?: string): boolean { return !!activity && this.canOpenLists; }
  isOpen(activity?: string): boolean { return this.showRecipients && this.activity === activity; }
  trackLabel(_: number, row: { label: string }): string { return row.label; }

  /** Opens the list of people behind a figure or chart row. */
  openActivity(activity: string): void {
    this.activity = activity;
    this.openRecipients();
    setTimeout(() => this.recipsRef?.nativeElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
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
