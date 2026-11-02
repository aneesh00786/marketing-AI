import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { LeadDiscoveryComponent } from './lead-discovery.component';

describe('LeadDiscoveryComponent: search form', () => {
  let fixture: ComponentFixture<LeadDiscoveryComponent>;
  let comp: LeadDiscoveryComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const CONFIG = { configured: true, defaultResults: 50, defaultRequests: 10, maxResults: 300, maxRequests: 20, resultsPerRequest: 20, pricePer1000: { withContacts: 35, withoutContacts: 32 }, dailyRequestLimit: 200, requestsToday: 0, searchesToday: 0, dailySearchLimit: 20 };
  const select = (name: string) => el().querySelector(`select[name=${name}]`) as HTMLSelectElement;
  const texts = (name: string) => Array.from(select(name).options).map(o => o.textContent!.trim());

  function start(config: any = CONFIG, recent: any[] = []): void {
    fixture = TestBed.createComponent(LeadDiscoveryComponent);
    comp = fixture.componentInstance;
    comp.products = [{ id: 7, name: 'VanSales' }];
    fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/leads/discovery/config')).flush({ config });
    http.expectOne(r => r.url.endsWith('/leads/discovery/recent')).flush({ searches: recent });
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [LeadDiscoveryComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('asks only how many businesses, as a dropdown; there is no budget to set', () => {
    start();
    expect(el().querySelector('input[name=maxResults]')).toBeNull();
    expect(el().querySelector('[name=maxRequests]')).toBeNull();
    expect(texts('maxResults')).toEqual(['10 businesses', '25 businesses', '50 businesses', '100 businesses', '200 businesses', '300 businesses']);
    expect(el().textContent).not.toContain('request budget');
  });

  it('no country is chosen at first, and searching asks for one', () => {
    start();
    expect(comp.form.countryCode).toBe('');
    expect((el().querySelector('#country-search') as HTMLInputElement).value).toBe('');
    comp.form.productId = '7';
    comp.form.businessType = 'Wholesale';
    expect(comp.searchBlockedReason).toBe('Choose a country.');
    comp.selectCountry({ code: 'AU', name: 'Australia' });
    expect(comp.searchBlockedReason).toBe('');
  });

  it('starts on the server defaults', () => {
    start();
    expect([comp.form.maxResults, comp.form.maxRequests]).toEqual([50, 10]);
  });

  it('never offers more than the server allows, and keeps a default between choices', () => {
    start({ ...CONFIG, maxResults: 60, maxRequests: 8, defaultResults: 40, defaultRequests: 8 });
    expect(comp.targetOptions).toEqual([10, 25, 40, 50, 60]);
  });

  it('the Google budget follows the number, up to the server limit', () => {
    start();
    for (const [target, budget] of [[10, 2], [25, 5], [50, 10], [100, 20], [200, 20], [300, 20]]) {
      comp.onTargetChange(target);
      expect(comp.form.maxRequests).withContext(`target ${target}`).toBe(budget);
    }
  });

  it('choosing a number sets its budget, and the cost shown follows', () => {
    start();
    comp.onTargetChange(100);
    fixture.detectChanges();
    expect([comp.form.maxResults, comp.form.maxRequests]).toEqual([100, 20]);
    expect(el().querySelector('.budget-line')!.textContent).toContain('Costs at most $0.70');
    for (const k of ['phone', 'website', 'email', 'contactPerson']) comp.form.fields[k] = false;
    expect(comp.maxCost).toBe(0.64, 'address only uses the lower price tier');
  });

  it('more options are always shown (never collapsed), with their defaults unchanged', () => {
    start();
    const more = el().querySelector('.more-options') as HTMLElement;
    expect(el().querySelector('details')).withContext('nothing collapsible').toBeNull();
    expect(more.textContent).toContain('More options');
    for (const name of ['keywords', 'expandCategories', 'aiQualify', 'review']) {
      expect(more.querySelector(`[name=${name}]`)).withContext(name).toBeTruthy();
    }
    expect([comp.form.expandCategories, comp.form.aiQualify, comp.form.review]).toEqual([true, true, true]);
  });

  it('the details to collect are chosen before searching, all ticked at first, and sent as fields', async () => {
    start();
    await fixture.whenStable();
    fixture.detectChanges();
    const picks = el().querySelector('fieldset.field-picks')!;
    expect(picks.closest('details')).withContext('visible, not under More options').toBeNull();
    const labels = Array.from(picks.querySelectorAll('label')).map(l => l.textContent!.trim());
    expect(labels).toEqual(['Address', 'Phone', 'Website', 'Email', 'Contact person']);
    expect(Array.from(picks.querySelectorAll('input')).every(i => (i as HTMLInputElement).checked)).toBeTrue();

    const address = picks.querySelector('input[name=field-address]') as HTMLInputElement;
    address.click();
    fixture.detectChanges();
    expect(comp.chosenFields).toEqual(['phone', 'website', 'email', 'contactPerson']);
    comp.form.businessType = 'Wholesale';
    comp.form.productId = 7;
    comp.products = [{ id: 7, name: 'P' }];
    expect((comp as any).body().fields).toEqual(['phone', 'website', 'email', 'contactPerson']);
    expect((comp as any).body().includeContacts).toBeUndefined();
  });

  it('only new businesses is on by default, visible, and sent with the search', async () => {
    start();
    await fixture.whenStable();
    fixture.detectChanges();
    const box = el().querySelector('input[name=newOnly]') as HTMLInputElement;
    expect(box.closest('details')).toBeNull();
    expect(box.checked).toBeTrue();
    box.click();
    fixture.detectChanges();
    expect((comp as any).body().newOnly).toBeFalse();
  });

  it('results show only the collected columns, with email and contact person from the website', () => {
    start();
    comp.data = {
      run: { id: 1, productName: 'P', includeContacts: true, fields: ['email', 'contactPerson'] },
      summary: { found: 1, raw: 1, repeatsAcrossQueries: 0, eligible: 1, duplicates: 0, possibleDuplicates: 0, missingContact: 0, closed: 0, queries: 1 },
      coverage: { requestsUsed: 1, allowedRequests: 1, estimatedCostUsd: 0.04, stopReason: 'no_more_queries', explanation: '', categories: ['x'], categoriesFrom: 'business_type_only' },
      queries: [], ai: null,
      websiteLookup: { checked: 1, emails: 1, contactPeople: 0, withoutWebsite: 0, unreachable: 0, blocked: 0 },
      results: [{ placeId: 'p1', name: 'Biz', category: 'Wholesaler', eligible: true, email: 'sales@biz.in', emailSource: 'https://biz.in/contact', contactPerson: null, contactLookup: 'found' }]
    };
    comp.phase = 'review';
    fixture.detectChanges();
    const heads = Array.from(el().querySelectorAll('table.tbl thead th')).map(t => t.textContent!.trim()).filter(Boolean);
    expect(heads.slice(0, 4)).toEqual(['#', 'Business', 'Contact person', 'Email']);
    expect(heads).not.toContain('Address');
    expect(heads).not.toContain('Phone');
    expect(el().querySelector('a[href="mailto:sales@biz.in"]')).toBeTruthy();
    expect(el().textContent).toContain('email found for 1');
  });

  it('recent searches fill the form; "Search again" runs for new businesses only', () => {
    const recent = [{ runId: 3, productName: 'VanSales', location: 'Kochi, Kerala, India', found: 50, imported: 20,
      search: { businessType: 'Bakeries', countryCode: 'IN', scope: 'city', region: 'Kerala', city: 'Kochi', keywords: '', productId: 7, expandCategories: false, maxResults: 25, maxRequests: 5, fields: ['phone', 'email'] } }];
    start(CONFIG, recent);
    expect(el().querySelector('.recent-modal')).withContext('closed until asked for').toBeNull();
    const open = Array.from(el().querySelectorAll('button')).find(b => b.textContent!.includes('Recent searches (1)')) as HTMLButtonElement;
    open.click();
    fixture.detectChanges();
    expect(el().querySelector('.recent-modal')!.textContent).toContain('Bakeries · Kochi, Kerala, India · 25 businesses');
    const searchSpy = spyOn(comp, 'search').and.resolveTo();
    (Array.from(el().querySelectorAll('.recent-modal button')).find(b => b.textContent!.includes('Use settings')) as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el().querySelector('.recent-modal')).withContext('closes after choosing').toBeNull();
    expect([comp.form.businessType, comp.form.city, comp.form.scope, comp.form.productId, comp.form.maxResults, comp.form.newOnly]).toEqual(['Bakeries', 'Kochi', 'city', '7', 25, true]);
    expect(comp.chosenFields).toEqual(['phone', 'email']);
    expect(comp.countryQuery).toBe('India');
    expect(searchSpy).not.toHaveBeenCalled();
    open.click();
    fixture.detectChanges();
    (Array.from(el().querySelectorAll('.recent-modal button')).find(b => b.textContent!.includes('Search again')) as HTMLButtonElement).click();
    expect(searchSpy).toHaveBeenCalled();
  });

  it('the search button says how many, how long and the most it costs; regions are suggested for the country', () => {
    start();
    fixture.detectChanges();
    const actions = el().querySelector('.form-actions')!.textContent!;
    expect(actions).toContain('Search 50 businesses');
    expect(actions).toMatch(/Takes about \d+(–\d+)? min · up to \$0\.35/);
    expect(comp.regionOptions).toEqual([], 'no country chosen yet');
    comp.form.countryCode = 'IN';
    expect(comp.regionOptions).toContain('Kerala');
    comp.form.countryCode = 'FR';
    expect(comp.regionOptions).toEqual([]);
  });

  describe('results', () => {
    const rows = [
      { placeId: 'a', name: 'Alpha', category: 'Wholesaler', city: 'Kochi', eligible: true, email: 'a@alpha.in', phone: '1', rating: 4.6, ratingCount: 10, fit: { score: 80, confidence: 'medium', evidence: 'x', inference: true } },
      { placeId: 'b', name: 'Beta', category: 'Wholesaler', city: 'Thrissur', eligible: true, email: null, phone: '2', rating: 3.9, ratingCount: 300, fit: { score: 40, confidence: 'low', evidence: 'x', inference: true } },
      { placeId: 'c', name: 'Gamma', category: 'Grocer', city: 'Kochi', eligible: false, email: 'c@g.in', phone: null, rating: null, ratingCount: null, fit: null, duplicate: { leadId: 1, reason: 'phone' } }
    ];
    function withResults(): void {
      start();
      comp.data = {
        run: { id: 1, productName: 'P', includeContacts: true, newOnly: true, fields: ['address', 'phone', 'email'] },
        summary: { found: 3, raw: 3, repeatsAcrossQueries: 0, alreadyInLeads: 4, eligible: 2, duplicates: 1, possibleDuplicates: 0, missingContact: 0, closed: 0, queries: 1 },
        coverage: { requestsUsed: 1, allowedRequests: 1, estimatedCostUsd: 0.04, stopReason: 'reached_target', explanation: '', categories: ['x'], categoriesFrom: 'business_type_only' },
        queries: [], ai: { available: true, assessed: 2 }, results: rows.map(r => ({ ...r }))
      };
      comp.phase = 'review';
      fixture.detectChanges();
    }
    const names = () => comp.visible.map(x => x.name);

    it('filter by email, phone, AI fit, rating, city and text; select only what is shown', () => {
      withResults();
      comp.filters.hasEmail = true;
      expect(names()).toEqual(['Alpha', 'Gamma']);
      comp.filters.hasEmail = false; comp.filters.hasPhone = true;
      expect(names()).toEqual(['Alpha', 'Beta']);
      comp.filters.hasPhone = false; comp.filters.minFit = 60;
      expect(names()).toEqual(['Alpha']);
      comp.filters.minFit = 0; comp.filters.minRating = 4;
      expect(names()).toEqual(['Alpha']);
      comp.filters.minRating = 0; comp.filters.city = 'Kochi';
      expect(names()).toEqual(['Alpha', 'Gamma']);
      comp.filters.city = ''; comp.filters.text = 'groc';
      expect(names()).toEqual(['Gamma']);
      comp.filters.text = ''; comp.filters.hasPhone = true;
      comp.clearSelection();
      comp.selectAllEligible();
      expect([...comp.selected]).toEqual(['a', 'b']);
      comp.resetFilters();
      expect(names()).toEqual(['Alpha', 'Beta', 'Gamma']);
    });

    it('sort by AI fit, rating, reviews and name; ratings are shown', () => {
      withResults();
      comp.sortBy = 'fit'; expect(names()).toEqual(['Alpha', 'Beta', 'Gamma']);
      comp.sortBy = 'reviews'; expect(names()).toEqual(['Beta', 'Alpha', 'Gamma']);
      comp.sortBy = 'rating'; expect(names()).toEqual(['Alpha', 'Beta', 'Gamma']);
      comp.sortBy = 'name'; expect(names()).toEqual(['Alpha', 'Beta', 'Gamma']);
      fixture.detectChanges();
      expect(el().textContent).toContain('★ 4.6');
      expect(el().textContent).toContain('already in your leads (skipped)');
    });

    it('importing sends the details shown for each selected business, so they are saved on the leads', () => {
      withResults();
      comp.data.results[0].address = '1 Market Rd'; comp.data.results[0].website = 'https://alpha.in/'; comp.data.results[0].googleMapsUri = 'https://maps.google.com/?cid=1';
      comp.clearSelection();
      comp.selected.add('a');
      comp.importSelected();
      const req = http.expectOne(r => r.url.endsWith('/runs/1/import'));
      expect(req.request.body.placeIds).toEqual(['a']);
      expect(req.request.body.details).toEqual([{ placeId: 'a', name: 'Alpha', category: 'Wholesaler', address: '1 Market Rd', phone: '1', website: 'https://alpha.in/', googleMapsUri: 'https://maps.google.com/?cid=1', rating: 4.6, ratingCount: 10 }]);
      req.flush({ created: [{ placeId: 'a', leadId: 9 }], duplicates: [], skipped: [], failed: [] });
    });

    it('rows are numbered, continuing across pages', () => {
      withResults();
      const nums = () => Array.from(el().querySelectorAll('table.results-tbl tbody td.sl-cell')).map(td => td.textContent!.trim());
      expect(nums()).toEqual(['1', '2', '3']);
      expect(el().querySelector('table.results-tbl thead th.sl-cell')!.textContent!.trim()).toBe('#');
      comp.data.results = Array.from({ length: 25 }, (_, i) => ({ placeId: 'p' + i, name: 'B' + i, eligible: true }));
      comp.page = 2;
      fixture.detectChanges();
      expect(nums()).toEqual(['21', '22', '23', '24', '25']);
    });

    it('the map explains how to enable it when no browser key is set', () => {
      withResults();
      comp.data.results[0].location = { lat: 9.9, lng: 76.2 };
      fixture.detectChanges();
      const mapBtn = Array.from(el().querySelectorAll('.view-toggle button')).find(b => b.textContent!.trim() === 'Map') as HTMLButtonElement;
      mapBtn.click();
      fixture.detectChanges();
      expect(el().textContent).toContain('GOOGLE_MAPS_BROWSER_KEY');
      expect(el().querySelector('table.tbl')).toBeNull();
    });
  });
});
