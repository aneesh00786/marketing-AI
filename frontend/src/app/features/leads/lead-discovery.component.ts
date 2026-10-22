import { Component, EventEmitter, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { apiRoot } from '../../core/api-base';
import { AuthStateService } from '../../core/auth-state.service';

/**
 * AI Lead Discovery: search Google Places for businesses, review them, import selected ones
 * into the Leads tab. Every search is for one Digital Product (required), and imported leads
 * are linked to it. Nothing is listed until the user searches. Business details are shown for review only (Google's terms do not allow
 * storing them); imported leads keep a Google place reference and show details live.
 * A search runs several Google queries (related categories, then states/cities found in the
 * results) within a request budget; progress streams in while it runs.
 */
@Component({
  selector: 'app-lead-discovery',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './lead-discovery.component.html',
  styleUrls: ['../command/command-center.component.css', './lead-discovery.component.css']
})
export class LeadDiscoveryComponent implements OnInit, OnDestroy {
  @Input() products: any[] = [];
  @Output() imported = new EventEmitter<number>();
  @Output() viewLeads = new EventEmitter<void>();

  private base = `${apiRoot()}/api/v1/leads/discovery`;
  readonly pageSize = 20;
  readonly countries = LeadDiscoveryComponent.countryList();

  config: any = null;
  form = {
    businessType: '', countryCode: 'IN', scope: 'country' as 'country' | 'region' | 'city', region: '', city: '', keywords: '', productId: '' as any,
    expandCategories: true, maxResults: 50, maxRequests: 10, includeContacts: true, aiQualify: true, review: true
  };
  phase: 'idle' | 'searching' | 'review' | 'importing' | 'done' = 'idle';
  // Live progress of a running search (counts only) and a way to stop it.
  progress: any = null;
  private abort: AbortController | null = null;
  showQueries = false;

  // Optional preview of the search plan; its categories can be edited before searching.
  plan: any = null;
  planCategories: string[] = [];
  newCategory = '';
  planning = false;
  private planKey = '';
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

  constructor(private http: HttpClient, private auth: AuthStateService) {}

  ngOnInit(): void {
    this.http.get<any>(`${this.base}/config`).subscribe({
      next: r => { this.config = r.config; this.form.maxResults = r.config.defaultResults; this.form.maxRequests = r.config.defaultRequests; },
      error: e => this.error = this.err(e)
    });
  }

  ngOnDestroy(): void {
    this.abort?.abort();
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
    if (this.form.scope === 'city' && !this.form.city.trim()) return 'Enter the city, or choose a wider search scope.';
    if (this.form.scope === 'region' && !this.form.region.trim()) return 'Enter the state or region, or choose a wider search scope.';
    return '';
  }

  get canSearch(): boolean {
    return this.phase !== 'searching' && this.phase !== 'importing' && !this.searchBlockedReason && !!this.form.countryCode && !!this.config?.configured;
  }

  /** What the request budget allows: Google returns at most 20 places per request. */
  get budgetInfo(): { maxPlaces: number; maxCost: number; shortfall: boolean } {
    const per = this.config ? (this.form.includeContacts ? this.config.pricePer1000.withContacts : this.config.pricePer1000.withoutContacts) : 35;
    const req = Number(this.form.maxRequests) || 0;
    const maxPlaces = req * (this.config?.resultsPerRequest || 20);
    return { maxPlaces, maxCost: Math.round(req * per / 10) / 100, shortfall: Number(this.form.maxResults) > maxPlaces };
  }

  get dailyRequestsLeft(): number {
    return this.config ? Math.max(0, this.config.dailyRequestLimit - this.config.requestsToday) : 0;
  }

  private body(): any {
    const f = this.form;
    const body: any = {
      businessType: f.businessType.trim(), countryCode: f.countryCode, scope: f.scope, productId: Number(f.productId),
      maxResults: Number(f.maxResults), maxRequests: Number(f.maxRequests), includeContacts: f.includeContacts, aiQualify: f.aiQualify, expandCategories: f.expandCategories
    };
    if (f.keywords.trim()) body.keywords = f.keywords.trim();
    if (f.scope !== 'country' && f.region.trim()) body.region = f.region.trim();
    if (f.scope === 'city') body.city = f.city.trim();
    return body;
  }

  /** The plan applies only while the inputs it was made for are unchanged. */
  private keyOf(b: any): string {
    return JSON.stringify([b.businessType, b.keywords, b.countryCode, b.scope, b.region, b.city, b.productId, b.expandCategories]);
  }
  get planIsCurrent(): boolean { return !!this.plan && this.planKey === this.keyOf(this.body()); }

  previewPlan(): void {
    if (this.searchBlockedReason) return;
    this.planning = true;
    this.error = '';
    const b = this.body();
    this.http.post<any>(`${this.base}/plan`, b).subscribe({
      next: r => { this.planning = false; this.plan = r.plan; this.planCategories = [...r.plan.categories]; this.planKey = this.keyOf(b); },
      error: e => { this.planning = false; this.error = this.err(e); }
    });
  }

  removeCategory(i: number): void { if (this.planCategories.length > 1) this.planCategories.splice(i, 1); }
  addCategory(): void {
    const c = this.newCategory.trim();
    const max = this.config?.maxCategories || 8;
    if (c && this.planCategories.length < max && !this.planCategories.some(x => x.toLowerCase() === c.toLowerCase())) this.planCategories.push(c);
    this.newCategory = '';
  }

  /** Streams progress lines from the server, then the result. */
  async search(): Promise<void> {
    if (!this.canSearch) return;
    this.error = '';
    this.outcome = null;
    this.data = null;
    this.selected.clear();
    this.page = 1;
    this.showQueries = false;
    this.phase = 'searching';
    this.progress = { phase: 'starting' };
    const body = this.body();
    if (this.planIsCurrent) body.categories = this.planCategories;
    this.abort = new AbortController();
    // Streaming search uses fetch (not HttpClient), so it checks the tab's session itself.
    if (this.auth.checkSession()) {
      this.phase = 'idle';
      this.error = 'Your session changed in another tab. Reload this page to continue.';
      return;
    }
    const token = this.auth.token;
    try {
      const res = await fetch(`${this.base}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
        signal: this.abort.signal
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Search failed (HTTP ${res.status}).`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let result: any = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.type === 'progress') this.progress = msg;
          else if (msg.type === 'result') result = msg;
          else if (msg.type === 'error') throw new Error(msg.error);
        }
      }
      if (!result) throw new Error('The search ended without results. Please try again.');
      this.data = result;
      if (this.config) { this.config.searchesToday += 1; this.config.requestsToday += result.coverage.requestsUsed; }
      // Pre-select eligible results; possible (name-only) duplicates stay for the user to decide.
      for (const x of result.results) if (x.eligible && !x.possibleDuplicate) this.selected.add(x.placeId);
      this.phase = 'review';
      if (!this.form.review) this.importSelected();
    } catch (e: any) {
      this.phase = 'idle';
      this.error = e?.name === 'AbortError' ? 'Search cancelled. Google requests already made are still counted.' : (e?.message || 'Search failed.');
    } finally {
      this.progress = null;
      this.abort = null;
    }
  }

  cancelSearch(): void {
    this.abort?.abort();
  }

  get progressText(): string {
    const p = this.progress;
    if (!p) return '';
    if (p.phase === 'starting') return 'Starting the search…';
    if (p.phase === 'planning') return 'Choosing related business categories with AI…';
    if (p.phase === 'checking') return 'Checking for duplicates in your leads…';
    if (p.phase === 'assessing') return 'Assessing product fit with AI…';
    return p.current ? `Searching: “${p.current}”` : 'Searching Google Places…';
  }

  stopText(reason: string): string {
    return ({ reached_target: 'target reached', budget_exhausted: 'request budget used', daily_budget: 'daily request budget reached', no_more_queries: 'all queries completed', quota: 'Google quota reached', provider_rejected: 'Google rejected requests', cancelled: 'cancelled' } as any)[reason] || reason;
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
