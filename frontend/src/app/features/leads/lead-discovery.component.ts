import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { apiRoot } from '../../core/api-base';

/**
 * AI Lead Discovery: search Google Places for businesses, review them, import selected ones
 * into the Leads tab. Every search is for one Digital Product (required), and imported leads
 * are linked to it. Nothing is listed until the user searches. Business details are shown for review only (Google's terms do not allow
 * storing them); imported leads keep a Google place reference and show details live.
 */
@Component({
  selector: 'app-lead-discovery',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './lead-discovery.component.html',
  styleUrls: ['../command/command-center.component.css', './lead-discovery.component.css']
})
export class LeadDiscoveryComponent implements OnInit {
  @Input() products: any[] = [];
  @Output() imported = new EventEmitter<number>();
  @Output() viewLeads = new EventEmitter<void>();

  private base = `${apiRoot()}/api/v1/leads/discovery`;
  readonly pageSize = 20;
  readonly countries = LeadDiscoveryComponent.countryList();

  config: any = null;
  form = { businessType: '', countryCode: 'IN', region: '', city: '', keywords: '', productId: '' as any, maxResults: 20, includeContacts: true, aiQualify: true, review: true };
  phase: 'idle' | 'searching' | 'review' | 'importing' | 'done' = 'idle';
  status = '';
  error = '';
  data: any = null;
  selected = new Set<string>();
  onlyEligible = false;
  page = 1;
  outcome: any = null;

  // Searchable country picker (combobox): type to filter, arrows + Enter or click to choose.
  countryQuery = 'India';
  countryOpen = false;
  activeCountry = 0;

  constructor(private http: HttpClient) {}

  ngOnInit(): void {
    this.http.get<any>(`${this.base}/config`).subscribe({
      next: r => { this.config = r.config; this.form.maxResults = r.config.defaultResults; },
      error: e => this.error = this.err(e)
    });
  }

  /** ISO 3166-1 alpha-2 countries with English names from the browser's CLDR data. */
  static countryList(): { code: string; name: string }[] {
    const names = new (Intl as any).DisplayNames(['en'], { type: 'region' });
    // Retired codes (e.g. DD, SU, YU, UK) and non-country regions (EU, UN, IC, ...); same list as the server.
    const skip = new Set(['AC', 'AN', 'BU', 'CP', 'CS', 'DD', 'DG', 'DY', 'EA', 'EU', 'EZ', 'FX', 'HV', 'IC', 'NH', 'QO', 'RH', 'SU', 'TA', 'TP', 'UK', 'UN', 'VD', 'XA', 'XB', 'YD', 'YU', 'ZR', 'ZZ']);
    const out: { code: string; name: string }[] = [];
    for (let a = 65; a <= 90; a++) {
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b);
        if (skip.has(code)) continue;
        let name = '';
        try { name = names.of(code); } catch { name = ''; }
        if (name && name !== code && !/unknown/i.test(name)) out.push({ code, name });
      }
    }
    return out.sort((x, y) => x.name.localeCompare(y.name));
  }

  get selectedCountryName(): string {
    return this.countries.find(c => c.code === this.form.countryCode)?.name || '';
  }

  get filteredCountries(): { code: string; name: string }[] {
    // While the box still shows the chosen country, list everything.
    const q = this.countryQuery.trim().toLowerCase();
    if (!q || this.countryQuery === this.selectedCountryName) return this.countries;
    const starts = this.countries.filter(c => c.name.toLowerCase().startsWith(q) || c.code.toLowerCase() === q);
    const contains = this.countries.filter(c => !starts.includes(c) && c.name.toLowerCase().includes(q));
    return [...starts, ...contains];
  }

  openCountries(): void {
    this.countryOpen = true;
    this.activeCountry = Math.max(0, this.filteredCountries.findIndex(c => c.code === this.form.countryCode));
    this.scrollToActiveCountry();
  }

  onCountryInput(): void {
    this.countryOpen = true;
    this.activeCountry = 0;
  }

  selectCountry(c: { code: string; name: string }): void {
    this.form.countryCode = c.code;
    this.countryQuery = c.name;
    this.countryOpen = false;
  }

  /** Leaving the box without choosing keeps the previously selected country. */
  closeCountries(): void {
    this.countryOpen = false;
    this.countryQuery = this.selectedCountryName;
  }

  onCountryKey(e: KeyboardEvent): void {
    const list = this.filteredCountries;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!this.countryOpen) { this.openCountries(); return; }
      const step = e.key === 'ArrowDown' ? 1 : -1;
      this.activeCountry = Math.min(Math.max(this.activeCountry + step, 0), Math.max(list.length - 1, 0));
      this.scrollToActiveCountry();
    } else if (e.key === 'Enter') {
      if (this.countryOpen && list[this.activeCountry]) { e.preventDefault(); this.selectCountry(list[this.activeCountry]); }
    } else if (e.key === 'Escape') {
      if (this.countryOpen) { e.preventDefault(); this.closeCountries(); }
    }
  }

  private scrollToActiveCountry(): void {
    setTimeout(() => document.getElementById(`country-opt-${this.activeCountry}`)?.scrollIntoView({ block: 'nearest' }));
  }

  /** Why Search is disabled, shown next to the button. */
  get searchBlockedReason(): string {
    if (!this.products.length) return 'Add a product in Digital Products first: discovered leads are always linked to a product.';
    if (!this.form.productId) return 'Choose the product these leads are for.';
    if (this.form.businessType.trim().length < 2) return 'Enter a business type or industry.';
    return '';
  }

  get canSearch(): boolean {
    return this.phase !== 'searching' && this.phase !== 'importing' && this.form.businessType.trim().length >= 2 && !!this.form.countryCode && !!this.form.productId && !!this.config?.configured;
  }

  search(): void {
    if (!this.canSearch) return;
    this.error = '';
    this.outcome = null;
    this.data = null;
    this.selected.clear();
    this.page = 1;
    this.phase = 'searching';
    this.status = 'Searching Google Places…' + (this.form.aiQualify ? ' Then assessing product fit with AI.' : '');
    const f = this.form;
    const body: any = {
      businessType: f.businessType.trim(), countryCode: f.countryCode, maxResults: Number(f.maxResults),
      includeContacts: f.includeContacts, aiQualify: f.aiQualify
    };
    for (const k of ['region', 'city', 'keywords'] as const) if (f[k].trim()) body[k] = f[k].trim();
    body.productId = Number(f.productId);
    this.http.post<any>(`${this.base}/search`, body).subscribe({
      next: r => {
        this.data = r;
        this.config && (this.config.searchesToday += 1);
        // Pre-select eligible results; possible (name-only) duplicates stay for the user to decide.
        for (const x of r.results) if (x.eligible && !x.possibleDuplicate) this.selected.add(x.placeId);
        this.phase = 'review';
        this.status = '';
        if (!f.review) this.importSelected();
      },
      error: e => { this.phase = 'idle'; this.status = ''; this.error = this.err(e); }
    });
  }

  get visible(): any[] {
    const all = this.data?.results || [];
    return this.onlyEligible ? all.filter((x: any) => x.eligible) : all;
  }
  get pageRows(): any[] { return this.visible.slice((this.page - 1) * this.pageSize, this.page * this.pageSize); }
  get pageCount(): number { return Math.max(1, Math.ceil(this.visible.length / this.pageSize)); }

  toggle(x: any): void {
    if (!x.eligible) return;
    this.selected.has(x.placeId) ? this.selected.delete(x.placeId) : this.selected.add(x.placeId);
  }
  selectAllEligible(): void { for (const x of this.data?.results || []) if (x.eligible) this.selected.add(x.placeId); }
  clearSelection(): void { this.selected.clear(); }

  importSelected(): void {
    if (!this.data || !this.selected.size) return;
    this.phase = 'importing';
    this.status = `Importing ${this.selected.size} lead(s)…`;
    this.http.post<any>(`${this.base}/runs/${this.data.run.id}/import`, { placeIds: [...this.selected] }).subscribe({
      next: r => {
        this.outcome = r;
        this.phase = 'done';
        this.status = '';
        for (const c of r.created) this.selected.delete(c.placeId);
        const done = new Set([...r.created, ...r.duplicates].map((c: any) => c.placeId));
        for (const x of this.data.results) if (done.has(x.placeId)) { x.eligible = false; x.ineligibleReason = 'imported'; }
        if (r.created.length) this.imported.emit(r.created.length);
      },
      error: e => { this.phase = 'review'; this.status = ''; this.error = this.err(e); }
    });
  }

  matchText(x: any): string {
    const m = x.duplicate || x.possibleDuplicate;
    if (!m) return '';
    const why: any = { place_id: 'same Google place', phone: 'same phone number', website_domain: 'same website domain', name: 'similar name only' };
    return `${x.duplicate ? 'Duplicate' : 'Possible duplicate'} of lead #${m.leadId} (${why[m.reason] || m.reason})`;
  }

  private err(e: any): string {
    return e?.error?.error || e?.message || 'Request failed.';
  }
}
