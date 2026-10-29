import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IconComponent } from '../../shared/icon.component';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { apiRoot } from '../../core/api-base';
import { ZohoCampaignsComponent } from './zoho-campaigns.component';
import { TemplatePickerComponent } from './template-picker.component';
import { EmailPreviewComponent } from './email-preview.component';
import { CampaignMetricsComponent } from './campaign-metrics.component';

/**
 * Email campaigns: written, validated, approved and sent from Marketech.ai; delivered by Zoho.
 * Recipients are Zoho mailing lists chosen here (their contacts and consent live in Zoho).
 * The server enforces permissions; controls are only hidden here.
 */
@Component({
  selector: 'app-email-campaigns',
  standalone: true,
  imports: [CommonModule, IconComponent, FormsModule, ZohoCampaignsComponent, TemplatePickerComponent, EmailPreviewComponent, CampaignMetricsComponent],
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
  /** Email content panel: edit the HTML source or preview it (both use form.html; nothing is saved). */
  contentMode: 'edit' | 'preview' = 'edit';
  previewWidth: 'desktop' | 'mobile' = 'desktop';

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
    this.http.get<any>(this.base).subscribe({
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
    this.busy = 'create';
    this.http.post<any>(this.base, { name: 'Untitled campaign', html: '<p>Hello,</p>\n<p></p>\n<p><a href="$[LI:UNSUBSCRIBE]$">Unsubscribe</a></p>' }).subscribe({
      next: r => { this.busy = ''; this.open(r.campaign); this.load(); },
      error: e => { this.busy = ''; this.toast.emit(this.err(e)); }
    });
  }

  setMode(m: 'edit' | 'preview'): void { this.contentMode = m; }

  /** Left/Right arrows switch between Edit and Preview (tabs pattern). */
  onModeKey(ev: KeyboardEvent): void {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    ev.preventDefault();
    const next = this.contentMode === 'edit' ? 'preview' : 'edit';
    this.setMode(next);
    setTimeout(() => (document.getElementById(`ec-mode-${next}`) as HTMLElement | null)?.focus());
  }

  /** Inserts Zoho's unsubscribe link at the cursor (only edits the unsaved content). */
  insertUnsubscribe(box: HTMLTextAreaElement): void {
    if (!this.form || !this.editable) return;
    if (this.form.html.includes('$[LI:UNSUBSCRIBE]$')) { this.toast.emit('The unsubscribe link is already in the content.'); return; }
    const link = '<p><a href="$[LI:UNSUBSCRIBE]$">Unsubscribe</a></p>';
    const at = typeof box?.selectionStart === 'number' ? box.selectionStart : this.form.html.length;
    this.form.html = this.form.html.slice(0, at) + link + this.form.html.slice(at);
  }

  /** Reminders while editing (the server's validation is unchanged and still decides). */
  get contentHints(): string[] {
    const html = this.form?.html || '';
    const out: string[] = [];
    if (!html.trim()) return ['Add the email content: write HTML or choose a template.'];
    if (!html.includes('$[LI:UNSUBSCRIBE]$')) out.push('No unsubscribe link yet: Zoho requires $[LI:UNSUBSCRIBE]$.');
    if (/<img\b[^>]*\bsrc\s*=\s*["']?http:\/\//i.test(html)) out.push('Some images use http://. Use https:// image URLs so they load for recipients.');
    return out;
  }

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
    this.busy = 'create';
    this.http.post<any>(this.base, { name: String(t.name).slice(0, 150), templateId: t.id }).subscribe({
      next: r => { this.busy = ''; this.open(r.campaign); this.load(); this.toast.emit('Campaign created from the template.'); },
      error: e => { this.busy = ''; this.toast.emit(this.err(e)); }
    });
  }

  open(c: any): void {
    this.http.get<any>(`${this.base}/${c.id}`).subscribe({
      next: r => this.setSelected(r.campaign),
      error: e => this.toast.emit(this.err(e))
    });
  }

  private setSelected(c: any): void {
    this.selected = c;
    this.validation = null;
    // Edit by default; a campaign that can no longer be edited opens on its preview.
    this.contentMode = this.editable ? 'edit' : 'preview';
    this.previewWidth = 'desktop';
    this.form = {
      name: c.name, subject: c.subject || '', fromName: c.fromName || '', fromEmail: c.fromEmail || '', html: c.html || '',
      topicId: c.topicId || '', listKeys: new Set((c.lists || []).map((l: any) => l.key))
    };
  }

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

  remove(): void {
    if (!confirm(`Delete "${this.selected.name}"?`)) return;
    this.http.delete<any>(`${this.base}/${this.selected.id}`).subscribe({
      next: () => { this.selected = null; this.form = null; this.load(); this.toast.emit('Campaign deleted.'); },
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
