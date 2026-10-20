import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { apiRoot } from '../../core/api-base';
import { LineChartComponent, LinePoint } from '../../shared/charts/line-chart.component';

interface Metric { value: any; status: 'available' | 'partial' | 'unavailable' | 'estimate'; reason?: string; basis?: string; method?: string; smallSample?: boolean; numerator?: number; denominator?: number; note?: string }

/**
 * AI Campaigns analytics: email, social and CRM results side by side. Every number shows its
 * status: a real value (0 is a real zero), partial, unavailable (with the reason) or an
 * estimate (attribution only). Revenue and ROI are never shown as numbers.
 */
@Component({
  selector: 'app-campaign-analytics',
  standalone: true,
  imports: [CommonModule, FormsModule, LineChartComponent],
  templateUrl: './campaign-analytics.component.html',
  styleUrls: ['../command/command-center.component.css', './campaign-analytics.component.css']
})
export class CampaignAnalyticsComponent implements OnInit {
  private base = `${apiRoot()}/api/v1/campaign-analytics`;
  range = '30';
  conversionStatus = 'Won';
  lookbackDays = 30;
  loading = false;
  error = '';
  data: any = null;
  recs: any = null;
  recsBusy = false;
  recsError = '';
  trendKey = 'emailsSent';
  readonly trendOptions = [
    { key: 'emailsSent', label: 'Emails sent' },
    { key: 'replies', label: 'Replies' },
    { key: 'postsPublished', label: 'Posts published' },
    { key: 'engagements', label: 'Social engagements' },
    { key: 'leadsCreated', label: 'Leads created' },
    { key: 'conversions', label: 'Conversions' }
  ];

  constructor(private http: HttpClient) {}

  ngOnInit(): void { this.load(); }

  private err(e: any): string { return e?.error?.error || e?.message || 'Request failed'; }

  load(): void {
    this.loading = true;
    this.error = '';
    this.recs = null;
    this.http.get<any>(`${this.base}/overview`, { params: { range: this.range, conversionStatus: this.conversionStatus, lookbackDays: String(this.lookbackDays) } }).subscribe({
      next: r => { this.loading = false; this.data = r; },
      error: e => { this.loading = false; this.error = this.err(e); }
    });
  }

  recommend(): void {
    this.recsBusy = true;
    this.recsError = '';
    this.http.post<any>(`${this.base}/recommendations`, { range: this.range, conversionStatus: this.conversionStatus, lookbackDays: String(this.lookbackDays) }).subscribe({
      next: r => { this.recsBusy = false; this.recs = r; },
      error: e => { this.recsBusy = false; this.recsError = e?.status === 503 ? `AI is unavailable, so no recommendations were generated. ${this.err(e)}` : this.err(e); }
    });
  }

  // ------------------------------------------------------------ display helpers
  fmt(m: Metric | null | undefined, kind: 'count' | 'rate' = 'count'): string {
    if (!m || m.status === 'unavailable' || m.value === null || m.value === undefined) return '—';
    if (kind === 'rate') return `${(Number(m.value) * 100).toFixed(1)}%`;
    return Number(m.value).toLocaleString();
  }

  tip(m: Metric | null | undefined): string {
    if (!m) return '';
    if (m.status === 'unavailable') return m.reason || 'Not available';
    const parts: string[] = [];
    if (m.numerator !== undefined && m.denominator !== undefined) parts.push(`${m.numerator} of ${m.denominator}`);
    if (m.basis) parts.push(m.basis);
    if (m.smallSample) parts.push('small sample (under 30)');
    if (m.method) parts.push(m.method);
    if (m.note) parts.push(m.note);
    return parts.join(' · ');
  }

  get trendPoints(): LinePoint[] {
    const s = this.data?.trends?.series?.[this.trendKey];
    if (!Array.isArray(s)) return [];
    return this.data.trends.days.map((d: string, i: number) => ({ label: d.slice(5), value: s[i] }));
  }

  get trendUnavailable(): string | null {
    const s = this.data?.trends?.series?.[this.trendKey];
    return s && !Array.isArray(s) ? s.unavailable : null;
  }

  statusEntries(): [string, number][] {
    return Object.entries(this.data?.channels?.crm?.statusSnapshot || {}) as [string, number][];
  }

  attributed(id: number): Metric | null { return this.data?.attribution?.email?.[id] || null; }
  evidenceKeys(r: any): string[] { return r.evidence || []; }
}
