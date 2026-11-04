import { Component, EventEmitter, HostListener, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { apiRoot } from '../../core/api-base';
import { IconComponent } from '../../shared/icon.component';
import { parseLeadSheet, LeadSheetRow } from '../leads/lead-sheet';
import { ImportSync, importSyncBody, importSyncProblem, newImportSync } from '../leads/import-sync';
import { ImportSyncOptionsComponent } from '../leads/import-sync-options.component';

interface ZList { key: string; name: string | null; contacts: number | null; campaignList: boolean; }
interface ManualContact { name: string; company: string; email: string; phone: string; }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const emptyContact = (): ManualContact => ({ name: '', company: '', email: '', phone: '' });

interface LeadOpt { id: number; name: string; email: string; company?: string | null; eligible?: boolean; reasons?: string[]; }

/**
 * Zoho Campaigns → Contact lists, like Zoho's "Manage Lists": every mailing list with its contact
 * count, a new list, adding contacts (your leads or typed addresses) and removing contacts.
 * Lists Marketech.ai made for a campaign are hidden unless asked for. Deleting and renaming a list
 * stay in Zoho (see zohoLists.js on the server).
 */
@Component({
  selector: 'app-zoho-lists',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, ImportSyncOptionsComponent],
  templateUrl: './zoho-lists.component.html',
  styleUrls: ['../command/command-center.component.css', './mail-ui.css', './zoho-lists.component.css']
})
export class ZohoListsComponent implements OnInit {
  /** Zoho is connected with the scopes campaigns need. */
  @Input() zohoReady = false;
  /** The user may change recipients (mail.send). */
  @Input() canManage = false;
  /** May set the Zoho plan's contact limit (mail.configure). */
  @Input() canConfigure = false;
  @Output() toast = new EventEmitter<string>();
  /** Opens the Zoho connection popup (connect or reconnect). */
  @Output() openZoho = new EventEmitter<void>();

  private base = `${apiRoot()}/api/v1/mail/campaigns`;
  lists: ZList[] = [];
  loading = false;
  error = '';
  canAdd = false;
  canRemove = false;
  query = '';
  showCampaignLists = false;

  /** The add / new-list popup. */
  form: { mode: 'create' | 'add'; list: ZList | null; name: string; emails: string; manual: ManualContact[]; draft: ManualContact; picked: Map<number, LeadOpt>; skipped: { email: string; reason: string }[] } | null = null;
  leadOptions: LeadOpt[] = [];
  leadsLoading = false;
  saving = false;

  /** The contacts popup. */
  viewing: { list: ZList; status: 'subscribed' | 'unsubscribed' | 'bounced'; page: number; pageSize: number; contacts: any[]; hasMore: boolean; loading: boolean } | null = null;
  removing = '';

  constructor(private http: HttpClient) {}

  ngOnInit(): void { if (this.zohoReady) this.load(); }

  load(): void {
    this.loading = true; this.error = '';
    this.http.get<any>(`${this.base}/zoho-lists`).subscribe({
      next: r => { this.loading = false; this.lists = r.lists || []; this.canAdd = !!r.canAdd; this.canRemove = !!r.canRemove; this.plan = r.plan || null; },
      error: e => { this.loading = false; this.error = this.err(e); }
    });
  }

  // ---------- Zoho plan: contact limit and usage ----------
  plan: { contactLimit: number | null; usage: { upTo: number; atLeast: number } } | null = null;
  limitEdit: string | null = null;
  limitSaving = false;

  /** Share of the limit the lists may already use (upper bound), for the bar. */
  get usagePct(): number {
    const p = this.plan;
    return p?.contactLimit ? Math.min(100, Math.round((p.usage.upTo / p.contactLimit) * 100)) : 0;
  }

  /** A warning when adding `adding` new addresses could go over the plan ('' when it cannot). */
  limitWarning(adding: number): string {
    const p = this.plan;
    if (!p?.contactLimit || !adding) return '';
    const after = p.usage.upTo + adding;
    if (after <= p.contactLimit) return '';
    const room = Math.max(0, p.contactLimit - p.usage.atLeast);
    return `Your Zoho plan allows ${p.contactLimit.toLocaleString('en-US')} contacts and your lists already hold up to ${p.usage.upTo.toLocaleString('en-US')}. `
      + `Adding ${adding.toLocaleString('en-US')} may go over it (contacts already in Zoho do not count again). Zoho refuses contacts beyond the limit`
      + (room < adding ? `; there may be room for only about ${room.toLocaleString('en-US')} more.` : '.');
  }

  editLimit(): void { this.limitEdit = this.plan?.contactLimit ? String(this.plan.contactLimit) : ''; }

  saveLimit(): void {
    if (this.limitEdit === null || this.limitSaving) return;
    const t = this.limitEdit.replace(/[,\s]/g, '');
    if (t && !/^\d{1,8}$/.test(t)) { this.toast.emit('Enter the number of contacts your plan allows, e.g. 1000.'); return; }
    const value = t ? Number(t) : null;
    if (value === 0) { this.toast.emit('Enter a number above 0, or leave it empty.'); return; }
    this.limitSaving = true;
    this.http.put<any>(`${this.base}/zoho-plan`, { contactLimit: value }).subscribe({
      next: r => { this.limitSaving = false; this.limitEdit = null; if (this.plan) this.plan.contactLimit = r.contactLimit; this.toast.emit(r.contactLimit ? 'Contact limit saved.' : 'Contact limit removed.'); },
      error: e => { this.limitSaving = false; this.toast.emit(this.err(e)); }
    });
  }

  get campaignListCount(): number { return this.lists.filter(l => l.campaignList).length; }

  get visibleLists(): ZList[] {
    const q = this.query.trim().toLowerCase();
    return this.lists.filter(l => (this.showCampaignLists || !l.campaignList) && (!q || String(l.name || '').toLowerCase().includes(q)));
  }

  // ---------- New list / add contacts ----------
  openForm(mode: 'create' | 'add', list: ZList | null = null): void {
    this.form = { mode, list, name: '', emails: '', manual: [], draft: emptyContact(), picked: new Map(), skipped: [] };
    this.picker = null;
    this.loadLeads();
  }

  /** All leads for the dropdown: ones that can be added, and the rest (disabled) with the reason. */
  loadLeads(): void {
    if (!this.form) return;
    this.leadsLoading = true;
    this.http.get<any>(`${this.base}/lead-options`, { params: { pageSize: '2000' } }).subscribe({
      next: r => { this.leadsLoading = false; this.leadOptions = r.leads || []; },
      error: e => { this.leadsLoading = false; this.leadOptions = []; this.toast.emit(this.err(e)); }
    });
  }

  get addableLeads(): LeadOpt[] { return this.leadOptions.filter(l => l.eligible !== false); }
  get blockedLeads(): LeadOpt[] { return this.leadOptions.filter(l => l.eligible === false); }

  // ---------- Lead picker popup (checkboxes; applied on "Done") ----------
  picker: { query: string; sel: Set<number> } | null = null;

  openPicker(): void { this.picker = { query: '', sel: new Set(this.form?.picked.keys() || []) }; }

  /** Leads matching the filter: ones that can be added first, then the rest (disabled). */
  get pickerLeads(): LeadOpt[] {
    const q = (this.picker?.query || '').trim().toLowerCase();
    const hit = (l: LeadOpt) => !q || [l.name, l.email, l.company].some(v => String(v || '').toLowerCase().includes(q));
    return [...this.addableLeads.filter(hit), ...this.blockedLeads.filter(hit)];
  }

  get pickerShownAddable(): LeadOpt[] { return this.pickerLeads.filter(l => l.eligible !== false); }

  get pickerAllShownChecked(): boolean {
    const shown = this.pickerShownAddable;
    return !!shown.length && shown.every(l => this.picker!.sel.has(l.id));
  }

  togglePick(l: LeadOpt): void {
    if (!this.picker || l.eligible === false) return;
    if (this.picker.sel.has(l.id)) this.picker.sel.delete(l.id); else this.picker.sel.add(l.id);
  }

  toggleAllShown(): void {
    if (!this.picker) return;
    const on = !this.pickerAllShownChecked;
    for (const l of this.pickerShownAddable) on ? this.picker.sel.add(l.id) : this.picker.sel.delete(l.id);
  }

  applyPicker(): void {
    if (!this.form || !this.picker) return;
    const picked = new Map<number, LeadOpt>();
    for (const l of this.addableLeads) if (this.picker.sel.has(l.id)) picked.set(l.id, l);
    this.form.picked = picked;
    this.picker = null;
  }

  /** Typed addresses: one per line, or separated by commas, semicolons or spaces. */
  get typedEmails(): string[] {
    return [...new Set(String(this.form?.emails || '').split(/[\s,;]+/).map(e => e.trim().toLowerCase()).filter(Boolean))];
  }

  get formCount(): number { return (this.form?.picked.size || 0) + this.typedEmails.length + (this.form?.manual.length || 0); }

  // ---------- Add a contact manually (saved in Leads, then added to the list) ----------
  /** Why the typed contact cannot be added yet ('' when it can). */
  get draftProblem(): string {
    const d = this.form?.draft;
    if (!d) return '';
    if (!d.name.trim() && !d.company.trim()) return 'Enter a name or business.';
    if (!EMAIL_RE.test(d.email.trim())) return 'Enter a valid email address.';
    if (this.form!.manual.some(m => m.email === d.email.trim().toLowerCase())) return 'This email is already added below.';
    return '';
  }

  addManual(): void {
    const f = this.form;
    if (!f || this.draftProblem) return;
    const d = f.draft;
    f.manual.push({ name: d.name.trim(), company: d.company.trim(), email: d.email.trim().toLowerCase(), phone: d.phone.trim() });
    f.draft = emptyContact();
  }

  removeManual(i: number): void { this.form?.manual.splice(i, 1); }

  get formProblem(): string {
    const f = this.form;
    if (!f) return '';
    if (f.mode === 'create' && !f.name.trim()) return 'Enter a list name.';
    if (!this.formCount) return f.mode === 'create' ? 'Add at least one contact: Zoho creates a list together with its first contacts.' : 'Choose leads, add a contact or enter email addresses.';
    if (this.formCount > 500) return 'Add up to 500 contacts at a time.';
    return '';
  }

  submitForm(): void {
    const f = this.form;
    if (!f || this.saving || this.formProblem) return;
    this.saving = true;
    if (!f.manual.length) { this.sendForm(f); return; }
    // Manual contacts become leads first (an existing lead with the same email is reused), so
    // their name, business and phone are kept and shown in the list.
    const rows = f.manual.map(m => ({ name: m.name || m.company, companyName: m.company, email: m.email, phone: m.phone }));
    this.http.post<any>(`${apiRoot()}/api/v1/leads/import-bulk`, { leads: rows }).subscribe({
      next: r => {
        // They are now leads: keep them as picked, so a failed Zoho step can simply be retried.
        const ids: number[] = [...(r.leadIds || []), ...(r.duplicates || []).map((d: any) => d.leadId).filter(Boolean)];
        ids.forEach(id => f.picked.set(id, { id, name: '', email: '' }));
        f.manual = [];
        this.loadLeads();
        this.sendForm(f);
      },
      error: e => { this.saving = false; this.toast.emit(this.err(e)); }
    });
  }

  private sendForm(f: NonNullable<ZohoListsComponent['form']>): void {
    const body: any = { leadIds: [...f.picked.keys()], emails: this.typedEmails };
    if (f.mode === 'create') body.name = f.name.trim();
    const url = f.mode === 'create' ? `${this.base}/zoho-lists` : `${this.base}/zoho-lists/${encodeURIComponent(f.list!.key)}/contacts`;
    this.http.post<any>(url, body).subscribe({
      next: r => {
        this.saving = false;
        const skipped = r.skipped || [];
        const what = f.mode === 'create' ? `List “${r.list?.name}” created in Zoho with ${r.added} contact(s)` : `${r.added} contact(s) added to “${r.list?.name}”`;
        this.toast.emit(`${what}.${skipped.length ? ` ${skipped.length} skipped.` : ''}`);
        if (skipped.length) { f.skipped = skipped; f.picked.clear(); f.emails = ''; } else this.form = null;
        this.load();
      },
      error: e => { this.saving = false; this.toast.emit(this.err(e)); }
    });
  }

  // ---------- Contacts in a list ----------
  /** "Showing 1–34" for the loaded page. */
  get viewRange(): string {
    const v = this.viewing;
    if (!v || !v.contacts.length) return '';
    const from = (v.page - 1) * v.pageSize + 1;
    return `Showing ${from}–${from + v.contacts.length - 1}${v.hasMore ? '' : ' of ' + (from + v.contacts.length - 1)}`;
  }

  view(list: ZList, status: 'subscribed' | 'unsubscribed' | 'bounced' = 'subscribed', page = 1): void {
    this.viewing = { list, status, page, pageSize: 50, contacts: [], hasMore: false, loading: true };
    const v = this.viewing;
    this.http.get<any>(`${this.base}/audiences/${encodeURIComponent(list.key)}/contacts`, { params: { status, page: String(page) } }).subscribe({
      next: r => {
        if (this.viewing !== v) return;
        v.loading = false; v.contacts = r.contacts || []; v.hasMore = !!r.hasMore; v.pageSize = r.pageSize || v.pageSize;
        // Zoho's list count can run ahead while it is still processing added contacts; on the
        // last page of subscribers the real number is known, so the list shows it.
        if (status === 'subscribed' && !v.hasMore && (v.contacts.length || page === 1)) list.contacts = (page - 1) * v.pageSize + v.contacts.length;
      },
      error: e => { if (this.viewing !== v) return; v.loading = false; this.toast.emit(this.err(e)); }
    });
  }

  /** Removes the contact from this list only (Zoho unsubscribes them from it). */
  remove(c: any): void {
    const v = this.viewing;
    if (!v || this.removing || !this.canRemove) return;
    if (!confirm(`Remove ${c.email} from “${v.list.name}”?\n\nZoho unsubscribes them from this list only. They stay in your Zoho contacts and on other lists.`)) return;
    this.removing = c.email;
    this.http.post<any>(`${this.base}/zoho-lists/${encodeURIComponent(v.list.key)}/remove`, { email: c.email }).subscribe({
      next: () => { this.removing = ''; v.contacts = v.contacts.filter(x => x.email !== c.email); this.toast.emit(`${c.email} removed from “${v.list.name}”.`); this.load(); },
      error: e => { this.removing = ''; this.toast.emit(this.err(e)); }
    });
  }

  // ---------- Import from Excel (saved as leads, then added to a Zoho list) ----------
  importing: { fileName: string; rows: LeadSheetRow[]; noName: number; sync: ImportSync; busy: boolean; result: any } | null = null;

  openImport(list: ZList | null = null): void {
    const sync = newImportSync(list?.key || '');
    if (!list) sync.list = 'new';
    this.importing = { fileName: '', rows: [], noName: 0, sync, busy: false, result: null };
  }

  onImportFile(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    const imp = this.importing;
    if (!file || !imp) return;
    imp.fileName = file.name; imp.rows = []; imp.result = null;
    parseLeadSheet(file).then(({ rows, skippedNoName }) => { imp.rows = rows; imp.noName = skippedNoName; })
      .catch(err => this.toast.emit(err.message));
    input.value = '';
  }

  get importProblem(): string {
    const imp = this.importing;
    if (!imp) return '';
    if (!imp.rows.length) return 'Choose an Excel or CSV file with a Name (or Company) and Email column.';
    return importSyncProblem(imp.sync);
  }

  runImport(): void {
    const imp = this.importing;
    if (!imp || imp.busy || this.importProblem) return;
    imp.busy = true;
    this.http.post<any>(`${apiRoot()}/api/v1/leads/import-bulk`, { leads: imp.rows, ...importSyncBody(imp.sync) }).subscribe({
      next: r => { imp.busy = false; imp.result = r; this.toast.emit(r.message); this.load(); },
      error: e => { imp.busy = false; this.toast.emit(this.err(e)); }
    });
  }

  @HostListener('document:keydown.escape') closeAll(): void { this.form = null; this.viewing = null; this.importing = null; }

  private err(e: any): string { return e?.error?.error || e?.error?.message || 'Something went wrong. Try again.'; }
}
