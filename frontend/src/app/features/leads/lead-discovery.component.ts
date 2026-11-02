import { Component, ElementRef, EventEmitter, Input, OnDestroy, OnInit, Output, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { apiRoot } from '../../core/api-base';
import { AuthStateService } from '../../core/auth-state.service';
import { CallButtonComponent } from '../../shared/calling/call-button.component';
import { REGIONS } from './regions';

const TARGET_PRESETS = [10, 25, 50, 100, 200, 300];
/** Google returns 20 places per request, but many repeat across queries: allow for about 5 new ones each. */
const NEW_PLACES_PER_REQUEST = 5;
/** Fields a search can collect; name and category are always shown. Email and contact person come from the business's website. */
export const DISCOVERY_FIELDS: { key: string; label: string; hint: string }[] = [
  { key: 'address', label: 'Address', hint: 'From Google' },
  { key: 'phone', label: 'Phone', hint: 'From Google' },
  { key: 'website', label: 'Website', hint: 'From Google' },
  { key: 'email', label: 'Email', hint: "From the business's website" },
  { key: 'contactPerson', label: 'Contact person', hint: "From the business's website" }
];

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
  imports: [CommonModule, FormsModule, CallButtonComponent],
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
    businessType: '', countryCode: '', scope: 'country' as 'country' | 'region' | 'city', region: '', city: '', keywords: '', productId: '' as any,
    expandCategories: true, maxResults: 50, maxRequests: 10, aiQualify: true, review: true, newOnly: true,
    fields: { address: true, phone: true, website: true, email: true, contactPerson: true } as Record<string, boolean>
  };
  readonly fieldChoices = DISCOVERY_FIELDS;
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

  // The workspace's recent searches (settings only), for one-click "Search again".
  recent: any[] = [];
  recentOpen = false;
  // Businesses shown while the search is still running (email and AI fit follow later).
  liveRows: any[] = [];
  // Filters and sorting for the results.
  filters = { text: '', hasEmail: false, hasPhone: false, minFit: 0, minRating: 0, city: '' };
  sortBy: 'best' | 'fit' | 'rating' | 'reviews' | 'name' = 'best';
  view: 'table' | 'map' = 'table';
  mapNote = '';
  @ViewChild('mapEl') mapEl?: ElementRef<HTMLDivElement>;
  private mapsLoading: Promise<void> | null = null;

  // Searchable country picker (combobox): type to filter, arrows + Enter or click to choose.
  // No country is chosen until the user picks one.
  countryQuery = '';
  countryOpen = false;
  activeCountry = 0;

  constructor(private http: HttpClient, private auth: AuthStateService) {}

  ngOnInit(): void {
    this.http.get<any>(`${this.base}/config`).subscribe({
      next: r => { this.config = r.config; this.form.maxResults = r.config.defaultResults; this.form.maxRequests = r.config.defaultRequests; },
      error: e => this.error = this.err(e)
    });
    this.loadRecent();
  }

  loadRecent(): void {
    this.http.get<any>(`${this.base}/recent`).subscribe({ next: r => this.recent = r.searches || [], error: () => this.recent = [] });
  }

  /** Fills the form with a recent search's settings; with run, searches straight away. */
  useRecent(r: any, run = false): void {
    const s = r.search;
    const country = this.countries.find(c => c.code === s.countryCode);
    Object.assign(this.form, {
      businessType: s.businessType, countryCode: s.countryCode, scope: s.scope, region: s.region || '', city: s.city || '', keywords: s.keywords || '',
      expandCategories: !!s.expandCategories, maxResults: s.maxResults, maxRequests: s.maxRequests
    });
    if (country) this.countryQuery = country.name;
    if (this.products.some(p => String(p.id) === String(s.productId))) this.form.productId = String(s.productId);
    for (const f of DISCOVERY_FIELDS) this.form.fields[f.key] = (s.fields || []).includes(f.key);
    this.form.newOnly = true;
    this.plan = null;
    if (run) this.search();
  }

  recentLabel(r: any): string {
    return `${r.search.businessType} · ${r.location || r.search.countryCode} · ${r.search.maxResults} businesses`;
  }

  get regionOptions(): string[] { return REGIONS[this.form.countryCode] || []; }

  /** A rough duration, so nobody wonders whether the search is stuck. */
  get estimateText(): string {
    const target = Number(this.form.maxResults) || 50;
    let secs = Number(this.form.maxRequests) * 1.5 + (this.form.expandCategories ? 4 : 0);
    if (this.readsWebsites) secs += Math.ceil(target / 6) * 4;
    if (this.form.aiQualify) secs += Math.ceil(Math.min(target, 60) / 20) * 15;
    const low = Math.max(1, Math.round(secs / 2 / 60));
    const high = Math.max(1, Math.ceil(secs / 60));
    return low === high ? `about ${high} min` : `about ${low}–${high} min`;
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
    if (!this.form.countryCode) return 'Choose a country.';
    if (this.form.scope === 'city' && !this.form.city.trim()) return 'Enter the city, or choose a wider search scope.';
    if (this.form.scope === 'region' && !this.form.region.trim()) return 'Enter the state or region, or choose a wider search scope.';
    return '';
  }

  get canSearch(): boolean {
    return this.phase !== 'searching' && this.phase !== 'importing' && !this.searchBlockedReason && !!this.form.countryCode && !!this.config?.configured;
  }

  /** Choices within the server's limit, always including the current value. */
  get targetOptions(): number[] {
    const cap = this.config?.maxResults || 300;
    return [...new Set([...TARGET_PRESETS.filter(n => n <= cap), cap, this.form.maxResults])].sort((a, b) => a - b);
  }

  /**
   * The Google request budget follows the number of businesses, so nobody has to work it out. It is
   * a ceiling only: a search stops as soon as it reaches the number.
   */
  onTargetChange(target: number): void {
    this.form.maxResults = target;
    this.form.maxRequests = Math.min(Math.ceil(target / NEW_PLACES_PER_REQUEST), this.config?.maxRequests || 20);
  }

  get chosenFields(): string[] { return DISCOVERY_FIELDS.map(f => f.key).filter(k => this.form.fields[k]); }
  /** Phone, website, email and contact person all need Google's contact-tier price (email and contact person are found via the website). */
  get usesContactTier(): boolean { return this.chosenFields.some(k => k !== 'address'); }
  get readsWebsites(): boolean { return !!(this.form.fields['email'] || this.form.fields['contactPerson']); }

  /** The most this search can cost, in USD. */
  get maxCost(): number {
    const per = this.config ? (this.usesContactTier ? this.config.pricePer1000.withContacts : this.config.pricePer1000.withoutContacts) : 35;
    return Math.round(this.form.maxRequests * per / 10) / 100;
  }

  get dailyRequestsLeft(): number {
    return this.config ? Math.max(0, this.config.dailyRequestLimit - this.config.requestsToday) : 0;
  }

  private body(): any {
    const f = this.form;
    const body: any = {
      businessType: f.businessType.trim(), countryCode: f.countryCode, scope: f.scope, productId: Number(f.productId),
      maxResults: Number(f.maxResults), maxRequests: Number(f.maxRequests), fields: this.chosenFields, newOnly: f.newOnly, aiQualify: f.aiQualify, expandCategories: f.expandCategories
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
    this.liveRows = [];
    this.view = 'table';
    this.resetFilters();
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
          if (msg.type === 'progress') {
            if (msg.rows) this.liveRows.push(...msg.rows);
            if (msg.contact) { const row = this.liveRows.find(x => x.placeId === msg.contact.placeId); if (row) Object.assign(row, msg.contact); }
            const { rows, contact, ...p } = msg;
            this.progress = p;
          }
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
      this.liveRows = [];
      this.loadRecent();
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
    if (p.phase === 'contacts') return `Reading business websites for email and contact person… ${p.checked || 0} of ${p.total || 0}`;
    return p.current ? `Searching: “${p.current}”` : 'Searching Google Places…';
  }

  stopText(reason: string): string {
    return ({ reached_target: 'target reached', budget_exhausted: 'request budget used', daily_budget: 'daily request budget reached', no_more_queries: 'all queries completed', quota: 'Google quota reached', provider_rejected: 'Google rejected requests', cancelled: 'cancelled' } as any)[reason] || reason;
  }

  get visible(): any[] {
    const f = this.filters;
    const text = f.text.trim().toLowerCase();
    let rows = (this.data?.results || []).filter((x: any) =>
      (!this.onlyEligible || x.eligible)
      && (!text || `${x.name || ''} ${x.category || ''} ${x.address || ''} ${x.contactPerson || ''}`.toLowerCase().includes(text))
      && (!f.hasEmail || !!x.email)
      && (!f.hasPhone || !!x.phone)
      && (!f.minFit || (x.fit && x.fit.score >= f.minFit))
      && (!f.minRating || (x.rating != null && x.rating >= f.minRating))
      && (!f.city || x.city === f.city));
    const by: Record<string, (a: any, b: any) => number> = {
      fit: (a, b) => (b.fit?.score ?? -1) - (a.fit?.score ?? -1),
      rating: (a, b) => (b.rating ?? -1) - (a.rating ?? -1) || (b.ratingCount ?? 0) - (a.ratingCount ?? 0),
      reviews: (a, b) => (b.ratingCount ?? -1) - (a.ratingCount ?? -1),
      name: (a, b) => String(a.name || '').localeCompare(String(b.name || ''))
    };
    if (by[this.sortBy]) rows = [...rows].sort(by[this.sortBy]);
    return rows;
  }
  get filtersActive(): boolean {
    const f = this.filters;
    return !!(f.text.trim() || f.hasEmail || f.hasPhone || f.minFit || f.minRating || f.city || this.onlyEligible);
  }
  resetFilters(): void {
    this.filters = { text: '', hasEmail: false, hasPhone: false, minFit: 0, minRating: 0, city: '' };
    this.onlyEligible = false;
    this.sortBy = 'best';
    this.page = 1;
  }
  onFilterChange(): void { this.page = 1; if (this.view === 'map') this.drawMap(); }
  get cityOptions(): string[] {
    return [...new Set((this.data?.results || []).map((x: any) => x.city).filter(Boolean))].sort() as string[];
  }
  get hasRatings(): boolean { return (this.data?.results || []).some((x: any) => x.rating != null); }
  get hasFit(): boolean { return (this.data?.results || []).some((x: any) => x.fit); }
  get mappable(): boolean { return (this.data?.results || []).some((x: any) => x.location); }

  // ------------------------------------------------------------ map view (Google Maps, as Google's terms require for Places data)
  showMap(): void {
    this.view = 'map';
    this.mapNote = '';
    if (!this.config?.mapsBrowserKey) {
      this.mapNote = 'The map needs a Google Maps browser key. Add GOOGLE_MAPS_BROWSER_KEY to backend/.env (Maps JavaScript API enabled, restricted to this site\'s address), then restart the server.';
      return;
    }
    setTimeout(() => this.drawMap());
  }

  private loadMaps(): Promise<void> {
    const w = window as any;
    if (w.google?.maps?.Map) return Promise.resolve();
    if (!this.mapsLoading) {
      this.mapsLoading = new Promise<void>((resolve, reject) => {
        const cb = '__discoveryMapsReady';
        w[cb] = () => resolve();
        const s = document.createElement('script');
        s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(this.config.mapsBrowserKey)}&callback=${cb}&loading=async`;
        s.async = true;
        s.onerror = () => { this.mapsLoading = null; reject(new Error('Google Maps could not be loaded.')); };
        document.head.appendChild(s);
      });
    }
    return this.mapsLoading;
  }

  async drawMap(): Promise<void> {
    if (this.view !== 'map' || !this.config?.mapsBrowserKey) return;
    try {
      await this.loadMaps();
    } catch (e: any) {
      this.mapNote = e.message;
      return;
    }
    const el = this.mapEl?.nativeElement;
    const g = (window as any).google;
    if (!el || !g?.maps) return;
    const rows = this.visible.filter(x => x.location);
    const map = new g.maps.Map(el, { mapTypeControl: false, streetViewControl: false });
    const bounds = new g.maps.LatLngBounds();
    const info = new g.maps.InfoWindow();
    for (const x of rows) {
      const marker = new g.maps.Marker({ position: x.location, map, title: x.name || '', label: x.fit ? String(x.fit.score) : undefined });
      marker.addListener('click', () => {
        const box = document.createElement('div');
        const name = document.createElement('strong');
        name.textContent = x.name || 'Business';
        box.appendChild(name);
        const meta = document.createElement('div');
        meta.textContent = [x.category, x.rating != null ? `★ ${x.rating} (${x.ratingCount || 0})` : null, x.fit ? `Fit ${x.fit.score}/100` : null].filter(Boolean).join(' · ');
        box.appendChild(meta);
        if (x.googleMapsUri) {
          const a = document.createElement('a');
          a.href = x.googleMapsUri; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = 'Open in Google Maps';
          box.appendChild(a);
        }
        info.setContent(box);
        info.open({ anchor: marker, map });
      });
      bounds.extend(x.location);
    }
    if (rows.length) map.fitBounds(bounds);
    else { map.setCenter({ lat: 20, lng: 0 }); map.setZoom(2); }
    this.mapNote = rows.length < this.visible.length ? `${this.visible.length - rows.length} business(es) have no map position.` : '';
  }
  get pageRows(): any[] { return this.visible.slice((this.page - 1) * this.pageSize, this.page * this.pageSize); }
  get pageCount(): number { return Math.max(1, Math.ceil(this.visible.length / this.pageSize)); }

  toggle(x: any): void {
    if (!x.eligible) return;
    this.selected.has(x.placeId) ? this.selected.delete(x.placeId) : this.selected.add(x.placeId);
  }
  /** Selects the eligible businesses that the current filters show. */
  selectAllEligible(): void { for (const x of this.visible) if (x.eligible) this.selected.add(x.placeId); }
  clearSelection(): void { this.selected.clear(); }

  importSelected(): void {
    if (!this.data || !this.selected.size) return;
    this.phase = 'importing';
    this.status = `Importing ${this.selected.size} lead(s)…`;
    // The details shown for each selected business are saved on its lead.
    const ids = [...this.selected];
    const byId = new Map<string, any>((this.data.results || []).map((x: any) => [x.placeId, x]));
    const details = ids.map(id => byId.get(id)).filter(Boolean).map((x: any) => ({
      placeId: x.placeId, name: x.name || null, category: x.category || null, address: x.address || null, phone: x.phone || null,
      website: x.website || null, googleMapsUri: x.googleMapsUri || null, rating: x.rating ?? null, ratingCount: x.ratingCount ?? null
    }));
    this.http.post<any>(`${this.base}/runs/${this.data.run.id}/import`, { placeIds: ids, details }).subscribe({
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
    const why: any = { place_id: 'same Google place', phone: 'same phone number', website_domain: 'same website domain', email: 'same email address', name: 'similar name only' };
    return `${x.duplicate ? 'Duplicate' : 'Possible duplicate'} of lead #${m.leadId} (${why[m.reason] || m.reason})`;
  }

  /** "business1.in/shop" rather than the full https://www... address, so the cell stays one line. */
  siteLabel(url: string): string {
    try {
      const u = new URL(url);
      const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
      return u.hostname.replace(/^www\./, '') + path;
    } catch { return url; }
  }

  /** Was this field collected by the search being reviewed? */
  shows(field: string): boolean { return (this.data?.run?.fields || []).includes(field); }
  get columnCount(): number { return 5 + ['address', 'phone', 'website', 'email', 'contactPerson'].filter(f => this.shows(f)).length; }
  get missingContactLabel(): string {
    const parts = ['phone', 'website', 'email'].filter(f => this.shows(f));
    return parts.length ? `no ${parts.join(' or ')}` : 'no contact details';
  }
  lookupText(status: string): string {
    return ({ no_website: 'No website to check', not_found: 'Not on the website', blocked: 'Website does not allow reading', unreachable: 'Website could not be read', not_checked: 'Not checked' } as any)[status] || 'Not found';
  }

  private err(e: any): string {
    return e?.error?.error || e?.message || 'Request failed.';
  }
}
