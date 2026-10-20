import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { apiRoot } from '../../core/api-base';

type View = 'list' | 'new' | 'detail';

/**
 * A/B tests for email sequences and social variant posts. Success metric, minimum sample and
 * significance level are fixed before the test runs; results are real counts and a winner can
 * only be declared when the data supports it.
 */
@Component({
  selector: 'app-ab-tests',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './ab-tests.component.html',
  styleUrls: ['../command/command-center.component.css', './ab-tests.component.css']
})
export class AbTestsComponent implements OnInit {
  @Input() initialEmailCampaignId: number | null = null;
  @Output() toast = new EventEmitter<string>();
  @Output() openEmailCampaign = new EventEmitter<number>();
  @Output() openSocialCampaign = new EventEmitter<number>();

  private base = `${apiRoot()}/api/v1/ab-tests`;
  view: View = 'list';
  busy = '';
  error = '';
  tests: any[] = [];
  meta: any = { emailMetrics: {}, socialMetrics: {}, alphas: [0.01, 0.05, 0.1] };
  test: any = null;

  emailCampaigns: any[] = [];
  socialCampaigns: any[] = [];
  groups: any[] = [];
  form = this.blankForm();
  variantEdit = { subject: '', body: '' };

  constructor(private http: HttpClient) {}

  ngOnInit(): void {
    this.http.get<any>(`${this.base}/meta`).subscribe({ next: r => this.meta = r, error: () => {} });
    this.load();
    if (this.initialEmailCampaignId) { this.startNew(); this.form.kind = 'email'; this.form.emailCampaignId = this.initialEmailCampaignId; }
  }

  private blankForm() {
    return { kind: 'email' as 'email' | 'social', name: '', hypothesis: '', emailCampaignId: null as number | null, stepOrder: 1, socialCampaignId: null as number | null, variantGroup: '',
      metric: 'reply_rate', minSamplePerVariant: 100, waitDays: 3, alpha: 0.05, variantSubject: '', variantBody: '' };
  }

  private err(e: any): string { return e?.error?.error || e?.message || 'Request failed'; }
  objectKeys(o: any): string[] { return Object.keys(o || {}); }

  load(): void {
    this.http.get<any>(this.base).subscribe({ next: r => this.tests = r.tests || [], error: e => this.error = this.err(e) });
  }

  startNew(): void {
    this.form = this.blankForm();
    this.view = 'new';
    this.error = '';
    this.http.get<any>(`${apiRoot()}/api/v1/outreach/campaigns`).subscribe({ next: r => this.emailCampaigns = (r.campaigns || []).filter((c: any) => c.status === 'draft'), error: () => this.emailCampaigns = [] });
    this.http.get<any>(`${apiRoot()}/api/v1/social/campaigns`).subscribe({ next: r => this.socialCampaigns = r.campaigns || [], error: () => this.socialCampaigns = [] });
  }

  setKind(k: 'email' | 'social'): void {
    this.form.kind = k;
    this.form.metric = k === 'email' ? 'reply_rate' : 'engagement_rate';
    this.form.minSamplePerVariant = k === 'email' ? 100 : 500;
  }

  loadGroups(): void {
    this.groups = [];
    this.form.variantGroup = '';
    if (!this.form.socialCampaignId) return;
    this.http.get<any>(`${this.base}/social-groups/${this.form.socialCampaignId}`).subscribe({ next: r => this.groups = r.groups || [], error: e => this.error = this.err(e) });
  }

  get selectedEmailCampaign(): any {
    return this.emailCampaigns.find(c => c.id === this.form.emailCampaignId) || null;
  }

  create(): void {
    const f = this.form;
    if (!f.name.trim()) { this.error = 'Name the test.'; return; }
    let req;
    if (f.kind === 'email') {
      if (!f.emailCampaignId) { this.error = 'Choose a draft email sequence.'; return; }
      const body: any = { name: f.name.trim(), hypothesis: f.hypothesis.trim() || null, emailCampaignId: f.emailCampaignId, stepOrder: Number(f.stepOrder), metric: f.metric,
        minSamplePerVariant: Number(f.minSamplePerVariant), waitDays: Number(f.waitDays), alpha: Number(f.alpha) };
      if (f.variantSubject.trim() && f.variantBody.trim()) body.variant = { subject: f.variantSubject.trim(), body: f.variantBody.trim() };
      req = this.http.post<any>(`${this.base}/email`, body);
    } else {
      if (!f.socialCampaignId || !f.variantGroup) { this.error = 'Choose a social campaign and a post with A/B variants.'; return; }
      req = this.http.post<any>(`${this.base}/social`, { name: f.name.trim(), hypothesis: f.hypothesis.trim() || null, socialCampaignId: f.socialCampaignId, variantGroup: f.variantGroup,
        metric: f.metric, minSamplePerVariant: Number(f.minSamplePerVariant), alpha: Number(f.alpha) });
    }
    this.busy = 'create';
    req.subscribe({
      next: r => { this.busy = ''; this.toast.emit('A/B test created. Its metric and sample size are now fixed.'); this.open(r.test.id); this.load(); },
      error: e => { this.busy = ''; this.error = this.err(e); }
    });
  }

  open(id: number): void {
    this.view = 'detail';
    this.error = '';
    this.http.get<any>(`${this.base}/${id}`).subscribe({
      next: r => { this.test = r.test; this.variantEdit = { subject: r.test.content?.B?.subject || '', body: r.test.content?.B?.body || '' }; },
      error: e => this.error = this.err(e)
    });
  }

  back(): void { this.view = 'list'; this.test = null; this.load(); }

  saveVariant(): void {
    if (!this.variantEdit.subject.trim() || !this.variantEdit.body.trim()) { this.error = 'Variant B needs a subject and a body.'; return; }
    this.busy = 'variant';
    this.http.patch<any>(`${this.base}/${this.test.id}`, { variant: { subject: this.variantEdit.subject.trim(), body: this.variantEdit.body.trim() } }).subscribe({
      next: r => { this.busy = ''; this.test = r.test; this.toast.emit('Variant B saved.'); },
      error: e => { this.busy = ''; this.error = this.err(e); }
    });
  }

  generateVariant(): void {
    if (this.test.content?.B && !confirm('Replace variant B with a new AI-written one?')) return;
    this.busy = 'generate';
    this.http.post<any>(`${this.base}/${this.test.id}/generate-variant`, {}).subscribe({
      next: r => { this.busy = ''; this.test = r.test; this.variantEdit = { subject: r.test.content.B.subject, body: r.test.content.B.body }; this.toast.emit('Variant B written by AI. Review it.'); },
      error: e => { this.busy = ''; this.error = e?.status === 503 ? `AI is unavailable, so no variant was written. ${this.err(e)}` : this.err(e); }
    });
  }

  conclude(decision: 'winner' | 'no_winner'): void {
    const d = this.test.result?.decision;
    const msg = decision === 'winner'
      ? `Declare variant ${d.leader} the winner?${this.test.kind === 'email' ? ' Recipients who have not received this email yet will get the winner.' : ' This records the result; it does not publish anything.'}`
      : 'End the test without a winner?' + (this.test.kind === 'email' ? ' Remaining recipients get the original (A).' : '');
    if (!confirm(msg)) return;
    this.busy = 'conclude';
    this.http.post<any>(`${this.base}/${this.test.id}/conclude`, { decision, winner: decision === 'winner' ? d.leader : undefined, confirm: true }).subscribe({
      next: r => { this.busy = ''; this.test = r.test; this.toast.emit('Test concluded.'); },
      error: e => { this.busy = ''; this.error = this.err(e); }
    });
  }

  cancel(): void {
    if (!confirm('Cancel this A/B test?')) return;
    this.http.post<any>(`${this.base}/${this.test.id}/cancel`, {}).subscribe({ next: r => { this.test = r.test; this.toast.emit('Test cancelled.'); }, error: e => this.error = this.err(e) });
  }

  pct(v: number | null): string { return v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`; }

  recLabel(r: string): string {
    return ({ winner: 'Winner supported by data', no_difference: 'No significant difference', insufficient_data: 'Not enough data yet', not_started: 'Not started', no_winner: 'Ended without winner' } as any)[r] || r;
  }

  statusLabel(s: string): string {
    return ({ draft: 'Draft', running: 'Running', concluded: 'Concluded', cancelled: 'Cancelled' } as any)[s] || s;
  }
}
