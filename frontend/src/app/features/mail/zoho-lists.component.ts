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
  form: { mode: 'create' | 'add'; list: ZList | null; name: string; emails: string; picked: Map<number, LeadOpt>; skipped: { email: string; reason: string }[] } | null = null;
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
      next: r => { this.loading = false; this.lists = r.lists || []; this.canAdd = !!r.canAdd; this.canRemove = !!r.canRemove; },
      error: e => { this.loading = false; this.error = this.err(e); }
    });
  }

  get campaignListCount(): number { return this.lists.filter(l => l.campaignList).length; }

  get visibleLists(): ZList[] {
    const q = this.query.trim().toLowerCase();
    return this.lists.filter(l => (this.showCampaignLists || !l.campaignList) && (!q || String(l.name || '').toLowerCase().includes(q)));
  }

  // ---------- New list / add contacts ----------
  openForm(mode: 'create' | 'add', list: ZList | null = null): void {
    this.form = { mode, list, name: '', emails: '', picked: new Map(), skipped: [] };
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

  get formCount(): number { return (this.form?.picked.size || 0) + this.typedEmails.length; }

  get formProblem(): string {
    const f = this.form;
    if (!f) return '';
    if (f.mode === 'create' && !f.name.trim()) return 'Enter a list name.';
    if (!this.formCount) return f.mode === 'create' ? 'Add at least one contact: Zoho creates a list together with its first contacts.' : 'Choose leads or enter email addresses.';
    if (this.formCount > 500) return 'Add up to 500 contacts at a time.';
    return '';
  }

  submitForm(): void {
    const f = this.form;
    if (!f || this.saving || this.formProblem) return;
    this.saving = true;
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
