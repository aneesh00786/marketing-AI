import { AfterViewInit, Component, ElementRef, EventEmitter, HostListener, Input, OnInit, Output, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { CountryFilterComponent, LeadCountry } from '../../shared/leads/country-filter.component';

export interface PickedContact { id: number; name: string; email: string; company: string | null; productId?: number | null; }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Chooses a recipient from Leads CRM (this workspace only; the server enforces it), or adds a new
 * contact through the Leads API after checking for an existing contact with the same email.
 * Creating a contact records no marketing consent. Typing an address that is not a contact is a
 * separate, explicit option (allowManual) and is never mixed into the contact list.
 */
@Component({
  selector: 'app-contact-picker',
  standalone: true,
  imports: [CommonModule, FormsModule, CountryFilterComponent],
  templateUrl: './contact-picker.component.html',
  styleUrls: ['../command/command-center.component.css', './mail-ui.css', './contact-picker.component.css']
})
export class ContactPickerComponent implements OnInit, AfterViewInit {
  @Input() title = 'Select contact';
  @Input() selectedId: number | null = null;
  @Input() canCreate = true;
  @Input() allowManual = false;
  /** Workspace products (for the filter) and the product to filter by initially (Leads CRM's productId filter). */
  @Input() products: any[] = [];
  @Input() productId: number | null = null;
  @Output() picked = new EventEmitter<PickedContact>();
  @Output() manual = new EventEmitter<{ name: string; email: string }>();
  @Output() closed = new EventEmitter<void>();
  @ViewChild('searchBox') searchBox?: ElementRef<HTMLInputElement>;

  mode: 'search' | 'create' | 'manual' = 'search';
  query = '';
  results: any[] = [];
  loading = false;
  error: string | null = null;
  choice: any = null;
  /** Leads CRM product filter: a product id, 'none' (no product) or 'all'. */
  productFilter: number | 'none' | 'all' = 'all';
  countryFilter = '';
  countries: LeadCountry[] = [];
  private timer: any = null;
  private seq = 0;
  private submitted = false;

  // Add new contact
  draft = { name: '', email: '', company: '', assignProduct: true };
  creating = false;
  createError: string | null = null;
  duplicate: any = null;
  sameName: any = null;
  nameConfirmed = false;

  // Address without a contact
  manualForm = { name: '', email: '' };
  manualError: string | null = null;

  constructor(private api: ApiService) {}

  ngOnInit(): void {
    this.productFilter = this.productId ?? 'all';
    this.search(true);
  }

  productName(id: any): string {
    return (this.products || []).find(p => String(p.id) === String(id))?.name || '';
  }

  /** Why a contact cannot be chosen, or null when it can. */
  unusableReason(l: any): string | null {
    if (l.hasValidEmail) return null;
    switch (l.emailIssue) {
      case 'placeholder': return `${l.email} is a placeholder address (reserved demo domain) and cannot receive email. Update it in Leads.`;
      case 'invalid': return `${l.email} is not a valid email address. Fix it in Leads.`;
      default: return 'No email address. Add one in Leads.';
    }
  }

  get noneUsable(): boolean { return this.results.length > 0 && !this.results.some(l => l.hasValidEmail); }

  setProductFilter(v: any): void {
    this.productFilter = v === 'all' || v === 'none' ? v : Number(v);
    this.choice = null;
    this.search(true);
  }
  ngAfterViewInit(): void { setTimeout(() => this.searchBox?.nativeElement.focus()); }

  @HostListener('document:keydown.escape', ['$event'])
  onEscape(ev: Event): void {
    ev.stopImmediatePropagation();
    if (this.mode !== 'search') { this.mode = 'search'; return; }
    this.closed.emit();
  }

  search(immediate = false): void {
    clearTimeout(this.timer);
    const run = () => {
      const mySeq = ++this.seq;
      this.loading = true;
      this.error = null;
      const params: any = { q: this.query.trim(), limit: 50 };
      if (this.productFilter !== 'all') params.productId = this.productFilter;
      if (this.countryFilter) params.country = this.countryFilter;
      this.api.getLeads(params).subscribe({
        next: (res: any) => { if (mySeq !== this.seq) return; this.loading = false; this.results = res.leads || []; if (res.countries) this.countries = res.countries; },
        error: (err: any) => { if (mySeq !== this.seq) return; this.loading = false; this.results = []; this.error = err?.status === 403 ? 'Your role cannot view contacts.' : (err?.error?.error || 'Contacts could not be loaded.'); }
      });
    };
    if (immediate) run(); else this.timer = setTimeout(run, 250);
  }

  isSelected(l: any): boolean { return (this.choice?.id ?? this.selectedId) === l.id; }

  choose(l: any): void { if (l.hasValidEmail) this.choice = l; }

  confirm(): void {
    const l = this.choice;
    if (!l || !l.hasValidEmail || this.submitted) return;
    this.submitted = true;
    this.picked.emit(this.toPicked(l));
  }

  private toPicked(l: any): PickedContact {
    return { id: l.id, name: l.name, email: l.email, company: l.companyName || null, productId: l.productId ?? null };
  }

  /** Arrow keys move between selectable contacts; Enter chooses and confirms. */
  onListKey(ev: KeyboardEvent, l: any): void {
    if (ev.key === 'Enter') { ev.preventDefault(); if (l.hasValidEmail) { this.choice = l; this.confirm(); } return; }
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    ev.preventDefault();
    const items = Array.from((ev.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('.cp-item:not([disabled])') || []);
    const i = items.indexOf(ev.currentTarget as HTMLButtonElement);
    const next = items[ev.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1)];
    next?.focus();
  }

  // ---------- add new contact ----------
  openCreate(): void {
    this.mode = 'create';
    this.draft = { name: '', email: EMAIL_RE.test(this.query.trim()) ? this.query.trim() : '', company: '', assignProduct: true };
    if (!this.draft.email && this.query.trim()) this.draft.name = this.query.trim();
    this.createError = null;
    this.duplicate = null;
    this.sameName = null;
    this.nameConfirmed = false;
  }

  get createProblem(): string | null {
    if (!this.draft.name.trim()) return 'Enter the contact\'s name.';
    if (!EMAIL_RE.test(this.draft.email.trim())) return 'Enter a valid email address.';
    return null;
  }

  /** Looks for an existing contact with the same email (blocks) or the same name (asks once), then creates. */
  create(): void {
    if (this.creating) return;
    const problem = this.createProblem;
    if (problem) { this.createError = problem; return; }
    const email = this.draft.email.trim();
    const name = this.draft.name.trim();
    this.creating = true;
    this.createError = null;
    this.duplicate = null;
    this.api.getLeads({ q: email, limit: 20 }).subscribe({
      next: (res: any) => {
        const leads = res.leads || [];
        this.duplicate = leads.find((l: any) => String(l.email || '').trim().toLowerCase() === email.toLowerCase()) || null;
        if (this.duplicate) { this.creating = false; return; }
        this.api.getLeads({ q: name, limit: 20 }).subscribe({
          next: (r2: any) => {
            const same = (r2.leads || []).find((l: any) => String(l.name || '').trim().toLowerCase() === name.toLowerCase());
            if (same && !this.nameConfirmed) { this.sameName = same; this.creating = false; return; }
            this.doCreate(name, email);
          },
          error: () => this.doCreate(name, email)
        });
      },
      error: (err: any) => { this.creating = false; this.createError = err?.error?.error || 'Could not check for existing contacts. Try again.'; }
    });
  }

  createAnyway(): void {
    this.nameConfirmed = true;
    this.sameName = null;
    this.create();
  }

  /** The product a new contact is linked to (Leads CRM's productId on create), when the list is filtered by one. */
  get assignableProductId(): number | null {
    return typeof this.productFilter === 'number' ? this.productFilter : null;
  }

  private doCreate(name: string, email: string): void {
    const body: any = { name, email, companyName: this.draft.company.trim() || null };
    if (this.assignableProductId !== null && this.draft.assignProduct) body.productId = this.assignableProductId;
    this.api.createLead(body).subscribe({
      next: (res: any) => {
        this.creating = false;
        const l = res.lead;
        if (!l?.id) { this.createError = 'The contact was not created.'; return; }
        this.picked.emit(this.toPicked(l));
      },
      error: (err: any) => {
        this.creating = false;
        this.createError = err?.status === 403 ? 'Your role cannot add contacts.' : (err?.error?.error || 'The contact could not be created.');
      }
    });
  }

  useExisting(l: any): void {
    if (!l.hasValidEmail) return;
    this.picked.emit(this.toPicked(l));
  }

  // ---------- address without a contact ----------
  useManual(): void {
    const email = this.manualForm.email.trim();
    if (!EMAIL_RE.test(email)) { this.manualError = 'Enter a valid email address.'; return; }
    this.manual.emit({ name: this.manualForm.name.trim(), email });
  }
}
