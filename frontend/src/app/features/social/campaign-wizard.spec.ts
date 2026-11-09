import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { CampaignWizardComponent } from './campaign-wizard.component';

const PRODUCTS = [
  { id: 5, name: 'ShelfSync', tagline: 'Real-time shelf stock', description: 'Tracks stock.', category: 'Retail', status: 'Active', features: ['Live counts', 'Alerts', 'Reorders', 'Reports'], url: 'https://shelfsync.io', target_audience: 'Store managers', images: [] },
  { id: 6, name: 'CafeBook', tagline: 'Bookings', description: '', category: 'Hospitality', status: 'Active', features: [], url: 'https://cafebook.io', images: [] }
];
const OVERVIEW = (over: any = {}) => ({
  campaign: { id: 9, name: 'ShelfSync launch', productId: 5, objective: 'Product Launch', platforms: ['instagram'], imageAssetIds: [11], wizardStep: 'strategy', startDate: '2026-12-01', endDate: '2026-12-07' },
  product: { id: 5, name: 'ShelfSync', images: [{ id: 11, url: '/api/v1/social/media-files/abc' }] }, missingInformation: ['Pricing (prices and offers will not be mentioned)'],
  strategy: null, connected: [{ id: 1, platform: 'instagram' }], items: [], counts: {}, ...over
});

describe('CampaignWizardComponent (product campaigns)', () => {
  let fixture: ComponentFixture<CampaignWizardComponent>;
  let comp: CampaignWizardComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const init = () => {
    fixture = TestBed.createComponent(CampaignWizardComponent);
    comp = fixture.componentInstance;
    fixture.detectChanges();
    http.expectOne(r => r.url.includes('/social/accounts')).flush({ accounts: [{ id: 1, status: 'connected', platformKey: 'instagram', displayName: 'Shop IG' }] });
    fixture.detectChanges();
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [CampaignWizardComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('Create Campaign starts with product selection: cards from Digital Products, search and category filter; selecting fills the details', () => {
    init();
    expect(el().textContent).toContain('No campaigns yet');
    comp.newCampaign();
    http.expectOne(r => r.url.endsWith('/api/v1/products?')).flush({ products: PRODUCTS });
    http.expectOne(r => r.url.endsWith('/api/v1/products/categories')).flush({ categories: ['Hospitality', 'Retail'] });
    fixture.detectChanges();
    const cards = Array.from(el().querySelectorAll('.cw-prod'));
    expect(cards.length).toBe(2);
    expect(cards[0].textContent).toContain('Retail');
    expect(cards[0].textContent).toContain('+1 more');
    comp.search = 'shelf'; comp.category = 'Retail'; comp.loadProducts();
    http.expectOne(r => r.url.includes('search=shelf') && r.url.includes('category=Retail')).flush({ products: [PRODUCTS[0]] });
    comp.selectProduct(PRODUCTS[0]);
    fixture.detectChanges();
    // Step 2: review the selected product, then continue or change it.
    expect(comp.step).toBe('confirm');
    const panel = el().querySelector('.cw-confirm') as HTMLElement;
    expect(panel.textContent).toContain('ShelfSync');
    expect(panel.textContent).toContain('Tracks stock.');
    expect(panel.textContent).toContain('Live counts');
    expect(panel.textContent).toContain('https://shelfsync.io');
    (Array.from(panel.querySelectorAll('button')).find(b => b.textContent!.includes('Change Product')) as HTMLButtonElement).click();
    expect(comp.step).toBe('product');
    comp.selectProduct(PRODUCTS[0]);
    fixture.detectChanges();
    (Array.from(el().querySelectorAll('.cw-confirm button')).find(b => b.textContent!.includes('Continue to Create Campaign')) as HTMLButtonElement).click();
    http.expectOne(r => r.urlWithParams.includes('type=image')).flush({ items: [{ id: 11, previewPath: '/p.png' }] });
    fixture.detectChanges();
    expect(comp.step).toBe('details');
    expect(el().textContent).toContain('Selected product');
    expect([comp.form.productId, comp.form.name, comp.form.targetAudience, comp.form.landingUrl, comp.form.platforms]).toEqual([5, 'ShelfSync campaign', 'Store managers', 'https://shelfsync.io', ['instagram']]);
    // Only connected platforms can be chosen.
    const plats = Array.from(el().querySelectorAll('.cw-plat')) as HTMLButtonElement[];
    expect(plats.find(b => b.textContent!.includes('LinkedIn'))!.disabled).toBeTrue();
    expect(plats.find(b => b.textContent!.includes('Instagram'))!.disabled).toBeFalse();
  });

  it('campaign details are saved as a draft (product, platforms, the campaign\'s product images) and the strategy step opens', () => {
    init();
    comp.form = { ...comp.blankForm(), name: 'ShelfSync launch', productId: 5, platforms: ['instagram'], imageAssetIds: [11], objective: 'Product Launch', tone: 'Premium' };
    comp.saveDetails(true);
    const req = http.expectOne(r => r.method === 'POST' && r.url.endsWith('/api/v1/social/campaigns'));
    expect(req.request.body).toEqual(jasmine.objectContaining({ productId: 5, platforms: ['instagram'], imageAssetIds: [11], objective: 'Product Launch', tone: 'Premium', wizardStep: 'strategy' }));
    req.flush({ campaign: { id: 9 } });
    http.expectOne(r => r.url.endsWith('/studio/campaigns/9/overview')).flush(OVERVIEW());
    expect(comp.step).toBe('strategy');
    fixture.detectChanges();
    expect(el().textContent).toContain('Generate AI Campaign Strategy');
    expect(el().textContent).toContain('Mark will not invent them');
  });

  it('AI strategy: generate, edit and remove ideas, then accept (saving edits first) — no media is generated', () => {
    init();
    comp.campaignId = 9; comp.ov = OVERVIEW(); comp.form = { ...comp.blankForm(), productId: 5, platforms: ['instagram'] }; comp.step = 'strategy';
    comp.generateStrategy();
    const g = http.expectOne(r => r.method === 'POST' && r.url.endsWith('/studio/campaigns/9/strategy'));
    expect(g.request.body.requestKey).toMatch(/^ui-/);
    g.flush({ strategy: { status: 'draft', strategy: 'Plan', theme: 'Full shelves', hashtags: ['retail'], unverifiedClaims: ['50%'], ideas: [
      { id: 'a', day: 1, title: 'Intro', idea: 'Meet it', format: 'poster', platform: 'instagram', suggested_time: '10:00' },
      { id: 'b', day: 2, title: 'Offer', idea: '50% off', format: 'post', platform: 'instagram', suggested_time: '10:00' }] } });
    fixture.detectChanges();
    expect(el().textContent).toContain('not found in the product\'s details: 50%');
    comp.removeIdea(1);
    comp.addIdea();
    expect(comp.strategy.ideas.length).toBe(2);
    comp.acceptStrategy();
    const save = http.expectOne(r => r.method === 'PUT' && r.url.endsWith('/studio/campaigns/9/strategy'));
    expect(save.request.body.ideas.map((i: any) => i.title)).toEqual(['Intro', 'New content item']);
    save.flush({ strategy: { ...comp.strategy, ideas: save.request.body.ideas } });
    http.expectOne(r => r.url.endsWith('/studio/campaigns/9/strategy/accept')).flush({ contentIds: [1, 2] });
    http.expectOne(r => r.url.endsWith('/studio/campaigns/9/overview')).flush(OVERVIEW({ strategy: { status: 'accepted', ideas: [] }, items: [{ id: 1, format: 'poster', title: 'Intro', planDay: 1, platformKey: 'instagram', status: 'draft', media: [] }] }));
    expect(comp.step).toBe('content');
    http.expectOne(r => r.method === 'GET' && r.url.endsWith('/studio/campaigns/9/bulk')).flush({ run: null, items: [], counts: { total: 0 } });
    http.expectNone(r => r.url.includes('/ai/'));
  });

  it('review: cards show preview, type, platform and statuses; Approve submits then approves; analytics show unavailable metrics and no leads', () => {
    init();
    comp.campaignId = 9; comp.form = { ...comp.blankForm(), name: 'ShelfSync launch', productId: 5, platforms: ['instagram'] };
    comp.ov = OVERVIEW({ strategy: { status: 'accepted', ideas: [] }, counts: { draft: 1 }, items: [
      { id: 1, format: 'poster', title: 'Intro', planDay: 1, platformKey: 'instagram', status: 'draft', caption: 'Meet ShelfSync', media: [{ id: 3, type: 'image', thumbnailUrl: '/t.png', url: '/t.png' }], generation: { status: 'completed' } }] });
    comp.step = 'review';
    fixture.detectChanges();
    const card = el().querySelector('.cw-card') as HTMLElement;
    expect(card.querySelector('img')!.getAttribute('src')).toBe('/t.png');
    expect(card.textContent).toContain('poster');
    expect(card.textContent).toContain('instagram');
    expect(card.textContent).toContain('Draft');
    expect(card.textContent).toContain('AI completed');
    comp.approve(comp.ov.items[0]);
    http.expectOne(r => r.url.endsWith('/content/1/submit')).flush({});
    http.expectOne(r => r.url.endsWith('/content/1/approve')).flush({});
    http.expectOne(r => r.url.endsWith('/studio/campaigns/9/overview')).flush(comp.ov);
    comp.go('analytics');
    http.expectOne(r => r.url.endsWith('/studio/campaigns/9/analytics')).flush({ analytics: { funnel: { generated: 1, approved: 1, scheduled: 0, published: 0 }, ai: { completed: 1, credits: 5, costUsd: null },
      metrics: { totals: { reach: { value: null }, likes: { value: 4 } }, byPlatform: {}, posts: [], publishedCount: 0 }, note: 'Leads are tracked in email campaigns, not here.' } });
    fixture.detectChanges();
    const metrics = Array.from(el().querySelectorAll('.cw-metric')).map(m => m.textContent!.replace(/\s+/g, ' ').trim());
    expect(metrics).toContain('ReachUnavailable');
    expect(metrics).toContain('Likes4');
    expect(el().textContent).not.toMatch(/Leads generated/);
  });

  it('changing the product of a campaign with content asks first, and confirms the change on save', () => {
    init();
    comp.campaignId = 9; comp.ov = OVERVIEW({ strategy: { status: 'draft', ideas: [] } }); comp.form = { ...comp.blankForm(), name: 'X', productId: 5, platforms: ['instagram'] }; comp.step = 'details';
    const ask = spyOn(window, 'confirm').and.returnValue(true);
    comp.changeProduct();
    expect(ask).toHaveBeenCalled();
    expect(comp.step).toBe('product');
    http.expectOne(r => r.url.includes('/api/v1/products?')).flush({ products: PRODUCTS });
    http.expectOne(r => r.url.endsWith('/categories')).flush({ categories: [] });
    comp.selectProduct(PRODUCTS[1]);
    comp.confirmProduct();
    http.expectOne(r => r.urlWithParams.includes('type=image')).flush({ items: [] });
    comp.saveDetails(false);
    const first = http.expectOne(r => r.method === 'PATCH' && r.url.endsWith('/social/campaigns/9'));
    expect(first.request.body.productId).toBe(6);
    expect('confirmProductChange' in first.request.body).toBeFalse();
    first.flush({ code: 'CONFIRM_PRODUCT_CHANGE', error: 'This campaign already has a strategy made for its current product.' }, { status: 409, statusText: 'Conflict' });
    const second = http.expectOne(r => r.method === 'PATCH' && r.url.endsWith('/social/campaigns/9'));
    expect(second.request.body.confirmProductChange).toBeTrue();
    second.flush({ campaign: { id: 9 } });
    http.expectOne(r => r.url.endsWith('/studio/campaigns/9/overview')).flush(OVERVIEW());
  });

  it('campaign duration presets set the end date; custom keeps it editable', () => {
    init();
    comp.form = { ...comp.blankForm(), startDate: '2026-12-01' };
    comp.setDuration('14');
    expect(comp.form.endDate).toBe('2026-12-14');
    comp.setDuration('30');
    expect([comp.form.endDate, comp.campaignDays]).toEqual(['2026-12-30', 30]);
    comp.setDuration('custom');
    expect(comp.form.endDate).toBe('2026-12-30');
  });

  it('Generate All Content: estimate by type with the balance, confirm, then a dashboard that follows the run; retry and cancel per item', () => {
    jasmine.clock().install();
    try {
      init();
      comp.campaignId = 9; comp.form = { ...comp.blankForm(), name: 'X', productId: 5, platforms: ['instagram'] };
      comp.ov = OVERVIEW({ strategy: { status: 'accepted', ideas: [] }, items: [] }); comp.step = 'content';
      fixture.detectChanges();
      comp.openBulkConfirm();
      http.expectOne(r => r.url.endsWith('/studio/campaigns/9/bulk/estimate')).flush({ estimate: { campaign: { id: 9, name: 'Summer' }, byType: [{ type: 'poster', label: 'Posters', count: 4, credits: 20 }, { type: 'video', label: 'Videos', count: 2, credits: 100 }],
        skipped: [], totalItems: 6, credits: 120, costUsd: null, balance: { available: 500, reserved: 0, limit: 2000 }, enough: true, active: null } });
      fixture.detectChanges();
      const dialog = el().querySelector('.cw-bulk-confirm') as HTMLElement;
      expect(dialog.textContent).toContain('4 Posters');
      expect(dialog.textContent).toContain('120 credits');
      expect(dialog.textContent).toContain('500 credits');
      comp.startBulk();
      const start = http.expectOne(r => r.method === 'POST' && r.url.endsWith('/studio/campaigns/9/bulk'));
      expect(start.request.body).toEqual({ confirm: true });
      start.flush({ batchKey: 'b1', alreadyRunning: false });
      const items = [{ itemId: 1, title: 'Intro', format: 'poster', platforms: ['instagram'], day: 1, status: 'completed', credits: 5, estimatedCredits: 5 },
        { itemId: 2, title: 'Demo', format: 'video', platforms: ['instagram'], day: 3, status: 'failed', error: 'Provider down', credits: null, estimatedCredits: 50 },
        { itemId: 3, title: 'Story', format: 'story', platforms: ['instagram'], day: 5, status: 'queued', credits: null, estimatedCredits: 5 }];
      http.expectOne(r => r.method === 'GET' && r.url.endsWith('/studio/campaigns/9/bulk')).flush({ run: { active: true, charged: 5, estimatedCredits: 60 }, items, counts: { total: 3, completed: 1, processing: 0, queued: 1, failed: 1, canceled: 0 } });
      http.match(r => r.url.endsWith('/studio/campaigns/9/overview')).forEach(r => r.flush(comp.ov));
      fixture.detectChanges();
      const rows = Array.from(el().querySelectorAll('.cw-bulk tbody tr'));
      expect(rows.length).toBe(3);
      expect(rows[1].textContent).toContain('Provider down');
      comp.retryBulkItem(items[1]);
      http.expectOne(r => r.url.endsWith('/bulk/items/2/retry')).flush({});
      http.expectOne(r => r.method === 'GET' && r.url.endsWith('/studio/campaigns/9/bulk')).flush({ run: { active: true, charged: 5 }, items, counts: { total: 3, completed: 1, processing: 1, queued: 1, failed: 0, canceled: 0 } });
      comp.cancelBulk(3);
      const cancel = http.expectOne(r => r.url.endsWith('/bulk/cancel'));
      expect(cancel.request.body).toEqual({ itemId: 3 });
      cancel.flush({});
      http.match(r => r.method === 'GET' && r.url.endsWith('/studio/campaigns/9/bulk')).forEach(r => r.flush({ run: null, items: [], counts: { total: 0 } }));
      // The embedded generator (create or redo one item) loads its own data.
      http.match(r => /capabilities|brand-kits|usage|generations|\/social\/media|overview/.test(r.url)).forEach(r => r.flush(r.request.url.endsWith('/overview') ? comp.ov : {}));
      comp.ngOnDestroy();
    } finally { jasmine.clock().uninstall(); }
  });

  it('review: filters by type and status, approve selected, and versions of a post', () => {
    init();
    comp.campaignId = 9; comp.form = { ...comp.blankForm(), name: 'X', productId: 5, platforms: ['instagram'] };
    comp.ov = OVERVIEW({ strategy: { status: 'accepted', ideas: [] }, items: [
      { id: 1, format: 'poster', title: 'A', platformKey: 'instagram', status: 'draft', hashtags: ['shop'], suggestedPublishAt: '2026-12-01T10:00:00Z', media: [{ type: 'image', url: '/a.png', thumbnailUrl: '/a.png' }] },
      { id: 2, format: 'video', title: 'B', platformKey: 'instagram', status: 'approved', media: [] },
      { id: 3, format: 'post', title: 'C', platformKey: 'linkedin', status: 'failed', media: [] }] });
    comp.step = 'review';
    expect([comp.countFor('poster'), comp.countFor('needs'), comp.countFor('approved'), comp.countFor('failed')]).toEqual([1, 1, 1, 1]);
    comp.reviewFilter = 'video';
    fixture.detectChanges();
    expect(el().querySelectorAll('.cw-card').length).toBe(1);
    comp.reviewFilter = 'all';
    fixture.detectChanges();
    expect(el().querySelector('.cw-card')!.textContent).toContain('#shop');
    spyOn(window, 'confirm').and.returnValue(true);
    comp.toggleSelect(1);
    comp.approveSelected();
    http.expectOne(r => r.url.endsWith('/content/1/submit')).flush({});
    http.expectOne(r => r.url.endsWith('/content/1/approve')).flush({});
    http.expectOne(r => r.url.endsWith('/studio/campaigns/9/overview')).flush(comp.ov);
    comp.showHistory(comp.ov.items[0]);
    http.expectOne(r => r.url.endsWith('/studio/content/1/generations')).flush({ history: [{ version: 1, status: 'completed', provider: 'openai', model: 'gpt-image-1', credits: 5, costUsd: null, prompt: 'A shelf', assets: [] }] });
    fixture.detectChanges();
    expect(el().textContent).toContain('Version 1');
    expect(el().textContent).toContain('gpt-image-1');
  });
});
