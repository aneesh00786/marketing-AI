import { Component, EventEmitter, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { OutreachApiService } from './outreach-api.service';

type View = 'list' | 'new' | 'detail';
type Tab = 'sequence' | 'audience' | 'launch' | 'results';

interface StepDraft { delayDays: number; subject: string; body: string; needsVerification?: string[] }

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * AI Campaigns: email outreach campaigns. Build a sequence with AI from verified product
 * facts, choose leads, approve once, and the background worker sends inside the sending
 * window. Results show only real outcomes (sent, replied, bounced, unsubscribed, failed).
 */
@Component({
  selector: 'app-outreach',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './outreach.component.html',
  styleUrls: ['./outreach.component.css']
})
export class OutreachComponent implements OnInit, OnDestroy {
  @Input() playbooksAvailable = true;
  /** Opens this email sequence directly (e.g. from the Command Center). */
  @Input() initialCampaignId: number | null = null;
  @Output() toast = new EventEmitter<string>();
  @Output() openPlaybooks = new EventEmitter<void>();
  @Output() openMailSettings = new EventEmitter<void>();

  readonly dayNames = DAY_NAMES;
  readonly hours = Array.from({ length: 25 }, (_, i) => i);
  readonly tones = ['Professional', 'Friendly', 'Direct', 'Consultative'];

  view: View = 'list';
  tab: Tab = 'sequence';
  loading = false;
  busy = '';
  error = '';

  status: any = null;
  campaigns: any[] = [];
  products: any[] = [];
  leadStatuses: string[] = [];
  campaign: any = null;
  steps: StepDraft[] = [];
  stepsDirty = false;
  stepCount = 3;

  form = this.blankForm();

  audienceFilter = { statuses: [] as string[], productId: null as number | null, minScore: null as number | null };
  audience: any[] = [];
  audienceSelected = new Set<number>();
  audienceLoaded = false;

  recipients: any[] = [];
  readiness: any = null;
  acknowledgeFlags = false;
  private refreshTimer: any = null;

  constructor(private api: OutreachApiService) {}

  ngOnInit(): void {
    this.loadAll();
    if (this.initialCampaignId) this.openCampaign(this.initialCampaignId, 'sequence');
    this.api.products().subscribe({ next: r => this.products = r.products || [], error: () => this.products = [] });
    this.api.leadStatuses().subscribe({ next: r => this.leadStatuses = r.statuses || [], error: () => this.leadStatuses = [] });
  }

  ngOnDestroy(): void {
    clearInterval(this.refreshTimer);
  }

  private blankForm() {
    return { name: '', productId: null as number | null, goal: '', audienceNote: '', tone: 'Professional', sendDays: [1, 2, 3, 4, 5], sendStartHour: 9, sendEndHour: 17, dailyLimit: 50, timezone: '' };
  }

  private err(e: any): string {
    return e?.error?.error || e?.message || 'Request failed';
  }

  loadAll(): void {
    this.loading = true;
    this.api.status().subscribe({ next: r => this.status = r.status, error: () => this.status = null });
    this.api.campaigns().subscribe({
      next: r => { this.campaigns = r.campaigns || []; this.loading = false; },
      error: e => { this.loading = false; this.error = this.err(e); }
    });
  }

  // ---------------------------------------------------------------- list / create
  startNew(): void {
    this.form = this.blankForm();
    this.view = 'new';
    this.error = '';
  }

  toggleDay(list: number[], d: number): number[] {
    return list.includes(d) ? list.filter(x => x !== d) : [...list, d].sort();
  }

  createCampaign(): void {
    if (!this.form.name.trim()) { this.error = 'Give the campaign a name.'; return; }
    if (!this.form.sendDays.length) { this.error = 'Choose at least one sending day.'; return; }
    this.busy = 'create';
    const body: any = { ...this.form, name: this.form.name.trim(), goal: this.form.goal.trim() || null, audienceNote: this.form.audienceNote.trim() || null };
    if (!body.timezone) delete body.timezone;
    this.api.create(body).subscribe({
      next: r => { this.busy = ''; this.toast.emit('Campaign created. Next: generate the email sequence.'); this.openCampaign(r.campaign.id, 'sequence'); this.loadAll(); },
      error: e => { this.busy = ''; this.error = this.err(e); }
    });
  }

  openCampaign(id: number, tab: Tab = 'sequence'): void {
    this.view = 'detail';
    this.tab = tab;
    this.error = '';
    this.acknowledgeFlags = false;
    this.audience = [];
    this.audienceLoaded = false;
    this.audienceSelected = new Set();
    this.reloadCampaign(id);
    clearInterval(this.refreshTimer);
    // Live progress while a campaign is sending.
    this.refreshTimer = setInterval(() => { if (this.campaign?.status === 'running') this.reloadCampaign(this.campaign.id, true); }, 20000);
  }

  backToList(): void {
    clearInterval(this.refreshTimer);
    this.view = 'list';
    this.campaign = null;
    this.loadAll();
  }

  reloadCampaign(id: number, quiet = false): void {
    if (!quiet) this.loading = true;
    this.api.campaign(id).subscribe({
      next: r => {
        this.loading = false;
        this.campaign = r.campaign;
        if (!this.stepsDirty || !quiet) {
          this.steps = (r.campaign.steps || []).map((s: any) => ({ delayDays: s.delayDays, subject: s.subject, body: s.body, needsVerification: s.needsVerification }));
          this.stepsDirty = false;
        }
        this.loadRecipients();
        if (this.tab === 'launch') this.loadReadiness();
      },
      error: e => { this.loading = false; this.error = this.err(e); }
    });
  }

  get editable(): boolean {
    return !!this.campaign && ['draft', 'paused'].includes(this.campaign.status);
  }

  setTab(t: Tab): void {
    this.tab = t;
    this.error = '';
    if (t === 'launch') this.loadReadiness();
    if (t === 'audience' && !this.audienceLoaded) this.previewAudience();
    if (t === 'results') this.loadRecipients();
  }

  deleteCampaign(): void {
    if (!this.campaign || !confirm(`Delete "${this.campaign.name}"? This cannot be undone.`)) return;
    this.api.remove(this.campaign.id).subscribe({
      next: () => { this.toast.emit('Campaign deleted.'); this.backToList(); },
      error: e => this.error = this.err(e)
    });
  }

  // ---------------------------------------------------------------- sequence
  generate(): void {
    if (!this.campaign) return;
    if (this.steps.length && !confirm('Replace the current emails with a new AI-written sequence?')) return;
    this.busy = 'generate';
    this.error = '';
    this.api.generate(this.campaign.id, this.stepCount).subscribe({
      next: r => { this.busy = ''; this.campaign = r.campaign; this.steps = r.campaign.steps.map((s: any) => ({ ...s })); this.stepsDirty = false; this.toast.emit('Sequence written by AI. Review every email before approving.'); },
      error: e => {
        this.busy = '';
        this.error = e?.error?.code === 'AI_UNAVAILABLE' || e?.status === 503 ? `AI is unavailable, so no emails were written. ${this.err(e)}` : this.err(e);
      }
    });
  }

  addStep(): void {
    if (this.steps.length >= 5) return;
    this.steps = [...this.steps, { delayDays: 3, subject: '', body: 'Hi {{first_name}},\n\n' }];
    this.stepsDirty = true;
  }

  removeStep(i: number): void {
    this.steps = this.steps.filter((_, idx) => idx !== i);
    this.stepsDirty = true;
  }

  moveStep(i: number, dir: -1 | 1): void {
    const j = i + dir;
    if (j < 0 || j >= this.steps.length) return;
    const copy = [...this.steps];
    [copy[i], copy[j]] = [copy[j], copy[i]];
    this.steps = copy;
    this.stepsDirty = true;
  }

  markDirty(): void { this.stepsDirty = true; }

  saveSteps(): void {
    if (!this.campaign) return;
    if (this.steps.some(s => !s.subject.trim() || !s.body.trim())) { this.error = 'Every email needs a subject and a body.'; return; }
    this.busy = 'steps';
    this.api.saveSteps(this.campaign.id, this.steps.map((s, i) => ({ delayDays: i === 0 ? 0 : Math.max(1, Number(s.delayDays) || 1), subject: s.subject.trim(), body: s.body.trim() }))).subscribe({
      next: r => { this.busy = ''; this.campaign = r.campaign; this.steps = r.campaign.steps.map((s: any) => ({ ...s })); this.stepsDirty = false; this.toast.emit('Emails saved.'); },
      error: e => { this.busy = ''; this.error = this.err(e); }
    });
  }

  dayOffset(i: number): number {
    return this.steps.slice(1, i + 1).reduce((sum, s) => sum + (Number(s.delayDays) || 0), 0);
  }

  hasPlaceholder(text: string): boolean {
    return /\[[^\]{}]{2,60}\]/.test(text || '');
  }

  // ---------------------------------------------------------------- audience
  toggleStatus(s: string): void {
    const set = new Set(this.audienceFilter.statuses);
    set.has(s) ? set.delete(s) : set.add(s);
    this.audienceFilter.statuses = [...set];
  }

  previewAudience(): void {
    const f: any = {};
    if (this.audienceFilter.statuses.length) f.statuses = this.audienceFilter.statuses;
    if (this.audienceFilter.productId) f.productId = this.audienceFilter.productId;
    if (this.audienceFilter.minScore !== null && this.audienceFilter.minScore !== undefined && String(this.audienceFilter.minScore) !== '') f.minScore = Number(this.audienceFilter.minScore);
    this.busy = 'audience';
    this.api.previewAudience(f).subscribe({
      next: r => {
        this.busy = '';
        this.audienceLoaded = true;
        const inCampaign = new Set(this.recipients.map(x => x.leadId));
        this.audience = (r.audience || []).map((a: any) => ({ ...a, inCampaign: inCampaign.has(a.leadId) }));
        this.audienceSelected = new Set(this.audience.filter(a => a.eligible && !a.inCampaign).map(a => a.leadId));
      },
      error: e => { this.busy = ''; this.error = this.err(e); }
    });
  }

  toggleLead(id: number): void {
    this.audienceSelected.has(id) ? this.audienceSelected.delete(id) : this.audienceSelected.add(id);
  }

  addSelected(): void {
    if (!this.campaign || !this.audienceSelected.size) return;
    this.busy = 'add';
    this.api.addRecipients(this.campaign.id, [...this.audienceSelected]).subscribe({
      next: r => {
        this.busy = '';
        this.campaign = r.campaign;
        const skipped = (r.skipped || []).length;
        this.toast.emit(`Added ${r.added} recipient${r.added === 1 ? '' : 's'}${skipped ? `; skipped ${skipped}` : ''}.`);
        this.loadRecipients(() => this.previewAudience());
      },
      error: e => { this.busy = ''; this.error = this.err(e); }
    });
  }

  removeRecipient(r: any): void {
    if (!this.campaign) return;
    this.api.removeRecipient(this.campaign.id, r.id).subscribe({
      next: () => { this.reloadCampaign(this.campaign.id, true); },
      error: e => this.error = this.err(e)
    });
  }

  loadRecipients(after?: () => void): void {
    if (!this.campaign) return;
    this.api.recipients(this.campaign.id).subscribe({
      next: r => { this.recipients = r.recipients || []; after?.(); },
      error: () => { this.recipients = []; after?.(); }
    });
  }

  retry(r: any): void {
    if (!this.campaign || !confirm(`Try sending email ${r.nextStep} to ${r.email} again?`)) return;
    this.api.retryRecipient(this.campaign.id, r.id).subscribe({
      next: () => { this.toast.emit('Queued for another attempt.'); this.reloadCampaign(this.campaign.id, true); },
      error: e => this.error = this.err(e)
    });
  }

  // ---------------------------------------------------------------- launch
  loadReadiness(): void {
    if (!this.campaign) return;
    this.api.readiness(this.campaign.id).subscribe({ next: r => this.readiness = r.readiness, error: e => this.error = this.err(e) });
  }

  approve(): void {
    if (!this.campaign || !this.readiness?.ready) return;
    const resume = this.campaign.status === 'paused';
    const msg = `${resume ? 'Resume' : 'Start'} sending "${this.campaign.name}"?\n\n${this.readiness.recipients} recipient(s), ${this.readiness.steps} email(s) each, from ${this.readiness.sender}.\nEmails go out automatically inside the sending window, up to ${this.campaign.dailyLimit} per day.`;
    if (!confirm(msg)) return;
    this.busy = 'approve';
    const call = resume ? this.api.resume(this.campaign.id, this.acknowledgeFlags) : this.api.approve(this.campaign.id, this.acknowledgeFlags);
    call.subscribe({
      next: r => { this.busy = ''; this.campaign = r.campaign; this.toast.emit(resume ? 'Campaign resumed.' : 'Campaign approved. Sending starts in the next sending window.'); this.setTab('results'); },
      error: e => { this.busy = ''; this.error = this.err(e); this.loadReadiness(); }
    });
  }

  pause(): void {
    if (!this.campaign) return;
    this.api.pause(this.campaign.id).subscribe({ next: r => { this.campaign = r.campaign; this.toast.emit('Campaign paused. No more emails will be sent until you resume.'); }, error: e => this.error = this.err(e) });
  }

  stop(): void {
    if (!this.campaign || !confirm(`Stop "${this.campaign.name}" for good? Remaining emails will not be sent.`)) return;
    this.api.stop(this.campaign.id).subscribe({ next: r => { this.campaign = r.campaign; this.loadRecipients(); this.toast.emit('Campaign stopped.'); }, error: e => this.error = this.err(e) });
  }

  // ---------------------------------------------------------------- helpers
  windowLabel(c: any): string {
    const days = (c.sendDays || []).map((d: number) => DAY_NAMES[d - 1]).join(', ');
    return `${days} · ${String(c.sendStartHour).padStart(2, '0')}:00–${String(c.sendEndHour).padStart(2, '0')}:00 ${c.timezone}`;
  }

  rate(n: number, of: number): string {
    return of ? `${Math.round((n / of) * 100)}%` : '—';
  }

  productName(id: number | null): string {
    if (!id) return 'No product';
    return this.products.find(p => p.id === id)?.name || 'Product removed';
  }

  statusLabel(s: string): string {
    return ({ draft: 'Draft', running: 'Sending', paused: 'Paused', completed: 'Completed', stopped: 'Stopped' } as any)[s] || s;
  }

  recipientLabel(s: string): string {
    return ({ pending: 'Waiting for approval', active: 'In sequence', completed: 'Sequence finished', replied: 'Replied', unsubscribed: 'Unsubscribed', bounced: 'Bounced',
      failed: 'Send failed', needs_review: 'Check delivery', suppressed: 'Suppressed', stopped: 'Stopped' } as any)[s] || s;
  }
}
