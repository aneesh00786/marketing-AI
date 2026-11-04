import { Component, EventEmitter, HostListener, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';

export interface Metric { label: string; value: string; hint?: string; unavailable?: boolean; activity?: string }
export interface SummaryItem { label: string; value: string; sub: string | null; activity?: string; unavailable: boolean }
export interface BarRow { label: string; value: number; pct: number; activity?: string }

/** Popup tabs. "delivered" shows Zoho's sent-to list; "forwards" has no list in Zoho. */
const ACTIVITIES = [
  { key: 'sent', label: 'Sent', api: 'sent', help: 'Everyone Zoho sent this campaign to.' },
  { key: 'delivered', label: 'Delivered', api: 'sent', help: 'Zoho lists everyone it sent to; those that bounced are under Bounced.' },
  { key: 'opened', label: 'Opened', api: 'opened', help: 'Opened the email at least once (an estimate: image blocking and privacy features affect it).' },
  { key: 'unopened', label: 'Unopened', api: 'unopened', help: 'Delivered, but no open recorded yet. Good candidates for a follow-up.' },
  { key: 'clicked', label: 'Clicked', api: 'clicked', help: 'Clicked a link in the email: your most interested contacts.' },
  { key: 'hard_bounced', label: 'Hard bounced', api: 'hard_bounced', help: 'Addresses that do not exist or refuse mail. Zoho will not send to them again.' },
  { key: 'soft_bounced', label: 'Soft bounced', api: 'soft_bounced', help: 'Temporary problems such as a full mailbox.' },
  { key: 'unsubscribed', label: 'Unsubscribed', api: 'unsubscribed', help: 'Asked not to get these emails any more.' },
  { key: 'spam', label: 'Marked spam', api: 'spam', help: 'Reported the email as spam.' },
  { key: 'forwards', label: 'Forwards', api: null, help: 'Times the email was forwarded.' }
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

  readonly popupActivities = ACTIVITIES;
  activity = 'opened';
  readonly pageSize = 50;
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
      item('Delivered', delivered, share(r.delivered_percent, delivered, sent), 'delivered'),
      item('Opened', opened, share(r.open_percent, opened, delivered), 'opened'),
      item('Unopened', unopened, share(r.unopened_percent, unopened, delivered), 'unopened'),
      item('Clicked', num(r.unique_clicks_count), share(r.unique_clicked_percent, num(r.unique_clicks_count), delivered), 'clicked'),
      item('Bounced', num(r.bounces_count), share(r.bounce_percent, num(r.bounces_count), sent), 'hard_bounced'),
      item('Unsubscribes', num(r.unsub_count), share(r.unsubscribe_percent, num(r.unsub_count), delivered), 'unsubscribed'),
      item('Marked spam', num(r.spams_count) ?? num(r.complaints_count), share(r.spam_percent, num(r.spams_count), delivered), 'spam'),
      item('Forwards', num(r.forwards_count), share(r.forward_percent, num(r.forwards_count), delivered), 'forwards')
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
      { label: 'Delivered', value: num(r.delivered_count), activity: 'delivered' },
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

  /** Opens the popup with the people behind a figure or chart row. */
  openActivity(activity: string): void {
    this.showRecipients = true;
    this.selectActivity(activity);
  }

  selectActivity(activity: string): void {
    this.activity = activity;
    this.recipients = [];
    this.hasMore = false;
    this.error = null;
    this.notSent = false;
    if (this.noList(activity)) { this.page = 1; this.loading = false; this.seq++; return; }
    this.loadRecipients(1);
  }

  closeRecipients(): void { this.showRecipients = false; this.seq++; }

  @HostListener('document:keydown.escape') onEscape(): void { if (this.showRecipients) this.closeRecipients(); }

  private def(key: string) { return ACTIVITIES.find(a => a.key === key); }
  activityLabel(key: string): string { return this.def(key)?.label || key; }
  activityHelp(key: string): string { return this.def(key)?.help || ''; }
  /** Why a group has no list of people ('' when it has one). */
  noList(key: string): string { return this.def(key) && !this.def(key)!.api ? 'Zoho counts forwards but does not say who forwarded the email.' : ''; }

  /** The figure for a popup tab, from the report (null when Zoho did not report it). */
  activityCount(key: string): number | null {
    const r = this.report || {};
    const map: Record<string, any> = {
      sent: r.emails_sent_count, delivered: r.delivered_count, opened: r.opens_count, clicked: r.unique_clicks_count,
      unopened: r.unopened ?? (num(r.delivered_count) !== null && num(r.opens_count) !== null ? Math.max(0, num(r.delivered_count)! - num(r.opens_count)!) : null),
      hard_bounced: r.hardbounce_count, soft_bounced: r.softbounce_count, unsubscribed: r.unsub_count, spam: r.spams_count ?? r.complaints_count, forwards: r.forwards_count
    };
    return num(map[key]);
  }

  loadRecipients(page = 1): void {
    const api = this.def(this.activity)?.api ?? this.activity;
    if (!this.campaignId || !api) return;
    const mine = ++this.seq;
    this.page = page;
    this.loading = true;
    this.error = null;
    this.api.getCampaignRecipients(this.campaignId, api, page).subscribe({
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

  /** The loaded page as a CSV file (for a follow-up list or a spreadsheet). */
  downloadCsv(): void {
    const head = ['Contact', 'Business', 'Email', 'Phone', 'Location', 'Opens', 'Last opened', 'Clicks', 'Lead status'];
    const cell = (v: any) => {
      let t = v === null || v === undefined ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; // keep spreadsheet formulas from running
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const rows = this.recipients.map(r => [r.name || r.contactName, r.company, r.email, r.phone, r.location, r.opens, r.lastOpenedAt, r.clicks, r.leadStatus].map(cell).join(','));
    const blob = new Blob([[head.join(','), ...rows].join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${this.activityLabel(this.activity).toLowerCase().replace(/\s+/g, '-')}-page-${this.page}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href));
  }

  // ---------- Insights (devices, clients, browsers, locations, lists) ----------
  get insights(): any { return this.report?.insights || null; }

  get insightGroups(): { label: string; hint?: string; empty: string; rows: BarRow[] }[] {
    const ins = this.insights;
    if (!ins) return [];
    const rowsOf = (list: any[]) => bars((list || []).map((x: any) => ({ label: String(x.label), value: num(x.value) })));
    return [
      { label: 'Devices', hint: 'Opens by device', empty: 'No opens recorded yet.', rows: rowsOf(ins.devices) },
      { label: 'Email apps', empty: 'Zoho has not identified any email app yet.', rows: rowsOf(ins.emailClients) },
      { label: 'Browsers', hint: 'For opens in webmail', empty: 'No browser opens recorded yet.', rows: rowsOf(ins.browsers) },
      { label: 'Locations', hint: 'Opens by country', empty: 'No locations recorded yet.', rows: rowsOf(ins.locations) }
    ];
  }
}
