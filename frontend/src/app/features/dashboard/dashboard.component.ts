import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SocialApiService } from '../social/social-api.service';
import { IconComponent } from '../../shared/icon.component';
import { LineChartComponent, LinePoint, compact } from '../../shared/charts/line-chart.component';
import { BarChartComponent, BarItem } from '../../shared/charts/bar-chart.component';
import { DonutChartComponent, DonutSegment } from '../../shared/charts/donut-chart.component';

export interface DashboardNavigation {
  route: 'social' | 'leads' | 'products' | 'emails' | 'drafts' | 'businesses' | 'voice' | 'appointments';
  section?: string;
  campaignId?: number;
  status?: string;
}

type SeriesMetric = 'reach' | 'impressions' | 'engagements' | 'clicks' | 'leads';
type CompareMetric = 'reach' | 'engagements' | 'clicks';

const PLATFORM_LABELS: Record<string, string> = { facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn', youtube: 'YouTube', x: 'X' };
const POST_STATUSES: { key: string; label: string; color: string }[] = [
  { key: 'draft', label: 'Draft', color: 'var(--chart-6)' },
  { key: 'review', label: 'In review', color: 'var(--chart-4)' },
  { key: 'approved', label: 'Approved', color: 'var(--chart-2)' },
  { key: 'scheduled', label: 'Scheduled', color: 'var(--chart-3)' },
  { key: 'published', label: 'Published', color: 'var(--chart-1)' },
  { key: 'failed', label: 'Failed', color: 'var(--danger)' },
  { key: 'rejected', label: 'Rejected', color: 'var(--chart-5)' },
  { key: 'cancelled', label: 'Cancelled', color: 'var(--border-strong)' }
];

/** AI Marketing Command Center: an eagle-eye view built only from stored, workspace-scoped data. */
@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, LineChartComponent, BarChartComponent, DonutChartComponent],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.css']
})
export class DashboardComponent implements OnInit {
  @Output() navigate = new EventEmitter<DashboardNavigation>();
  /** Roger "always listening" switch state, owned by the app shell (which runs the voice session). */
  @Input() voiceOn = false;
  @Input() voiceLive = false;
  @Input() voiceBusy = false;
  @Input() voiceStatus = 'Off';
  @Output() voiceToggle = new EventEmitter<boolean>();

  readonly ranges = [{ key: '7', label: '7 days' }, { key: '30', label: '30 days' }, { key: '90', label: '90 days' }, { key: 'custom', label: 'Custom' }];
  readonly seriesMetrics: { key: SeriesMetric; label: string; color: string }[] = [
    { key: 'reach', label: 'Reach', color: 'var(--chart-1)' },
    { key: 'impressions', label: 'Impressions', color: 'var(--chart-2)' },
    { key: 'engagements', label: 'Engagements', color: 'var(--chart-3)' },
    { key: 'clicks', label: 'Clicks', color: 'var(--chart-4)' },
    { key: 'leads', label: 'Leads', color: 'var(--chart-5)' }
  ];
  readonly compareMetrics: { key: CompareMetric; label: string }[] = [
    { key: 'engagements', label: 'Engagements' }, { key: 'reach', label: 'Reach' }, { key: 'clicks', label: 'Clicks' }
  ];
  readonly platformLabels = PLATFORM_LABELS;
  readonly compact = compact;

  range = '30';
  customFrom = this.isoDay(-30);
  customTo = this.isoDay(0);
  loading = true;
  error: string | null = null;
  data: any = null;

  seriesMetric: SeriesMetric = 'engagements';
  compareMetric: CompareMetric = 'engagements';
  platformMetric: CompareMetric = 'engagements';

  linePoints: LinePoint[] = [];
  campaignBars: BarItem[] = [];
  platformBars: BarItem[] = [];
  statusSegments: DonutSegment[] = [];

  constructor(private api: SocialApiService) {}

  ngOnInit(): void {
    try { this.range = localStorage.getItem('tradesage_dash_range') || '30'; } catch { this.range = '30'; }
    if (this.range === 'custom') this.range = '30';
    this.load();
  }

  private isoDay(offset: number): string {
    return new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
  }

  setRange(key: string): void {
    this.range = key;
    if (key !== 'custom') {
      try { localStorage.setItem('tradesage_dash_range', key); } catch { /* ignore */ }
      this.load();
    }
  }

  applyCustom(): void {
    if (!this.customFrom || !this.customTo || this.customFrom > this.customTo) {
      this.error = 'Choose a start date on or before the end date.';
      return;
    }
    this.load();
  }

  load(): void {
    this.loading = true;
    this.error = null;
    const params = this.range === 'custom'
      ? { from: new Date(`${this.customFrom}T00:00:00`).toISOString(), to: new Date(`${this.customTo}T23:59:59`).toISOString() }
      : { range: this.range };
    this.api.dashboard(params).subscribe({
      next: r => { this.data = r.dashboard; this.loading = false; this.rebuild(); },
      error: e => { this.loading = false; this.error = e?.error?.error || 'The dashboard could not be loaded.'; }
    });
  }

  rebuild(): void {
    if (!this.data) return;
    const d = this.data;
    const m = this.seriesMetric;
    this.linePoints = d.series.map((p: any) => ({
      label: p.date,
      value: m === 'leads' ? p.leads : p[m],
      note: m === 'leads' ? `${p.leads} lead${p.leads === 1 ? '' : 's'} created` : (p.posts ? `${p.posts} post${p.posts === 1 ? '' : 's'} published` : 'No posts published')
    }));
    this.campaignBars = d.campaigns
      .filter((c: any) => c.publishedInRange > 0)
      .map((c: any) => ({ id: c.id, label: c.name, sublabel: `${c.publishedInRange} post${c.publishedInRange === 1 ? '' : 's'} · ${c.platforms.map((p: string) => PLATFORM_LABELS[p] || p).join(', ') || 'no platform'}`, value: c.metrics[this.compareMetric] }))
      .sort((a: BarItem, b: BarItem) => (b.value ?? -1) - (a.value ?? -1))
      .slice(0, 8);
    this.platformBars = d.platforms
      .filter((p: any) => p.connected)
      .map((p: any) => ({ id: p.key, label: PLATFORM_LABELS[p.key], sublabel: `${p.posts} post${p.posts === 1 ? '' : 's'}`, value: p[this.platformMetric], unavailableText: p.posts ? 'Not reported' : 'No posts in range' }));
    this.statusSegments = POST_STATUSES.map(s => ({ ...s, value: d.postStatus[s.key] || 0 })).filter(s => s.value > 0 || ['draft', 'review', 'approved', 'scheduled', 'published', 'failed'].includes(s.key));
  }

  get activeSeries() {
    return this.seriesMetrics.find(s => s.key === this.seriesMetric)!;
  }

  get seriesTotal(): number | null {
    const vals = this.linePoints.map(p => p.value).filter((v): v is number => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  }

  // ---------- Formatting ----------
  num(v: number | null | undefined): string {
    return v === null || v === undefined ? '—' : Number(v).toLocaleString();
  }

  rangeLabel(): string {
    if (!this.data) return '';
    const f = new Date(this.data.range.from);
    const t = new Date(this.data.range.to);
    const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: f.getFullYear() !== t.getFullYear() ? 'numeric' : undefined };
    return `${f.toLocaleDateString(undefined, opts)} – ${t.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }

  coverage(k: any): string {
    if (!k?.coverage) return '';
    const { available, total } = k.coverage;
    if (!total) return 'No published posts in range';
    if (available === 0) return 'Not reported by the platforms';
    if (available === total) return total === 1 ? 'From 1 post' : `All ${total} posts`;
    return `Reported for ${available} of ${total} posts`;
  }

  changeText(change: any, suffix = ''): string {
    if (!change) return '';
    if (change.pct === null) return `+${compact(change.delta)}${suffix} (new)`;
    return `${change.pct > 0 ? '+' : ''}${change.pct}%`;
  }

  changeClass(change: any): string {
    if (!change) return '';
    if (change.delta > 0) return 'up';
    if (change.delta < 0) return 'down';
    return 'flat';
  }

  fmtDate(v: any, withTime = true): string {
    if (!v) return '—';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v).slice(0, 10);
    return d.toLocaleString(undefined, { timeZone: this.data?.range?.timezone || undefined, month: 'short', day: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) });
  }

  statusTone(status: string): string {
    return ({ Active: 'ok', Running: 'ok', Completed: 'info', Paused: 'warn', Draft: 'muted', Archived: 'muted' } as any)[status] || 'muted';
  }

  platformLabel(key: string): string {
    return PLATFORM_LABELS[key] || key;
  }

  // ---------- Navigation ----------
  go(nav: DashboardNavigation): void {
    this.navigate.emit(nav);
  }

  openInsight(link: any): void {
    if (!link) return;
    if (link.anchor) {
      document.getElementById(`dash-${link.anchor}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    this.go({ route: link.route, section: link.section, status: link.status });
  }

  openStatus(key: string): void {
    this.go({ route: 'social', section: key === 'scheduled' ? 'calendar' : (key === 'failed' ? 'queue' : 'library'), status: key });
  }

  openCampaign(id: number): void {
    this.go({ route: 'social', section: 'campaigns', campaignId: id });
  }

  onCampaignBar(b: BarItem): void {
    this.openCampaign(b.id);
  }

  onPlatformBar(): void {
    this.go({ route: 'social', section: 'analytics' });
  }

  trackById(_: number, item: any): any {
    return item.id;
  }
}
