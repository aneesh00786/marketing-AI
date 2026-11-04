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
import { ZohoListContactsComponent } from './zoho-list-contacts.component';
import { CampaignContactsComponent } from './campaign-contacts.component';
import { CampaignContactRowsComponent } from './campaign-contact-rows.component';
import { EmailPreviewComponent as ThumbPreview } from './email-preview.component';
import { CampaignMetricsComponent } from './campaign-metrics.component';
import { ZohoListsComponent } from './zoho-lists.component';
/** Same checks as the server (campaignService PUBLIC_DOMAINS). */
const SENDER_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PUBLIC_MAIL_RE = /@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|gmx|yandex|proton|protonmail|mail|zoho|rediffmail)\.[a-z.]+$/i;
import { SAMPLE_SUBJECT, sampleCampaignHtml } from './sample-email';
import { CONTACT_FIELDS, ContactField, contactTag, fallbackExample, fallbackQuestion } from './merge-tags';

/** A sent campaign's figures are read from Zoho when it is opened, at most this often. */
const REPORT_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Email campaigns: written, validated, approved and sent from Marketech.ai; delivered by Zoho.
 * Recipients are Zoho mailing lists and contacts selected here; selected contacts are added to
 * Zoho by the server when the campaign is sent.
 * The server enforces permissions; controls are only hidden here.
 */
@Component({
  selector: 'app-email-campaigns',
  standalone: true,
  imports: [CommonModule, IconComponent, FormsModule, ZohoCampaignsComponent, TemplatePickerComponent, EmailContentEditorComponent, ThumbPreview, ZohoListContactsComponent, CampaignContactsComponent, CampaignContactRowsComponent, CampaignMetricsComponent, ZohoListsComponent],
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
  /** Open Email Templates with a new blank template ("New Campaign" menu → New email template). */
  @Output() createTemplate = new EventEmitter<void>();

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
  /** The open campaign's "More" menu, the Zoho connection popup and the send confirmation popup. */
  moreOpen = false;
  zohoOpen = false;
  sendConfirm: { name: string; subject: string; recipients: string } | null = null;
  /** Guided editing: 1 Details, 2 Recipients, 3 Email content, 4 Review & send. */
  readonly steps = [
    { n: 1, title: 'Details' }, { n: 2, title: 'Recipients' }, { n: 3, title: 'Email content' }, { n: 4, title: 'Review & send' }
  ];
  step = 1;
  /** The Zoho mailing list whose contacts are being viewed. */
  contactsList: any = null;
  /** The saved selection once loaded, and the part picked from each Zoho list (shown on its row). */
  allContacts: any[] | null = null;
  picksByList = new Map<string, any[]>();
  /** The saved values of the open campaign, to tell when the form has unsaved changes. */
  private original = '';
  @ViewChild(ZohoCampaignsComponent) private zohoPanel?: ZohoCampaignsComponent;
  @ViewChild(CampaignContactsComponent) private contactsPanel?: CampaignContactsComponent;

  constructor(private http: HttpClient) {}

  ngOnInit(): void { this.load(); }

  get canCompose(): boolean { return !!this.zoho?.canCompose; }
  get canSend(): boolean { return !!this.zoho?.canSend; }
  get zohoReady(): boolean { return !!this.zoho?.connection?.connected && !(this.zoho?.connection?.missingScopes || []).length; }
  get canSyncContacts(): boolean { return this.zoho?.connection?.canSyncContacts !== false; }
  /** Contacts can be picked inside a Zoho list only while this campaign's recipients can change. */
  get canPickFromZoho(): boolean { return this.editable && this.canSend && this.canSyncContacts; }
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

  /**
   * Blank: a short email with an unsubscribe link. Sample: a ready-made layout (greeting with the
   * contact's name, offer, button, footer) whose [bracketed] parts must be filled in before approval.
   */
  newCampaign(kind: 'blank' | 'sample' = 'blank'): void {
    if (!this.confirmDiscard()) return;
    this.busy = 'create';
    const body = kind === 'sample'
      ? { name: 'Sample campaign', subject: SAMPLE_SUBJECT, html: sampleCampaignHtml(this.workspaceName()) }
      : { name: 'Untitled campaign', html: '<p>Hello,</p>\n<p></p>\n<p><a href="$[LI:UNSUBSCRIBE]$">Unsubscribe</a></p>' };
    this.http.post<any>(this.base, body).subscribe({
      next: r => {
        this.busy = ''; this.open(r.campaign); this.load();
        if (kind === 'sample') this.toast.emit('Sample email added. Replace the [bracketed] text and the button link, then review it in Email content.');
      },
      error: e => { this.busy = ''; this.toast.emit(this.err(e)); }
    });
  }

  private workspaceName(): string {
    try { return String(JSON.parse(localStorage.getItem('tradesage_workspace') || '{}')?.name || ''); } catch { return ''; }
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

  @HostListener('document:click') closeMenu(): void { this.menuFor = null; this.showCreateMenu = false; this.moreOpen = false; }
  @HostListener('document:keydown.escape') escMenu(): void { this.menuFor = null; this.showCreateMenu = false; this.moreOpen = false; this.zohoOpen = false; this.sendConfirm = null; }

  toggleMore(ev: Event): void { ev.stopPropagation(); this.moreOpen = !this.moreOpen; this.menuFor = null; this.showCreateMenu = false; }

  // ---------- Steps ----------
  get hasContent(): boolean { return !!String(this.form?.html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').trim(); }
  /** Selected contacts that are not already covered by a ticked list. */
  get extraContacts(): number {
    const keys = this.form ? this.form.listKeys as Set<string> : new Set<string>();
    return this.allContacts ? this.allContacts.filter(c => c.eligible && !keys.has(c.sourceListKey)).length : (this.selected?.contactCount ?? 0);
  }
  get recipientSummary(): string {
    const lists = this.form ? this.form.listKeys.size : 0;
    const people = this.extraContacts;
    return [lists && `${lists} Zoho list${lists === 1 ? '' : 's'}`, people && `${people} contact${people === 1 ? '' : 's'}`].filter(Boolean).join(' + ');
  }
  get fromText(): string {
    const f = this.form || {};
    if (!f.fromName && !f.fromEmail) return 'Zoho account default';
    return f.fromName && f.fromEmail ? `${f.fromName} <${f.fromEmail}>` : (f.fromName || f.fromEmail);
  }
  stepDone(n: number): boolean {
    if (!this.form) return false;
    if (n === 1) return !!String(this.form.name || '').trim() && !!String(this.form.subject || '').trim();
    if (n === 2) return !!this.recipientSummary;
    if (n === 3) return this.hasContent;
    return !!this.selected?.approved || ['submitted', 'submitting'].includes(this.selected?.status);
  }
  stepHint(n: number): string {
    if (n === 1) return this.stepDone(1) ? 'Name and subject set' : 'Name and subject';
    if (n === 2) return this.recipientSummary || 'Lists or leads';
    if (n === 3) return this.hasContent ? 'Content added' : 'Design the email';
    if (this.selected?.status === 'submitted') return 'Sent';
    if (this.selected?.approved) return 'Approved, ready to send';
    return 'Check and approve';
  }
  /** The check found [placeholders] or the sample link: step 3 has a box for each. */
  get hasFillProblems(): boolean {
    return !!this.validation?.problems?.some((p: string) => p.startsWith('Replace the placeholders') || p.includes('sample link'));
  }

  goStep(n: number): void {
    if (n < 1 || n > 4) return;
    this.step = n;
    // Arriving at Review runs the checks, so problems show without an extra click.
    if (n === 4 && this.selected && !this.validation && this.busy !== 'validate') this.validate();
  }
  /** Campaigns, or Zoho Campaigns → Contact lists. */
  view: 'campaigns' | 'lists' = 'campaigns';

  // ---------- Sender ("From"), picked like Zoho's sender address dropdown ----------
  /** True while a new sender address is being typed. */
  senderAdding = false;
  newSender = '';
  senderError = '';

  /**
   * Sender addresses grouped by domain, as in Zoho. Zoho's API cannot list verified senders, so
   * these are the addresses used in this workspace's campaigns: each with the last sender name
   * used with it and whether Zoho has accepted a campaign from it (which shows it is verified).
   */
  get senderGroups(): { domain: string; items: { email: string; name: string; sentBefore: boolean }[] }[] {
    const seen = new Map<string, { email: string; name: string; sentBefore: boolean }>();
    for (const c of this.campaigns || []) {
      const email = String(c?.fromEmail || '').trim().toLowerCase();
      if (!SENDER_RE.test(email) || PUBLIC_MAIL_RE.test(email)) continue;
      const s = seen.get(email) || { email, name: '', sentBefore: false };
      if (!s.name && c.fromName) s.name = String(c.fromName);
      if (c.status === 'submitted') s.sentBefore = true;
      seen.set(email, s);
    }
    const current = String(this.form?.fromEmail || '').trim().toLowerCase();
    if (current && !seen.has(current)) seen.set(current, { email: current, name: '', sentBefore: false });
    const groups = new Map<string, { email: string; name: string; sentBefore: boolean }[]>();
    for (const s of seen.values()) {
      const d = s.email.split('@')[1] || '';
      groups.set(d, [...(groups.get(d) || []), s]);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([domain, items]) => ({ domain, items: items.sort((a, b) => a.email.localeCompare(b.email)) }));
  }

  /** The picked sender, with what is known about it. */
  get currentSender(): { email: string; name: string; sentBefore: boolean } | null {
    const e = String(this.form?.fromEmail || '').trim().toLowerCase();
    if (!e) return null;
    for (const g of this.senderGroups) for (const s of g.items) if (s.email === e) return s;
    return null;
  }

  /** Picking an address also fills in the sender name last used with it, when none is typed. */
  pickSender(value: string, sel?: HTMLSelectElement): void {
    if (!this.editable || !this.form) return;
    if (value === '__add') {
      this.senderAdding = true; this.newSender = ''; this.senderError = '';
      if (sel) sel.value = this.form.fromEmail || '';
      return;
    }
    this.form.fromEmail = value;
    const s = this.currentSender;
    if (s?.name && !String(this.form.fromName || '').trim()) this.form.fromName = s.name;
  }

  /** "Add sender address": checked here as Zoho would (format, no public mailbox domains). */
  addSender(): void {
    const e = String(this.newSender || '').trim().toLowerCase();
    if (!SENDER_RE.test(e)) { this.senderError = 'Enter a full email address, e.g. news@yourdomain.com.'; return; }
    if (PUBLIC_MAIL_RE.test(e)) { this.senderError = 'Zoho does not send from Gmail, Yahoo, Outlook or other public mailboxes. Use an address on your own domain.'; return; }
    if (this.form) this.form.fromEmail = e;
    this.senderAdding = false; this.newSender = ''; this.senderError = '';
  }

  readonly contactFields = CONTACT_FIELDS;
  readonly fallbackQuestion = fallbackQuestion;
  readonly fallbackExample = fallbackExample;
  /** The contact field going into the subject, waiting for its default value. */
  subjectAsk: { field: ContactField; label: string; fallback: string } | null = null;
  /** Where the cursor was when the subject box was left (-1: never clicked, the tag goes at the end). */
  subjectCaret = -1;
  private subjectAt = -1;

  /**
   * Subject "Merge tags" menu: uses the last cursor position, then asks for the default value (as Zoho
   * does). A subject is not a greeting, so the first-name default starts as "you", not "there".
   */
  pickSubjectTag(key: string, _box?: HTMLInputElement): void {
    const f = CONTACT_FIELDS.find(x => x.key === key);
    if (!f || !this.editable || !this.form) return;
    this.subjectAt = this.subjectCaret;
    this.subjectAsk = { field: f.key, label: f.label, fallback: f.key === 'first' ? 'you' : f.fallback };
  }

  /** The subject with the tag inserted at the remembered cursor position, and where the tag ends. */
  private subjectWith(tag: string): { text: string; end: number } {
    const s = String(this.form?.subject || '');
    const at = this.subjectAt >= 0 && this.subjectAt <= s.length ? this.subjectAt : s.length;
    const before = s.slice(0, at);
    const token = `${before && !/\s$/.test(before) ? ' ' : ''}${tag}`;
    const after = s.slice(at);
    return { text: (before + token + (after && !/^[\s,.!?;:]/.test(after) ? ' ' : '') + after).slice(0, 255), end: at + token.length };
  }

  /**
   * The subject as three kinds of recipient will see it, while the default value is typed:
   * a person, a business lead without a contact person, and a contact with no name at all.
   */
  get subjectPreview(): { who: string; text: string }[] {
    const ask = this.subjectAsk;
    if (!ask || !this.form) return [];
    const subject = this.subjectWith(contactTag(ask.field, ask.fallback)).text;
    const fill = (first: string | null, last: string | null) => subject
      .replace(/\$\[FNAME(?:\|([^|\]]*))?(?:\|[^\]]*)?\]\$/g, (_m, fb) => first ?? (fb || ''))
      .replace(/\$\[LNAME(?:\|([^|\]]*))?(?:\|[^\]]*)?\]\$/g, (_m, fb) => last ?? (fb || ''))
      .replace(/\s+/g, ' ').trim();
    return [
      { who: 'Priya Nair', text: fill('Priya', 'Nair') },
      { who: 'Business lead, no contact person', text: fill('Big Red Packaging team', null) },
      { who: 'No name at all', text: fill(null, null) }
    ];
  }

  /** Inserts the Zoho merge tag (e.g. $[FNAME|you]$) at the remembered cursor position. */
  confirmSubjectTag(box?: HTMLInputElement): void {
    const ask = this.subjectAsk;
    if (!ask || !this.editable || !this.form) { this.subjectAsk = null; return; }
    const { text, end } = this.subjectWith(contactTag(ask.field, ask.fallback));
    this.subjectAsk = null;
    this.form.subject = text;
    if (box) setTimeout(() => { try { box.focus(); box.setSelectionRange(end, end); } catch { /* not focusable */ } });
  }

  /** Next step; unsaved edits are saved first. */
  next(): void {
    if (this.dirty) this.save(() => this.goStep(this.step + 1));
    else this.goStep(this.step + 1);
  }

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
      next: r => { this.setSelected(r.campaign); this.refreshReport(r.campaign); },
      error: e => this.toast.emit(this.err(e))
    });
  }

  /** Quietly updates the figures: if Zoho cannot be reached, the last ones stay on screen. */
  private refreshReport(c: any): void {
    if (c.status !== 'submitted') return;
    if (c.lastCheckedAt && Date.now() - new Date(c.lastCheckedAt).getTime() < REPORT_MAX_AGE_MS) return;
    this.http.post<any>(`${this.base}/${c.id}/refresh`, {}).subscribe({
      next: r => { if (this.selected?.id === c.id) this.selected = r.campaign; this.load(); },
      error: () => {}
    });
  }

  private setSelected(c: any): void {
    const fresh = this.selected?.id !== c.id;
    if (fresh) { this.onContacts(null); this.subjectCaret = -1; this.subjectAsk = null; this.senderAdding = false; this.senderError = ''; }
    this.selected = c;
    this.validation = null;
    this.form = {
      name: c.name, subject: c.subject || '', fromName: c.fromName || '', fromEmail: c.fromEmail || '', html: c.html || '',
      topicId: c.topicId || '', listKeys: new Set((c.lists || []).map((l: any) => l.key))
    };
    this.original = this.snapshot();
    if (fresh) this.step = this.editable ? 1 : 4;
  }

  onContacts(list: any[] | null): void {
    this.allContacts = list;
    this.picksByList = new Map();
    for (const c of list || []) {
      if (c.sourceListKey) this.picksByList.set(c.sourceListKey, [...(this.picksByList.get(c.sourceListKey) || []), c]);
    }
  }

  removeContact(c: any): void { this.contactsPanel?.remove(c); }

  /** Selected contacts are saved at once: the campaign changed, but form edits are kept. */
  onCampaignChanged(c: any): void {
    this.selected = c;
    this.validation = null;
    this.load();
  }

  onZohoContactsAdded(r: any): void {
    this.contactsPanel?.apply(r);
    this.onCampaignChanged(r.campaign);
    const refused = r.refused ? ` ${r.refused} could not be added (unsubscribed or blocked).` : '';
    this.toast.emit(`${r.added} contact${r.added === 1 ? '' : 's'} added.${refused} Approve the campaign before sending.`);
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

  /** Who the saved campaign goes to, as shown in the send confirmation. */
  sendRecipients(): string {
    const lists = (this.selected.lists || []).map((l: any) => l.name || l.key).join(', ');
    // A ticked list already covers the contacts picked from it.
    const keys = new Set((this.selected.lists || []).map((l: any) => l.key));
    const contacts = this.allContacts ? this.allContacts.filter(c => c.eligible && !keys.has(c.sourceListKey)).length : this.selected.contactCount ?? 0;
    return [lists && `Zoho lists ${lists}`, contacts && `${contacts} selected contact${contacts === 1 ? '' : 's'} (added to Zoho first)`].filter(Boolean).join(' and ');
  }

  /** Opens the confirmation popup; nothing is sent until "Send now". */
  send(): void {
    this.sendConfirm = { name: this.selected.name, subject: this.selected.subject || '', recipients: this.sendRecipients() };
  }

  confirmSend(): void {
    if (!this.sendConfirm || this.busy === 'send') return;
    this.busy = 'send';
    this.http.post<any>(`${this.base}/${this.selected.id}/send`, { confirm: true }).subscribe({
      next: r => { this.busy = ''; this.sendConfirm = null; this.setSelected(r.campaign); this.load(); this.toast.emit('Zoho accepted the campaign for sending. Delivery figures appear as Zoho sends.'); },
      error: e => { this.busy = ''; this.sendConfirm = null; this.toast.emit(this.err(e)); this.open(this.selected); this.load(); }
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

  /** A new draft from this campaign, to send it again. The server re-checks selected contacts. */
  duplicate(c: any): void {
    if (!this.confirmDiscard()) return;
    this.busy = 'duplicate';
    this.http.post<any>(`${this.base}/${c.id}/duplicate`, {}).subscribe({
      next: r => {
        this.busy = '';
        this.setSelected(r.campaign);
        this.load();
        const dropped = r.contactsDropped ? ` ${r.contactsDropped} contact${r.contactsDropped === 1 ? ' was' : 's were'} left out because they can no longer be emailed.` : '';
        this.toast.emit(`Copy created as a draft.${dropped}`);
      },
      error: e => { this.busy = ''; this.toast.emit(this.err(e)); }
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
