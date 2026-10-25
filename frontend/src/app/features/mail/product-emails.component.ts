import { Component, EventEmitter, OnInit, Output } from '@angular/core';
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
export class ProductEmailsComponent implements OnInit {
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
  results: any[] = [];
  previewId: number | null = null;
  readonly tokenHint = '{{first_name}}, {{company}}, {{product_name}}';
  readonly goalPlaceholder = 'e.g. Show {{company}} how our product cuts planning time';
  caps = { compose: false, send: false };
  busy = '';
  error = '';

  constructor(private http: HttpClient, private sanitizer: DomSanitizer, private auth: AuthStateService) {}

  ngOnInit(): void {
    this.form.senderName = this.auth.user?.displayName || '';
    this.http.get<any>(`${apiRoot()}/api/v1/mail/zoho/status`).subscribe({ next: r => this.caps = { compose: !!r.canCompose, send: !!r.canSend } });
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
    const source = prompt(`How did ${l.name} agree to receive marketing email? (e.g. "Website sign-up form, 2026-09-12")`);
    if (!source || source.trim().length < 3) return;
    this.http.post<any>(`${this.base}/consent`, { leadIds: [l.id], status: 'granted', source: source.trim() }).subscribe({
      next: () => { this.toast.emit(`Consent recorded for ${l.name}.`); this.loadRecipients(); },
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
    if (!this.previewId || !this.drafts.some(d => d.id === this.previewId)) this.previewId = this.drafts[0]?.id || null;
  }

  get preview(): any { return this.drafts.find(d => d.id === this.previewId) || null; }
  get previewHtml(): SafeHtml {
    // Sandboxed iframe only: no scripts, no access to the app.
    return this.sanitizer.bypassSecurityTrustHtml(this.preview?.bodyHtml || '');
  }
  get readyCount(): number { return this.drafts.filter(d => d.status === 'Approved').length; }

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
    if (!confirm(`Send ${this.readyCount} separate email(s) now? Each recipient gets their own personalized email. This cannot be undone.`)) return;
    this.busy = 'send';
    this.http.post<any>(`${this.base}/batches/${this.batch.id}/send`, { confirm: true }).subscribe({
      next: r => {
        this.busy = '';
        this.setBatch(r);
        this.results = r.results;
        const s = r.summary || {};
        this.toast.emit(`Sent ${s.sent || 0}${s.skipped ? `, skipped ${s.skipped}` : ''}${s.failed ? `, failed ${s.failed}` : ''}${s.needs_review ? `, ${s.needs_review} unknown (check Mail Drafts)` : ''}.`);
      },
      error: e => { this.busy = ''; this.toast.emit(this.err(e)); this.refreshBatch(); }
    });
  }

  startOver(): void {
    this.batch = null; this.drafts = []; this.results = []; this.problems = []; this.skipped = []; this.selected.clear(); this.loadRecipients();
  }

  private err(e: any): string { return e?.error?.error || e?.message || 'Request failed.'; }
}
