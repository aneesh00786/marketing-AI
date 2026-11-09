import { Component, EventEmitter, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpEventType } from '@angular/common/http';
import { apiRoot } from '../../core/api-base';
import { SocialApiService } from './social-api.service';
import { StudioApiService, requestKey } from './studio-api.service';
import { StudioGeneratorComponent } from './studio-generator.component';

type Step = 'product' | 'confirm' | 'details' | 'strategy' | 'content' | 'review' | 'schedule' | 'analytics';
type Tab = 'poster' | 'video' | 'carousel' | 'post' | 'story';

/**
 * Product campaign wizard: Select Product → Campaign Details → AI Strategy → Generate Content →
 * Review & Approve → Schedule & Publish → Analytics. Everything is saved on the server as the user goes
 * (the campaign is a Draft until its strategy is accepted), so any step can be left and resumed.
 * Nothing is published without explicit approval and a scheduling or publishing action.
 */
@Component({
  selector: 'app-campaign-wizard',
  standalone: true,
  imports: [CommonModule, FormsModule, StudioGeneratorComponent],
  styleUrls: ['./social-shared.css', './studio.css', './campaign-wizard.component.css'],
  templateUrl: './campaign-wizard.component.html'
})
export class CampaignWizardComponent implements OnInit, OnDestroy {
  @Input() campaigns: any[] = [];
  @Input() initialProductId: number | null = null;
  @Input() initialCampaignId: number | null = null;
  /** Opens straight on product selection (AI Content Generator and the Overview's create buttons). */
  @Input() startNew = false;
  /** The content tab to open first once the campaign reaches content generation. */
  @Input() preferredTab: 'poster' | 'video' | 'carousel' | 'post' | 'story' | null = null;
  @Output() toast = new EventEmitter<string>();
  @Output() openContent = new EventEmitter<number>();
  @Output() openCalendar = new EventEmitter<number>();
  @Output() changed = new EventEmitter<void>();

  readonly steps: { key: Step; label: string; icon: string }[] = [
    { key: 'product', label: 'Select Product', icon: '📦' }, { key: 'confirm', label: 'Review Product', icon: '🔍' }, { key: 'details', label: 'Campaign Details', icon: '📝' },
    { key: 'strategy', label: 'AI Strategy', icon: '🧠' }, { key: 'content', label: 'Generate Content', icon: '✨' },
    { key: 'review', label: 'Review & Approve', icon: '✅' }, { key: 'schedule', label: 'Schedule & Publish', icon: '🗓️' },
    { key: 'analytics', label: 'Analytics', icon: '📊' }
  ];
  readonly objectives = ['Brand Awareness', 'Lead Generation', 'Increase Sales', 'Product Promotion', 'Product Launch', 'Website Traffic', 'Customer Engagement'];
  readonly tones = ['Professional', 'Friendly', 'Promotional', 'Informative', 'Emotional', 'Creative', 'Premium'];
  readonly platforms = [{ key: 'facebook', label: 'Facebook', icon: '📘' }, { key: 'instagram', label: 'Instagram', icon: '📸' }, { key: 'linkedin', label: 'LinkedIn', icon: '💼' }, { key: 'youtube', label: 'YouTube', icon: '▶️' }];
  readonly formats = ['poster', 'carousel', 'video', 'reel', 'post', 'story'];
  readonly tabs: { key: Tab; label: string; icon: string; formats: string[] }[] = [
    { key: 'poster', label: 'Posters', icon: '🖼️', formats: ['poster'] }, { key: 'video', label: 'Videos & Reels', icon: '🎬', formats: ['video', 'reel'] },
    { key: 'carousel', label: 'Carousels', icon: '🎠', formats: ['carousel'] }, { key: 'post', label: 'Social Posts', icon: '✍️', formats: ['post'] },
    { key: 'story', label: 'Stories', icon: '⭕', formats: ['story'] }
  ];
  readonly statusLabels: Record<string, string> = { draft: 'Draft', generating: 'Generating', review: 'Ready for review', approved: 'Approved', scheduled: 'Scheduled', publishing: 'Publishing', published: 'Published', failed: 'Failed', rejected: 'Changes requested', cancelled: 'Cancelled' };

  step: Step | null = null;
  campaignId: number | null = null;
  ov: any = null;            // campaign overview (product, strategy, posts, counts)
  busy = '';
  error = '';

  // Step 1
  products: any[] = []; categories: string[] = []; search = ''; category = ''; detailsOf: any = null;
  // Step 2
  form: any = this.blankForm();
  connected: string[] = [];
  accounts: any[] = [];
  // Step 3
  strategy: any = null; direction = ''; strategyDirty = false;
  // Step 4
  tab: Tab = 'poster'; workingItem: any = null; prefill: any = null;
  // Step 6
  scheduleAt: Record<number, string> = {}; scheduleAccount: Record<number, number | null> = {};
  // Step 7
  analytics: any = null;
  // Preview
  previewing: any = null;

  private productsUrl = `${apiRoot()}/api/v1/products`;
  constructor(private http: HttpClient, private social: SocialApiService, private studio: StudioApiService) {}

  ngOnInit(): void {
    this.social.accounts().subscribe({
      next: r => {
        const map: Record<string, string> = { facebook_page: 'facebook', instagram_business: 'instagram', linkedin_organization: 'linkedin', youtube_channel: 'youtube' };
        this.accounts = (r.accounts || []).filter((a: any) => a.status === 'connected').map((a: any) => ({ ...a, platform: a.platformKey || map[a.accountType || a.account_type] }));
        this.connected = [...new Set(this.accounts.map(a => a.platform).filter(Boolean))];
      }, error: () => {}
    });
    if (this.preferredTab) this.tab = this.preferredTab;
    if (this.initialCampaignId) this.openCampaign(this.initialCampaignId);
    else if (this.startNew) this.newCampaign();
    else if (this.initialProductId) { this.newCampaign(); this.loadProducts(() => { const p = this.products.find(x => x.id === this.initialProductId); if (p) this.selectProduct(p); }); }
  }

  // ------------------------------------------------------------ navigation
  blankForm(): any {
    const d = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    return { name: '', productId: null, imageAssetIds: [] as number[], duration: '7', objective: 'Product Promotion', targetAudience: '', description: '', keyMessage: '', startDate: d(1), endDate: d(7), platforms: [] as string[], language: 'en', tone: 'Professional', callToAction: '', landingUrl: '' };
  }
  get product(): any { return this.ov?.product || this.products.find(p => p.id === this.form.productId) || null; }
  get stepIndex(): number { return this.steps.findIndex(s => s.key === this.step); }
  /** A step can be opened once the earlier steps are done (product → campaign saved → strategy accepted). */
  reachable(s: Step): boolean {
    const accepted = this.ov?.strategy?.status === 'accepted';
    return ({ product: true, confirm: !!this.form.productId, details: !!this.form.productId, strategy: !!this.campaignId, content: accepted, review: accepted, schedule: accepted, analytics: !!this.campaignId } as any)[s];
  }
  go(s: Step): void {
    if (!this.reachable(s)) return;
    this.step = s; this.error = '';
    if (s === 'product' && !this.products.length) this.loadProducts();
    if (s === 'analytics') this.loadAnalytics();
    if (['content', 'review', 'schedule'].includes(s) && this.campaignId) this.loadOverview();
    if (s === 'content') this.loadBulk();
    if (this.campaignId && s !== 'analytics') this.social.updateCampaign(this.campaignId, { wizardStep: s }).subscribe({ error: () => {} });
  }
  newCampaign(): void { this.campaignId = null; this.ov = null; this.strategy = null; this.form = this.blankForm(); this.step = 'product'; this.loadProducts(); }
  close(): void { this.step = null; this.campaignId = null; this.ov = null; this.changed.emit(); }

  openCampaign(id: number): void {
    this.campaignId = id; this.busy = 'open';
    this.studio.campaignOverview(id).subscribe({
      next: r => {
        this.busy = ''; this.applyOverview(r);
        const c = r.campaign;
        this.form = { ...this.blankForm(), name: c.name, productId: c.productId, objective: c.objective || 'Product Promotion', targetAudience: c.targetAudience || '', description: c.description || '', keyMessage: c.keyMessage || '',
          imageAssetIds: [...(c.imageAssetIds || [])], duration: c.startDate && c.endDate ? this.durationOf(c.startDate, c.endDate) : '7', startDate: c.startDate || this.form.startDate, endDate: c.endDate || this.form.endDate, platforms: c.platforms || [], language: c.language || 'en', tone: c.tone || 'Professional', callToAction: c.callToAction || '', landingUrl: c.landingUrl || '' };
        const s = (c.wizardStep as Step) || (r.strategy?.status === 'accepted' ? 'review' : r.strategy ? 'strategy' : 'details');
        this.step = this.reachable(s) ? s : 'details';
        if (this.step === 'analytics') this.loadAnalytics();
        if (this.step === 'content') this.loadBulk();
      },
      error: e => { this.busy = ''; this.error = this.err(e); }
    });
  }
  private applyOverview(r: any): void { this.ov = r; this.strategy = r.strategy ? JSON.parse(JSON.stringify(r.strategy)) : null; this.strategyDirty = false; }
  loadOverview(): void { if (this.campaignId) this.studio.campaignOverview(this.campaignId).subscribe({ next: r => this.applyOverview(r), error: e => this.error = this.err(e) }); }

  // ------------------------------------------------------------ step 1: product
  loadProducts(after?: () => void): void {
    const q = [this.search ? `search=${encodeURIComponent(this.search)}` : '', this.category ? `category=${encodeURIComponent(this.category)}` : ''].filter(Boolean).join('&');
    this.http.get<any>(`${this.productsUrl}?${q}`).subscribe({ next: r => { this.products = r.products || []; after?.(); }, error: e => this.error = this.err(e) });
    if (!this.categories.length) this.http.get<any>(`${this.productsUrl}/categories`).subscribe({ next: r => this.categories = r.categories || [], error: () => {} });
  }
  /** The product chosen on the cards, shown for confirmation before the campaign form. */
  chosen: any = null;
  selectProduct(p: any): void {
    this.chosen = p;
    this.detailsOf = null;
    this.step = 'confirm';
  }
  /** "Change product": back to the cards (a campaign with content asks for confirmation when saved). */
  changeProduct(): void {
    const made = (this.ov?.items || []).length || this.ov?.strategy;
    if (made && !confirm('This campaign already has a strategy or posts made for its current product. Choose another product anyway? You will be asked to confirm again when you save.')) return;
    this.step = 'product';
    if (!this.products.length) this.loadProducts();
  }
  /** "Continue to Create Campaign": the product becomes the campaign's product. */
  confirmProduct(): void {
    const p = this.chosen;
    if (!p) return;
    const changed = this.form.productId && this.form.productId !== p.id;
    this.form.productId = p.id;
    if (changed) this.form.imageAssetIds = [];
    if (!this.form.name) this.form.name = `${p.name} campaign`;
    if (!this.form.targetAudience) this.form.targetAudience = p.target_audience || '';
    if (!this.form.landingUrl) this.form.landingUrl = p.url || '';
    if (!this.form.platforms.length) this.form.platforms = this.connected.slice(0, 2);
    // The product's own images start as the campaign's images.
    if (!this.form.imageAssetIds.length && (p.imageAssetIds || []).length) this.form.imageAssetIds = [...p.imageAssetIds];
    this.step = 'details';
    this.loadLibrary();
  }

  // ------------------------------------------------------------ product images for this campaign
  library: any[] = []; picking = false; uploading = false;
  private imageUrls = new Map<number, string>();
  imageUrl(id: number): string | null { return this.imageUrls.get(id) || this.ov?.product?.images?.find((i: any) => i.id === id)?.url || null; }
  loadLibrary(): void {
    this.social.media({ type: 'image', limit: 200 }).subscribe({ next: r => { this.library = r.items || []; for (const a of this.library) this.imageUrls.set(a.id, a.previewPath || a.url); }, error: () => {} });
  }
  togglePicker(): void { this.picking = !this.picking; if (this.picking && !this.library.length) this.loadLibrary(); }
  pickImage(a: any): void {
    const ids: number[] = this.form.imageAssetIds;
    const i = ids.indexOf(a.id);
    if (i >= 0) ids.splice(i, 1); else if (ids.length < 12) ids.push(a.id);
  }
  removeImage(id: number): void { this.form.imageAssetIds = this.form.imageAssetIds.filter((x: number) => x !== id); }
  uploadImages(ev: Event): void {
    const files = Array.from((ev.target as HTMLInputElement).files || []);
    if (!files.length) return;
    this.uploading = true;
    let left = files.length;
    for (const f of files) {
      this.social.uploadMedia(f, f.name).subscribe({
        next: e => {
          if (e.type !== HttpEventType.Response) return;
          const a = (e.body as any)?.asset;
          if (a) { this.imageUrls.set(a.id, a.previewPath || a.url); if (this.form.imageAssetIds.length < 12) this.form.imageAssetIds.push(a.id); this.library = [a, ...this.library]; }
          if (--left === 0) this.uploading = false;
        },
        error: err => { this.error = this.err(err); if (--left === 0) this.uploading = false; }
      });
    }
  }

  // ------------------------------------------------------------ step 2: details (saved as Draft)
  togglePlatform(k: string): void {
    if (!this.connected.includes(k)) return;
    const i = this.form.platforms.indexOf(k);
    if (i >= 0) this.form.platforms.splice(i, 1); else this.form.platforms.push(k);
  }
  detailsValid(): boolean { return !!this.form.name.trim() && !!this.form.productId && this.form.platforms.length > 0 && (!this.form.endDate || this.form.endDate >= this.form.startDate); }
  saveDetails(next: boolean): void {
    if (!this.detailsValid()) { this.error = 'Add a name, choose a product and at least one connected platform (the end date must be after the start).'; return; }
    this.busy = 'details'; this.error = '';
    const { duration, ...fields } = this.form;
    const body: any = { ...fields, landingUrl: this.form.landingUrl || null, wizardStep: next ? 'strategy' : 'details', ...(this.confirmChange ? { confirmProductChange: true } : {}) };
    const req = this.campaignId ? this.social.updateCampaign(this.campaignId, body) : this.social.createCampaign(body);
    req.subscribe({
      next: r => {
        this.busy = ''; this.campaignId = r.campaign.id; this.changed.emit();
        this.toast.emit(next ? 'Campaign saved as a draft.' : 'Draft saved. You can continue later.');
        this.studio.campaignOverview(this.campaignId!).subscribe({ next: o => { this.applyOverview(o); if (next) this.step = 'strategy'; } });
      },
      error: e => {
        this.busy = '';
        if (e?.error?.code === 'CONFIRM_PRODUCT_CHANGE' && confirm(`${e.error.error} A draft strategy will be cleared; posts already made stay as they are.`)) {
          this.confirmChange = true; this.saveDetails(next); this.confirmChange = false; return;
        }
        this.error = this.err(e);
      }
    });
  }
  private confirmChange = false;

  // ------------------------------------------------------------ step 3: AI strategy
  generateStrategy(): void {
    if (!this.campaignId) return;
    this.busy = 'strategy'; this.error = '';
    this.studio.strategy(this.campaignId, { requestKey: requestKey(), instruction: this.direction }).subscribe({
      next: r => { this.busy = ''; this.strategy = r.strategy; this.ov = { ...this.ov, strategy: r.strategy }; this.strategyDirty = false; this.toast.emit('Strategy ready. Review the ideas, then accept.'); },
      error: e => { this.busy = ''; this.error = this.err(e); }
    });
  }
  addIdea(): void {
    const day = Math.max(1, ...((this.strategy?.ideas || []).map((i: any) => i.day))) || 1;
    this.strategy.ideas.push({ day, title: 'New content item', idea: '', format: 'post', platforms: [this.form.platforms[0] || 'instagram'], suggested_time: '10:00', caption: '', hashtags: [], cta: '' });
    this.openIdea = null;
    this.strategyDirty = true;
  }
  removeIdea(i: number): void { this.strategy.ideas.splice(i, 1); this.strategyDirty = true; }
  saveStrategy(after?: () => void): void {
    const ideas = this.strategy.ideas.map((i: any) => ({ ...i, day: Number(i.day) || 1 }));
    this.busy = 'save-strategy';
    this.studio.saveStrategy(this.campaignId!, { ideas, strategy: this.strategy.strategy, overview: this.strategy.overview, messages: this.strategy.messages, hashtags: this.strategy.hashtags }).subscribe({
      next: r => { this.busy = ''; this.strategy = r.strategy; this.strategyDirty = false; after ? after() : this.toast.emit('Strategy saved.'); },
      error: e => { this.busy = ''; this.error = this.err(e); }
    });
  }
  acceptStrategy(): void {
    const doAccept = () => {
      this.busy = 'accept';
      this.studio.acceptStrategy(this.campaignId!).subscribe({
        next: r => { this.busy = ''; this.toast.emit(`Strategy approved: ${r.contentIds.length} draft posts created. Now generate all content.`); this.changed.emit(); this.studio.campaignOverview(this.campaignId!).subscribe({ next: o => { this.applyOverview(o); this.step = 'content'; this.loadBulk(); } }); },
        error: e => { this.busy = ''; this.error = this.err(e); }
      });
    };
    if (this.strategyDirty) this.saveStrategy(doAccept); else doAccept();
  }
  hashtagText(): string { return (this.msgs.hashtags || this.strategy?.hashtags || []).map((h: string) => `#${h}`).join(' '); }
  setHashtags(v: string): void { const tags = this.splitTags(v); this.msgs.hashtags = tags; this.strategy.hashtags = tags; this.strategyDirty = true; }

  // ------------------------------------------------------------ step 4: generate content
  itemsFor(tab: Tab): any[] { const f = this.tabs.find(t => t.key === tab)!.formats; return (this.ov?.items || []).filter((i: any) => f.includes(i.format)); }
  work(item: any | null, tab: Tab = this.tab): void {
    this.tab = tab;
    this.workingItem = item;
    const mode = tab === 'story' ? 'poster' : tab;
    this.prefill = { mode, title: item?.title || this.ov?.product?.name || '', prompt: item?.mediaPrompt || item?.caption || '', platform: item?.platformKey, purpose: tab === 'story' ? 'story' : 'product_ad' };
  }
  setTab(t: Tab): void { this.tab = t; this.work(null, t); }

  // ------------------------------------------------------------ step 5: review
  approve(item: any): void {
    this.busy = `approve-${item.id}`;
    const done = (msg: string) => { this.busy = ''; this.toast.emit(msg); this.loadOverview(); };
    const approveNow = () => this.social.approveContent(item.id).subscribe({ next: () => done('Approved.'), error: e => done(e?.status === 403 ? 'Sent for approval: an approver will review it.' : this.err(e)) });
    if (item.status === 'review') approveNow();
    else this.social.submitContent(item.id, null).subscribe({ next: () => approveNow(), error: e => { this.busy = ''; this.error = this.err(e); } });
  }
  approveAllReady(): void {
    const ready = (this.ov?.items || []).filter((i: any) => ['draft', 'review'].includes(i.status) && (i.media?.length || i.format === 'post'));
    if (!ready.length) { this.toast.emit('Nothing ready: posts need their media first.'); return; }
    if (!confirm(`Approve ${ready.length} post(s)? You can still edit them before they are published.`)) return;
    ready.forEach((i: any) => this.approve(i));
  }
  duplicate(item: any): void { this.social.duplicateContent(item.id).subscribe({ next: () => { this.toast.emit('Duplicated as a draft.'); this.loadOverview(); }, error: e => this.error = this.err(e) }); }
  remove(item: any): void {
    if (!confirm(`Delete "${item.title || 'this post'}"?`)) return;
    this.social.deleteContent(item.id).subscribe({ next: () => this.loadOverview(), error: e => this.error = this.err(e) });
  }
  regenerate(item: any): void {
    const tab = (this.tabs.find(t => t.formats.includes(item.format))?.key || 'post') as Tab;
    this.step = 'content';
    this.work(item, tab);
  }
  rewrite(item: any): void {
    this.busy = `rewrite-${item.id}`;
    this.social.regenerateContent(item.id, ['caption', 'hashtags'], '').subscribe({ next: () => { this.busy = ''; this.toast.emit('Text rewritten (a new version).'); this.loadOverview(); }, error: e => { this.busy = ''; this.error = this.err(e); } });
  }
  cover(item: any): any { return item.media?.[0] || null; }

  // ------------------------------------------------------------ step 6: schedule & publish
  get publishable(): any[] { return (this.ov?.items || []).filter((i: any) => ['approved', 'scheduled', 'publishing', 'published', 'failed'].includes(i.status)); }
  accountsFor(platform: string): any[] { return this.accounts.filter(a => a.platform === platform); }
  defaultWhen(item: any): string {
    if (this.scheduleAt[item.id]) return this.scheduleAt[item.id];
    const d = item.suggestedPublishAt ? new Date(item.suggestedPublishAt) : new Date(Date.now() + 3600000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  schedule(item: any): void {
    const accountId = this.scheduleAccount[item.id] ?? item.socialAccountId ?? this.accountsFor(item.platformKey)[0]?.id;
    if (!accountId) { this.error = `Connect a ${item.platformKey} account first (Connected Accounts).`; return; }
    this.busy = `sched-${item.id}`;
    this.social.scheduleContent(item.id, { accountId, localDateTime: this.scheduleAt[item.id] || this.defaultWhen(item) }).subscribe({
      next: () => { this.busy = ''; this.toast.emit('Scheduled.'); this.loadOverview(); },
      error: e => { this.busy = ''; this.error = this.err(e); }
    });
  }
  publishNow(item: any): void {
    const accountId = this.scheduleAccount[item.id] ?? item.socialAccountId ?? this.accountsFor(item.platformKey)[0]?.id;
    if (!accountId) { this.error = `Connect a ${item.platformKey} account first (Connected Accounts).`; return; }
    if (!confirm(`Publish "${item.title || 'this post'}" to ${item.platformKey} now?`)) return;
    this.busy = `pub-${item.id}`;
    this.social.publishNow(item.id, accountId).subscribe({ next: () => { this.busy = ''; this.toast.emit('Publishing… the status updates when the platform confirms.'); this.loadOverview(); }, error: e => { this.busy = ''; this.error = this.err(e); } });
  }
  unschedule(item: any): void { this.social.unschedule(item.id).subscribe({ next: () => this.loadOverview(), error: e => this.error = this.err(e) }); }

  // ------------------------------------------------------------ step 7: analytics
  loadAnalytics(): void {
    if (!this.campaignId) return;
    this.busy = 'analytics';
    this.studio.campaignAnalytics(this.campaignId).subscribe({ next: r => { this.busy = ''; this.analytics = r.analytics; }, error: e => { this.busy = ''; this.error = this.err(e); } });
  }
  metric(m: any): string { if (!m || m.value === null || m.value === undefined) return 'Unavailable'; return Number(m.value).toLocaleString('en-US'); }
  objectEntries(o: any): [string, any][] { return Object.entries(o || {}); }
  readonly metricKeys = [['reach', 'Reach'], ['impressions', 'Impressions'], ['likes', 'Likes'], ['comments', 'Comments'], ['shares', 'Shares'], ['clicks', 'Clicks']];

  tagsOf(item: any): string { return (item?.hashtags || []).map((h: string) => `#${h}`).join(' '); }
  // ------------------------------------------------------------ duration and automatic draft saving
  readonly durations = [{ key: '7', label: '7 days' }, { key: '14', label: '14 days' }, { key: '30', label: '30 days' }, { key: 'custom', label: 'Custom' }];
  get campaignDays(): number {
    const s = new Date(`${this.form.startDate}T00:00:00Z`); const e = new Date(`${this.form.endDate}T00:00:00Z`);
    return isNaN(s.getTime()) || isNaN(e.getTime()) ? 7 : Math.max(1, Math.round((e.getTime() - s.getTime()) / 86400000) + 1);
  }
  setDuration(d: string): void {
    this.form.duration = d;
    if (d === 'custom' || !this.form.startDate) return;
    const e = new Date(`${this.form.startDate}T00:00:00Z`); e.setUTCDate(e.getUTCDate() + Number(d) - 1);
    this.form.endDate = e.toISOString().slice(0, 10);
    this.autosave();
  }
  private durationOf(start: string, end: string): string {
    const s = new Date(`${start}T00:00:00Z`); const e = new Date(`${end}T00:00:00Z`);
    const n = Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
    return ['7', '14', '30'].includes(String(n)) ? String(n) : 'custom';
  }
  private autosaveTimer: any = null;
  savedAt: Date | null = null;
  /** Campaign details save themselves as a draft a moment after a change (once the campaign exists). */
  autosave(): void {
    if (!this.campaignId || !this.detailsValid()) return;
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => {
      const { duration, ...body } = this.form;
      this.social.updateCampaign(this.campaignId!, { ...body, landingUrl: body.landingUrl || null }).subscribe({ next: () => this.savedAt = new Date(), error: () => {} });
    }, 1500);
  }

  // ------------------------------------------------------------ strategy review helpers
  openIdea: string | null = null;
  readonly mixKeys = [['post', 'Posts'], ['poster', 'Posters'], ['video', 'Videos'], ['reel', 'Reels'], ['carousel', 'Carousels'], ['story', 'Stories']];
  get locked(): boolean { return this.strategy?.status === 'accepted'; }
  get ovw(): any { if (this.strategy && !this.strategy.overview) this.strategy.overview = { theme: this.strategy.theme || '', main_message: this.strategy.main_message || '' }; return this.strategy?.overview || {}; }
  get msgs(): any { if (this.strategy && !this.strategy.messages) this.strategy.messages = { hashtags: this.strategy.hashtags || [], ctas: this.strategy.cta_suggestions || [] }; return this.strategy?.messages || {}; }
  planCount(format: string): number { return (this.strategy?.ideas || []).filter((i: any) => i.format === format).length; }
  get postCount(): number { return (this.strategy?.ideas || []).reduce((n: number, i: any) => n + ((i.platforms || []).length || 1), 0); }
  dateOf(day: number): Date { const d = new Date(`${this.form.startDate}T00:00:00`); d.setDate(d.getDate() + (Number(day) || 1) - 1); return d; }
  formatLabel(f: string): string { return ({ post: 'Social post', poster: 'Poster', carousel: 'Carousel', reel: 'Reel', video: 'Video', story: 'Story' } as any)[f] || f; }
  splitTags(v: string): string[] { return String(v || '').split(/[\s,]+/).map(t => t.replace(/^#/, '')).filter(Boolean).slice(0, 30); }
  toggleIdeaPlatform(it: any, p: string): void {
    const list: string[] = it.platforms || (it.platform ? [it.platform] : []);
    const next = list.includes(p) ? list.filter(x => x !== p) : [...list, p];
    if (!next.length) return;
    it.platforms = next; this.strategyDirty = true;
  }
  moveIdea(i: number, d: number): void { const a = this.strategy.ideas; [a[i], a[i + d]] = [a[i + d], a[i]]; this.strategyDirty = true; }
  regenerateIdea(it: any): void {
    const run = () => {
      this.busy = `idea-${it.id}`;
      this.studio.regenerateIdea(this.campaignId!, it.id, { requestKey: requestKey() }).subscribe({
        next: r => { this.busy = ''; this.strategy = r.strategy; this.strategyDirty = false; this.toast.emit('Content item regenerated.'); },
        error: e => { this.busy = ''; this.error = this.err(e); }
      });
    };
    this.strategyDirty ? this.saveStrategy(run) : run();
  }
  regenerateAll(): void {
    if (!confirm('Regenerate the whole strategy? Your edits to this strategy will be replaced.')) return;
    this.generateStrategy();
  }

  // ------------------------------------------------------------ Generate All Content
  bulkEstimate: any = null;
  bulkRun: any = null;
  bulkItems: any[] = [];
  bulkCounts: any = { total: 0, completed: 0, processing: 0, queued: 0, failed: 0, canceled: 0 };
  private bulkTimer: any = null;
  get bulkDone(): number { return this.bulkCounts.completed + this.bulkCounts.failed + this.bulkCounts.canceled; }
  openBulkConfirm(): void {
    this.busy = 'bulk-est'; this.error = '';
    this.studio.bulkEstimate(this.campaignId!).subscribe({
      next: r => { this.busy = ''; this.bulkEstimate = r.estimate; if (r.estimate.active) { this.bulkEstimate = null; this.loadBulk(); } },
      error: e => { this.busy = ''; this.error = this.err(e); }
    });
  }
  startBulk(): void {
    this.busy = 'bulk';
    this.studio.bulkStart(this.campaignId!, true).subscribe({
      next: r => { this.busy = ''; this.bulkEstimate = null; this.toast.emit(r.alreadyRunning ? 'Generation is already running.' : 'Generating all content. You can leave this page.'); this.loadBulk(); },
      error: e => { this.busy = ''; this.error = this.err(e); }
    });
  }
  loadBulk(): void {
    if (!this.campaignId) return;
    this.studio.bulkStatus(this.campaignId).subscribe({
      next: r => {
        const wasActive = this.bulkRun?.active;
        this.bulkRun = r.run; this.bulkItems = r.items || []; this.bulkCounts = r.counts;
        clearTimeout(this.bulkTimer);
        if (r.run?.active) this.bulkTimer = setTimeout(() => this.loadBulk(), 4000);
        if (wasActive && !r.run?.active) { this.toast.emit(`Generation finished: ${r.counts.completed} completed, ${r.counts.failed} failed.`); this.loadOverview(); }
        if (r.run?.active && (r.counts.completed || r.counts.failed)) this.loadOverview();
      },
      error: () => {}
    });
  }
  cancelBulk(itemId: number | null): void {
    if (!itemId && !confirm('Cancel the items that have not started yet? Items already being created will finish.')) return;
    this.studio.bulkCancel(this.campaignId!, itemId).subscribe({ next: () => this.loadBulk(), error: e => this.error = this.err(e) });
  }
  retryBulkItem(u: any): void { this.studio.bulkRetry(this.campaignId!, u.itemId).subscribe({ next: () => this.loadBulk(), error: e => this.error = this.err(e) }); }
  itemById(id: number): any { return (this.ov?.items || []).find((i: any) => i.id === id) || { id }; }
  viewItem(id: number): void { const it = this.itemById(id); if (it?.title) this.previewing = it; else this.loadOverview(); }
  tabOf(format: string): any { return (this.tabs.find(t => t.formats.includes(format))?.key || 'post'); }
  platformsText(ps: string[]): string { return (ps || []).map(p => `${this.platformIcon(p)} ${p}`).join('  '); }
  ngOnDestroy(): void { clearTimeout(this.bulkTimer); clearTimeout(this.autosaveTimer); }

  // ------------------------------------------------------------ review: filters, selection, versions
  readonly reviewFilters = [{ key: 'all', label: 'All content' }, { key: 'poster', label: 'Posters' }, { key: 'video', label: 'Videos' }, { key: 'reel', label: 'Reels' },
    { key: 'carousel', label: 'Carousels' }, { key: 'post', label: 'Social posts' }, { key: 'story', label: 'Stories' },
    { key: 'needs', label: 'Needs review' }, { key: 'approved', label: 'Approved' }, { key: 'failed', label: 'Failed' }];
  reviewFilter = 'all';
  selectedIds: number[] = [];
  historyFor: any = null; history: any[] = [];
  private matches(i: any, f: string): boolean {
    if (f === 'all') return true;
    if (f === 'needs') return ['draft', 'review', 'rejected'].includes(i.status);
    if (f === 'approved') return ['approved', 'scheduled', 'published'].includes(i.status);
    if (f === 'failed') return i.status === 'failed' || i.generation?.status === 'failed';
    return i.format === f;
  }
  get filteredItems(): any[] { return (this.ov?.items || []).filter((i: any) => this.matches(i, this.reviewFilter)); }
  countFor(f: string): number { return (this.ov?.items || []).filter((i: any) => this.matches(i, f)).length; }
  toggleSelect(id: number): void { this.selectedIds = this.selectedIds.includes(id) ? this.selectedIds.filter(x => x !== id) : [...this.selectedIds, id]; }
  approveSelected(): void {
    const items = (this.ov?.items || []).filter((i: any) => this.selectedIds.includes(i.id));
    if (!items.length || !confirm(`Approve ${items.length} selected post(s)?`)) return;
    items.forEach((i: any) => this.approve(i));
    this.selectedIds = [];
  }
  showHistory(it: any): void {
    this.historyFor = it; this.history = [];
    this.studio.history(it.id).subscribe({ next: r => this.history = r.history || [], error: e => this.error = this.err(e) });
  }

  // ------------------------------------------------------------ schedule all approved at the planned times
  get approvedCount(): number { return (this.ov?.items || []).filter((i: any) => i.status === 'approved').length; }
  scheduleAllPlanned(): void {
    const items = (this.ov?.items || []).filter((i: any) => i.status === 'approved');
    const missing = items.filter((i: any) => !(i.socialAccountId || this.accountsFor(i.platformKey)[0]));
    if (missing.length) { this.error = `Connect ${[...new Set(missing.map((i: any) => i.platformKey))].join(', ')} first (Connected Accounts).`; return; }
    if (!confirm(`Schedule ${items.length} approved post(s) at their planned dates and times?`)) return;
    this.busy = 'sched-all';
    let left = items.length; let ok = 0;
    for (const it of items) {
      const accountId = it.socialAccountId ?? this.accountsFor(it.platformKey)[0].id;
      this.social.scheduleContent(it.id, { accountId, localDateTime: this.defaultWhen(it) }).subscribe({
        next: () => { ok++; if (--left === 0) { this.busy = ''; this.toast.emit(`${ok} post(s) scheduled.`); this.loadOverview(); } },
        error: e => { this.error = `${it.title}: ${this.err(e)}`; if (--left === 0) { this.busy = ''; this.loadOverview(); } }
      });
    }
  }

  statusOf(s: string): string { return this.statusLabels[s] || s; }
  platformIcon(k: string): string { return this.platforms.find(p => p.key === k)?.icon || '•'; }
  formatIcon(f: string): string { return ({ post: '✍️', poster: '🖼️', carousel: '🎠', reel: '📱', video: '🎬', story: '⭕' } as any)[f] || '•'; }
  campaignStep(c: any): string { return this.steps.find(s => s.key === c.wizardStep)?.label || (c.strategy ? 'AI Strategy' : 'Campaign Details'); }
  /** Features of the selected product (benefits are what the features do for the customer; nothing is added). */
  featuresOf(p: any): string[] { return (p?.features || []).map((f: any) => String(f)); }
  productName(id: number): string { return this.products.find(p => p.id === id)?.name || ''; }
  private err(e: any): string { return e?.error?.error || e?.message || 'Something went wrong.'; }
}
