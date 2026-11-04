import { Component, EventEmitter, HostListener, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { apiRoot } from '../../core/api-base';
import { IconComponent } from '../../shared/icon.component';
import { parseLeadSheet, LeadSheetRow } from '../leads/lead-sheet';

export interface MList { id: number; name: string; source: string; inZoho: boolean; total: number; reachable: number; updatedAt?: string; }
interface ManualContact { name: string; company: string; email: string; phone: string; }
interface LeadOpt { id: number; name: string; email: string; company?: string | null; eligible?: boolean; reasons?: string[]; }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SYNC_POLL_MS = 3000;
const emptyContact = (): ManualContact => ({ name: '', company: '', email: '', phone: '' });
type Status = 'all' | 'subscribed' | 'unsubscribed' | 'bounced';

/**
 * Zoho Campaigns → Contact lists, kept in Marketech.ai. Lists are made and changed here; Zoho gets
 * a list only when a campaign is sent to it. When Zoho is connected, its lists and contacts are
 * copied here once (status line at the top). Deleting a list copied from Zoho asks where: here,
 * in Zoho only, or both.
 */
@Component({
  selector: 'app-contact-lists',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent],
  templateUrl: './contact-lists.component.html',
  styleUrls: ['../command/command-center.component.css', './mail-ui.css', './contact-lists-shared.css', './contact-lists.component.css']
})
export class ContactListsComponent implements OnInit, OnDestroy {
  @Input() zohoReady = false;
  /** May change lists (mail.send). */
  @Input() canManage = false;
  /** Owner / Admin (mail.configure): may delete lists in Zoho. */
  @Input() canConfigure = false;
  @Output() toast = new EventEmitter<string>();
  @Output() openZoho = new EventEmitter<void>();

  private base = `${apiRoot()}/api/v1/mail/campaigns`;
  lists: MList[] = [];
  totalContacts = 0;
  sync: any = null;
  loading = false;
  error = '';
  query = '';

  constructor(private http: HttpClient) {}

  private syncPoll: any = null;
  ngOnInit(): void { this.load(); this.loadPlan(); }
  ngOnDestroy(): void { clearTimeout(this.syncPoll); }

  // ---------- Zoho plan: contacts in Zoho against the plan's limit ----------
  plan: { contactLimit: number | null; usage: { upTo: number; atLeast: number } } | null = null;
  limitEdit: string | null = null;
  limitSaving = false;

  /** Read from Zoho (its lists' counts); quietly absent when Zoho is not connected. */
  loadPlan(): void {
    if (!this.zohoReady) return;
    this.http.get<any>(`${this.base}/zoho-lists`).subscribe({ next: r => this.plan = r.plan || null, error: () => this.plan = null });
  }

  get usagePct(): number {
    const p = this.plan;
    return p?.contactLimit ? Math.min(100, Math.round((p.usage.upTo / p.contactLimit) * 100)) : 0;
  }

  editLimit(): void { this.limitEdit = this.plan?.contactLimit ? String(this.plan.contactLimit) : ''; }

  saveLimit(): void {
    if (this.limitEdit === null || this.limitSaving) return;
    const t = this.limitEdit.replace(/[,\s]/g, '');
    if (t && !/^\d{1,8}$/.test(t)) { this.toast.emit('Enter the number of contacts your plan allows, e.g. 10000.'); return; }
    const value = t ? Number(t) : null;
    if (value === 0) { this.toast.emit('Enter a number above 0, or leave it empty.'); return; }
    this.limitSaving = true;
    this.http.put<any>(`${this.base}/zoho-plan`, { contactLimit: value }).subscribe({
      next: r => { this.limitSaving = false; this.limitEdit = null; if (this.plan) this.plan.contactLimit = r.contactLimit; this.toast.emit(r.contactLimit ? 'Contact limit saved.' : 'Contact limit removed.'); },
      error: e => { this.limitSaving = false; this.toast.emit(this.err(e)); }
    });
  }

  load(): void {
    this.loading = true; this.error = '';
    this.http.get<any>(`${this.base}/contact-lists`).subscribe({
      next: r => {
        this.loading = false; this.lists = r.lists || []; this.totalContacts = r.contacts || 0; this.sync = r.sync || null;
        // While the copy from Zoho runs (after connecting), check again until it is done.
        clearTimeout(this.syncPoll);
        if (this.sync && ['queued', 'running'].includes(this.sync.status)) this.syncPoll = setTimeout(() => this.load(), SYNC_POLL_MS);
      },
      error: e => { this.loading = false; this.error = this.err(e); }
    });
  }

  get visibleLists(): MList[] {
    const q = this.query.trim().toLowerCase();
    return this.lists.filter(l => !q || l.name.toLowerCase().includes(q));
  }

  /** "Copied 7,387 contacts from 4 Zoho lists on …", or what is happening now. */
  get syncText(): string {
    const s = this.sync;
    if (!s || s.status === 'never') return this.zohoReady ? 'Zoho lists were not copied yet. Reconnect Zoho (Settings) to copy them.' : 'Connect Zoho to copy your Zoho lists and contacts here once.';
    if (s.status === 'queued' || s.status === 'running') return 'Copying your Zoho lists and contacts… This takes about a minute; they appear here when it is done.';
    if (s.status === 'failed') return `Copying from Zoho failed: ${s.error || 'unknown error'}. Reconnect Zoho to try again.`;
    const r = s.result || {};
    return `Copied ${Number(r.contacts || 0).toLocaleString('en-US')} contacts from ${r.lists || 0} Zoho list(s) when Zoho was connected. Lists are managed here from then on.`;
  }

  // ---------- New list / add contacts ----------
  form: { mode: 'create' | 'add'; list: MList | null; name: string; emails: string; manual: ManualContact[]; draft: ManualContact; picked: Map<number, LeadOpt>; skipped: { email: string; reason: string }[] } | null = null;
  leadOptions: LeadOpt[] = [];
  leadsLoading = false;
  saving = false;

  openForm(mode: 'create' | 'add', list: MList | null = null): void {
    this.form = { mode, list, name: '', emails: '', manual: [], draft: emptyContact(), picked: new Map(), skipped: [] };
    this.picker = null;
    this.leadsLoading = true;
    this.http.get<any>(`${this.base}/lead-options`, { params: { pageSize: '2000' } }).subscribe({
      next: r => { this.leadsLoading = false; this.leadOptions = r.leads || []; },
      error: e => { this.leadsLoading = false; this.leadOptions = []; this.toast.emit(this.err(e)); }
    });
  }

  get addableLeads(): LeadOpt[] { return this.leadOptions.filter(l => l.eligible !== false); }

  picker: { query: string; sel: Set<number> } | null = null;
  openPicker(): void { this.picker = { query: '', sel: new Set(this.form?.picked.keys() || []) }; }
  get pickerLeads(): LeadOpt[] {
    const q = (this.picker?.query || '').trim().toLowerCase();
    const hit = (l: LeadOpt) => !q || [l.name, l.email, l.company].some(v => String(v || '').toLowerCase().includes(q));
    return [...this.addableLeads.filter(hit), ...this.leadOptions.filter(l => l.eligible === false).filter(hit)];
  }
  get pickerShownAddable(): LeadOpt[] { return this.pickerLeads.filter(l => l.eligible !== false); }
  get pickerAllShownChecked(): boolean { const s = this.pickerShownAddable; return !!s.length && s.every(l => this.picker!.sel.has(l.id)); }
  togglePick(l: LeadOpt): void { if (!this.picker || l.eligible === false) return; this.picker.sel.has(l.id) ? this.picker.sel.delete(l.id) : this.picker.sel.add(l.id); }
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

  get typedEmails(): string[] {
    return [...new Set(String(this.form?.emails || '').split(/[\s,;]+/).map(e => e.trim().toLowerCase()).filter(Boolean))];
  }
  get formCount(): number { return (this.form?.picked.size || 0) + this.typedEmails.length + (this.form?.manual.length || 0); }

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
    if (f.mode === 'add' && !this.formCount) return 'Choose leads, add a contact or enter email addresses.';
    if (this.formCount > 5000) return 'Add up to 5,000 contacts at a time.';
    return '';
  }

  submitForm(): void {
    const f = this.form;
    if (!f || this.saving || this.formProblem) return;
    this.saving = true;
    const body: any = { leadIds: [...f.picked.keys()], emails: this.typedEmails, contacts: f.manual };
    if (f.mode === 'create') body.name = f.name.trim();
    const url = f.mode === 'create' ? `${this.base}/contact-lists` : `${this.base}/contact-lists/${f.list!.id}/contacts`;
    this.http.post<any>(url, body).subscribe({
      next: r => {
        this.saving = false;
        const skipped = r.skipped || [];
        const what = f.mode === 'create' ? `List “${r.list?.name}” created with ${r.added} contact(s)` : `${r.added} contact(s) added to “${r.list?.name}”`;
        this.toast.emit(`${what}.${r.alreadyIn ? ` ${r.alreadyIn} were already in it.` : ''}${skipped.length ? ` ${skipped.length} skipped.` : ''}`);
        if (skipped.length) { f.skipped = skipped; f.picked.clear(); f.emails = ''; f.manual = []; if (f.mode === 'create') { f.mode = 'add'; f.list = { ...r.list }; } } else this.form = null;
        this.load();
      },
      error: e => { this.saving = false; this.toast.emit(this.err(e)); }
    });
  }

  // ---------- Contacts in a list ----------
  viewing: { list: MList; status: Status; q: string; page: number; pageSize: number; contacts: any[]; hasMore: boolean; loading: boolean } | null = null;
  removing = 0;
  private viewSeq = 0;

  view(list: MList, status: Status = 'all', page = 1, q = this.viewing?.list.id === list.id ? this.viewing.q : ''): void {
    this.viewing = { list, status, q, page, pageSize: 50, contacts: [], hasMore: false, loading: true };
    const v = this.viewing;
    const mine = ++this.viewSeq;
    this.http.get<any>(`${this.base}/contact-lists/${list.id}/contacts`, { params: { status, page: String(page), q: q.trim() } }).subscribe({
      next: r => { if (mine !== this.viewSeq) return; v.loading = false; v.contacts = r.contacts || []; v.hasMore = !!r.hasMore; v.pageSize = r.pageSize || 50; },
      error: e => { if (mine !== this.viewSeq) return; v.loading = false; this.toast.emit(this.err(e)); }
    });
  }

  get viewRange(): string {
    const v = this.viewing;
    if (!v || !v.contacts.length) return '';
    const from = (v.page - 1) * v.pageSize + 1;
    return `Showing ${from.toLocaleString('en-US')}–${(from + v.contacts.length - 1).toLocaleString('en-US')}`;
  }

  statusLabel(s: string): string { return ({ subscribed: 'Subscribed', unsubscribed: 'Unsubscribed', bounced: 'Bounced' } as any)[s] || s; }

  remove(c: any): void {
    const v = this.viewing;
    if (!v || this.removing) return;
    if (!confirm(`Remove ${c.email} from “${v.list.name}”? They stay in your contacts and other lists.`)) return;
    this.removing = c.id;
    this.http.post<any>(`${this.base}/contact-lists/${v.list.id}/remove`, { contactIds: [c.id] }).subscribe({
      next: () => { this.removing = 0; v.contacts = v.contacts.filter(x => x.id !== c.id); this.toast.emit(`${c.email} removed from “${v.list.name}”.`); this.load(); },
      error: e => { this.removing = 0; this.toast.emit(this.err(e)); }
    });
  }

  // ---------- Import from Excel / CSV into a list (not into Leads) ----------
  importing: { fileName: string; rows: LeadSheetRow[]; noName: number; target: 'new' | number; newName: string; busy: boolean; result: any } | null = null;

  openImport(list: MList | null = null): void {
    this.importing = { fileName: '', rows: [], noName: 0, target: list ? list.id : 'new', newName: '', busy: false, result: null };
  }

  onImportFile(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    const imp = this.importing;
    if (!file || !imp) return;
    imp.fileName = file.name; imp.rows = []; imp.result = null;
    if (!imp.newName) imp.newName = file.name.replace(/\.[^.]+$/, '').slice(0, 150);
    parseLeadSheet(file).then(({ rows, skippedNoName }) => { imp.rows = rows; imp.noName = skippedNoName; }).catch(err => this.toast.emit(err.message));
    input.value = '';
  }

  get importProblem(): string {
    const imp = this.importing;
    if (!imp) return '';
    if (!imp.rows.length) return 'Choose an Excel or CSV file with an Email column (and Name, Company, Phone if you have them).';
    if (imp.target === 'new' && !imp.newName.trim()) return 'Enter a name for the new list.';
    if (imp.rows.length > 5000) return 'Import up to 5,000 rows at a time.';
    return '';
  }

  runImport(): void {
    const imp = this.importing;
    if (!imp || imp.busy || this.importProblem) return;
    imp.busy = true;
    const contacts = imp.rows.filter(r => r.email).map(r => ({ name: r.name || '', company: r.companyName || '', email: r.email, phone: r.phone || '' }));
    const req = imp.target === 'new'
      ? this.http.post<any>(`${this.base}/contact-lists`, { name: imp.newName.trim(), contacts })
      : this.http.post<any>(`${this.base}/contact-lists/${imp.target}/contacts`, { contacts });
    req.subscribe({
      next: r => { imp.busy = false; imp.result = { ...r, noEmail: imp.rows.length - contacts.length }; this.toast.emit(`${r.added} contact(s) imported into “${r.list?.name}”.`); this.load(); },
      error: e => { imp.busy = false; this.toast.emit(this.err(e)); }
    });
  }

  // ---------- Delete a list ----------
  deleting: { list: MList; where: 'here' | 'zoho' | 'both'; busy: boolean } | null = null;

  openDelete(l: MList): void { this.deleting = { list: l, where: 'here', busy: false }; }

  /** Why the Zoho options cannot be chosen ('' when they can). */
  get zohoDeleteBlock(): string { return this.canConfigure ? '' : 'Only an Owner or Admin can delete lists in Zoho.'; }

  confirmDelete(): void {
    const d = this.deleting;
    if (!d || d.busy || (d.where !== 'here' && this.zohoDeleteBlock)) return;
    d.busy = true;
    this.http.delete<any>(`${this.base}/contact-lists/${d.list.id}`, { body: { where: d.where, confirm: true } }).subscribe({
      next: () => {
        this.deleting = null;
        this.toast.emit({ here: `“${d.list.name}” deleted here.${d.list.inZoho ? ' It is still in Zoho.' : ''}`, zoho: `“${d.list.name}” deleted in Zoho. It is kept here.`, both: `“${d.list.name}” deleted here and in Zoho.` }[d.where]);
        this.load();
      },
      error: e => { d.busy = false; this.toast.emit(this.err(e)); }
    });
  }

  @HostListener('document:keydown.escape') closeAll(): void {
    if (this.picker) { this.picker = null; return; }
    this.form = null; this.viewing = null; this.importing = null; this.deleting = null;
  }

  private err(e: any): string { return e?.error?.error || e?.error?.message || 'Something went wrong. Try again.'; }
}
