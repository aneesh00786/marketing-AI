import { Component, EventEmitter, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CommandApiService } from './command-api.service';
import { OutreachComponent } from '../outreach/outreach.component';
import { AbTestsComponent } from '../abtests/ab-tests.component';
import { AutomationsComponent } from '../automation/automations.component';
import { CampaignAnalyticsComponent } from '../campaignAnalytics/campaign-analytics.component';

type Area = 'campaigns' | 'email' | 'abtests' | 'automations' | 'analytics';
type View = 'list' | 'new' | 'detail';
type Step = 'strategist' | 'audience' | 'build' | 'overview';

const CHANNEL_LABELS: Record<string, string> = { email: 'Email', linkedin: 'LinkedIn', facebook: 'Facebook', instagram: 'Instagram', youtube: 'YouTube', x: 'X' };

/**
 * AI Campaigns · Campaign Command Center.
 * Strategist (AI brief from verified facts) → Audience (real CRM leads) → Builder (creates the
 * email sequence and the Social Media Marketing campaign) → Overview (approvals, schedule,
 * failures, real metrics). Sending and publishing keep their own approvals in those modules.
 */
@Component({
  selector: 'app-command-center',
  standalone: true,
  imports: [CommonModule, FormsModule, OutreachComponent, AbTestsComponent, AutomationsComponent, CampaignAnalyticsComponent],
  templateUrl: './command-center.component.html',
  styleUrls: ['./command-center.component.css']
})
export class CommandCenterComponent implements OnInit {
  @Output() toast = new EventEmitter<string>();
  @Output() openPlaybooks = new EventEmitter<void>();
  @Output() openMailSettings = new EventEmitter<void>();
  @Output() openSocialCampaign = new EventEmitter<number>();

  readonly channelKeys = Object.keys(CHANNEL_LABELS);
  readonly channelLabels = CHANNEL_LABELS;
  readonly tones = ['Professional', 'Friendly', 'Direct', 'Consultative'];
  readonly currencies = ['USD', 'EUR', 'GBP', 'INR', 'AED', 'AUD', 'CAD', 'SGD'];

  area: Area = 'campaigns';
  emailCampaignToOpen: number | null = null;
  view: View = 'list';
  step: Step = 'strategist';
  busy = '';
  error = '';

  programs: any[] = [];
  products: any[] = [];
  leadStatuses: string[] = [];
  kpiMetrics: Record<string, string> = {};
  program: any = null;
  overview: any = null;
  acknowledgeFlags = false;

  form = this.blankForm();
  briefEdit: any = null;
  editingBrief = false;

  audienceFilter = { statuses: [] as string[], minScore: null as number | null, anyProduct: false };
  audience: any[] = [];
  audienceSelected = new Set<number>();
  audienceLoaded = false;
  buildResult: any = null;

  constructor(private api: CommandApiService) {}

  ngOnInit(): void {
    this.loadPrograms();
    this.api.meta().subscribe({ next: r => this.kpiMetrics = r.kpiMetrics || {}, error: () => {} });
    this.api.products().subscribe({ next: r => this.products = r.products || [], error: () => this.products = [] });
    this.api.leadStatuses().subscribe({ next: r => this.leadStatuses = r.statuses || [], error: () => this.leadStatuses = [] });
  }

  private blankForm() {
    return { name: '', productId: null as number | null, goal: '', targetAudience: '', tone: 'Professional', channels: ['email', 'linkedin'] as string[],
      budgetAmount: null as number | null, budgetCurrency: 'USD', budgetNote: '', startDate: '', endDate: '' };
  }

  private err(e: any): string { return e?.error?.error || e?.message || 'Request failed'; }

  // ------------------------------------------------------------ areas & list
  showArea(a: Area, emailCampaignId: number | null = null): void {
    this.emailCampaignToOpen = emailCampaignId;
    this.area = a;
    this.error = '';
    if (a === 'campaigns') this.loadPrograms();
  }

  loadPrograms(): void {
    this.api.programs().subscribe({ next: r => this.programs = r.programs || [], error: e => this.error = this.err(e) });
  }

  startNew(): void {
    this.form = this.blankForm();
    this.view = 'new';
    this.error = '';
  }

  toggleChannel(c: string): void {
    this.form.channels = this.form.channels.includes(c) ? this.form.channels.filter(x => x !== c) : [...this.form.channels, c];
  }

  create(): void {
    if (!this.form.name.trim()) { this.error = 'Give the campaign a name.'; return; }
    if (!this.form.channels.length) { this.error = 'Choose at least one channel.'; return; }
    const f = this.form;
    const body: any = {
      name: f.name.trim(), productId: f.productId, goal: f.goal.trim() || null, targetAudience: f.targetAudience.trim() || null, tone: f.tone, channels: f.channels,
      budgetAmount: f.budgetAmount === null || (f.budgetAmount as any) === '' ? null : Number(f.budgetAmount), budgetCurrency: f.budgetAmount ? f.budgetCurrency : null,
      budgetNote: f.budgetNote.trim() || null, startDate: f.startDate || null, endDate: f.endDate || null
    };
    this.busy = 'create';
    this.api.create(body).subscribe({
      next: r => { this.busy = ''; this.toast.emit('Campaign created. Next: generate the strategy brief.'); this.open(r.program.id, 'strategist'); this.loadPrograms(); },
      error: e => { this.busy = ''; this.error = this.err(e); }
    });
  }

  open(id: number, step?: Step): void {
    this.view = 'detail';
    this.error = '';
    this.buildResult = null;
    this.audience = [];
    this.audienceLoaded = false;
    this.editingBrief = false;
    this.acknowledgeFlags = false;
    this.api.program(id).subscribe({
      next: r => {
        this.program = r.program;
        this.setStep(step || this.defaultStep(r.program));
      },
      error: e => this.error = this.err(e)
    });
  }

  defaultStep(p: any): Step {
    if (p.status === 'built' || p.status === 'archived') return 'overview';
    if (p.status === 'approved') return p.leadIds?.length ? 'build' : 'audience';
    return 'strategist';
  }

  back(): void {
    this.view = 'list';
    this.program = null;
    this.overview = null;
    this.loadPrograms();
  }

  setStep(s: Step): void {
    this.step = s;
    this.error = '';
    if (s === 'audience' && !this.audienceLoaded) this.previewAudience();
    if (s === 'overview') this.loadOverview();
  }

  get briefLocked(): boolean { return !this.program || !['draft', 'brief_ready'].includes(this.program.status); }

  // ------------------------------------------------------------ strategist
  generateBrief(): void {
    if (this.program.brief && !confirm('Replace the current brief with a new AI-written one?')) return;
    this.busy = 'brief';
    this.error = '';
    this.api.generateBrief(this.program.id).subscribe({
      next: r => { this.busy = ''; this.program = r.program; this.editingBrief = false; this.toast.emit('Brief written by AI. Review it before approving.'); },
      error: e => { this.busy = ''; this.error = e?.error?.code === 'AI_UNAVAILABLE' || e?.status === 503 ? `AI is unavailable, so no brief was generated. ${this.err(e)}` : this.err(e); }
    });
  }

  startEditBrief(): void {
    const b = this.program.brief;
    this.briefEdit = {
      objectives: b.objectives.join('\n'),
      audienceSummary: b.audience.summary,
      segments: (b.audience.segments || []).join('\n'),
      valueProposition: b.messaging.value_proposition,
      keyMessages: b.messaging.key_messages.join('\n'),
      proofPoints: (b.messaging.proof_points || []).join('\n'),
      cta: b.messaging.call_to_action || '',
      kpis: b.kpis.map((k: any) => ({ ...k, target: k.target || '' }))
    };
    this.editingBrief = true;
  }

  saveBrief(): void {
    const lines = (t: string) => String(t || '').split('\n').map(x => x.trim()).filter(Boolean);
    const e = this.briefEdit;
    const brief = {
      ...this.program.brief,
      objectives: lines(e.objectives),
      audience: { summary: e.audienceSummary.trim(), segments: lines(e.segments) },
      messaging: { value_proposition: e.valueProposition.trim(), key_messages: lines(e.keyMessages), proof_points: lines(e.proofPoints), call_to_action: e.cta.trim() },
      kpis: e.kpis.map((k: any) => ({ metric: k.metric, name: k.name, why: k.why || '', target: String(k.target || '').trim() || null }))
    };
    if (!brief.objectives.length || !brief.messaging.key_messages.length || !brief.audience.summary || !brief.messaging.value_proposition) {
      this.error = 'Objectives, audience, value proposition and at least one key message are required.';
      return;
    }
    this.busy = 'saveBrief';
    this.api.saveBrief(this.program.id, brief).subscribe({
      next: r => { this.busy = ''; this.program = r.program; this.editingBrief = false; this.toast.emit('Brief saved.'); },
      error: x => { this.busy = ''; this.error = this.err(x); }
    });
  }

  approveBrief(): void {
    if (!confirm('Approve this brief? It becomes the plan the email sequence and social posts are built from.')) return;
    this.busy = 'approve';
    this.api.approveBrief(this.program.id, this.acknowledgeFlags).subscribe({
      next: r => { this.busy = ''; this.program = r.program; this.toast.emit('Brief approved. Next: choose the audience.'); this.setStep('audience'); },
      error: e => { this.busy = ''; this.error = this.err(e); }
    });
  }

  phaseWidth(ph: any): number {
    const total = Math.max(...(this.program?.brief?.timeline || []).map((t: any) => t.end_day), 1);
    return Math.max(4, ((ph.end_day - ph.start_day + 1) / (total + 1)) * 100);
  }

  phaseOffset(ph: any): number {
    const total = Math.max(...(this.program?.brief?.timeline || []).map((t: any) => t.end_day), 1);
    return (ph.start_day / (total + 1)) * 100;
  }

  // ------------------------------------------------------------ audience
  toggleStatus(s: string): void {
    const set = new Set(this.audienceFilter.statuses);
    set.has(s) ? set.delete(s) : set.add(s);
    this.audienceFilter.statuses = [...set];
  }

  private currentFilter(): any {
    const f: any = {};
    if (this.audienceFilter.statuses.length) f.statuses = this.audienceFilter.statuses;
    if (this.audienceFilter.minScore !== null && String(this.audienceFilter.minScore) !== '') f.minScore = Number(this.audienceFilter.minScore);
    if (this.audienceFilter.anyProduct) f.productId = null;
    return f;
  }

  previewAudience(): void {
    this.busy = 'audience';
    this.api.previewAudience(this.program.id, this.currentFilter()).subscribe({
      next: r => {
        this.busy = '';
        this.audienceLoaded = true;
        // Eligible leads first, then excluded ones with their reason.
        this.audience = [...(r.audience || [])].sort((a: any, b: any) => Number(b.eligible) - Number(a.eligible));
        const saved = new Set<number>(this.program.leadIds || []);
        this.audienceSelected = new Set(this.audience.filter(a => a.eligible && (saved.size ? saved.has(a.leadId) : true)).map(a => a.leadId));
      },
      error: e => { this.busy = ''; this.error = this.err(e); }
    });
  }

  toggleLead(id: number): void {
    this.audienceSelected.has(id) ? this.audienceSelected.delete(id) : this.audienceSelected.add(id);
  }

  saveAudience(): void {
    this.busy = 'saveAudience';
    this.api.saveAudience(this.program.id, [...this.audienceSelected], this.currentFilter()).subscribe({
      next: r => { this.busy = ''; this.program = r.program; this.toast.emit(`Audience saved: ${r.saved} lead(s).`); },
      error: e => { this.busy = ''; this.error = this.err(e); }
    });
  }

  // ------------------------------------------------------------ build
  get hasEmail(): boolean { return (this.program?.channels || []).includes('email'); }
  get socialChannels(): string[] { return (this.program?.channels || []).filter((c: string) => c !== 'email'); }

  build(): void {
    const parts = [this.hasEmail ? `an email sequence for ${this.program.leadIds.length} lead(s)` : null, this.socialChannels.length ? `social posts for ${this.socialChannels.map(c => CHANNEL_LABELS[c]).join(', ')}` : null].filter(Boolean);
    if (!confirm(`Build ${parts.join(' and ')}?\n\nAI writes the content now. Nothing is sent or published until you approve it in the email sequence and in Social Media Marketing.`)) return;
    this.busy = 'build';
    this.error = '';
    this.api.build(this.program.id).subscribe({
      next: r => { this.busy = ''; this.program = r.program; this.buildResult = r.result; this.toast.emit(r.program.lastError ? 'Built with problems; see below.' : 'Campaign built. Review and approve the content.'); },
      error: e => { this.busy = ''; this.error = this.err(e); }
    });
  }

  // ------------------------------------------------------------ overview
  loadOverview(): void {
    if (!this.program) return;
    this.api.overview(this.program.id).subscribe({ next: r => this.overview = r, error: e => this.error = this.err(e) });
  }

  goApproval(a: any): void {
    if (a.action === 'brief') this.setStep('strategist');
    if (a.action === 'email' && this.program.emailCampaignId) this.showArea('email', this.program.emailCampaignId);
    if (a.action === 'social' && this.program.socialCampaignId) this.openSocialCampaign.emit(this.program.socialCampaignId);
  }

  archive(): void {
    if (!confirm(`Archive "${this.program.name}"? The email sequence and social campaign are not changed.`)) return;
    this.api.archive(this.program.id).subscribe({ next: r => { this.program = r.program; this.toast.emit('Campaign archived.'); }, error: e => this.error = this.err(e) });
  }

  remove(): void {
    if (!confirm(`Delete "${this.program.name}"?`)) return;
    this.api.remove(this.program.id).subscribe({ next: () => { this.toast.emit('Campaign deleted.'); this.back(); }, error: e => this.error = this.err(e) });
  }

  // ------------------------------------------------------------ helpers
  productName(id: number | null): string {
    if (!id) return 'No product';
    return this.products.find(p => p.id === id)?.name || 'Product removed';
  }

  statusLabel(s: string): string {
    return ({ draft: 'Draft', brief_ready: 'Brief ready', approved: 'Brief approved', built: 'Built', archived: 'Archived' } as any)[s] || s;
  }

  fmtMetric(v: any, unit: string): string {
    if (v === null || v === undefined) return '—';
    return `${v}${unit || ''}`;
  }

  stepDone(s: Step): boolean {
    const p = this.program;
    if (!p) return false;
    if (s === 'strategist') return ['approved', 'built', 'archived'].includes(p.status);
    if (s === 'audience') return (p.leadIds || []).length > 0 || !this.hasEmail;
    if (s === 'build') return p.status === 'built' || p.status === 'archived';
    return false;
  }
}
