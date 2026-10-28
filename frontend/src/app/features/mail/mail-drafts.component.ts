import { Component, EventEmitter, HostListener, Input, OnChanges, OnInit, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { TemplatePickerComponent } from './template-picker.component';
import { ContactPickerComponent, PickedContact } from './contact-picker.component';
import { APPROVAL_STATUSES } from './mail-nav';
import { EmailPreviewComponent } from './email-preview.component';
import { EmailTrackingComponent } from './email-tracking.component';

type DraftStatus = 'Draft' | 'Approved' | 'Sending' | 'Sent' | 'Needs Review';

/** Statuses the drafts API actually uses (Draft = waiting for approval). */
export const DRAFT_STATUSES: { key: DraftStatus; label: string; hint: string }[] = [
  { key: 'Draft', label: 'Draft', hint: 'Waiting for review and approval' },
  { key: 'Approved', label: 'Approved', hint: 'Approved, not sent yet' },
  { key: 'Sending', label: 'Sending', hint: 'Being sent right now' },
  { key: 'Needs Review', label: 'Needs review', hint: 'Delivery unknown: check before sending again' },
  { key: 'Sent', label: 'Sent', hint: 'Delivered to the mail provider' }
];
const LOCKED: string[] = ['Sent', 'Sending', 'Needs Review'];
const TONES = [
  { value: 'Professional', label: 'Professional & direct' },
  { value: 'Persuasive', label: 'Persuasive' },
  { value: 'Short', label: 'Short & punchy' },
  { value: 'Executive', label: 'Executive briefing' }
];

/**
 * Mail Drafts: the draft queue, the selected draft (edit, approve, send) and the "Create AI draft"
 * modal. Generating never sends and never picks a recipient by itself; sending always needs an
 * approved draft and an explicit confirmation. Permissions are enforced by the server; the page
 * also reads the member's capabilities to explain why an action is unavailable.
 */
@Component({
  selector: 'app-mail-drafts',
  standalone: true,
  imports: [CommonModule, FormsModule, EmailPreviewComponent, TemplatePickerComponent, ContactPickerComponent, EmailTrackingComponent],
  templateUrl: './mail-drafts.component.html',
  styleUrls: ['../command/command-center.component.css', './mail-drafts.component.css']
})
export class MailDraftsComponent implements OnInit, OnChanges {
  /** 'approvals' shows only drafts that need someone with mail.send; the actions are the same. */
  @Input() view: 'drafts' | 'approvals' = 'drafts';
  /** Status filter to open with (Mail Center overview shortcuts). */
  @Input() initialStatus: DraftStatus | null = null;
  /** Draft to open first (Mail Center "needs attention" list). */
  @Input() openDraftId: number | null = null;
  /** "Create Email" in Mail Center: open the generator, optionally with the template picker. */
  @Input() startAction: 'ai' | 'template' | null = null;
  @Output() actionConsumed = new EventEmitter<void>();
  @Input() products: any[] = [];
  /** A template chosen in Email Templates ("Use in a draft"): opens the generator with it selected. */
  @Input() startTemplate: { id: number; name: string } | null = null;
  /** "Create AI Email Draft" on a product card: opens the generator with that product selected. */
  @Input() startProduct: { id: number } | null = null;
  @Output() toast = new EventEmitter<string>();
  /** Drafts changed (created, edited, approved, sent, deleted): the shell refreshes its counts. */
  @Output() changed = new EventEmitter<void>();
  @Output() sent = new EventEmitter<void>();
  @Output() templateConsumed = new EventEmitter<void>();
  @Output() productConsumed = new EventEmitter<void>();

  readonly statuses = DRAFT_STATUSES;
  readonly tones = TONES;

  drafts: any[] = [];
  loading = false;
  loadError: string | null = null;
  query = '';
  statusFilter: DraftStatus | 'all' = 'all';
  selected: any = null;
  mobileView: 'list' | 'detail' = 'list';

  // Capabilities of the signed-in member (null = unknown: the server still decides).
  caps: Set<string> | null = null;
  /** Mail Drafts are marketing email: sendable only through an SMTP mailbox approved for marketing. */
  marketing: { allowed: boolean; code: string | null; reason: string | null } | null = null;

  // Selected-draft editing
  edit = { subject: '', body: '' };
  /** Which recipient the contact picker is choosing: the selected draft's, or the new draft's. */
  picker: 'detail' | 'create' | null = null;
  editingBody = false;
  placeholderValues: Record<string, string> = {};
  busy: 'save' | 'approve' | 'send' | 'delete' | 'rewrite' | 'resolve' | 'fill' | 'recipient' | null = null;
  lastOutcome: { kind: 'error' | 'unknown'; text: string } | null = null;

  // Create modal
  showCreate = false;
  generating = false;
  createError: string | null = null;
  form = this.blankForm();
  productQuery = '';
  /** New draft's recipient: a contact from Leads, or (explicitly) an address that is not a contact. */
  contact: PickedContact | null = null;
  /** True once the user has explicitly chosen to keep a contact that is not linked to the draft's product. */
  keptMismatch = false;
  manualRecipient: { name: string; email: string } | null = null;
  template: { id: number; name: string } | null = null;
  showTemplatePicker = false;

  constructor(private api: ApiService) {}


  ngOnInit(): void {
    if (this.initialStatus) this.statusFilter = this.initialStatus;
    if (this.openDraftId) this.mobileView = 'detail';
    this.load(this.openDraftId);
    this.api.getMe().subscribe({
      next: (me: any) => { if (Array.isArray(me?.capabilities)) this.caps = new Set(me.capabilities); },
      error: () => { this.caps = null; }
    });
    this.api.getMarketingDelivery().subscribe({
      next: (r: any) => { this.marketing = r?.marketing || null; },
      error: () => { this.marketing = null; } // unknown: the server still refuses if not allowed
    });
  }

  /** Why the draft cannot be sent (approval is still possible), e.g. no mailbox approved for marketing. */
  get deliveryBlocker(): string | null {
    if (this.marketing && this.marketing.allowed === false) {
      return `Drafts are marketing email and can't be sent from this workspace yet: ${this.marketing.reason || 'no mailbox is approved for marketing email.'}`;
    }
    return null;
  }

  ngOnChanges(ch: SimpleChanges): void {
    if (ch['startAction'] && this.startAction) {
      if (this.canCompose) {
        this.openCreate();
        this.showTemplatePicker = this.startAction === 'template';
      } else this.toast.emit('Your role cannot create drafts.');
      this.actionConsumed.emit();
    }
    if (ch['startTemplate'] && this.startTemplate) {
      this.openCreate();
      this.template = { ...this.startTemplate };
      this.templateConsumed.emit();
    }
    if (ch['startProduct'] && this.startProduct) {
      if (!this.showCreate) this.openCreate();
      this.form.productId = this.startProduct.id;
      this.productConsumed.emit();
    }
  }

  // ---------- permissions ----------
  can(cap: string): boolean { return this.caps === null || this.caps.has(cap); }
  get canCompose(): boolean { return this.can('mail.compose'); }
  get canSend(): boolean { return this.can('mail.send'); }
  get canViewContacts(): boolean { return this.can('leads.view'); }
  get canAddContacts(): boolean { return this.can('leads.manage'); }

  // ---------- list ----------
  load(selectId: number | null = null): void {
    this.loading = true;
    this.api.getMailDrafts().subscribe({
      next: (res: any) => {
        this.loading = false;
        this.loadError = null;
        this.drafts = res.drafts || [];
        const keep = selectId ?? this.selected?.id ?? null;
        // The open draft stays open after it changes status (e.g. sent from Approvals) so its result stays visible.
        const found = keep !== null ? this.drafts.find(d => d.id === keep) : null;
        if (found) this.applySelection(found);
        // On narrow screens the list stays in front (mobileView) until the user opens a draft.
        else if (!this.selected && this.filtered.length) this.applySelection(this.filtered[0]);
        else if (this.selected && !found) this.applySelection(null);
      },
      error: (err: any) => { this.loading = false; this.loadError = this.apiError(err); }
    });
  }

  /** Drafts this view covers: all of them, or (approvals) those waiting on someone with mail.send. */
  get scoped(): any[] {
    return this.view === 'approvals' ? this.drafts.filter(d => APPROVAL_STATUSES.includes(d.status)) : this.drafts;
  }

  get visibleStatuses() {
    return this.view === 'approvals' ? DRAFT_STATUSES.filter(s => APPROVAL_STATUSES.includes(s.key)) : DRAFT_STATUSES;
  }

  get filtered(): any[] {
    const q = this.query.trim().toLowerCase();
    return this.scoped.filter(d => (this.statusFilter === 'all' || d.status === this.statusFilter)
      && (!q || [d.subject, d.recipient_name, d.recipient_email, d.product_name].some(v => String(v || '').toLowerCase().includes(q))));
  }

  count(status: DraftStatus): number { return this.drafts.filter(d => d.status === status).length; }

  statusClass(s: string): string { return 'st-' + String(s || '').toLowerCase().replace(/\s+/g, '-'); }
  statusLabel(s: string): string { return DRAFT_STATUSES.find(x => x.key === s)?.label || s; }

  when(value: any): string {
    if (!value) return '';
    const d = new Date(String(value).includes('T') || String(value).endsWith('Z') ? value : String(value).replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return String(value).slice(0, 10);
    const mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }

  // ---------- selection & editing ----------
  get dirty(): boolean {
    const d = this.selected;
    if (!d) return false;
    return this.edit.subject !== (d.subject || '') || this.edit.body !== (d.body_html || '');
  }

  get locked(): boolean { return LOCKED.includes(this.selected?.status); }

  select(d: any): void {
    if (d?.id === this.selected?.id) { this.mobileView = 'detail'; return; }
    if (this.dirty && !confirm('Discard your unsaved changes to this draft?')) return;
    this.applySelection(d);
    this.mobileView = 'detail';
  }

  backToList(): void {
    if (this.dirty && !confirm('Discard your unsaved changes to this draft?')) return;
    this.applySelection(this.selected);
    this.mobileView = 'list';
  }

  private applySelection(d: any): void {
    this.selected = d;
    this.editingBody = false;
    this.lastOutcome = null;
    this.edit = { subject: d?.subject || '', body: d?.body_html || '' };
    this.placeholderValues = Object.fromEntries((d?.placeholders || []).map((p: string) => [p, '']));
  }

  /** Why approving/sending is not possible right now, or null. Shown next to the disabled buttons. */
  get sendBlocker(): string | null {
    const d = this.selected;
    if (!d) return null;
    if (!this.canSend) return 'Your role can review drafts but cannot approve or send them.';
    if (d.status === 'Sent') return 'This draft has been sent.';
    if (d.status === 'Sending') return 'This draft is being sent right now.';
    if (d.status === 'Needs Review') return 'Delivery is unknown. Resolve it below before sending again.';
    if (this.dirty) return 'Save your changes first: approval applies to the saved version.';
    if (d.contact?.missing) return 'The contact for this draft was deleted from Leads. Choose a contact again.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.recipient_email || '')) return 'Select a contact (recipient) first.';
    if (d.placeholders?.length) return `Fill in ${d.placeholders.length} placeholder${d.placeholders.length > 1 ? 's' : ''} first.`;
    return null;
  }

  get editBlocker(): string | null {
    if (!this.canCompose) return 'Your role cannot edit drafts.';
    if (this.locked) return this.selected?.status === 'Needs Review' ? 'Resolve the unknown delivery before editing.' : 'Sent drafts cannot be edited.';
    return null;
  }

  save(): void {
    const d = this.selected;
    if (!d || !this.dirty || this.busy) return;
    if (!this.edit.subject.trim()) { this.toast.emit('The subject cannot be empty.'); return; }
    const body: any = {};
    if (this.edit.subject !== d.subject) body.subject = this.edit.subject.trim();
    if (this.edit.body !== (d.body_html || '')) body.body_html = this.edit.body;
    this.busy = 'save';
    this.api.updateMailDraft(d.id, body).subscribe({
      next: (res: any) => { this.busy = null; this.toast.emit(d.status === 'Approved' ? 'Saved. The draft needs approval again before sending.' : 'Draft saved.'); this.afterChange(res.draft); },
      error: (err: any) => { this.busy = null; this.toast.emit(`Not saved: ${this.apiError(err)}`); }
    });
  }

  discard(): void { this.applySelection(this.selected); }

  /** Why the selected draft's recipient cannot be changed now, or null. */
  get recipientBlocker(): string | null {
    if (this.editBlocker) return this.editBlocker;
    if (this.selected?.batch_id) return 'The recipient of a product email comes from its lead.';
    return null;
  }

  openContactPicker(target: 'detail' | 'create'): void {
    if (target === 'detail') {
      if (this.recipientBlocker || this.busy) return;
      if (this.dirty) { this.toast.emit('Save or discard your changes before changing the recipient.'); return; }
    }
    this.picker = target;
  }

  onContactPicked(c: PickedContact): void {
    const target = this.picker;
    this.picker = null;
    // Choosing a contact in the picker is itself an intentional choice, even from "All contacts".
    if (target === 'create') { this.contact = c; this.manualRecipient = null; this.keptMismatch = true; return; }
    if (target === 'detail') this.changeRecipient({ lead_id: c.id }, c.name);
  }

  onManualRecipient(m: { name: string; email: string }): void {
    const target = this.picker;
    this.picker = null;
    if (target === 'create') { this.manualRecipient = m; this.contact = null; return; }
    if (target === 'detail') this.changeRecipient({ recipient_email: m.email, recipient_name: m.name }, m.email);
  }

  /** Saves the new recipient on the server (lead link or a typed address); approval must be given again. */
  private changeRecipient(body: { lead_id?: number; recipient_email?: string; recipient_name?: string }, label: string): void {
    const d = this.selected;
    if (!d || this.busy) return;
    if (d.status === 'Approved' && !confirm(`Change the recipient to ${label}? The draft will need approval again.`)) return;
    this.busy = 'recipient';
    this.api.updateMailDraft(d.id, body).subscribe({
      next: (res: any) => { this.busy = null; this.toast.emit(d.status === 'Approved' ? `Recipient changed to ${label}. Approve the draft again before sending.` : `Recipient changed to ${label}.`); this.afterChange(res.draft); },
      error: (err: any) => { this.busy = null; this.toast.emit(`Recipient not changed: ${this.apiError(err)}`); }
    });
  }

  get filledPlaceholders(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.placeholderValues).map(([k, v]) => [k, String(v).trim()]).filter(([, v]) => v));
  }

  fillPlaceholders(): void {
    const replacements = this.filledPlaceholders;
    if (!Object.keys(replacements).length) { this.toast.emit('Type a value for each placeholder first.'); return; }
    if (this.dirty) { this.toast.emit('Save or discard your other changes first.'); return; }
    this.busy = 'fill';
    this.api.updateMailDraft(this.selected.id, { replacements }).subscribe({
      next: (res: any) => { this.busy = null; this.toast.emit('Placeholders filled.'); this.afterChange(res.draft); },
      error: (err: any) => { this.busy = null; this.toast.emit(`Not saved: ${this.apiError(err)}`); }
    });
  }

  rewrite(instruction: string): void {
    if (this.busy || this.locked) return;
    if (this.dirty && !confirm('Rewriting replaces your unsaved changes. Continue?')) return;
    this.busy = 'rewrite';
    this.api.rewriteMailDraft(this.selected.id, instruction).subscribe({
      next: (res: any) => { this.busy = null; this.toast.emit(res.message); this.afterChange(res.draft); },
      error: (err: any) => { this.busy = null; this.toast.emit(`Rewrite failed: ${this.apiError(err)}`); }
    });
  }

  approve(): void {
    if (this.busy || this.sendBlocker) return;
    this.busy = 'approve';
    this.api.approveMailDraft(this.selected.id).subscribe({
      next: (res: any) => { this.busy = null; this.toast.emit(res.message); this.afterChange(res.draft); },
      error: (err: any) => { this.busy = null; this.toast.emit(`Not approved: ${this.apiError(err)}`); }
    });
  }

  /** Always asks first; an unapproved draft is approved, then sent. Never retried automatically. */
  send(): void {
    const d = this.selected;
    if (!d || this.busy || this.sendBlocker || this.deliveryBlocker) return;
    const verb = d.status === 'Approved' ? 'Send' : 'Approve and send';
    if (!confirm(`${verb} "${d.subject}" to ${d.recipient_email} now? This cannot be undone.`)) return;
    this.busy = 'send';
    this.lastOutcome = null;
    const doSend = () => this.api.sendMailDraft(d.id, true).subscribe({
      next: (res: any) => { this.busy = null; this.toast.emit(res.message); this.sent.emit(); this.refreshAfterSend(d.id); },
      error: (err: any) => {
        this.busy = null;
        const code = err?.error?.code;
        const unknown = code === 'MAIL_OUTCOME_UNKNOWN' || code === 'MAIL_SENT_NOT_RECORDED';
        this.lastOutcome = unknown
          ? { kind: 'unknown', text: `${this.apiError(err)} The email may have been delivered. Check the recipient's mailbox before doing anything else; it is never resent automatically.` }
          : { kind: 'error', text: `Not sent: ${this.apiError(err)}` };
        this.refreshAfterSend(d.id);
      }
    });
    if (d.status === 'Approved') { doSend(); return; }
    this.api.approveMailDraft(d.id).subscribe({
      next: () => doSend(),
      error: (err: any) => { this.busy = null; this.lastOutcome = { kind: 'error', text: `Not sent: ${this.apiError(err)}` }; }
    });
  }

  private refreshAfterSend(id: number): void {
    const outcome = this.lastOutcome;
    this.load(id);
    this.changed.emit();
    // Keep the send result visible after the list reloads.
    setTimeout(() => { if (this.selected?.id === id) this.lastOutcome = outcome; });
  }

  resolve(outcome: 'sent' | 'not_sent'): void {
    const d = this.selected;
    const q = outcome === 'sent'
      ? `Mark "${d.subject}" as sent? Only if you confirmed it reached ${d.recipient_email}.`
      : `Mark "${d.subject}" as NOT sent? Only if you checked it did not reach ${d.recipient_email}. You can then send it again yourself.`;
    if (!confirm(q)) return;
    this.busy = 'resolve';
    this.api.resolveMailDraft(d.id, outcome).subscribe({
      next: (res: any) => { this.busy = null; this.toast.emit(res.message); this.afterChange(res.draft); },
      error: (err: any) => { this.busy = null; this.toast.emit(this.apiError(err)); }
    });
  }

  remove(): void {
    const d = this.selected;
    if (!d || this.busy) return;
    if (!confirm(`Delete the draft "${d.subject}"? This cannot be undone.`)) return;
    this.busy = 'delete';
    this.api.deleteMailDraft(d.id).subscribe({
      next: () => { this.busy = null; this.toast.emit('Draft deleted.'); this.applySelection(null); this.mobileView = 'list'; this.load(); this.changed.emit(); },
      error: (err: any) => { this.busy = null; this.toast.emit(`Not deleted: ${this.apiError(err)}`); }
    });
  }

  private afterChange(draft: any): void {
    this.drafts = this.drafts.map(x => (x.id === draft.id ? draft : x));
    this.applySelection(draft);
    this.changed.emit();
  }

  /** The selected draft's contact is not linked (in Leads CRM) to the draft's product. Shown, never auto-replaced. */
  get detailMismatch(): boolean {
    const d = this.selected;
    if (!d?.contact || d.contact.missing || d.product_id == null) return false;
    return Number(d.contact.productId ?? 0) !== Number(d.product_id);
  }

  // ---------- create modal ----------
  /** The new draft's contact is not linked to the chosen product. Generic drafts (no product) never mismatch. */
  get contactMismatch(): boolean {
    return !!(this.contact && this.form.productId !== null && (this.contact.productId ?? null) !== this.form.productId);
  }

  /** A product change left an incompatible contact in place; the user must keep it or choose another. */
  get contactDecisionNeeded(): boolean { return this.contactMismatch && !this.keptMismatch; }

  setFormProduct(id: number | null): void {
    if (this.form.productId === id) return;
    this.form.productId = id;
    this.keptMismatch = false;
  }

  keepContact(): void { this.keptMismatch = true; }

  private blankForm() {
    return { productId: null as number | null, goal: '', tone: 'Professional' };
  }

  get createDirty(): boolean {
    const f = this.form;
    return !!(f.productId || f.goal.trim() || this.contact || this.manualRecipient || this.template || f.tone !== 'Professional');
  }

  openCreate(): void {
    this.form = this.blankForm();
    this.productQuery = '';
    this.contact = null;
    this.keptMismatch = false;
    this.manualRecipient = null;
    this.template = null;
    this.createError = null;
    this.showCreate = true;
  }

  closeCreate(force = false): void {
    if (this.generating) return;
    if (!force && this.createDirty && !confirm('Close without creating the draft? What you entered will be lost.')) return;
    this.showCreate = false;
    this.showTemplatePicker = false;
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.showTemplatePicker || this.picker) return; // the open picker handles Escape itself
    if (this.showCreate) this.closeCreate();
  }

  get filteredProducts(): any[] {
    const q = this.productQuery.trim().toLowerCase();
    return (this.products || []).filter(p => !q || String(p.name || '').toLowerCase().includes(q));
  }

  productName(id: number | null): string {
    return (this.products || []).find(p => p.id === id)?.name || '';
  }

  onTemplatePicked(t: any): void {
    this.showTemplatePicker = false;
    this.template = { id: t.id, name: t.name };
  }

  generate(): void {
    if (this.generating) return;
    if (this.contactDecisionNeeded) { this.createError = 'The selected contact is not linked to this product. Keep the contact or choose another one.'; return; }
    const f = this.form;
    // The recipient is only ever the contact picked here or the address explicitly typed; never guessed.
    const recipient = this.contact
      ? { leadId: this.contact.id, recipientName: '', recipientEmail: '' }
      : (this.manualRecipient ? { recipientName: this.manualRecipient.name, recipientEmail: this.manualRecipient.email } : { recipientName: '', recipientEmail: '' });
    this.generating = true;
    this.createError = null;
    this.api.generateMailDraft({ productId: f.productId ?? undefined, goal: f.goal.trim(), tone: f.tone, ...recipient, templateId: this.template?.id ?? undefined } as any).subscribe({
      next: (res: any) => {
        this.generating = false;
        this.showCreate = false;
        this.toast.emit(res.message || 'Draft created. Review it before sending.');
        this.statusFilter = 'all';
        this.query = '';
        if (res.draft) {
          this.drafts = [res.draft, ...this.drafts.filter(d => d.id !== res.draft.id)];
          this.applySelection(res.draft);
          this.mobileView = 'detail';
        }
        this.load(res.draft?.id ?? null);
        this.changed.emit();
      },
      error: (err: any) => { this.generating = false; this.createError = this.apiError(err); }
    });
  }

  apiError(err: any): string {
    return err?.error?.error || err?.message || 'Request failed';
  }
}
