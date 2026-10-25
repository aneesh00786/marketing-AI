import { Component, EventEmitter, OnDestroy, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { apiRoot } from '../../core/api-base';
import { AuthStateService } from '../../core/auth-state.service';
import { TemplatePickerComponent } from './template-picker.component';

/**
 * Mail Center → Product emails: Product → Leads → personalized emails → preview → send.
 * Leads are never pre-selected; only leads the server reports as eligible (valid address,
 * marketing consent recorded, not unsubscribed/bounced) can be selected, and the reasons are
 * shown for the rest. Each recipient gets a separate email (a draft in the batch), sent and
 * tracked with the usual draft safeguards. One-off emails to any address stay in Compose/Drafts.
 */
@Component({
  selector: 'app-product-emails',
  standalone: true,
  imports: [CommonModule, FormsModule, TemplatePickerComponent],
  templateUrl: './product-emails.component.html',
  styleUrls: ['../command/command-center.component.css', './product-emails.component.css']
})
export class ProductEmailsComponent implements OnInit, OnDestroy {
  @Output() toast = new EventEmitter<string>();

  private base = `${apiRoot()}/api/v1/mail/product-emails`;
  products: any[] = [];
  productId: number | null = null;
  product: any = null;
  // Recipients
  leads: any[] = [];
  total = 0;
  page = 1;
  pageSize = 25;
  q = '';
  status = '';
  eligibility = '';
  productLeadsOnly = false;
  eligibleIds: number[] = [];
  maxBatch = 100;
  selected = new Set<number>();
  private timer: any = null;
  // Email
  form = { goal: '', tone: 'Professional', subject: '', senderName: '' };
  template: { id: number; name: string } | null = null;
  showPicker = false;
  // Batch (preview / send)
  batch: any = null;
  drafts: any[] = [];
  skipped: any[] = [];
  problems: any[] = [];
  // Marketing delivery: never through ZeptoMail; only an SMTP mailbox approved for marketing.
  delivery: { allowed: boolean; code: string | null; reason: string | null; provider: string | null } | null = null;
  approveMarketingConfirm = false;
  // Consent evidence form (granting consent needs how, when and proof, not just a note).
  consentFor: any = null;
  consentForm = { method: 'web_form', obtainedAt: '', evidence: '', attest: false };
  readonly consentMethods = [
    { value: 'web_form', label: 'Website sign-up form' },
    { value: 'double_opt_in', label: 'Double opt-in (confirmed by email)' },
    { value: 'checkbox_at_signup', label: 'Consent checkbox at account sign-up' },
    { value: 'written', label: 'Written / signed consent' },
    { value: 'event_signup', label: 'Event or trade-show sign-up' },
    { value: 'customer_request', label: 'Customer asked to receive emails' },
    { value: 'imported_with_proof', label: 'Imported list with proof of consent' }
  ];
  private poll: any = null;
  previewId: number | null = null;
  readonly tokenHint = '{{first_name}}, {{company}}, {{product_name}}';
  readonly goalPlaceholder = 'e.g. Show {{company}} how our product cuts planning time';
  caps = { compose: false, send: false, configure: false };
  busy = '';
  error = '';

  constructor(private http: HttpClient, private sanitizer: DomSanitizer, private auth: AuthStateService) {}

  ngOnDestroy(): void { clearTimeout(this.poll); }

  ngOnInit(): void {
    this.form.senderName = this.auth.user?.displayName || '';
    this.http.get<any>(`${apiRoot()}/api/v1/mail/zoho/status`).subscribe({ next: r => this.caps = { compose: !!r.canCompose, send: !!r.canSend, configure: !!r.canConfigure } });
    this.loadDelivery();
    this.http.get<any>(`${apiRoot()}/api/v1/products`).subscribe({ next: r => this.products = r.products || [] });
  }

  // ---------------------------------------------------------------- 1. product

  chooseProduct(): void {
    this.batch = null;
    this.selected.clear();
    this.page = 1;
    this.loadRecipients();
  }

  // ---------------------------------------------------------------- 2. leads

  loadRecipients(): void {
    if (!this.productId) { this.product = null; this.leads = []; return; }
    const params: any = { productId: String(this.productId), page: String(this.page), pageSize: String(this.pageSize) };
    if (this.q.trim()) params.q = this.q.trim();
    if (this.status) params.status = this.status;
    if (this.eligibility) params.eligibility = this.eligibility;
    if (this.productLeadsOnly) params.productLeadsOnly = '1';
    this.http.get<any>(`${this.base}/recipients`, { params }).subscribe({
      next: r => {
        this.product = r.product; this.leads = r.leads; this.total = r.total; this.eligibleIds = r.eligibleIds; this.maxBatch = r.maxBatch; this.error = '';
        // A selection that is no longer eligible under the current filter results is kept only if still eligible.
        for (const id of [...this.selected]) if (!r.eligibleIds.includes(id) && !r.leads.some((l: any) => l.id === id && l.eligible)) this.selected.delete(id);
      },
      error: e => this.error = this.err(e)
    });
  }

  search(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.page = 1; this.loadRecipients(); }, 250);
  }

  get pages(): number { return Math.max(1, Math.ceil(this.total / this.pageSize)); }
  go(p: number): void { this.page = Math.min(Math.max(1, p), this.pages); this.loadRecipients(); }

  toggle(l: any): void {
    if (!l.eligible) return;
    if (this.selected.has(l.id)) this.selected.delete(l.id);
    else if (this.selected.size >= this.maxBatch) this.toast.emit(`At most ${this.maxBatch} recipients per batch.`);
    else this.selected.add(l.id);
  }

  selectAllEligible(): void {
    this.eligibleIds.forEach(id => this.selected.add(id));
    if (this.eligibleIds.length >= this.maxBatch) this.toast.emit(`Selected the first ${this.maxBatch} eligible leads (batch limit).`);
  }

  clearSelection(): void { this.selected.clear(); }

  recordConsent(l: any): void {
    this.consentFor = l;
    this.consentForm = { method: 'web_form', obtainedAt: '', evidence: '', attest: false };
  }

  get consentReady(): boolean {
    const f = this.consentForm;
    return !!f.method && /^\d{4}-\d{2}-\d{2}$/.test(f.obtainedAt) && f.evidence.trim().length >= 3 && f.attest;
  }

  saveConsent(): void {
    const l = this.consentFor;
    const f = this.consentForm;
    this.http.post<any>(`${this.base}/consent`, { leadIds: [l.id], status: 'granted', method: f.method, obtainedAt: f.obtainedAt, evidence: f.evidence.trim(), attest: true }).subscribe({
      next: () => { this.consentFor = null; this.toast.emit(`Consent recorded for ${l.name}.`); this.loadRecipients(); },
      error: e => this.toast.emit(this.err(e))
    });
  }

  // ---------------------------------------------------------------- 3. generate

  onTemplate(t: any): void { this.showPicker = false; this.template = { id: t.id, name: t.name }; }

  generate(): void {
    if (!this.selected.size) { this.toast.emit('Select at least one lead.'); return; }
    this.busy = 'generate';
    const body: any = { productId: this.productId, leadIds: [...this.selected], tone: this.form.tone, senderName: this.form.senderName.trim() };
    if (this.form.goal.trim()) body.goal = this.form.goal.trim();
    if (this.form.subject.trim()) body.subject = this.form.subject.trim();
    if (this.template) body.templateId = this.template.id;
    this.http.post<any>(`${this.base}/batches`, body).subscribe({
      next: r => { this.busy = ''; this.setBatch(r); this.skipped = r.skipped || []; this.toast.emit(`Prepared ${r.drafts.length} personalized email(s). Review them before sending.`); },
      error: e => { this.busy = ''; this.skipped = e?.error?.details?.skipped || []; this.toast.emit(this.err(e)); }
    });
  }

  // ---------------------------------------------------------------- 4. preview / approve / send

  private setBatch(r: any): void {
    this.batch = r.batch;
    this.drafts = r.drafts;
    if (r.marketingDelivery) this.delivery = r.marketingDelivery;
    // Sending happens in the background: follow progress until the batch finishes or pauses.
    clearTimeout(this.poll);
    if (['queued', 'sending'].includes(this.batch?.status)) this.poll = setTimeout(() => this.refreshBatch(), 4000);
    if (!this.previewId || !this.drafts.some(d => d.id === this.previewId)) this.previewId = this.drafts[0]?.id || null;
  }

  get preview(): any { return this.drafts.find(d => d.id === this.previewId) || null; }
  get previewHtml(): SafeHtml {
    // Sandboxed iframe only: no scripts, no access to the app.
    return this.sanitizer.bypassSecurityTrustHtml(this.preview?.bodyHtml || '');
  }
  get readyCount(): number { return this.drafts.filter(d => d.status === 'Approved' && !d.outcome).length; }
  get failedCount(): number { return this.drafts.filter(d => d.outcome === 'failed').length; }
  get sending(): boolean { return ['queued', 'sending'].includes(this.batch?.status); }

  refreshBatch(): void {
    this.http.get<any>(`${this.base}/batches/${this.batch.id}`).subscribe({ next: r => this.setBatch(r) });
  }

  approve(): void {
    this.busy = 'approve';
    this.http.post<any>(`${this.base}/batches/${this.batch.id}/approve`, {}).subscribe({
      next: r => { this.busy = ''; this.setBatch(r); this.problems = r.problems; this.toast.emit(`${r.approved} email(s) approved${r.problems.length ? `, ${r.problems.length} need attention` : ''}.`); },
      error: e => { this.busy = ''; this.toast.emit(this.err(e)); }
    });
  }

  send(): void {
    if (this.delivery && !this.delivery.allowed) { this.toast.emit(this.delivery.reason || 'Marketing email cannot be sent from this workspace.'); return; }
    if (!confirm(`Send ${this.readyCount} separate email(s)? Each recipient gets their own personalized email. This cannot be undone.`)) return;
    this.busy = 'send';
    this.http.post<any>(`${this.base}/batches/${this.batch.id}/send`, { confirm: true }).subscribe({
      next: r => { this.busy = ''; this.setBatch(r); this.toast.emit('Queued. The background sender sends each email separately; progress updates here.'); },
      error: e => { this.busy = ''; this.toast.emit(this.err(e)); this.refreshBatch(); }
    });
  }

  loadDelivery(): void {
    this.http.get<any>(`${apiRoot()}/api/v1/mail/marketing`).subscribe({ next: r => this.delivery = r.marketing, error: () => this.delivery = null });
  }

  /** Owner/Admin confirms that the workspace's SMTP provider allows marketing email. */
  approveMarketing(): void {
    if (!this.approveMarketingConfirm) return;
    this.http.post<any>(`${apiRoot()}/api/v1/mail/marketing`, { approved: true, confirm: true, note: 'Confirmed in Product Emails' }).subscribe({
      next: r => { this.delivery = r.marketing; this.approveMarketingConfirm = false; this.toast.emit('This SMTP mailbox is approved for marketing email.'); },
      error: e => this.toast.emit(this.err(e))
    });
  }

  retryFailed(): void {
    if (!confirm(`Retry the ${this.failedCount} email(s) that were clearly not sent? Emails with an unknown outcome are never retried.`)) return;
    this.http.post<any>(`${this.base}/batches/${this.batch.id}/retry-failed`, { confirm: true }).subscribe({
      next: r => { this.setBatch(r); this.toast.emit('Failed emails queued again.'); },
      error: e => this.toast.emit(this.err(e))
    });
  }

  outcomeLabel(d: any): string {
    if (d.placeholders?.length && d.status === 'Draft') return 'Fill ' + d.placeholders.join(', ');
    return ({ sent: 'Sent', skipped: 'Skipped', failed: 'Not sent', needs_review: 'Unknown — check' } as any)[d.outcome] || d.status;
  }

  startOver(): void {
    clearTimeout(this.poll);
    this.batch = null; this.drafts = []; this.problems = []; this.skipped = []; this.selected.clear(); this.loadRecipients();
  }

  private err(e: any): string { return e?.error?.error || e?.message || 'Request failed.'; }
}
