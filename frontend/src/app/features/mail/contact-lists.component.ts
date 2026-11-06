import { Component, EventEmitter, HostListener, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { apiRoot } from '../../core/api-base';
import { IconComponent } from '../../shared/icon.component';
import { CountryFilterComponent, LeadCountry } from '../../shared/leads/country-filter.component';
import { parseLeadSheet, LeadSheetRow } from '../leads/lead-sheet';

export interface MList { id: number; name: string; source: string; total: number; reachable: number; noConsent?: number; updatedAt?: string; }
interface ManualContact { name: string; company: string; email: string; phone: string; }
interface LeadOpt { id: number; name: string; email: string; company?: string | null; country?: string | null; address?: string | null; eligible?: boolean; reasons?: string[]; }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const emptyContact = (): ManualContact => ({ name: '', company: '', email: '', phone: '' });
type Status = 'all' | 'subscribed' | 'unsubscribed' | 'bounced';

/**
 * Contact lists kept in Marketech.ai: made and changed here, and chosen as a campaign's recipients.
 */
@Component({
  selector: 'app-contact-lists',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, CountryFilterComponent],
  templateUrl: './contact-lists.component.html',
  styleUrls: ['../command/command-center.component.css', './mail-ui.css', './contact-lists-shared.css', './contact-lists.component.css']
})
export class ContactListsComponent implements OnInit, OnDestroy {
  /** May change lists (mail.send). */
  @Input() canManage = false;
  @Output() toast = new EventEmitter<string>();

  private base = `${apiRoot()}/api/v1/mail/campaigns`;
  lists: MList[] = [];
  totalContacts = 0;
  loading = false;
  error = '';
  query = '';

  constructor(private http: HttpClient) {}

  ngOnInit(): void { this.load(); }
  ngOnDestroy(): void { /* nothing to stop */ }

  load(): void {
    this.loading = true; this.error = '';
    this.http.get<any>(`${this.base}/contact-lists`).subscribe({
      next: r => {
        this.loading = false; this.lists = r.lists || []; this.totalContacts = r.contacts || 0;
      },
      error: e => { this.loading = false; this.error = this.err(e); }
    });
  }

  get visibleLists(): MList[] {
    const q = this.query.trim().toLowerCase();
    return this.lists.filter(l => !q || l.name.toLowerCase().includes(q));
  }

  // ---------- New list / add contacts ----------
  form: { mode: 'create' | 'add'; list: MList | null; name: string; emails: string; manual: ManualContact[]; draft: ManualContact; picked: Map<number, LeadOpt>; skipped: { email: string; reason: string }[] } | null = null;
  leadOptions: LeadOpt[] = [];
  leadCountries: LeadCountry[] = [];
  leadsLoading = false;
  saving = false;

  openForm(mode: 'create' | 'add', list: MList | null = null): void {
    this.form = { mode, list, name: '', emails: '', manual: [], draft: emptyContact(), picked: new Map(), skipped: [] };
    this.picker = null;
    this.leadsLoading = true;
    this.http.get<any>(`${this.base}/lead-options`, { params: { pageSize: '2000' } }).subscribe({
      next: r => { this.leadsLoading = false; this.leadOptions = r.leads || []; this.leadCountries = r.countries || []; },
      error: e => { this.leadsLoading = false; this.leadOptions = []; this.toast.emit(this.err(e)); }
    });
  }

  get addableLeads(): LeadOpt[] { return this.leadOptions.filter(l => l.eligible !== false); }

  picker: { query: string; country: string; sel: Set<number> } | null = null;
  openPicker(): void { this.picker = { query: '', country: '', sel: new Set(this.form?.picked.keys() || []) }; }
  /** Filtered by the search and the country ('none' = leads without a country). */
  get pickerFiltered(): boolean { return !!(this.picker?.query.trim() || this.picker?.country); }
  get pickerLeads(): LeadOpt[] {
    const q = (this.picker?.query || '').trim().toLowerCase();
    const country = this.picker?.country || '';
    const inCountry = (l: LeadOpt) => !country || (country === 'none' ? !l.country : l.country === country);
    const hit = (l: LeadOpt) => inCountry(l) && (!q || [l.name, l.email, l.company, l.address].some(v => String(v || '').toLowerCase().includes(q)));
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

  /** Marketing consent as campaigns use it (see backend contacts/consent.js). */
  consentLabel(s: string): string { return ({ granted: 'Given', withdrawn: 'Withdrawn', none: 'Not recorded' } as any)[s] || '—'; }
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
  deleting: { list: MList; busy: boolean } | null = null;

  openDelete(l: MList): void { this.deleting = { list: l, busy: false }; }

  confirmDelete(): void {
    const d = this.deleting;
    if (!d || d.busy) return;
    d.busy = true;
    this.http.delete<any>(`${this.base}/contact-lists/${d.list.id}`, { body: { confirm: true } }).subscribe({
      next: () => {
        this.deleting = null;
        this.toast.emit(`“${d.list.name}” deleted.`);
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
