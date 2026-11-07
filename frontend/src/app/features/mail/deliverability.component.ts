import { Component, EventEmitter, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';

type Level = 'good' | 'warning' | 'critical' | 'none';

/**
 * Deliverability of campaigns sent with Amazon SES: delivery, bounce, complaint, unsubscribe and SES
 * rejection rates, emails per day, results by mailbox provider, warm-up of each sender domain, and the
 * bounce/complaint brake. "Delivered" means the receiving server accepted the email (inbox or spam);
 * no provider reports inbox placement, so this page never claims it.
 */
@Component({
  selector: 'app-deliverability',
  standalone: true,
  imports: [CommonModule],
  styleUrls: ['./deliverability.component.css'],
  template: `
<section class="dv" aria-labelledby="dv-title">
  <header class="dv-head">
    <div>
      <h2 id="dv-title">Deliverability</h2>
      <p class="dv-sub">How your Amazon SES campaigns are received. Delivered means the recipient's mail server accepted the email: it can still land in the spam folder.</p>
    </div>
    <div class="dv-controls">
      <div class="dv-range" role="group" aria-label="Time range">
        <button type="button" *ngFor="let r of ranges" [class.on]="days === r" [attr.aria-pressed]="days === r" (click)="setRange(r)">{{ r }} days</button>
      </div>
      <button type="button" class="dv-link" (click)="showTable = !showTable" [attr.aria-pressed]="showTable">{{ showTable ? 'Show chart' : 'Show as table' }}</button>
      <button type="button" class="dv-link" (click)="openSettings.emit()">Settings →</button>
    </div>
  </header>

  <p class="dv-muted" *ngIf="loading && !d">Loading…</p>
  <div class="dv-error" *ngIf="error" role="alert">{{ error }} <button type="button" class="dv-link" (click)="load()">Try again</button></div>

  <ng-container *ngIf="d && !error">
    <div class="dv-banner" *ngIf="d.health.message" [class.critical]="d.health.level === 'critical'" role="alert">
      <b>{{ d.health.level === 'critical' ? '⛔ Sending paused' : '⚠ Watch out' }}</b> {{ d.health.message }}
    </div>

    <h3 class="dv-section">Delivery <small class="dv-muted">reported by Amazon SES</small></h3>
    <div class="dv-stats">
      <div class="dv-stat" *ngFor="let t of tiles" [attr.data-level]="t.level">
        <span>{{ t.label }}</span>
        <strong>{{ t.value }}</strong>
        <small>{{ t.sub }}</small>
        <em class="dv-badge" *ngIf="t.level !== 'none'">{{ t.level === 'good' ? '✓ Healthy' : t.level === 'warning' ? '⚠ High' : '⛔ Too high' }}</em>
      </div>
      <div class="dv-stat" data-level="none">
        <span>Gmail domain reputation</span>
        <strong class="dv-na">Not available</strong>
        <small>Only in <a href="https://postmaster.google.com" target="_blank" rel="noopener">Google Postmaster Tools</a>: verify your sending domain there to see it.</small>
      </div>
    </div>

    <section class="dv-card">
      <h3>Engagement <small class="dv-muted">tracked by Marketech.ai, of delivered emails</small></h3>
      <div class="dv-stats">
        <div class="dv-stat" data-level="none"><span>Unique opens</span><strong>{{ d.totals.opened }}</strong><small>Open rate {{ fmt(d.rates.open) }}</small></div>
        <div class="dv-stat" data-level="none"><span>Unique clicks</span><strong>{{ d.totals.clicked }}</strong><small>Clicked a link at least once</small></div>
        <div class="dv-stat" data-level="none"><span>Click-through rate</span><strong>{{ fmt(d.rates.clickThrough) }}</strong><small>Unique clicks ÷ delivered</small></div>
      </div>
      <p class="dv-note">Opens are counted only when the email's images load: Gmail, Outlook and company mail systems often hide images until the reader allows them (and never load them in spam), so real opens are missed; Apple Mail can load them without anyone reading. Clicks are the more reliable signal. A click is never counted as an open.</p>
    </section>

    <figure class="dv-card">
      <figcaption><strong>Emails accepted by Amazon SES per day</strong><span class="dv-muted">Hover a day for delivered, bounces and complaints</span></figcaption>
      <p class="dv-muted" *ngIf="!d.totals.sent">No campaign emails were sent in this period.</p>
      <ng-container *ngIf="d.totals.sent">
        <div class="dv-plot" *ngIf="!showTable" (mouseleave)="hover = null">
          <div class="dv-grid" aria-hidden="true">
            <span [style.bottom.%]="100"><em>{{ yMax }}</em></span>
            <span [style.bottom.%]="50"><em>{{ yMax / 2 }}</em></span>
            <span class="base" [style.bottom.%]="0"><em>0</em></span>
          </div>
          <div class="dv-cols" [class.dense]="d.daily.length > 40">
            <div class="dv-col" *ngFor="let x of d.daily; let i = index" tabindex="0" [class.on]="hover === i"
                 [attr.aria-label]="short(x.day) + ': ' + x.sent + ' sent, ' + x.delivered + ' delivered, ' + x.bounced + ' bounced, ' + x.complaints + ' complaints'"
                 (mouseenter)="hover = i" (focus)="hover = i" (blur)="hover = null">
              <div class="dv-bar" *ngIf="x.sent" [style.height.%]="pct(x.sent)"></div>
            </div>
          </div>
          <div class="dv-tip" *ngIf="hover !== null && d.daily[hover]" [style.left.%]="left(hover)" [class.l]="left(hover) < 20" [class.r]="left(hover) > 80" role="status">
            <strong>{{ short(d.daily[hover].day) }}</strong>
            <span>Sent <b>{{ d.daily[hover].sent }}</b></span>
            <span>Delivered <b>{{ d.daily[hover].delivered }}</b></span>
            <span>Hard bounced <b>{{ d.daily[hover].bounced }}</b></span>
            <span>Complaints <b>{{ d.daily[hover].complaints }}</b></span>
          </div>
          <div class="dv-x" aria-hidden="true"><span *ngFor="let l of xLabels" [style.left.%]="left(l.i)">{{ l.text }}</span></div>
        </div>
        <div class="dv-table-wrap" *ngIf="showTable">
          <table class="dv-table">
            <thead><tr><th>Day</th><th>Sent</th><th>Delivered</th><th>Hard bounced</th><th>Complaints</th></tr></thead>
            <tbody><tr *ngFor="let x of activeDays"><td>{{ short(x.day) }}</td><td>{{ x.sent }}</td><td>{{ x.delivered }}</td><td>{{ x.bounced }}</td><td>{{ x.complaints }}</td></tr></tbody>
          </table>
        </div>
      </ng-container>
    </figure>

    <div class="dv-two">
      <section class="dv-card">
        <h3>By mailbox provider</h3>
        <p class="dv-muted" *ngIf="!d.receivers.length">No data yet.</p>
        <div class="dv-table-wrap" *ngIf="d.receivers.length">
          <table class="dv-table">
            <thead><tr><th>Provider</th><th>Sent</th><th>Delivered</th><th>Bounces</th><th>Complaints</th><th>Opened</th></tr></thead>
            <tbody>
              <tr *ngFor="let r of d.receivers">
                <td>{{ r.receiver }}</td><td>{{ r.sent }}</td><td>{{ fmt(r.deliveryRate) }}</td><td>{{ fmt(r.bounceRate) }}</td><td>{{ fmt(r.complaintRate) }}</td><td>{{ fmt(r.openRate) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="dv-note">Low opens at one provider with normal delivery usually means the email goes to spam there.</p>
      </section>

      <section class="dv-card">
        <h3>Warm-up of sender domains</h3>
        <p class="dv-muted" *ngIf="!d.warmups.length">No campaign sender yet.</p>
        <div class="dv-warm" *ngFor="let w of d.warmups">
          <div class="dv-warm-head"><b>{{ w.domain }}</b>
            <span *ngIf="!w.enabled">Warm-up off</span>
            <span *ngIf="w.enabled && w.cap === null">✓ Warmed up</span>
            <span *ngIf="w.enabled && w.cap !== null">Day {{ w.day }}: up to {{ w.cap }} emails in 24 hours</span>
          </div>
          <div class="dv-meter" *ngIf="w.enabled && w.cap !== null" role="meter" [attr.aria-valuenow]="w.sentLast24h" aria-valuemin="0" [attr.aria-valuemax]="w.cap" [attr.aria-label]="w.domain + ' warm-up used'">
            <div [style.width.%]="meter(w)"></div>
          </div>
          <small class="dv-muted" *ngIf="w.enabled && w.cap !== null">{{ w.sentLast24h }} sent in the last 24 hours, {{ w.remaining }} left.{{ w.resumeAt ? ' More from ' + (w.resumeAt | date:'medium') + '.' : '' }}</small>
        </div>
        <p class="dv-note">New domains send a little more each day (50, 100, 200, …) so Gmail and others learn to trust them. Campaigns over today's limit continue by themselves.</p>
      </section>
    </div>

    <p class="dv-note">{{ d.note }} Hard-bounced, complaining and unsubscribed addresses (and addresses that keep soft-bouncing) are added to the stop-list and never emailed again.</p>
  </ng-container>
</section>
`
})
export class DeliverabilityComponent implements OnInit {
  @Output() openSettings = new EventEmitter<void>();
  readonly ranges = [7, 30, 90];
  days = 30;
  d: any = null;
  loading = false;
  error: string | null = null;
  hover: number | null = null;
  showTable = false;

  constructor(private http: HttpClient) {}

  ngOnInit(): void { this.load(); }

  setRange(r: number): void { this.days = r; this.load(); }

  load(): void {
    this.loading = true;
    this.error = null;
    this.http.get<any>(`/api/v1/mail/ses/deliverability?days=${this.days}`).subscribe({
      next: r => { this.loading = false; this.d = r; this.hover = null; },
      error: e => { this.loading = false; this.error = e?.error?.error || 'Could not load deliverability.'; }
    });
  }

  /** Headline rates, each with the level it is at (SES's review/pause levels for bounces and complaints). */
  get tiles(): { label: string; value: string; sub: string; level: Level }[] {
    const d = this.d;
    if (!d) return [];
    const t = d.totals, r = d.rates, th = d.health.thresholds;
    const lvl = (v: number | null, warn: number, stop: number): Level => (v === null ? 'none' : v >= stop ? 'critical' : v >= warn ? 'warning' : 'good');
    return [
      { label: 'Delivery rate', value: this.fmt(r.delivery), sub: `${t.delivered} of ${t.sent} sent reached the mail server (inbox or spam)`, level: 'none' },
      { label: 'Bounce rate', value: this.fmt(r.bounce), sub: `${t.hardBounces} hard, ${t.softBounces} soft. Keep under ${th.bounceWarn}%`, level: lvl(r.bounce, th.bounceWarn, th.bounceStop) },
      { label: 'Complaint rate', value: this.fmt(r.complaint), sub: `${t.complaints} marked as spam. Keep under ${th.complaintWarn}%`, level: lvl(r.complaint, th.complaintWarn, th.complaintStop) },
      { label: 'Unsubscribe rate', value: this.fmt(r.unsubscribe), sub: `${t.unsubscribes} unsubscribed`, level: 'none' },
      { label: 'SES rejection rate', value: this.fmt(r.rejection), sub: `${t.rejected} of ${t.attempted} not accepted by Amazon SES`, level: 'none' }
    ];
  }

  get yMax(): number {
    const m = Math.max(1, ...(this.d?.daily || []).map((x: any) => x.sent));
    const step = Math.pow(10, Math.floor(Math.log10(m)));
    return Math.ceil(m / step / 2) * step * 2;
  }
  get activeDays(): any[] { return (this.d?.daily || []).filter((x: any) => x.sent); }
  get xLabels(): { i: number; text: string }[] {
    const n = this.d?.daily?.length || 0;
    if (!n) return [];
    const idx = [...new Set([0, Math.floor((n - 1) / 2), n - 1])];
    return idx.map(i => ({ i, text: this.short(this.d.daily[i].day) }));
  }
  pct(v: number): number { return (v / this.yMax) * 100; }
  left(i: number): number { const n = this.d?.daily?.length || 1; return ((i + 0.5) / n) * 100; }
  meter(w: any): number { return w.cap ? Math.min(100, (w.sentLast24h / w.cap) * 100) : 0; }
  fmt(v: number | null): string { return v === null || v === undefined ? '—' : `${v}%`; }
  short(day: string): string {
    const dt = new Date(`${day}T00:00:00Z`);
    return isNaN(dt.getTime()) ? day : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
}
