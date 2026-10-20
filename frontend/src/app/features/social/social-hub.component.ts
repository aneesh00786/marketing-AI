import { Component, EventEmitter, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SocialApiService } from './social-api.service';

type Section = 'overview' | 'accounts' | 'campaigns' | 'calendar' | 'library' | 'queue' | 'analytics' | 'inbox' | 'strategist' | 'settings';

const PLATFORMS = [
  { key: 'facebook', label: 'Facebook', icon: '📘' },
  { key: 'instagram', label: 'Instagram', icon: '📸' },
  { key: 'linkedin', label: 'LinkedIn', icon: '💼' },
  { key: 'youtube', label: 'YouTube', icon: '▶️' },
  { key: 'x', label: 'X (manual)', icon: '✖️' }
];

const METRIC_LABELS: Record<string, string> = {
  impressions: 'Impressions', reach: 'Reach', views: 'Views', likes: 'Likes',
  comments: 'Comments', shares: 'Shares', saves: 'Saves', clicks: 'Clicks'
};

@Component({
  selector: 'app-social-hub',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './social-hub.component.html',
  styleUrls: ['./social-hub.component.css']
})
export class SocialHubComponent implements OnInit, OnDestroy {
  @Input() initialSection: Section | null = null;
  @Input() oauthResult: Record<string, string> | null = null;
  @Input() initialCampaignId: number | null = null;
  @Input() initialLibraryStatus: string | null = null;
  @Output() toast = new EventEmitter<string>();

  readonly sections: { key: Section; label: string; icon: string }[] = [
    { key: 'overview', label: 'Overview', icon: '🧭' },
    { key: 'accounts', label: 'Connected Accounts', icon: '🔗' },
    { key: 'campaigns', label: 'Campaigns', icon: '🎯' },
    { key: 'calendar', label: 'Content Calendar', icon: '🗓️' },
    { key: 'library', label: 'Content Library', icon: '🗂️' },
    { key: 'queue', label: 'Publishing Queue', icon: '🚀' },
    { key: 'analytics', label: 'Analytics & Reports', icon: '📊' },
    { key: 'inbox', label: 'Engagement Inbox', icon: '💬' },
    { key: 'strategist', label: 'Roger AI Strategist', icon: '🧠' },
    { key: 'settings', label: 'Social Settings', icon: '⚙️' }
  ];
  readonly platforms = PLATFORMS;
  readonly metricKeys = Object.keys(METRIC_LABELS);
  readonly metricLabels = METRIC_LABELS;
  readonly contentStatuses = ['draft', 'generating', 'review', 'approved', 'scheduled', 'publishing', 'published', 'rejected', 'failed', 'cancelled'];
  readonly timezones: string[] = ['UTC', ...(((Intl as any).supportedValuesOf ? (Intl as any).supportedValuesOf('timeZone') : []) as string[]).filter(z => z !== 'UTC')];

  section: Section = 'overview';
  loading = false;
  error: string | null = null;
  oauthBanner: { ok: boolean; text: string } | null = null;

  // Shared reference data
  settings: any = { timezone: 'UTC', requireApproval: true };
  accounts: any[] = [];
  providers: any[] = [];
  registry: any = null;
  campaigns: any[] = [];
  products: any[] = [];
  members: any[] = [];
  assets: any[] = [];

  // Overview
  overview: any = null;

  // Provider app setup (per workspace)
  setupProvider: string | null = null;
  setupForm = { clientId: '', clientSecret: '' };
  readonly setupGuides: Record<string, { console: string; consoleUrl: string; steps: string[] }> = {
    meta: {
      console: 'Meta for Developers',
      consoleUrl: 'https://developers.facebook.com/apps',
      steps: [
        'Open Meta for Developers → My Apps → Create App, signed in as an admin of your Facebook Page.',
        'Choose the use case "Manage everything on your Page" (type: Business).',
        'In the use case → Customize, add the permissions listed below (Pages + Instagram).',
        'Facebook Login (for Business) → Settings → Valid OAuth Redirect URIs: add the redirect URL below.',
        'App settings → Basic: copy the App ID and App Secret into this form.',
        'While the app is in development mode only people with a role on the app can connect; publish it via App Review for everyone else.'
      ]
    },
    linkedin: {
      console: 'LinkedIn Developers',
      consoleUrl: 'https://www.linkedin.com/developers/apps',
      steps: [
        'Create an app at LinkedIn Developers and link it to your LinkedIn Page.',
        'Products tab: request access to "Community Management API" (LinkedIn must approve it).',
        'Auth tab: add the redirect URL below under "Authorized redirect URLs".',
        'Auth tab: copy the Client ID and Client Secret into this form.'
      ]
    },
    youtube: {
      console: 'Google Cloud Console',
      consoleUrl: 'https://console.cloud.google.com/apis/credentials',
      steps: [
        'In Google Cloud, create a project and enable "YouTube Data API v3".',
        'Configure the OAuth consent screen and add the scopes listed below.',
        'Credentials → Create OAuth client ID → Web application; add the redirect URL below as an authorized redirect URI.',
        'Copy the Client ID and Client Secret into this form.'
      ]
    }
  };

  // Campaigns
  campaignForm: any = this.blankCampaign();
  showCampaignWizard = false;
  selectedCampaign: any = null;
  selectedCampaignContent: any[] = [];
  factsUrl = '';
  extractedFacts: any = null;
  isExtracting = false;
  private pollTimer: any = null;

  // Library
  libraryFilters: any = { status: 'all', platformKey: '', campaignId: '', accountId: '', q: '' };
  libraryView: 'grid' | 'list' = 'grid';
  content: any[] = [];
  editor: any = null;
  editorDetail: any = null;
  editorDraft: any = null;
  scheduleForm: any = { accountId: null, localDateTime: '', timezone: 'UTC' };
  regenForm: any = { fields: { caption: true, hashtags: false, title: false, call_to_action: false, image_prompt: false }, instruction: '' };
  rejectNote = '';
  approverId: number | null = null;
  newAssetUrl = '';
  newAssetType: 'image' | 'video' = 'image';
  busy = false;

  // Calendar
  calendarView: 'month' | 'week' | 'list' = 'month';
  calendarAnchor = new Date();
  calendarItems: any[] = [];
  calendarFilters: any = { platformKey: '', accountId: '', campaignId: '', status: '' };

  // Queue
  queueStatus = 'all';
  jobs: any[] = [];

  // Analytics
  analyticsFilters: any = { from: this.isoDay(-30), to: this.isoDay(0), platformKey: '', accountId: '', campaignId: '' };
  analytics: any = null;

  // Inbox
  inboxFilters: any = { status: 'open', category: 'all', accountId: '' };
  threads: any[] = [];
  activeThread: any = null;
  replyText = '';
  replyDraftId: number | null = null;
  leadForm: any = { email: '', phone: '' };

  // Strategist
  question = '';
  strategistAnswer: any = null;
  isAsking = false;
  readonly examplePrompts = [
    'Which posts performed best this month?',
    'Compare our Facebook and Instagram engagement.',
    'Which campaigns generated the most clicks?',
    'Recommend content based on our actual performance.'
  ];

  // Settings
  settingsForm: any = null;
  usage: any = null;
  auditEvents: any[] = [];

  constructor(private api: SocialApiService) {}

  ngOnInit(): void {
    if (this.oauthResult?.['oauth']) {
      const r = this.oauthResult;
      const reasons: Record<string, string> = {
        invalid_state: 'The connection link expired or was already used. Start again.',
        denied: 'Permission was not granted on the provider screen.',
        no_eligible_accounts: 'No eligible Pages/accounts were found for that login (check you are an admin and granted Page access).',
        exchange_failed: 'The provider rejected the authorization. Check the app configuration and try again.',
        setup_required: 'Credential encryption is not configured on the server.',
        not_a_member: 'Your account is no longer a member of this workspace.'
      };
      this.oauthBanner = r['oauth'] === 'success'
        ? { ok: true, text: `Connected ${r['connected'] || ''} account(s) from ${r['provider']}.` }
        : { ok: false, text: `Connection failed (${r['provider'] || 'provider'}): ${reasons[r['reason']] || r['reason']}` };
    }
    this.loadReference();
    if (this.initialLibraryStatus && this.initialSection === 'library') this.libraryFilters.status = this.initialLibraryStatus;
    if (this.initialLibraryStatus && this.initialSection === 'queue') this.queueStatus = 'failed,needs_review';
    this.go(this.initialSection || (this.oauthResult ? 'accounts' : 'overview'));
    if (this.initialCampaignId && this.section === 'campaigns') this.openCampaign({ id: this.initialCampaignId });
  }

  ngOnDestroy(): void {
    clearInterval(this.pollTimer);
  }

  // ---------- Helpers ----------
  private isoDay(offsetDays: number): string {
    return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
  }

  private fail(err: any, fallback = 'Request failed'): void {
    const msg = err?.error?.error || err?.message || fallback;
    this.error = msg;
    this.toast.emit(`⚠️ ${msg}`);
    this.busy = false;
    this.loading = false;
  }

  notify(msg: string): void {
    this.error = null;
    this.toast.emit(msg);
  }

  platformLabel(key: string | null): string {
    return PLATFORMS.find(p => p.key === key)?.label || key || '—';
  }

  platformIcon(key: string | null): string {
    return PLATFORMS.find(p => p.key === key)?.icon || '📝';
  }

  /** Formats a UTC timestamp in the workspace time zone. */
  fmt(value: any, withTime = true): string {
    if (!value) return '—';
    const d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.toLocaleString(undefined, {
      timeZone: this.settings?.timezone || 'UTC',
      year: 'numeric', month: 'short', day: 'numeric',
      ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {})
    });
  }

  /** A metric value or an explicit "unavailable" label; never shows a missing metric as 0. */
  metricValue(m: any): string {
    if (!m) return '—';
    if (m.value === null || m.value === undefined) return m.availability === 'not_collected' ? 'Not collected' : 'Unavailable';
    return Number(m.value).toLocaleString();
  }

  metricCoverage(m: any): string {
    if (!m) return '';
    const total = (m.availableFor || 0) + (m.unavailableFor || 0) + (m.notCollectedFor || 0);
    if (!total) return 'No published posts in range';
    if (m.availableFor === total) return `All ${total} posts`;
    return `Reported for ${m.availableFor} of ${total} posts`;
  }

  accountsFor(platformKey: string | null): any[] {
    return this.accounts.filter(a => a.status === 'connected' && (!platformKey || a.platformKey === platformKey));
  }

  capabilityClass(status: string): string {
    return ({ available: 'ok', missing_permission: 'warn', setup_required: 'warn', not_implemented: 'muted', unsupported_by_provider: 'muted' } as any)[status] || 'muted';
  }

  capabilityText(status: string): string {
    return ({ available: 'Available', missing_permission: 'Missing permission', setup_required: 'Setup required', not_implemented: 'Not in this release', unsupported_by_provider: 'Not offered by platform' } as any)[status] || status;
  }

  statusClass(status: string): string {
    return `st-${status}`;
  }

  go(section: Section): void {
    this.section = section;
    this.error = null;
    switch (section) {
      case 'overview': this.loadOverview(); break;
      case 'accounts': this.loadAccounts(); break;
      case 'campaigns': this.loadCampaigns(); break;
      case 'calendar': this.loadCalendar(); break;
      case 'library': this.loadLibrary(); break;
      case 'queue': this.loadQueue(); break;
      case 'analytics': this.loadAnalytics(); break;
      case 'inbox': this.loadThreads(); break;
      case 'settings': this.loadSettings(); break;
    }
  }

  loadReference(): void {
    this.api.settings().subscribe({ next: r => { this.settings = r.settings; this.scheduleForm.timezone = r.settings.timezone; } });
    this.api.accounts().subscribe({ next: r => this.accounts = r.accounts });
    this.api.campaigns().subscribe({ next: r => this.campaigns = r.campaigns });
    this.api.products().subscribe({ next: r => this.products = r.products });
    this.api.members().subscribe({ next: r => this.members = r.members });
    this.api.capabilities().subscribe({ next: r => this.registry = r.registry });
  }

  // ---------- Overview ----------
  loadOverview(): void {
    this.loading = true;
    this.api.overview().subscribe({
      next: r => { this.overview = r.overview; this.settings = r.overview.settings; this.accounts = r.overview.accounts; this.loading = false; },
      error: e => this.fail(e)
    });
  }

  getRecommendations(): void {
    this.section = 'strategist';
    this.question = 'Recommend content based on our actual performance.';
    this.askRoger();
  }

  // ---------- Accounts ----------
  loadAccounts(): void {
    this.loading = true;
    this.api.providers().subscribe({ next: r => this.providers = r.providers, error: e => this.fail(e) });
    this.api.accounts(true).subscribe({
      next: r => { this.accounts = r.accounts.filter((a: any) => a.status !== 'disconnected'); this.loading = false; },
      error: e => this.fail(e)
    });
  }

  connect(provider: any): void {
    if (!provider.configured) {
      this.openSetup(provider);
      return;
    }
    this.busy = true;
    this.api.startOAuth(provider.providerKey).subscribe({
      next: r => { window.location.href = r.authorizeUrl; },
      error: e => this.fail(e)
    });
  }

  openSetup(p: any): void {
    this.setupProvider = p.providerKey;
    this.setupForm = { clientId: p.workspaceApp?.clientId || '', clientSecret: '' };
  }

  copy(text: string): void {
    navigator.clipboard?.writeText(text).then(() => this.notify('Copied.'), () => this.notify('Copy failed — select the text instead.'));
  }

  saveProviderApp(p: any): void {
    if (!this.setupForm.clientId.trim()) { this.notify(`Enter the ${p.labels.id}.`); return; }
    if (!this.setupForm.clientSecret.trim() && !p.workspaceApp) { this.notify(`Enter the ${p.labels.secret}.`); return; }
    this.busy = true;
    this.api.saveProviderApp(p.providerKey, { clientId: this.setupForm.clientId.trim(), clientSecret: this.setupForm.clientSecret.trim() }).subscribe({
      next: r => {
        this.busy = false;
        this.setupForm.clientSecret = '';
        this.setupProvider = null;
        this.notify(`✓ ${p.label} app saved. ${r.status.verification?.note || ''} You can now click Connect.`);
        this.loadAccounts();
      },
      error: e => this.fail(e)
    });
  }

  removeProviderApp(p: any): void {
    if (!confirm(`Remove your ${p.label} app credentials from this workspace? Connected accounts keep posting, but token refresh and new connections will stop working until you set it up again.`)) return;
    this.api.removeProviderApp(p.providerKey).subscribe({
      next: r => { this.notify(`App credentials removed.${r.accountsUsingIt ? ` ${r.accountsUsingIt} connected account(s) were using them.` : ''}`); this.loadAccounts(); },
      error: e => this.fail(e)
    });
  }

  checkAccount(a: any): void {
    this.api.checkAccount(a.id).subscribe({
      next: r => { this.notify(r.ok ? `✓ ${a.displayName}: connection healthy` : `⚠️ ${a.displayName}: ${r.detail}`); this.loadAccounts(); },
      error: e => this.fail(e)
    });
  }

  disconnect(a: any): void {
    if (!confirm(`Disconnect ${a.displayName}? Scheduled posts for this account will be unscheduled and stored credentials deleted.`)) return;
    this.api.disconnectAccount(a.id).subscribe({
      next: r => {
        this.notify(r.revoked ? `${a.displayName} disconnected and access revoked.` : `${a.displayName} disconnected.${r.sharedGrantInUse ? ' The provider grant stays active for other accounts from the same login.' : ''}${r.revokeError ? ` (Revocation failed: ${r.revokeError})` : ''}`);
        this.loadAccounts();
      },
      error: e => this.fail(e)
    });
  }

  featureList(): string[] {
    return this.registry ? Object.keys(this.registry.features) : [];
  }

  manualPlatforms(): any[] {
    return this.registry ? Object.values(this.registry.manualPlatforms) : [];
  }

  // ---------- Campaigns ----------
  blankCampaign(): any {
    return {
      name: '', objective: '', productId: null, targetAudience: '', offer: '', keyMessage: '',
      startDate: this.isoDay(1), endDate: this.isoDay(30), platforms: {} as Record<string, boolean>, accountIds: {} as Record<number, boolean>,
      tone: 'Professional', language: 'en', desiredPostCount: 6, imageRequirements: '', videoRequirements: '',
      callToAction: '', landingUrl: ''
    };
  }

  loadCampaigns(): void {
    this.loading = true;
    this.api.campaigns().subscribe({ next: r => { this.campaigns = r.campaigns; this.loading = false; }, error: e => this.fail(e) });
    this.api.products().subscribe({ next: r => this.products = r.products });
  }

  openWizard(): void {
    this.campaignForm = this.blankCampaign();
    this.extractedFacts = null;
    this.factsUrl = '';
    this.showCampaignWizard = true;
    this.selectedCampaign = null;
  }

  extractFacts(): void {
    if (!this.factsUrl) return;
    this.isExtracting = true;
    this.api.extractFacts(this.factsUrl).subscribe({
      next: r => { this.extractedFacts = r.facts; this.isExtracting = false; this.notify(r.note); },
      error: e => { this.isExtracting = false; this.fail(e); }
    });
  }

  saveExtractedProduct(): void {
    const f = this.extractedFacts;
    this.api.saveProduct({ name: f.name, url: f.url, tagline: f.tagline, description: f.description, features: f.features || [], targetAudience: f.target_audience }).subscribe({
      next: r => {
        this.notify('Product facts saved.');
        this.api.products().subscribe(p => { this.products = p.products; this.campaignForm.productId = r.productId; });
        this.extractedFacts = null;
      },
      error: e => this.fail(e)
    });
  }

  private campaignPayload(): any {
    const f = this.campaignForm;
    const n = (v: any) => (v === '' || v === undefined ? null : v);
    return {
      name: f.name, objective: n(f.objective), productId: f.productId ? Number(f.productId) : null,
      targetAudience: n(f.targetAudience), offer: n(f.offer), keyMessage: n(f.keyMessage),
      startDate: n(f.startDate), endDate: n(f.endDate),
      platforms: Object.keys(f.platforms).filter(k => f.platforms[k]),
      accountIds: Object.keys(f.accountIds).filter(k => f.accountIds[k]).map(Number),
      tone: n(f.tone), language: f.language || 'en', desiredPostCount: f.desiredPostCount ? Number(f.desiredPostCount) : null,
      imageRequirements: n(f.imageRequirements), videoRequirements: n(f.videoRequirements),
      callToAction: n(f.callToAction), landingUrl: f.landingUrl || null
    };
  }

  saveCampaign(generate: boolean): void {
    const payload = this.campaignPayload();
    if (!payload.name) { this.notify('Give the campaign a name.'); return; }
    if (payload.platforms.length === 0) { this.notify('Choose at least one platform.'); return; }
    this.busy = true;
    this.api.createCampaign(payload).subscribe({
      next: r => {
        this.busy = false;
        this.showCampaignWizard = false;
        this.notify('Campaign saved.');
        this.openCampaign(r.campaign);
        if (generate) this.generate(r.campaign);
        this.loadCampaigns();
      },
      error: e => this.fail(e)
    });
  }

  openCampaign(c: any): void {
    this.showCampaignWizard = false;
    this.api.campaign(c.id).subscribe({
      next: r => {
        this.selectedCampaign = r.campaign;
        this.selectedCampaignContent = r.content;
        if (['queued', 'running'].includes(r.campaign.generationStatus)) this.pollCampaign(c.id);
      },
      error: e => this.fail(e)
    });
  }

  generate(c: any): void {
    this.api.generateCampaign(c.id).subscribe({
      next: () => { this.notify('Generation queued. Drafts appear here when the worker finishes.'); this.pollCampaign(c.id); },
      error: e => this.fail(e)
    });
  }

  private pollCampaign(id: number): void {
    clearInterval(this.pollTimer);
    let tries = 0;
    this.pollTimer = setInterval(() => {
      tries++;
      this.api.campaign(id).subscribe(r => {
        this.selectedCampaign = r.campaign;
        this.selectedCampaignContent = r.content;
        if (!['queued', 'running'].includes(r.campaign.generationStatus) || tries > 90) {
          clearInterval(this.pollTimer);
          if (r.campaign.generationStatus === 'completed') this.notify(`✓ ${r.content.length} drafts generated for review.`);
          if (tries > 90 && ['queued', 'running'].includes(r.campaign.generationStatus)) this.notify('Still queued — is the worker running (npm run worker)?');
        }
      });
    }, 4000);
  }

  // ---------- Library & editor ----------
  loadLibrary(): void {
    this.loading = true;
    this.api.content(this.libraryFilters).subscribe({ next: r => { this.content = r.items; this.loading = false; }, error: e => this.fail(e) });
    this.api.assets().subscribe({ next: r => this.assets = r.assets });
  }

  newContent(): void {
    this.openEditor({ id: null, platformKey: 'linkedin', caption: '', hashtags: [], status: 'draft', mediaAssetIds: [], version: 1 });
  }

  openEditor(item: any): void {
    this.api.assets().subscribe({ next: r => this.assets = r.assets });
    this.editor = item;
    this.editorDetail = null;
    this.rejectNote = '';
    this.approverId = null;
    this.editorDraft = {
      title: item.title || '', caption: item.caption || '', hashtagsText: (item.hashtags || []).join(' '),
      callToAction: item.callToAction || '', linkUrl: item.linkUrl || '', platformKey: item.platformKey || 'linkedin',
      socialAccountId: item.socialAccountId || null, campaignId: item.campaignId || null,
      mediaAssetIds: [...(item.mediaAssetIds || [])], imagePrompt: item.imagePrompt || '', videoScript: item.videoScript || ''
    };
    const suggested = item.scheduledAt || item.suggestedPublishAt;
    this.scheduleForm = {
      accountId: item.socialAccountId || this.accountsFor(item.platformKey)[0]?.id || null,
      localDateTime: suggested ? this.toLocalInput(suggested) : '',
      timezone: item.scheduleTimezone || this.settings.timezone || 'UTC'
    };
    if (item.id) {
      this.api.contentDetail(item.id).subscribe({ next: r => { this.editorDetail = r; this.editor = r.content; }, error: e => this.fail(e) });
    }
  }

  closeEditor(): void {
    this.editor = null;
    this.editorDetail = null;
    if (this.section === 'library') this.loadLibrary();
    if (this.section === 'calendar') this.loadCalendar();
    if (this.selectedCampaign) this.openCampaign(this.selectedCampaign);
  }

  private toLocalInput(value: any): string {
    const d = new Date(value);
    const parts: any = {};
    new Intl.DateTimeFormat('en-US', { timeZone: this.settings.timezone || 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(d).forEach(p => parts[p.type] = p.value);
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  }

  private editorPayload(): any {
    const d = this.editorDraft;
    return {
      title: d.title || null, caption: d.caption, hashtags: d.hashtagsText, callToAction: d.callToAction || null,
      linkUrl: d.linkUrl || null, platformKey: d.platformKey, socialAccountId: d.socialAccountId ? Number(d.socialAccountId) : null,
      campaignId: d.campaignId ? Number(d.campaignId) : null, mediaAssetIds: d.mediaAssetIds,
      imagePrompt: d.imagePrompt || null, videoScript: d.videoScript || null
    };
  }

  saveEditor(): void {
    this.busy = true;
    const req = this.editor.id ? this.api.updateContent(this.editor.id, this.editorPayload()) : this.api.createContent(this.editorPayload());
    req.subscribe({
      next: r => {
        this.busy = false;
        const wasApproved = ['approved', 'scheduled'].includes(this.editor.status);
        this.notify(wasApproved && r.content.status === 'draft' ? 'Saved as a new version. It needs approval again.' : 'Saved.');
        this.openEditor(r.content);
      },
      error: e => this.fail(e)
    });
  }

  private act(obs: any, okMsg: string, reopen = true): void {
    this.busy = true;
    obs.subscribe({
      next: (r: any) => {
        this.busy = false;
        this.notify(okMsg);
        if (reopen && this.editor?.id) this.openEditor(r.content || this.editor);
      },
      error: (e: any) => this.fail(e)
    });
  }

  submitForApproval(): void { this.act(this.api.submitContent(this.editor.id, this.approverId), 'Submitted for approval.'); }
  approve(): void { this.act(this.api.approveContent(this.editor.id), '✓ Approved.'); }
  reject(): void {
    if (!this.rejectNote.trim()) { this.notify('Add a note explaining the rejection.'); return; }
    this.act(this.api.rejectContent(this.editor.id, this.rejectNote), 'Rejected with note.');
  }
  duplicate(): void {
    this.api.duplicateContent(this.editor.id).subscribe({ next: r => { this.notify('Duplicated as a new draft.'); this.openEditor(r.content); }, error: e => this.fail(e) });
  }
  cancelItem(): void {
    if (!confirm('Cancel this content? It will not be published.')) return;
    this.act(this.api.cancelContent(this.editor.id), 'Cancelled.');
  }
  deleteItem(): void {
    if (!confirm('Delete this draft permanently?')) return;
    this.api.deleteContent(this.editor.id).subscribe({ next: () => { this.notify('Deleted.'); this.closeEditor(); }, error: e => this.fail(e) });
  }

  schedule(): void {
    if (!this.scheduleForm.localDateTime) { this.notify('Pick a date and time.'); return; }
    this.busy = true;
    this.api.scheduleContent(this.editor.id, {
      accountId: this.scheduleForm.accountId ? Number(this.scheduleForm.accountId) : undefined,
      localDateTime: this.scheduleForm.localDateTime,
      timezone: this.scheduleForm.timezone
    }).subscribe({
      next: r => { this.busy = false; this.notify(`Scheduled for ${this.fmt(r.job.scheduledFor)} (${r.job.scheduleTimezone}).`); this.openEditor(this.editor); },
      error: e => this.fail(e)
    });
  }

  publishNow(): void {
    if (!confirm('Publish this post to the selected account now?')) return;
    this.busy = true;
    this.api.publishNow(this.editor.id, this.scheduleForm.accountId ? Number(this.scheduleForm.accountId) : undefined).subscribe({
      next: () => { this.busy = false; this.notify('Queued for immediate publishing. It is marked published only after the platform confirms.'); this.openEditor(this.editor); },
      error: e => this.fail(e)
    });
  }

  unschedule(): void { this.act(this.api.unschedule(this.editor.id), 'Unscheduled.'); }

  regenerate(): void {
    const fields = Object.keys(this.regenForm.fields).filter(k => this.regenForm.fields[k]);
    if (!fields.length) { this.notify('Choose what to regenerate.'); return; }
    this.busy = true;
    this.api.regenerateContent(this.editor.id, fields, this.regenForm.instruction).subscribe({
      next: r => { this.busy = false; this.notify('Regenerated as a new version — review it before approving.'); this.openEditor(r.content); },
      error: e => this.fail(e)
    });
  }

  addAsset(): void {
    if (!this.newAssetUrl) return;
    this.api.registerAsset({ url: this.newAssetUrl, assetType: this.newAssetType }).subscribe({
      next: r => {
        this.assets = [r.asset, ...this.assets];
        this.editorDraft.mediaAssetIds = [...this.editorDraft.mediaAssetIds, r.asset.id];
        this.newAssetUrl = '';
        this.notify('Media added. Save to attach it.');
      },
      error: e => this.fail(e)
    });
  }

  toggleAsset(id: number): void {
    const ids: number[] = this.editorDraft.mediaAssetIds;
    this.editorDraft.mediaAssetIds = ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id];
  }

  assetById(id: number): any {
    return this.assets.find(a => a.id === id);
  }

  previewText(): string {
    const d = this.editorDraft;
    return [d.caption, d.callToAction && !d.caption.includes(d.callToAction) ? d.callToAction : '', d.hashtagsText].filter(Boolean).join('\n\n');
  }

  captionLimit(): number | null {
    const map: Record<string, number> = { facebook: 63206, instagram: 2200, linkedin: 3000, x: 280 };
    return map[this.editorDraft?.platformKey] || null;
  }

  copyForManualPosting(): void {
    navigator.clipboard?.writeText(this.previewText()).then(
      () => this.notify('Copied. Post it manually on the platform — TradeSage will not mark it as published.'),
      () => this.notify('Copy failed; select the preview text instead.')
    );
  }

  canEdit(item: any): boolean {
    return ['draft', 'review', 'approved', 'scheduled', 'rejected', 'failed'].includes(item?.status) || !item?.id;
  }

  // ---------- Calendar ----------
  loadCalendar(): void {
    const { from, to } = this.calendarRange();
    this.loading = true;
    this.api.calendar({ ...this.calendarFilters, from: from.toISOString(), to: to.toISOString() }).subscribe({
      next: r => { this.calendarItems = r.items; this.loading = false; },
      error: e => this.fail(e)
    });
  }

  calendarRange(): { from: Date; to: Date } {
    const a = new Date(this.calendarAnchor);
    if (this.calendarView === 'week') {
      const start = new Date(a);
      start.setDate(a.getDate() - ((a.getDay() + 6) % 7));
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(start.getDate() + 7);
      return { from: start, to: end };
    }
    if (this.calendarView === 'list') {
      const start = new Date(a);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(start.getDate() + 60);
      return { from: start, to: end };
    }
    const first = new Date(a.getFullYear(), a.getMonth(), 1);
    const start = new Date(first);
    start.setDate(first.getDate() - ((first.getDay() + 6) % 7));
    const end = new Date(start);
    end.setDate(start.getDate() + 42);
    return { from: start, to: end };
  }

  calendarTitle(): string {
    if (this.calendarView === 'month') return this.calendarAnchor.toLocaleString(undefined, { month: 'long', year: 'numeric' });
    const { from, to } = this.calendarRange();
    const end = new Date(to.getTime() - 86400000);
    return `${from.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }

  goToday(): void {
    this.calendarAnchor = new Date();
    this.loadCalendar();
  }

  shiftCalendar(dir: number): void {
    const a = new Date(this.calendarAnchor);
    if (this.calendarView === 'month') a.setMonth(a.getMonth() + dir);
    else if (this.calendarView === 'week') a.setDate(a.getDate() + 7 * dir);
    else a.setDate(a.getDate() + 60 * dir);
    this.calendarAnchor = a;
    this.loadCalendar();
  }

  calendarDays(): Date[] {
    const { from, to } = this.calendarRange();
    const days: Date[] = [];
    for (let d = new Date(from); d < to; d.setDate(d.getDate() + 1)) days.push(new Date(d));
    return days;
  }

  /** Day key in the workspace time zone, so a 23:30 UTC post lands on the right local day. */
  private dayKey(value: any): string {
    const parts: any = {};
    new Intl.DateTimeFormat('en-US', { timeZone: this.settings.timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(value)).forEach(p => parts[p.type] = p.value);
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  itemsOn(day: Date): any[] {
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    return this.calendarItems.filter(i => i.calendarAt && this.dayKey(i.calendarAt) === key);
  }

  isOtherMonth(day: Date): boolean {
    return this.calendarView === 'month' && day.getMonth() !== this.calendarAnchor.getMonth();
  }

  isToday(day: Date): boolean {
    return day.toDateString() === new Date().toDateString();
  }

  // ---------- Queue ----------
  loadQueue(): void {
    this.loading = true;
    this.api.queue(this.queueStatus).subscribe({ next: r => { this.jobs = r.jobs; this.loading = false; }, error: e => this.fail(e) });
  }

  retryJob(job: any): void {
    let confirmNotPublished = false;
    if (job.status === 'needs_review') {
      confirmNotPublished = confirm('The previous attempt has an UNKNOWN outcome. Open the account on the platform and confirm the post is NOT there.\n\nPress OK only if you have checked and it was not posted.');
      if (!confirmNotPublished) return;
    }
    this.api.retryJob(job.id, confirmNotPublished).subscribe({ next: () => { this.notify('Re-queued.'); this.loadQueue(); }, error: e => this.fail(e) });
  }

  cancelJob(job: any): void {
    if (!confirm('Cancel this publication?')) return;
    this.api.cancelJob(job.id).subscribe({ next: () => { this.notify('Cancelled.'); this.loadQueue(); }, error: e => this.fail(e) });
  }

  openContentById(id: number): void {
    this.section = 'library';
    this.loadLibrary();
    this.openEditor({ id });
  }

  // ---------- Analytics ----------
  loadAnalytics(): void {
    this.loading = true;
    const f = this.analyticsFilters;
    this.api.analytics({ ...f, from: f.from ? new Date(`${f.from}T00:00:00Z`).toISOString() : null, to: f.to ? new Date(`${f.to}T23:59:59Z`).toISOString() : null }).subscribe({
      next: r => { this.analytics = r.analytics; this.loading = false; },
      error: e => this.fail(e)
    });
  }

  syncAnalytics(): void {
    this.api.syncAnalytics().subscribe({ next: r => this.notify(r.note), error: e => this.fail(e) });
  }

  objectEntries(obj: any): [string, any][] {
    return obj ? Object.entries(obj) : [];
  }

  // ---------- Inbox ----------
  loadThreads(): void {
    this.loading = true;
    this.api.threads(this.inboxFilters).subscribe({ next: r => { this.threads = r.threads; this.loading = false; }, error: e => this.fail(e) });
  }

  syncInbox(): void {
    this.api.syncInbox().subscribe({ next: r => this.notify(`Sync queued for ${r.queued} account(s). Results appear after the worker runs.`), error: e => this.fail(e) });
  }

  openThread(t: any): void {
    this.replyText = '';
    this.replyDraftId = null;
    this.api.thread(t.id).subscribe({
      next: r => {
        this.activeThread = r;
        const draft = [...r.messages].reverse().find((m: any) => m.status === 'draft_reply');
        if (draft) { this.replyText = draft.body_text; this.replyDraftId = draft.id; }
      },
      error: e => this.fail(e)
    });
  }

  analyzeThread(): void {
    this.api.analyzeThread(this.activeThread.thread.id).subscribe({ next: () => { this.openThread(this.activeThread.thread); this.loadThreads(); }, error: e => this.fail(e) });
  }

  suggestReply(): void {
    this.busy = true;
    this.api.suggestReply(this.activeThread.thread.id).subscribe({
      next: r => { this.busy = false; this.replyText = r.text; this.replyDraftId = r.messageId; this.notify('AI draft ready — edit it, then approve & send.'); },
      error: e => this.fail(e)
    });
  }

  sendReply(): void {
    if (!this.replyText.trim()) return;
    if (!confirm('Post this reply publicly on the platform?')) return;
    this.busy = true;
    this.api.sendReply(this.activeThread.thread.id, this.replyText, this.replyDraftId).subscribe({
      next: () => { this.busy = false; this.notify('Reply sent.'); this.openThread(this.activeThread.thread); },
      error: e => this.fail(e)
    });
  }

  setThreadStatus(status: string): void {
    this.api.updateThread(this.activeThread.thread.id, { status }).subscribe({ next: () => { this.loadThreads(); this.openThread(this.activeThread.thread); }, error: e => this.fail(e) });
  }

  assignThread(userId: any): void {
    this.api.updateThread(this.activeThread.thread.id, { assignedUserId: userId ? Number(userId) : null }).subscribe({ next: () => this.notify('Assigned.'), error: e => this.fail(e) });
  }

  createLead(): void {
    const body: any = {};
    if (this.leadForm.email) body.email = this.leadForm.email;
    if (this.leadForm.phone) body.phone = this.leadForm.phone;
    this.api.createLead(this.activeThread.thread.id, body).subscribe({
      next: r => { this.notify(r.alreadyLinked ? 'Already linked to a lead.' : 'Lead created in the Leads module.'); this.openThread(this.activeThread.thread); },
      error: e => this.fail(e)
    });
  }

  inboxCapabilities(): any[] {
    return this.accounts.filter(a => a.status === 'connected').map(a => ({
      name: a.displayName, type: a.accountTypeLabel,
      read: a.capabilities.comments_read, reply: a.capabilities.comments_reply, messages: a.capabilities.messages_read
    }));
  }

  // ---------- Strategist ----------
  askRoger(q?: string): void {
    if (q) this.question = q;
    if (!this.question.trim()) return;
    this.isAsking = true;
    this.strategistAnswer = null;
    this.api.ask(this.question).subscribe({
      next: r => { this.strategistAnswer = r; this.isAsking = false; },
      error: e => { this.isAsking = false; this.fail(e); }
    });
  }

  // ---------- Settings ----------
  loadSettings(): void {
    this.api.settings().subscribe({ next: r => { this.settings = r.settings; this.settingsForm = { ...r.settings }; }, error: e => this.fail(e) });
    this.api.usage().subscribe({ next: r => this.usage = r, error: () => this.usage = null });
    this.api.audit().subscribe({ next: r => this.auditEvents = r.events, error: () => this.auditEvents = [] });
  }

  saveSettings(): void {
    const f = this.settingsForm;
    this.api.saveSettings({
      timezone: f.timezone, requireApproval: !!f.requireApproval, defaultHashtags: f.defaultHashtags || '',
      analyticsPollMinutes: Number(f.analyticsPollMinutes), inboxPollMinutes: Number(f.inboxPollMinutes)
    }).subscribe({
      next: r => { this.settings = r.settings; this.settingsForm = { ...r.settings }; this.notify('Settings saved.'); },
      error: e => this.fail(e)
    });
  }
}
