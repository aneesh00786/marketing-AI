import { Component, EventEmitter, Input, OnInit, Output, HostListener, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IconComponent } from '../../shared/icon.component';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { apiRoot } from '../../core/api-base';
import { ZohoCampaignsComponent } from './zoho-campaigns.component';
import { TemplatePickerComponent } from './template-picker.component';
import { EmailPreviewComponent } from './email-preview.component';
import { EmailContentEditorComponent } from './email-content-editor.component';
import { EmailPreviewComponent as ThumbPreview } from './email-preview.component';
import { CampaignMetricsComponent } from './campaign-metrics.component';

/**
 * Email campaigns: written, validated, approved and sent from Marketech.ai; delivered by Zoho.
 * Recipients are Zoho mailing lists chosen here (their contacts and consent live in Zoho).
 * The server enforces permissions; controls are only hidden here.
 */
@Component({
  selector: 'app-email-campaigns',
  standalone: true,
  imports: [CommonModule, IconComponent, FormsModule, ZohoCampaignsComponent, TemplatePickerComponent, EmailContentEditorComponent, ThumbPreview, CampaignMetricsComponent],
  templateUrl: './email-campaigns.component.html',
  styleUrls: ['../command/command-center.component.css', './mail-ui.css', './email-campaigns.component.css']
})
export class EmailCampaignsComponent implements OnInit {
  @Input() oauthResult: { zoho?: string; reason?: string } | null = null;
  /** Set by Email Templates → "New campaign": creates a campaign from that template. */
  @Input() set startTemplate(t: { id: number; name: string } | null) {
    if (t && t.id) this.newFromTemplate(t);
  }
  @Output() toast = new EventEmitter<string>();
  /** Open Settings → Zoho Campaigns (where the Zoho API credentials are entered). */
  @Output() openSettings = new EventEmitter<void>();

  private base = `${apiRoot()}/api/v1/mail/campaigns`;
  zoho: any = null;
  campaigns: any[] = [];
  selected: any = null;      // the campaign being edited/viewed (full)
  form: any = null;          // editable copy
  audiences: { lists: any[]; topics: any[] } | null = null;
  validation: any = null;
  busy = '';
  error = '';
  // 'new': create a campaign from a template; 'load': replace this campaign's content with one.
  picker: 'new' | 'load' | null = null;
  // Campaign list: search, status filter, sort, and the per-item menu (all client-side).
  listQuery = '';
  listStatus = '';
  listSort: 'newest' | 'oldest' | 'name' = 'newest';
  menuFor: number | null = null;
  showCreateMenu = false;
  /** The saved values of the open campaign, to tell when the form has unsaved changes. */
  private original = '';
  @ViewChild(ZohoCampaignsComponent) private zohoPanel?: ZohoCampaignsComponent;

  constructor(private http: HttpClient) {}

  ngOnInit(): void { this.load(); }

  get canCompose(): boolean { return !!this.zoho?.canCompose; }
  get canSend(): boolean { return !!this.zoho?.canSend; }
  get zohoReady(): boolean { return !!this.zoho?.connection?.connected && !(this.zoho?.connection?.missingScopes || []).length; }
  get selectedListNames(): string { return (this.selected?.lists || []).map((l: any) => l.name || l.key).join(', '); }
  get editable(): boolean { return !!this.selected && ['draft', 'approved', 'failed'].includes(this.selected.status) && this.canCompose; }

  onZohoStatus(s: any): void {
    this.zoho = s;
    if (this.zohoReady && this.canCompose && !this.audiences) this.loadAudiences();
  }

  load(): void {
    // thumbs=1: the start of each campaign's HTML for the list thumbnails (capped by the server).
    this.http.get<any>(this.base, { params: { thumbs: '1' } }).subscribe({
      next: r => { this.campaigns = r.campaigns; },
      error: e => this.error = this.err(e)
    });
  }

  loadAudiences(): void {
    this.http.get<any>(`${this.base}/audiences`).subscribe({
      next: r => { this.audiences = { lists: r.lists, topics: r.topics }; },
      error: e => { this.audiences = null; this.error = this.err(e); }
    });
  }

  newCampaign(): void {
    if (!this.confirmDiscard()) return;
    this.busy = 'create';
    this.http.post<any>(this.base, { name: 'Untitled campaign', html: '<p>Hello,</p>\n<p></p>\n<p><a href="$[LI:UNSUBSCRIBE]$">Unsubscribe</a></p>' }).subscribe({
      next: r => { this.busy = ''; this.open(r.campaign); this.load(); },
      error: e => { this.busy = ''; this.toast.emit(this.err(e)); }
    });
  }

  // ---------- Campaign list ----------
  get visibleCampaigns(): any[] {
    const q = this.listQuery.trim().toLowerCase();
    const list = this.campaigns.filter(c => (!this.listStatus || c.status === this.listStatus)
      && (!q || `${c.name || ''} ${c.subject || ''}`.toLowerCase().includes(q)));
    const at = (c: any) => String(c.updatedAt || c.createdAt || '');
    if (this.listSort === 'name') return list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return list.sort((a, b) => this.listSort === 'oldest' ? at(a).localeCompare(at(b)) : at(b).localeCompare(at(a)));
  }

  /** Tag/dot tone for a campaign status (the label always says the status too). */
  tone(s: string): string {
    if (s === 'submitted') return 'good';
    if (s === 'approved') return 'info';
    if (s === 'failed' || s === 'needs_review') return 'bad';
    if (s === 'submitting') return 'warn';
    return '';
  }

  canDelete(c: any): boolean { return this.canCompose && ['draft', 'approved', 'failed'].includes(c.status); }

  toggleMenu(id: number, ev: Event): void { ev.stopPropagation(); this.menuFor = this.menuFor === id ? null : id; }

  @HostListener('document:click') closeMenu(): void { this.menuFor = null; this.showCreateMenu = false; }
  @HostListener('document:keydown.escape') escMenu(): void { this.menuFor = null; this.showCreateMenu = false; }

  /** The recipient-lists "Connect Zoho" button uses the same connect flow as the Zoho panel. */
  connectZoho(): void { this.zohoPanel?.connect(); }

  /** A copy of the template's HTML goes into the campaign; the template itself is not changed. */
  onTemplatePicked(t: any): void {
    const mode = this.picker;
    this.picker = null;
    if (mode === 'new') {
      this.newFromTemplate(t);
    } else if (mode === 'load' && this.form) {
      if (this.form.html.trim() && !confirm('Replace this campaign\'s content with the template? Save afterwards; an approved campaign must be approved again.')) return;
      this.form.html = t.html;
      this.toast.emit(`Loaded "${t.name}". Review it, then Save.`);
    }
  }

  newFromTemplate(t: { id: number; name: string }): void {
    if (!this.confirmDiscard()) return;
    this.busy = 'create';
    this.http.post<any>(this.base, { name: String(t.name).slice(0, 150), templateId: t.id }).subscribe({
      next: r => { this.busy = ''; this.open(r.campaign); this.load(); this.toast.emit('Campaign created from the template.'); },
      error: e => { this.busy = ''; this.toast.emit(this.err(e)); }
    });
  }

  open(c: any): void {
    if (this.selected?.id !== c.id && !this.confirmDiscard()) return;
    this.http.get<any>(`${this.base}/${c.id}`).subscribe({
      next: r => this.setSelected(r.campaign),
      error: e => this.toast.emit(this.err(e))
    });
  }

  private setSelected(c: any): void {
    this.selected = c;
    this.validation = null;
    this.form = {
      name: c.name, subject: c.subject || '', fromName: c.fromName || '', fromEmail: c.fromEmail || '', html: c.html || '',
      topicId: c.topicId || '', listKeys: new Set((c.lists || []).map((l: any) => l.key))
    };
    this.original = this.snapshot();
  }

  private snapshot(): string {
    const f = this.form;
    return f ? JSON.stringify([f.name, f.subject, f.fromName, f.fromEmail, f.html, f.topicId, [...f.listKeys].sort()]) : '';
  }

  /** True when the open campaign has edits that are not saved yet. */
  get dirty(): boolean { return !!this.form && this.editable && this.snapshot() !== this.original; }

  /** True when nothing is unsaved, or the user agrees to discard it. */
  confirmDiscard(): boolean { return !this.dirty || confirm('Discard your unsaved changes to this campaign?'); }

  close(): void {
    if (!this.confirmDiscard()) return;
    this.selected = null;
    this.form = null;
    this.original = '';
  }

  toggleCreateMenu(ev: Event): void { ev.stopPropagation(); this.showCreateMenu = !this.showCreateMenu; this.menuFor = null; }

  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(e: BeforeUnloadEvent): void { if (this.dirty) { e.preventDefault(); e.returnValue = ''; } }

  toggleList(key: string): void {
    this.form.listKeys.has(key) ? this.form.listKeys.delete(key) : this.form.listKeys.add(key);
  }

  save(then?: () => void): void {
    const known = new Map((this.audiences?.lists || []).map((l: any) => [l.key, l.name]));
    const prior = new Map((this.selected.lists || []).map((l: any) => [l.key, l.name]));
    const body = {
      name: this.form.name, subject: this.form.subject, fromName: this.form.fromName, fromEmail: this.form.fromEmail, html: this.form.html,
      topicId: this.form.topicId || '',
      lists: [...this.form.listKeys].map((k: any) => ({ key: k, ...((known.get(k) || prior.get(k)) ? { name: String(known.get(k) || prior.get(k)).slice(0, 200) } : {}) }))
    };
    this.busy = 'save';
    this.http.patch<any>(`${this.base}/${this.selected.id}`, body).subscribe({
      next: r => { this.busy = ''; this.setSelected(r.campaign); this.load(); if (then) then(); else this.toast.emit('Saved. Approve it again before sending.'); },
      error: e => { this.busy = ''; this.toast.emit(this.err(e)); }
    });
  }

  validate(): void {
    this.busy = 'validate';
    this.http.post<any>(`${this.base}/${this.selected.id}/validate`, {}).subscribe({
      next: r => { this.busy = ''; this.validation = r.validation; },
      error: e => { this.busy = ''; this.toast.emit(this.err(e)); }
    });
  }

  approve(): void {
    this.busy = 'approve';
    this.http.post<any>(`${this.base}/${this.selected.id}/approve`, {}).subscribe({
      next: r => { this.busy = ''; this.setSelected(r.campaign); this.load(); this.toast.emit('Campaign approved.'); },
      error: e => { this.busy = ''; this.validation = e?.error?.details || this.validation; this.toast.emit(this.err(e)); }
    });
  }

  send(): void {
    const lists = (this.selected.lists || []).map((l: any) => l.name || l.key).join(', ');
    if (!confirm(`Send "${this.selected.name}" through Zoho now?\n\nRecipients: Zoho lists ${lists}.\nYour Zoho plan's sending limits apply. This cannot be undone.`)) return;
    this.busy = 'send';
    this.http.post<any>(`${this.base}/${this.selected.id}/send`, { confirm: true }).subscribe({
      next: r => { this.busy = ''; this.setSelected(r.campaign); this.load(); this.toast.emit('Zoho accepted the campaign for sending. Delivery figures appear as Zoho sends.'); },
      error: e => { this.busy = ''; this.toast.emit(this.err(e)); this.open(this.selected); this.load(); }
    });
  }

  refresh(): void {
    this.busy = 'refresh';
    this.http.post<any>(`${this.base}/${this.selected.id}/refresh`, {}).subscribe({
      next: r => { this.busy = ''; this.setSelected(r.campaign); this.load(); },
      error: e => { this.busy = ''; this.toast.emit(this.err(e)); }
    });
  }

  resolve(): void {
    if (!confirm('Only after checking: Zoho does not show this campaign as prepared or sent. Mark the last attempt as not done so it can be sent again?')) return;
    this.http.post<any>(`${this.base}/${this.selected.id}/resolve`, { confirm: true }).subscribe({
      next: r => { this.setSelected(r.campaign); this.load(); this.toast.emit('Marked as not done. You can send it again.'); },
      error: e => { this.toast.emit(this.err(e)); this.open(this.selected); }
    });
  }

  remove(): void { if (this.selected) this.removeCampaign(this.selected); }

  removeCampaign(c: any): void {
    if (!confirm(`Delete "${c.name}"?`)) return;
    this.http.delete<any>(`${this.base}/${c.id}`).subscribe({
      next: () => { if (this.selected?.id === c.id) { this.selected = null; this.form = null; this.original = ''; } this.load(); this.toast.emit('Campaign deleted.'); },
      error: e => this.toast.emit(this.err(e))
    });
  }

  statusLabel(s: string): string {
    return ({ draft: 'Draft', approved: 'Approved', submitting: 'Submitting…', submitted: 'Submitted to Zoho', failed: 'Not sent', needs_review: 'Unknown — check' } as any)[s] || s;
  }

  private err(e: any): string {
    return e?.error?.error || e?.message || 'Request failed.';
  }
}
