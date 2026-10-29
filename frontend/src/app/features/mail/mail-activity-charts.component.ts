import { Component, EventEmitter, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ApiService } from '../../services/api.service';

type Day = { date: string; mailbox: number; campaigns: number; received: number };

/**
 * Overview charts: emails sent per day (mailbox vs AI campaigns, stacked), and what happened to
 * tracked emails (delivered / opened / clicked). Every number comes from /mail/activity/summary;
 * hovering or focusing a day shows its counts, and each chart can be shown as a table.
 */
@Component({
  selector: 'app-mail-activity-charts',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './mail-activity-charts.component.html',
  styleUrls: ['./mail-ui.css', './mail-activity-charts.component.css']
})
export class MailActivityChartsComponent implements OnInit {
  /** Open Sent Mail, optionally filtered by status (e.g. 'not_sent'). */
  @Output() openSent = new EventEmitter<string | null>();

  readonly ranges: (7 | 30 | 90)[] = [7, 30, 90];
  days: 7 | 30 | 90 = 30;
  data: any = null;
  loading = false;
  error: string | null = null;
  hover: number | null = null;
  showTable = false;
  private seq = 0;

  constructor(private api: ApiService) {}

  ngOnInit(): void { this.load(); }

  setRange(d: 7 | 30 | 90): void {
    if (d === this.days) return;
    this.days = d;
    this.load();
  }

  load(): void {
    const mine = ++this.seq;
    this.loading = true;
    this.error = null;
    this.hover = null;
    this.api.getMailActivitySummary(this.days).subscribe({
      next: (r: any) => { if (mine !== this.seq) return; this.loading = false; this.data = r; },
      error: (e: any) => { if (mine !== this.seq) return; this.loading = false; this.error = e?.error?.error || 'Mail activity could not be loaded.'; }
    });
  }

  get daily(): Day[] { return this.data?.daily || []; }
  get totalSent(): number { return (this.data?.totals?.sentMailbox || 0) + (this.data?.totals?.sentCampaigns || 0); }

  /** Top of the y-axis: the busiest day rounded up to 1, 2 or 5 × 10ⁿ (at least 4). */
  get yMax(): number {
    const peak = Math.max(0, ...this.daily.map(d => d.mailbox + d.campaigns));
    if (peak <= 4) return 4;
    const p = Math.pow(10, Math.floor(Math.log10(peak)));
    return [1, 2, 5, 10].map(m => m * p).find(v => v >= peak) || peak;
  }
  h(v: number): number { return (v / this.yMax) * 100; }

  /** Date labels under the axis: first, middle and last day. */
  get xLabels(): { i: number; text: string }[] {
    const n = this.daily.length;
    if (!n) return [];
    const idx = Array.from(new Set([0, Math.floor((n - 1) / 2), n - 1]));
    return idx.map(i => ({ i, text: this.short(this.daily[i].date) }));
  }
  short(iso: string): string {
    const d = new Date(`${iso}T00:00:00Z`);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  left(i: number): number { return ((i + 0.5) / Math.max(1, this.daily.length)) * 100; }

  get delivery(): { label: string; value: number; hint: string }[] {
    const d = this.data?.delivery;
    if (!d?.tracked) return [];
    const rows = [{ label: 'Delivered', value: d.delivered, hint: 'Confirmed delivered by the mail service' }];
    if (d.opensTracked) rows.push({ label: 'Opened', value: d.opened, hint: 'Opened at least once (open tracking on)' });
    if (d.clicksTracked) rows.push({ label: 'Clicked', value: d.clicked, hint: 'Clicked a link at least once (click tracking on)' });
    return rows;
  }
  pct(v: number): number { return this.data?.delivery?.tracked ? Math.round((v / this.data.delivery.tracked) * 100) : 0; }
}
