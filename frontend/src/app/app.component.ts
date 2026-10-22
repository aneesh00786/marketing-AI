import { Component, OnInit, OnDestroy, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import * as XLSX from 'xlsx';
import { ApiService } from './services/api.service';
import { SpeechService } from './services/speech.service';
import { AuthStateService, SessionChangeKind } from './core/auth-state.service';
import { ThemeService } from './core/theme.service';
import { LoginComponent } from './core/login.component';
import { SocialHubComponent } from './features/social/social-hub.component';
import { CommandCenterComponent } from './features/command/command-center.component';
import { IconComponent } from './shared/icon.component';
import { DashboardComponent, DashboardNavigation } from './features/dashboard/dashboard.component';
import { LeadDiscoveryComponent } from './features/leads/lead-discovery.component';
import { MembersComponent } from './features/members/members.component';
import { EmailCampaignsComponent } from './features/mail/email-campaigns.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, LoginComponent, SocialHubComponent, CommandCenterComponent, IconComponent, DashboardComponent, LeadDiscoveryComponent, MembersComponent, EmailCampaignsComponent],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent implements OnInit, OnDestroy {
  // Navigation: Directly accessible HUD
  // Email campaigns panel in Mail Center (Zoho delivery), and the result of returning from Zoho sign-in.
  showZohoPanel = false;
  zohoOauthResult: { zoho?: string; reason?: string } | null = null;
  currentRoute: 'dashboard' | 'products' | 'leads' | 'emails' | 'drafts' | 'businesses' | 'social' | 'voice' | 'appointments' | 'members' = 'dashboard';

  // ---------- App shell (sidebar, top bar, menus) ----------
  readonly navGroups: { label: string; items: { route: AppComponent['currentRoute']; label: string; icon: string; subtitle: string }[] }[] = [
    {
      label: 'Overview',
      items: [
        { route: 'dashboard', label: 'Command Center', icon: 'dashboard', subtitle: 'Campaigns, content performance, leads and what needs attention' }
      ]
    },
    {
      label: 'Sell',
      items: [
        { route: 'products', label: 'Digital Products', icon: 'products', subtitle: 'Your products, live website features and AI extraction' },
        { route: 'leads', label: 'Leads CRM', icon: 'leads', subtitle: 'AI-scored leads, Excel import and follow-up advice' },
        { route: 'appointments', label: 'Demos', icon: 'calendar', subtitle: 'Booked demos and appointments' }
      ]
    },
    {
      label: 'Communicate',
      items: [
        { route: 'emails', label: 'Mail Center', icon: 'mail', subtitle: 'Inbox, visual HTML mail and AI smart replies' },
        { route: 'drafts', label: 'Mail Drafts', icon: 'drafts', subtitle: 'AI drafts, rewrites and approval before sending' }
      ]
    },
    {
      label: 'Market',
      items: [
        { route: 'social', label: 'Social Media Marketing', icon: 'social', subtitle: 'Accounts, campaigns, publishing and real analytics' },
        { route: 'businesses', label: 'AI Campaigns', icon: 'campaigns', subtitle: 'Campaign Command Center: AI strategy, audience, email and social' }
      ]
    },
    {
      label: 'Assistant',
      items: [
        { route: 'voice', label: 'Mark Voice Center', icon: 'voice', subtitle: 'Talk to Mark, your AI executive assistant' }
      ]
    },
    {
      label: 'Workspace',
      items: [
        { route: 'members', label: 'Members', icon: 'building', subtitle: 'People in this workspace, roles and invitations' }
      ]
    }
  ];
  sidebarCollapsed = false;
  mobileNavOpen = false;
  openMenu: 'workspace' | 'notifications' | 'profile' | null = null;

  get currentNav() {
    for (const g of this.navGroups) {
      const item = g.items.find(i => i.route === this.currentRoute);
      if (item) return item;
    }
    return this.navGroups[0].items[0];
  }

  navCount(route: string): number | null {
    const counts: Record<string, number> = {
      products: this.digitalProducts.length,
      leads: this.leadTotal || this.leads.length,
      emails: this.emails.length,
      drafts: this.drafts.length,
      appointments: this.appointments.length
    };
    return route in counts ? counts[route] : null;
  }

  navigate(route: AppComponent['currentRoute']): void {
    // Sidebar navigation opens a module at its default view.
    this.socialSection = null;
    this.socialCampaignId = null;
    this.socialLibraryStatus = null;
    this.showPlaybooks = false;
    this.currentRoute = route;
    this.mobileNavOpen = false;
    this.openMenu = null;
    if (typeof window !== 'undefined') window.scrollTo({ top: 0 });
  }

  toggleSidebar(): void {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    try { localStorage.setItem('tradesage_sidebar_collapsed', this.sidebarCollapsed ? '1' : '0'); } catch { /* storage unavailable */ }
  }

  // ---------- Invitations to the signed-in account ----------
  private readonly INVITE_KEY = 'marketech_invite_token';
  myInvitations: any[] = [];
  invitePreview: any = null;
  inviteLinkError = '';
  showInvitations = false;
  inviteBusy = false;

  private get inviteToken(): string | null {
    try { return sessionStorage.getItem(this.INVITE_KEY); } catch { return null; }
  }
  private clearInviteToken(): void {
    try { sessionStorage.removeItem(this.INVITE_KEY); } catch { /* ignore */ }
  }

  checkInvitations(): void {
    this.apiService.getMyInvitations().subscribe({
      next: (res) => { this.myInvitations = res.invitations || []; },
      error: () => { this.myInvitations = []; }
    });
    const token = this.inviteToken;
    if (!token) return;
    this.apiService.previewInvitation(token).subscribe({
      next: (res) => { this.invitePreview = res; this.inviteLinkError = ''; this.showInvitations = true; },
      error: (err) => {
        this.clearInviteToken();
        this.invitePreview = null;
        this.inviteLinkError = err?.error?.error || 'This invitation link is not valid.';
        this.showInvitations = true;
      }
    });
  }

  /** The invitation that came with the link, if it is one of mine. */
  isLinkedInvitation(inv: any): boolean {
    return !!this.invitePreview && this.invitePreview.invitation.id === inv.id;
  }

  acceptInvitation(): void {
    const token = this.inviteToken;
    if (!token || !this.invitePreview?.canAccept) return;
    this.inviteBusy = true;
    this.apiService.acceptInvitation(token).subscribe({
      next: (res) => {
        this.clearInviteToken();
        // Open the joined workspace with its own session (full reload clears the previous one).
        this.startSession(res.session);
      },
      error: (err) => {
        this.inviteBusy = false;
        this.clearInviteToken();
        this.invitePreview = null;
        this.inviteLinkError = err?.error?.error || 'Could not accept the invitation.';
      }
    });
  }

  declineInvitation(inv: any): void {
    if (!confirm(`Decline the invitation to ${inv.workspaceName}?`)) return;
    const token = this.isLinkedInvitation(inv) ? this.inviteToken : null;
    this.inviteBusy = true;
    this.apiService.declineInvitation(token ? { token } : { id: inv.id }).subscribe({
      next: () => {
        this.inviteBusy = false;
        if (token) { this.clearInviteToken(); this.invitePreview = null; }
        this.myInvitations = this.myInvitations.filter(i => i.id !== inv.id);
        this.showToast('Invitation declined.');
        if (!this.myInvitations.length && !this.invitePreview) this.showInvitations = false;
      },
      error: (err) => { this.inviteBusy = false; this.showToast(err?.error?.error || 'Could not decline the invitation.'); }
    });
  }

  // ---------- Workspaces (list, switch, create) ----------
  workspaces: any[] = [];
  workspaceBusy = false;
  workspaceError = '';
  showCreateWorkspace = false;
  newWorkspace = { name: '', industry: '' };

  loadWorkspaces(then?: () => void): void {
    this.apiService.getWorkspaces().subscribe({
      next: (res) => { this.workspaces = res.workspaces || []; then?.(); },
      error: () => { this.workspaces = []; }
    });
  }

  /** Workspace-1-only modules (Demos, Mark text chat) work only where the server says so. */
  get legacyModules(): boolean {
    const id = this.auth.workspace?.id;
    const listed = this.workspaces.find(w => w.id === id);
    if (listed) return !!listed.legacyModules;
    return this.auth.workspace?.legacyModules !== false;
  }

  get legacyWorkspaceName(): string {
    return this.workspaces.find(w => w.legacyModules)?.name || 'the main workspace';
  }

  /** A new token for the chosen workspace, then a full reload so no data of the previous one stays in memory. */
  switchWorkspace(w: any): void {
    if (this.workspaceBusy || w.id === this.auth.workspace?.id) { this.openMenu = null; return; }
    this.workspaceBusy = true;
    this.apiService.switchWorkspace(w.id).subscribe({
      next: (res) => this.startSession(res),
      error: (err) => { this.workspaceBusy = false; this.showToast(err?.error?.error || 'Could not switch workspace.'); }
    });
  }

  openCreateWorkspace(): void {
    this.openMenu = null;
    this.newWorkspace = { name: '', industry: '' };
    this.workspaceError = '';
    this.showCreateWorkspace = true;
  }

  createWorkspace(): void {
    const name = this.newWorkspace.name.trim();
    if (name.length < 2) { this.workspaceError = 'Enter a workspace name (at least 2 characters).'; return; }
    this.workspaceBusy = true;
    this.workspaceError = '';
    this.apiService.createWorkspace({ name, industry: this.newWorkspace.industry.trim() || undefined }).subscribe({
      next: (res) => this.startSession(res),
      error: (err) => { this.workspaceBusy = false; this.workspaceError = err?.error?.error || 'Could not create the workspace.'; }
    });
  }

  /** Another tab changed the shared session: stop live activity and require a reload. */
  private onSessionChanged(kind: SessionChangeKind): void {
    this.voiceManualStop = true;
    this.clearVoiceRetry();
    this.speechService.stopElevenLabsSession();
    this.isElevenLabsConnected = false;
    this.openMenu = null;
    const messages: Record<SessionChangeKind, [string, string]> = {
      'switched-workspace': ['Workspace changed in another tab', 'You switched to a different workspace in another tab. Reload to continue in that workspace; this page will not load or save anything for the previous one.'],
      'signed-out': ['Signed out in another tab', 'You signed out in another tab. Reload to sign in again.'],
      'signed-in': ['Signed in in another tab', 'You signed in in another tab. Reload to continue.'],
      'other-user': ['Different account signed in', 'Another account signed in in another tab. Reload to continue as that account; nothing more will be loaded or saved here for the previous account.'],
      'replaced': ['Session changed in another tab', 'Your session changed in another tab. Reload to continue.']
    };
    const [title, message] = messages[kind];
    this.sessionChange = { title, message };
  }

  reloadForSession(): void {
    window.location.reload();
  }

  private startSession(res: any): void {
    this.voiceManualStop = true;
    this.speechService.stopElevenLabsSession();
    this.auth.setSession(res);
    window.location.reload();
  }

  toggleMenu(menu: 'workspace' | 'notifications' | 'profile', event: Event): void {
    event.stopPropagation();
    this.openMenu = this.openMenu === menu ? null : menu;
  }

  /** Notifications derived from data the app has already loaded (no extra API calls). */
  get notifications(): { icon: string; title: string; detail: string; route: AppComponent['currentRoute']; tone: 'danger' | 'warning' | 'info' }[] {
    const out: { icon: string; title: string; detail: string; route: AppComponent['currentRoute']; tone: 'danger' | 'warning' | 'info' }[] = [];
    const urgent = this.emails.filter(e => (e.is_urgent === 1 || e.ai_priority === 'Urgent') && !e.is_read);
    if (urgent.length) out.push({ icon: 'mail', title: `${urgent.length} urgent email${urgent.length > 1 ? 's' : ''}`, detail: urgent[0].subject || 'Needs a reply', route: 'emails', tone: 'danger' });
    const pendingDrafts = this.drafts.filter(d => d.status === 'Draft' || d.status === 'Pending Approval');
    if (pendingDrafts.length) out.push({ icon: 'drafts', title: `${pendingDrafts.length} draft${pendingDrafts.length > 1 ? 's' : ''} awaiting approval`, detail: pendingDrafts[0].subject || 'Review before sending', route: 'drafts', tone: 'warning' });
    const hot = this.leads.filter(l => l.category === 'Hot');
    if (hot.length) out.push({ icon: 'leads', title: `${hot.length} hot lead${hot.length > 1 ? 's' : ''}`, detail: hot[0].name || 'High purchase intent', route: 'leads', tone: 'info' });
    if (this.appointments.length) out.push({ icon: 'calendar', title: `${this.appointments.length} scheduled demo${this.appointments.length > 1 ? 's' : ''}`, detail: this.appointments[0].customer_name || this.appointments[0].contact_name || 'Upcoming', route: 'appointments', tone: 'info' });
    return out;
  }

  /** Highest rule-based scores first; unscored leads go last. */
  get topScoredLeads(): any[] {
    return [...this.leads].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, 4);
  }

  get userInitials(): string {
    const name = this.auth.user?.displayName || this.auth.user?.email || '?';
    return name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p: string) => p[0]?.toUpperCase()).join('') || '?';
  }

  @HostListener('document:click')
  closeMenus(): void {
    this.openMenu = null;
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.openMenu = null;
    this.mobileNavOpen = false;
  }

  // Social Media Marketing hub deep-link (e.g. returning from an OAuth provider)
  socialSection: any = null;
  socialCampaignId: number | null = null;
  socialLibraryStatus: string | null = null;
  socialOauthResult: Record<string, string> | null = null;
  private sessionSub: any = null;
  private sessionChangeSub: any = null;
  // Set when another tab switched workspace, signed out or signed in: this tab must reload.
  sessionChange: { title: string; message: string } | null = null;

  // Company Mail Authorization State (SMTP & IMAP)
  showMailConfigModal: boolean = false;
  // AI Campaigns opens on email campaigns; the older idea playbooks are one click away.
  showPlaybooks = false;
  mailConfig: any = {
    provider: 'custom_smtp',
    smtp_host: 'smtp.gmail.com',
    smtp_port: 587,
    smtp_secure: false,
    smtp_user: '',
    smtp_pass: '',
    imap_host: 'imap.gmail.com',
    imap_port: 993,
    imap_tls: true,
    imap_user: '',
    imap_pass: '',
    sender_name: '',
    sender_email: '',
    status: 'Not Configured',
    has_smtp_auth: false,
    has_imap_auth: false
  };
  isSavingMailConfig: boolean = false;
  isTestingSmtp: boolean = false;
  isSyncingMail: boolean = false;
  smtpTestResult: { success?: boolean; message?: string; error?: string } | null = null;

  // Voice Dictation into Quick Chat input
  isListeningQuickChat: boolean = false;

  // Server Status & Mobile LAN
  serverStatus: any = {
    status: 'online',
    agent_name: 'MARK // Executive AI Voice & Marketing OS',
    voice_engine: 'ElevenLabs Conversational AI',
    lan_ip: '127.0.0.1',
    mobile_url: 'http://localhost:8000'
  };

  // Voice HUD State (ElevenLabs Full-Duplex Real-Time)
  isElevenLabsConnected: boolean = false;

  // "Always listening" switch: keeps a Mark voice session open and reconnects it if it drops.
  voiceAlwaysOn = false;
  voiceConnecting = false;
  voiceNeedsGesture = false;
  voiceReconnectPaused = false;
  private voiceManualStop = false;
  private voiceRetry = 0;
  private voiceRetryTimer: any = null;
  private readonly voiceMaxRetries = 6;
  private voiceGestureHandler: (() => void) | null = null;
  elevenLabsMode: 'listening' | 'speaking' = 'listening';
  callStatusText: string = 'SAY "HELLO MARK" OR TAP ORB';
  callSubText: string = 'Speak naturally to converse with Mark in real time';
  callTimer: string = '00:00';
  private timerInterval: any = null;
  private callSeconds: number = 0;

  dialogueTranscript: Array<{ sender: string; text: string; role: 'user' | 'agent'; time?: string }> = [
    {
      sender: 'MARK',
      text: 'Standing by, sir. Tap the orb or speak in English. I can extract features for your digital products, score leads, draft approved HTML emails, and execute marketing campaigns for ThriveWoo or any connected client.',
      role: 'agent',
      time: 'Ready'
    }
  ];

  // Quick Chat Input Box
  quickTextInput: string = '';
  isProcessingChat: boolean = false;

  // 1. Digital Products Hub (ThriveWoo Flagship & URL Extractor)
  digitalProducts: any[] = [];
  selectedProduct: any = null;
  productUrlInput: string = 'https://thrivewoo.com';
  isExtractingUrl: boolean = false;
  extractedProductPreview: any = null;
  showNewProductModal: boolean = false;
  newProduct = {
    name: '',
    url: '',
    tagline: '',
    description: '',
    featuresText: '',
    target_audience: ''
  };

  // 2. Leads CRM & Excel Importer (Lead Getting & AI Scoring)
  leads: any[] = [];
  showNewLeadModal: boolean = false;
  showExcelImportModal: boolean = false;
  // Leads CRM tabs: all leads, and AI Lead Discovery (search results until the user imports them).
  leadsTab: 'crm' | 'discovery' = 'crm';
  // Live Google Places details for a discovered lead (never stored).
  placeDetails: { lead: any; loading: boolean; error: string; data: any } | null = null;
  excelFileName: string = '';
  excelPreviewRows: any[] = [];
  isImportingLeads: boolean = false;
  isQualifyingAll: boolean = false;
  // Lead form (create + edit). No invented defaults: empty fields stay empty.
  editingLeadId: number | null = null;
  newLead: any = this.blankLead();
  leadProducts: any[] = [];
  leadStatuses: string[] = [];
  leadFilters = { productId: '', status: '', q: '' };
  leadPage = 1;
  leadTotal = 0;
  readonly leadPageSize = 50;
  leadsLoading = false;
  leadImportResult: any = null;
  excelSkippedNoName = 0;

  // 3. Email Command Center (Visual HTML Rendering & AI Summaries)
  emails: any[] = [];
  showComposeModal: boolean = false;
  composeTab: 'visual' | 'code' = 'visual';
  viewingEmailVisual: any = null;
  isAnalyzingEmail: boolean = false;
  composeEmail = {
    recipient_email: '',
    recipient_name: '',
    subject: '',
    body: '',
    html_body: '',
    is_html: true
  };

  // 4. Mail Drafts & Approvals Workflow (Human-in-the-loop)
  drafts: any[] = [];
  selectedDraft: any = null;
  draftRecipientEdit = { name: '', email: '' };
  isGeneratingDraft: boolean = false;
  isRewritingDraft: boolean = false;
  newDraftForm = {
    productId: null as any,
    recipientName: '',
    recipientEmail: '',
    goal: '',
    tone: 'Professional'
  };

  // 5. Connected Businesses & Dynamic Marketing Playbooks
  connectedBusinesses: any[] = [];
  selectedBusiness: any = null;
  generatedIdeas: any[] = [];
  isGeneratingIdeas: boolean = false;
  playbookProductId: number | null = null;
  playbookGoal = '';
  playbookError = '';
  playbookMissing: string[] = [];
  dispatchIdea: any = null;
  dispatchSubject = '';
  dispatchBody = '';
  dispatchLeadIds = new Set<number>();
  isDispatching = false;
  showNewBusinessModal: boolean = false;
  newBusiness = {
    name: '',
    industry: '',
    website: '',
    description: '',
    productsText: '',
    target_audience: '',
    business_type: 'client'
  };

  // 6. Appointments & Demos
  appointments: any[] = [];
  showBookingModal: boolean = false;
  newBooking = {
    customer_name: '',
    service: 'ThriveWoo B2B Wholesale Platform Demo',
    date: '2026-10-24',
    time: '02:00 PM',
    notes: 'Walkthrough of mobile field sales order booking, wholesale tiers, and live inventory sync.'
  };

  // Executive Briefing Cache & Toast
  executiveBriefing: any = null;
  toastMessage: string = '';
  private toastTimeout: any = null;

  constructor(
    public apiService: ApiService,
    public speechService: SpeechService,
    public auth: AuthStateService,
    public theme: ThemeService,
    private sanitizer: DomSanitizer
  ) {}

  ngOnInit(): void {
    try { this.sidebarCollapsed = localStorage.getItem('tradesage_sidebar_collapsed') === '1'; } catch { this.sidebarCollapsed = false; }
    this.readDeepLink();
    this.sessionSub = this.auth.sessionExpired$.subscribe(() => this.showToast('Session ended — please sign in again.'));
    this.sessionChangeSub = this.auth.sessionChanged$.subscribe(kind => this.onSessionChanged(kind));
    this.auth.checkSession();
    if (this.auth.isLoggedIn) {
      this.checkInvitations();
      this.loadWorkspaceData();
      this.restoreVoiceAlwaysOn();
      this.checkVoiceReadiness();
    }
  }

  /** Reads ?view=social&section=…&oauth=… set by the OAuth callback redirect, then cleans the URL. */
  private readDeepLink(): void {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    // Invitation link (/?invite=<token>): kept for this tab until the invitation is answered,
    // so it survives signing in or registering first.
    const invite = params.get('invite');
    if (invite && /^[A-Za-z0-9_-]{40,64}$/.test(invite)) {
      try { sessionStorage.setItem(this.INVITE_KEY, invite); } catch { /* storage unavailable */ }
      window.history.replaceState({}, '', window.location.pathname);
    }
    // Return from Zoho sign-in (/?view=mail&section=zoho&zoho=connected|error&reason=...).
    if (params.get('view') === 'mail') {
      this.currentRoute = 'emails';
      this.showZohoPanel = params.get('section') === 'zoho';
      this.zohoOauthResult = { zoho: params.get('zoho') || undefined, reason: params.get('reason') || undefined };
      window.history.replaceState({}, '', window.location.pathname);
    }
    if (params.get('view') === 'social') {
      this.currentRoute = 'social';
      this.socialSection = params.get('section');
      if (params.get('oauth')) {
        this.socialOauthResult = Object.fromEntries(['oauth', 'provider', 'reason', 'connected'].filter(k => params.get(k)).map(k => [k, params.get(k) as string]));
      }
      window.history.replaceState({}, '', window.location.pathname);
    }
  }

  /** Deep links from the Command Center into a module (and Social hub section). */
  onDashboardNavigate(nav: DashboardNavigation): void {
    this.navigate(nav.route);
    if (nav.route === 'social') {
      // Inputs are read when the hub is created during the next change detection.
      this.socialSection = nav.section || null;
      this.socialCampaignId = nav.campaignId ?? null;
      this.socialLibraryStatus = nav.status || null;
    }
  }

  onLoggedIn(): void {
    this.checkInvitations();
    this.loadWorkspaceData();
    this.restoreVoiceAlwaysOn();
    this.checkVoiceReadiness();
  }

  /**
   * Login notice when the voice agent cannot work (no ElevenLabs credits, bad key, missing agent).
   * Shown once per browser session; an unknown result (e.g. ElevenLabs unreachable) shows nothing.
   */
  voiceNotice: { status: string; message: string; remainingCredits?: number; creditLimit?: number; resetsAt?: string | null } | null = null;
  private readonly VOICE_NOTICE_KEY = 'marketech_voice_notice_shown';

  checkVoiceReadiness(): void {
    try { if (sessionStorage.getItem(this.VOICE_NOTICE_KEY) === '1') return; } catch { /* storage unavailable */ }
    this.apiService.getVoiceStatus().subscribe({
      next: (res) => {
        const v = res?.voice;
        if (v && v.available === false) {
          this.voiceNotice = v;
          try { sessionStorage.setItem(this.VOICE_NOTICE_KEY, '1'); } catch { /* storage unavailable */ }
        }
      },
      error: () => { /* voice not available to this workspace or check failed: no notice */ }
    });
  }

  dismissVoiceNotice(): void {
    this.voiceNotice = null;
  }

  get voiceNoticeTitle(): string {
    switch (this.voiceNotice?.status) {
      case 'no_credits': return 'No voice credits left';
      case 'not_configured': return 'Voice agent not set up';
      case 'agent_not_found': return 'Voice agent not found';
      case 'workspace_unavailable': return 'Voice not available in this workspace';
      default: return 'Voice agent unavailable';
    }
  }

  logout(): void {
    this.voiceManualStop = true;
    this.clearVoiceRetry();
    this.removeVoiceGestureHandler();
    this.isElevenLabsConnected = false;
    this.speechService.stopElevenLabsSession();
    this.voiceNotice = null;
    try { sessionStorage.removeItem(this.VOICE_NOTICE_KEY); } catch { /* storage unavailable */ }
    this.auth.clear();
  }

  private loadWorkspaceData(): void {
    this.loadStatus();
    this.loadDigitalProducts();
    this.loadLeads();
    this.loadEmails();
    this.loadDrafts();
    this.loadMailConfig();
    this.loadConnectedBusinesses();
    // Appointments are a workspace-1-only module: load them only once the server confirms they
    // work here (sessions from before multi-workspace support carry no flag).
    this.loadWorkspaces(() => { if (this.legacyModules) this.loadAppointments(); });
  }

  ngOnDestroy(): void {
    this.voiceManualStop = true;
    this.clearVoiceRetry();
    this.removeVoiceGestureHandler();
    this.stopCallTimer();
    this.speechService.stopElevenLabsSession();
    this.sessionSub?.unsubscribe();
    this.sessionChangeSub?.unsubscribe();
  }

  showToast(msg: string): void {
    this.toastMessage = msg;
    if (this.toastTimeout) clearTimeout(this.toastTimeout);
    this.toastTimeout = setTimeout(() => this.toastMessage = '', 4000);
  }

  getSafeHtml(html: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(html || '');
  }

  // ==========================================
  // 1. STATUS & ELEVENLABS REAL-TIME VOICE
  // ==========================================
  loadStatus(): void {
    this.apiService.getStatus().subscribe({
      next: (res) => {
        if (res) this.serverStatus = res;
      },
      error: () => console.warn('Status endpoint unavailable')
    });
  }

  async toggleElevenLabsCall(): Promise<void> {
    if (this.isElevenLabsConnected) {
      // A manual disconnect also turns "always listening" off, so it never fights the user.
      if (this.voiceAlwaysOn) this.setVoiceAlwaysOn(false);
      else await this.disconnectElevenLabs();
    } else {
      await this.connectElevenLabs();
    }
  }

  /** Dashboard switch: on = keep Mark listening (same session as "Call Mark"), off = end it. */
  setVoiceAlwaysOn(on: boolean): void {
    this.voiceAlwaysOn = on;
    try { localStorage.setItem('tradesage_voice_always_on', on ? '1' : '0'); } catch { /* storage unavailable */ }
    this.clearVoiceRetry();
    this.voiceReconnectPaused = false;
    this.voiceNeedsGesture = false;
    this.removeVoiceGestureHandler();
    if (on) {
      this.voiceRetry = 0;
      if (!this.isElevenLabsConnected) this.connectElevenLabs();
    } else if (this.isElevenLabsConnected) {
      this.disconnectElevenLabs();
    }
  }

  get voiceStatusLabel(): string {
    if (!this.voiceAlwaysOn) return this.isElevenLabsConnected ? 'Live (manual call)' : 'Off';
    if (this.voiceNeedsGesture) return 'Click anywhere to start listening';
    if (this.voiceReconnectPaused) return 'Paused after repeated connection errors';
    if (this.voiceConnecting) return this.voiceRetry > 0 ? 'Reconnecting…' : 'Connecting…';
    if (this.isElevenLabsConnected) return this.elevenLabsMode === 'speaking' ? 'Mark is speaking' : 'Listening for your command';
    return this.voiceRetry > 0 ? 'Connection failed — retrying…' : 'Starting…';
  }

  private clearVoiceRetry(): void {
    if (this.voiceRetryTimer) clearTimeout(this.voiceRetryTimer);
    this.voiceRetryTimer = null;
  }

  private scheduleVoiceReconnect(): void {
    if (!this.voiceAlwaysOn || this.voiceRetryTimer || this.voiceConnecting) return;
    if (this.voiceRetry >= this.voiceMaxRetries) {
      this.voiceReconnectPaused = true;
      this.showToast('Mark voice paused after repeated connection errors. Toggle the switch to retry.');
      return;
    }
    const delay = Math.min(2000 * Math.pow(2, this.voiceRetry), 30000);
    this.voiceRetry++;
    this.voiceRetryTimer = setTimeout(() => {
      this.voiceRetryTimer = null;
      if (this.voiceAlwaysOn && !this.isElevenLabsConnected) this.connectElevenLabs();
    }, delay);
  }

  /** Browsers only allow microphone/audio after a user gesture; resume on the first click. */
  private waitForVoiceGesture(): void {
    if (this.voiceGestureHandler || typeof document === 'undefined') return;
    this.voiceNeedsGesture = true;
    this.voiceGestureHandler = () => {
      this.removeVoiceGestureHandler();
      this.voiceNeedsGesture = false;
      if (this.voiceAlwaysOn && !this.isElevenLabsConnected) this.connectElevenLabs();
    };
    document.addEventListener('pointerdown', this.voiceGestureHandler, { once: true, capture: true });
  }

  private removeVoiceGestureHandler(): void {
    if (this.voiceGestureHandler) document.removeEventListener('pointerdown', this.voiceGestureHandler, { capture: true } as any);
    this.voiceGestureHandler = null;
  }

  /** Restores the saved switch state after sign-in or a page reload. */
  private restoreVoiceAlwaysOn(): void {
    try { this.voiceAlwaysOn = localStorage.getItem('tradesage_voice_always_on') === '1'; } catch { this.voiceAlwaysOn = false; }
    if (!this.voiceAlwaysOn) return;
    const nav: any = typeof navigator !== 'undefined' ? navigator : null;
    const activated = nav?.userActivation ? nav.userActivation.hasBeenActive : false;
    if (activated) this.connectElevenLabs();
    else this.waitForVoiceGesture();
  }

  async connectElevenLabs(): Promise<void> {
    if (this.voiceConnecting || this.isElevenLabsConnected) return;
    this.voiceConnecting = true;
    this.voiceManualStop = false;
    try {
      this.callStatusText = 'CONNECTING TO ELEVENLABS...';
      const res: any = await this.apiService.getVoiceSignedUrl().toPromise();
      if (!res?.signed_url) throw new Error('Signed URL was not generated.');

      await this.speechService.startElevenLabsSession(res.signed_url, {
        onConnect: () => {
          this.isElevenLabsConnected = true;
          this.voiceConnecting = false;
          this.voiceRetry = 0;
          this.voiceReconnectPaused = false;
          this.callStatusText = 'CONVERSATION ACTIVE (SPEAK IN ENGLISH)';
          this.callSubText = '🎙️ Real-time full-duplex voice active. Speak naturally.';
          this.startCallTimer();
          this.showToast('Connected to Mark (ElevenLabs Conversational AI)');
        },
        onDisconnect: () => this.onElevenLabsDisconnected(),
        onError: (err) => {
          console.warn('ElevenLabs Error:', err);
          this.callStatusText = 'VOICE SESSION ERROR';
        },
        onMessage: (msg) => {
          this.dialogueTranscript.unshift({
            sender: msg.role === 'agent' ? 'MARK' : 'YOU',
            text: msg.text,
            role: msg.role === 'agent' ? 'agent' : 'user',
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          });
        },
        onModeChange: (mode) => {
          this.elevenLabsMode = mode;
        }
      });
    } catch (err: any) {
      console.error('Failed to connect ElevenLabs:', err);
      this.voiceConnecting = false;
      // Prefer the server's reason (e.g. sign-in expired, voice not configured) over the raw HTTP text.
      const reason = err?.error?.error || err?.message || 'Check ElevenLabs key';
      // Sign-in, permission or server setup problems do not fix themselves: never retry those.
      const permanent = [401, 403, 503].includes(err?.status);
      this.callStatusText = 'STANDBY (CLICK TO CONNECT)';
      this.callSubText = `Connection error: ${reason}`;
      if (this.voiceAlwaysOn && !permanent) {
        // Autoplay/microphone blocked without a gesture: wait for a click instead of retrying.
        if (err?.name === 'NotAllowedError' && !(navigator as any)?.userActivation?.hasBeenActive) this.waitForVoiceGesture();
        else this.scheduleVoiceReconnect();
      } else {
        if (this.voiceAlwaysOn) this.voiceReconnectPaused = true;
        this.showToast(permanent ? `Mark voice unavailable: ${reason}` : 'Could not connect to ElevenLabs voice session.');
      }
    } finally {
      if (!this.isElevenLabsConnected) this.voiceConnecting = false;
    }
  }

  /** Session ended by ElevenLabs or the network (not by the user). */
  private async onElevenLabsDisconnected(): Promise<void> {
    if (this.voiceManualStop) return;
    const wasConnected = this.isElevenLabsConnected;
    await this.speechService.stopElevenLabsSession();
    this.isElevenLabsConnected = false;
    this.voiceConnecting = false;
    this.stopCallTimer();
    this.callStatusText = 'SAY "HELLO MARK" OR TAP ORB';
    this.callSubText = 'Speak naturally to converse with Mark in real time';
    if (this.voiceAlwaysOn) this.scheduleVoiceReconnect();
    else if (wasConnected) this.showToast('Mark voice session disconnected.');
  }

  async disconnectElevenLabs(): Promise<void> {
    this.voiceManualStop = true;
    this.clearVoiceRetry();
    await this.speechService.stopElevenLabsSession();
    this.isElevenLabsConnected = false;
    this.stopCallTimer();
    this.callStatusText = 'SAY "HELLO MARK" OR TAP ORB';
    this.callSubText = 'Speak naturally to converse with Mark in real time';
    this.showToast('Mark voice session disconnected.');
  }

  private startCallTimer(): void {
    this.callSeconds = 0;
    this.callTimer = '00:00';
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.timerInterval = setInterval(() => {
      this.callSeconds++;
      const mins = Math.floor(this.callSeconds / 60).toString().padStart(2, '0');
      const secs = (this.callSeconds % 60).toString().padStart(2, '0');
      this.callTimer = `${mins}:${secs}`;
    }, 1000);
  }

  private stopCallTimer(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    this.callTimer = '00:00';
    this.callSeconds = 0;
  }

  sendQuickText(): void {
    if (!this.legacyModules) {
      this.showToast('Text chat with Mark is not available in this workspace. Voice calls work.');
      return;
    }
    const text = this.quickTextInput.trim();
    if (!text) return;

    this.dialogueTranscript.unshift({
      sender: 'YOU',
      text,
      role: 'user',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });

    this.quickTextInput = '';
    this.isProcessingChat = true;

    this.apiService.sendChatMessage('executive_assistant', text).subscribe({
      next: (res) => {
        this.isProcessingChat = false;
        this.dialogueTranscript.unshift({
          sender: 'MARK',
          text: res.reply || 'Acknowledged, sir.',
          role: 'agent',
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
        this.loadEmails();
        this.loadLeads();
        this.loadDrafts();
      },
      error: (err) => {
        this.isProcessingChat = false;
        this.dialogueTranscript.unshift({
          sender: 'MARK',
          text: `Apologies sir, error processing request: ${err.message}`,
          role: 'agent',
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
      }
    });
  }

  toggleVoiceDictation(): void {
    if (this.isListeningQuickChat) {
      this.speechService.stopListening();
      this.isListeningQuickChat = false;
    } else {
      const started = this.speechService.startListening(
        (transcript) => {
          this.quickTextInput = transcript;
          this.isListeningQuickChat = false;
          this.sendQuickText();
        },
        (interim) => {
          this.quickTextInput = interim;
        },
        (err) => {
          console.warn('Voice dictation event:', err);
          this.isListeningQuickChat = false;
        }
      );
      if (started) {
        this.isListeningQuickChat = true;
        this.showToast('🎙️ Listening... Speak your command in English');
      } else {
        this.showToast('Microphone not supported in this browser. Please type.');
      }
    }
  }

  sendPresetPrompt(promptText: string): void {
    this.quickTextInput = promptText;
    this.sendQuickText();
  }

  // ==========================================
  // 2. DIGITAL PRODUCTS HUB & AI URL EXTRACTOR
  // ==========================================
  loadDigitalProducts(): void {
    this.apiService.getDigitalProducts().subscribe({
      next: (res) => {
        this.digitalProducts = res.products || [];
        if (this.digitalProducts.length > 0 && !this.selectedProduct) {
          this.selectedProduct = this.digitalProducts[0];
        }
      },
      error: (err) => console.warn('Error loading digital products:', err)
    });
  }

  extractFeaturesFromUrl(): void {
    const url = (this.productUrlInput || '').trim();
    if (!url) {
      this.showToast('Please enter a product website URL (e.g. https://thrivewoo.com)');
      return;
    }
    this.isExtractingUrl = true;
    this.extractedProductPreview = null;

    this.apiService.extractProductFromUrl(url).subscribe({
      next: (res) => {
        this.isExtractingUrl = false;
        this.extractedProductPreview = res.product;
        this.showToast(`Extracted ${res.product?.features?.length || 0} features from ${url}!`);
      },
      error: (err) => {
        this.isExtractingUrl = false;
        this.showToast(`Extraction error: ${err.message}`);
      }
    });
  }

  saveExtractedProduct(): void {
    if (!this.extractedProductPreview) return;
    this.apiService.createDigitalProduct(this.extractedProductPreview).subscribe({
      next: (res) => {
        this.showToast(res.message || 'Digital product saved to your Hub!');
        this.extractedProductPreview = null;
        this.loadDigitalProducts();
      },
      error: (err) => this.showToast(`Error saving product: ${err.message}`)
    });
  }

  submitNewProduct(): void {
    if (!this.newProduct.name) return;
    const features = this.newProduct.featuresText.split('\n').map(f => f.trim()).filter(f => f);

    this.apiService.createDigitalProduct({
      name: this.newProduct.name,
      url: this.newProduct.url,
      tagline: this.newProduct.tagline,
      description: this.newProduct.description,
      target_audience: this.newProduct.target_audience,
      features,
      pricing: []
    }).subscribe({
      next: (res) => {
        this.showToast(res.message);
        this.showNewProductModal = false;
        this.newProduct = { name: '', url: '', tagline: '', description: '', featuresText: '', target_audience: '' };
        this.loadDigitalProducts();
      },
      error: (err) => this.showToast(`Error adding product: ${err.message}`)
    });
  }

  deleteDigitalProduct(id: number): void {
    if (!confirm('Are you sure you want to remove this digital product?')) return;
    this.apiService.deleteDigitalProduct(id).subscribe({
      next: () => {
        this.showToast('Digital product removed');
        this.loadDigitalProducts();
      },
      error: (err) => this.showToast(`Error: ${err.message}`)
    });
  }

  askRogerAboutProduct(prod: any): void {
    const prodName = prod?.name || 'ThriveWoo';
    this.currentRoute = 'voice';
    this.quickTextInput = `Can you see the details and features of ${prodName}?`;
    this.sendQuickText();
  }

  // ==========================================
  // 3. LEADS CRM & EXCEL / CSV IMPORTER
  // ==========================================
  private blankLead(): any {
    return { name: '', phone: '', email: '', company_name: '', estimated_budget: '', notes: '', productId: null, status: 'New' };
  }

  loadLeads(): void {
    this.leadsLoading = true;
    const params: any = { page: this.leadPage, limit: this.leadPageSize };
    if (this.leadFilters.productId) params.productId = this.leadFilters.productId;
    if (this.leadFilters.status) params.status = this.leadFilters.status;
    if (this.leadFilters.q.trim()) params.q = this.leadFilters.q.trim();
    this.apiService.getLeads(params).subscribe({
      next: (res) => {
        this.leadsLoading = false;
        this.leads = res.leads || [];
        this.leadTotal = res.total ?? this.leads.length;
        this.leadStatuses = res.statuses || this.leadStatuses;
      },
      error: (err) => {
        this.leadsLoading = false;
        console.warn('Error loading leads:', err);
      }
    });
    if (!this.leadProducts.length) this.loadLeadProducts();
  }

  loadLeadProducts(): void {
    this.apiService.getLeadProducts().subscribe({
      next: (res) => this.leadProducts = res.products || [],
      error: () => this.leadProducts = []
    });
  }

  applyLeadFilters(): void {
    this.leadPage = 1;
    this.loadLeads();
  }

  changeLeadPage(delta: number): void {
    const last = Math.max(1, Math.ceil(this.leadTotal / this.leadPageSize));
    this.leadPage = Math.min(Math.max(1, this.leadPage + delta), last);
    this.loadLeads();
  }

  showLeadsTab(tab: 'crm' | 'discovery'): void {
    this.leadsTab = tab;
    if (!this.leadProducts.length) this.loadLeadProducts();
  }

  onDiscoveryImported(count: number): void {
    this.showToast(`Imported ${count} lead${count === 1 ? '' : 's'} into Leads.`);
    this.leadPage = 1;
    this.loadLeads();
  }

  viewPlaceDetails(ld: any): void {
    this.placeDetails = { lead: ld, loading: true, error: '', data: null };
    this.apiService.getLeadPlaceDetails(ld.id).subscribe({
      next: (res) => { if (this.placeDetails?.lead === ld) this.placeDetails = { lead: ld, loading: false, error: '', data: res }; },
      error: (e) => { if (this.placeDetails?.lead === ld) this.placeDetails = { lead: ld, loading: false, error: e?.error?.error || 'Could not load details from Google.', data: null }; }
    });
  }

  get leadPageCount(): number {
    return Math.max(1, Math.ceil(this.leadTotal / this.leadPageSize));
  }

  scoreFactorsText(ld: any): string {
    const f = ld.scoreFactors || [];
    return f.length ? `Rule-based factors: ${f.map((x: any) => `${x.label} +${x.points}`).join(', ')}` : 'Rule-based score';
  }

  /** Display helper: missing values show as an em dash, never as invented data. */
  dash(v: any): string {
    return v === null || v === undefined || v === '' ? '—' : String(v);
  }

  openNewLead(): void {
    this.editingLeadId = null;
    this.newLead = this.blankLead();
    if (!this.leadProducts.length) this.loadLeadProducts();
    this.showNewLeadModal = true;
  }

  openEditLead(ld: any): void {
    this.editingLeadId = ld.id;
    this.newLead = {
      name: ld.name || '', phone: ld.phone || '', email: ld.email || '', company_name: ld.companyName || '',
      estimated_budget: ld.estimatedBudget || '', notes: ld.notes || '', productId: ld.productId ?? null, status: ld.status || 'New'
    };
    if (!this.leadProducts.length) this.loadLeadProducts();
    this.showNewLeadModal = true;
  }

  deleteLead(ld: any): void {
    if (!confirm(`Delete lead "${ld.name}"? This cannot be undone.`)) return;
    this.apiService.deleteLead(ld.id).subscribe({
      next: () => { this.showToast('Lead deleted.'); this.loadLeads(); },
      error: (err) => this.showToast(`Delete failed: ${err?.error?.error || err.message}`)
    });
  }

  onExcelFileSelected(event: any): void {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    this.excelFileName = file.name;
    this.leadImportResult = null;
    if (!this.leadProducts.length) this.loadLeadProducts();

    const pick = (row: any, keys: string[]) => {
      for (const k of keys) {
        const v = row[k];
        if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
      }
      return '';
    };
    const reader = new FileReader();
    reader.onload = (e: any) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rawJson: any[] = XLSX.utils.sheet_to_json(ws, { defval: '' });
        // Map known column names only; blank cells stay blank (no invented values).
        const rows = rawJson.map((row: any) => ({
          name: pick(row, ['Name', 'name', 'Contact Name', 'Full Name', 'Contact']),
          companyName: pick(row, ['Company', 'company', 'Company Name', 'Organisation', 'Organization']),
          email: pick(row, ['Email', 'email', 'E-mail', 'Email Address']),
          phone: pick(row, ['Phone', 'phone', 'Mobile', 'Phone Number', 'Contact Number']),
          product: pick(row, ['Product', 'product', 'Product Name', 'Interest', 'interest']),
          productId: pick(row, ['Product ID', 'product_id', 'productId', 'Product Id']),
          estimatedBudget: pick(row, ['Budget', 'budget', 'Estimated Budget', 'Deal Value']),
          notes: pick(row, ['Notes', 'notes', 'Comments'])
        }));
        this.excelSkippedNoName = rows.filter(r => !r.name).length;
        this.excelPreviewRows = rows.filter(r => r.name);
        this.showToast(`Parsed ${this.excelPreviewRows.length} leads from "${file.name}".${this.excelSkippedNoName ? ` ${this.excelSkippedNoName} rows without a name will be skipped.` : ''}`);
      } catch (err: any) {
        this.showToast(`Error reading spreadsheet: ${err.message}`);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  /** Preview-only product match (the server re-validates against the workspace on import). */
  previewProductMatch(row: any): { label: string; ok: boolean | null } {
    if (row.productId) {
      const p = this.leadProducts.find(x => String(x.id) === String(row.productId));
      return p ? { label: p.name, ok: true } : { label: `ID ${row.productId} not found — needs review`, ok: false };
    }
    if (row.product) {
      const p = this.leadProducts.find(x => x.name.trim().toLowerCase() === row.product.trim().toLowerCase());
      return p ? { label: p.name, ok: true } : { label: `"${row.product}" not found — needs review`, ok: false };
    }
    return { label: 'No product selected', ok: null };
  }

  get excelUnmatchedCount(): number {
    return this.excelPreviewRows.filter(r => this.previewProductMatch(r).ok === false).length;
  }

  confirmImportExcelLeads(): void {
    if (this.excelPreviewRows.length === 0) return;
    this.isImportingLeads = true;
    this.apiService.importLeadsBulk(this.excelPreviewRows).subscribe({
      next: (res) => {
        this.isImportingLeads = false;
        this.showToast(res.message);
        this.leadImportResult = res;
        this.excelPreviewRows = [];
        this.excelFileName = '';
        this.leadPage = 1;
        this.loadLeads();
      },
      error: (err) => {
        this.isImportingLeads = false;
        this.showToast(`Import failed: ${err?.error?.error || err.message}`);
      }
    });
  }

  qualifySingleLead(lead: any): void {
    this.apiService.qualifyLeadWithAi(lead.id).subscribe({
      next: (res) => {
        this.showToast(res.message);
        this.loadLeads();
      },
      error: (err) => this.showToast(`Qualify error: ${err?.error?.error || err.message}`)
    });
  }

  qualifyAllLeads(): void {
    this.isQualifyingAll = true;
    this.apiService.qualifyAllLeadsWithAi(this.leadFilters.productId && this.leadFilters.productId !== 'none' ? Number(this.leadFilters.productId) : undefined).subscribe({
      next: (res) => {
        this.isQualifyingAll = false;
        this.showToast(res.message);
        this.loadLeads();
      },
      error: (err) => {
        this.isQualifyingAll = false;
        this.showToast(`Error: ${err?.error?.error || err.message}`);
      }
    });
  }

  submitNewLead(): void {
    if (!this.newLead.name?.trim()) { this.showToast('Lead name is required.'); return; }
    const payload: any = {
      name: this.newLead.name.trim(),
      email: this.newLead.email?.trim() || null,
      phone: this.newLead.phone?.trim() || null,
      companyName: this.newLead.company_name?.trim() || null,
      estimatedBudget: this.newLead.estimated_budget?.trim() || null,
      notes: this.newLead.notes?.trim() || null,
      productId: this.newLead.productId ? Number(this.newLead.productId) : null
    };
    if (this.editingLeadId) payload.status = this.newLead.status || null;
    const req = this.editingLeadId ? this.apiService.updateLead(this.editingLeadId, payload) : this.apiService.createLead(payload);
    req.subscribe({
      next: (res) => {
        this.showToast(res.message || (this.editingLeadId ? 'Lead updated.' : 'Lead recorded.'));
        this.showNewLeadModal = false;
        this.editingLeadId = null;
        this.newLead = this.blankLead();
        this.loadLeads();
      },
      error: (err) => this.showToast(`Could not save lead: ${err?.error?.error || err.message}`)
    });
  }


  /** Opens the compose window with a draft built from the lead's real product (never a placeholder address). */
  quickEmailLead(lead: any): void {
    if (!lead.hasValidEmail) {
      this.showToast('This lead has no valid email address. Edit the lead to add one.');
      return;
    }
    this.apiService.getLeadEmailDraft(lead.id).subscribe({
      next: (res) => {
        const d = res.draft;
        this.composeEmail = { recipient_email: d.to, recipient_name: d.recipientName, subject: d.subject, body: d.body, html_body: d.html, is_html: true };
        this.composeTab = 'visual';
        this.showComposeModal = true;
      },
      error: (err) => this.showToast(err?.error?.error || 'Could not prepare the email draft.')
    });
  }

  // ==========================================
  // 4. EMAIL COMMAND CENTER & VISUAL HTML DISPATCH
  // ==========================================
  loadEmails(): void {
    this.apiService.getEmails().subscribe({
      next: (res) => {
        this.emails = res.emails || [];
      },
      error: (err) => console.warn('Error loading emails:', err)
    });
  }

  onHtmlTemplateUpload(event: any): void {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    const reader = new FileReader();
    reader.onload = (e: any) => {
      this.composeEmail.html_body = e.target.result;
      this.composeEmail.is_html = true;
      this.composeTab = 'visual';
      this.showToast(`HTML template loaded from "${file.name}". Rendering visual page layout!`);
    };
    reader.readAsText(file);
  }

  // One idempotency key per composed email: a double click or a retry of the same content reuses it,
  // so the server never sends it twice; changed content gets a new key.
  private composeSend: { fingerprint: string; key: string } | null = null;
  isSendingCompose = false;

  private composeKey(): string {
    const c = this.composeEmail;
    const fingerprint = JSON.stringify([c.recipient_email, c.recipient_name, c.subject, c.body, c.is_html ? c.html_body : '']);
    if (!this.composeSend || this.composeSend.fingerprint !== fingerprint) {
      const key = typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
      this.composeSend = { fingerprint, key };
    }
    return this.composeSend.key;
  }

  /** Error text for a failed send; an unknown outcome is not reported as "not sent". */
  private sendErrorText(err: any): string {
    const code = err?.error?.code;
    if (code === 'MAIL_OUTCOME_UNKNOWN' || code === 'MAIL_SENT_NOT_RECORDED') return `Delivery unknown: ${this.apiError(err)}`;
    return `Email not sent: ${this.apiError(err)}`;
  }

  sendOutboundEmail(): void {
    if (this.isSendingCompose) return;
    if (!this.composeEmail.recipient_email || !this.composeEmail.subject) {
      this.showToast('Recipient email and subject are required');
      return;
    }
    if (!confirm(`Send "${this.composeEmail.subject}" to ${this.composeEmail.recipient_email} now?`)) return;

    const key = this.composeKey();
    const done = {
      next: (res: any) => {
        this.isSendingCompose = false;
        this.composeSend = null;
        this.showToast(res.message);
        this.showComposeModal = false;
        this.loadEmails();
      },
      error: (err: any) => {
        this.isSendingCompose = false;
        this.showToast(this.sendErrorText(err));
      }
    };
    this.isSendingCompose = true;
    if (this.composeEmail.is_html && this.composeEmail.html_body) {
      this.apiService.sendHtmlEmail({
        recipient_email: this.composeEmail.recipient_email,
        recipient_name: this.composeEmail.recipient_name,
        subject: this.composeEmail.subject,
        html_body: this.composeEmail.html_body,
        body_text: this.composeEmail.body
      }, true, key).subscribe(done);
    } else {
      this.apiService.sendEmail(this.composeEmail, true, key).subscribe(done);
    }
  }

  analyzeEmail(email: any): void {
    this.isAnalyzingEmail = true;
    this.apiService.analyzeEmailWithAi(email.id).subscribe({
      next: (res) => {
        this.isAnalyzingEmail = false;
        this.showToast(`AI Analysis Complete! Priority: ${res.priority}`);
        this.loadEmails();
      },
      error: (err) => {
        this.isAnalyzingEmail = false;
        this.showToast(`Analysis error: ${err.message}`);
      }
    });
  }

  applySmartReply(reply: any, email: any): void {
    const toEmail = email.sender_email || email.recipient_email || 'client@example.com';
    const toName = email.sender || email.recipient_name || 'Client';

    this.composeEmail = {
      recipient_email: toEmail,
      recipient_name: toName,
      subject: email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject}`,
      body: reply.text || reply,
      html_body: '',
      is_html: false
    };
    this.composeTab = 'visual';
    this.showComposeModal = true;
  }

  replyToEmail(email: any): void {
    const toEmail = email.sender_email || email.recipient_email || 'client@example.com';
    const toName = email.sender || email.recipient_name || 'Client';

    this.composeEmail = {
      recipient_email: toEmail,
      recipient_name: toName,
      subject: email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject}`,
      body: `Hi ${toName},\n\nThank you for reaching out regarding "${email.subject}". Our team has reviewed your requirements and confirmed we can support your deployment. Would tomorrow at 2:00 PM work for a live demonstration?\n\nBest regards,\nExecutive Team`,
      html_body: '',
      is_html: false
    };
    this.composeTab = 'visual';
    this.showComposeModal = true;
  }

  openVisualEmailModal(email: any): void {
    this.viewingEmailVisual = email;
  }

  // ==========================================
  // 5. MAIL DRAFTS & APPROVALS WORKFLOW
  // ==========================================
  loadDrafts(): void {
    this.apiService.getMailDrafts().subscribe({
      next: (res) => {
        this.drafts = res.drafts || [];
        if (this.drafts.length > 0 && !this.selectedDraft) {
          this.selectDraft(this.drafts[0]);
        }
      },
      error: (err) => console.warn('Error loading drafts:', err)
    });
  }

  generateNewDraft(): void {
    this.isGeneratingDraft = true;
    this.apiService.generateMailDraft(this.newDraftForm).subscribe({
      next: (res) => {
        this.isGeneratingDraft = false;
        this.showToast(res.message);
        this.loadDrafts();
        this.selectDraft(res.draft);
      },
      error: (err) => {
        this.isGeneratingDraft = false;
        this.showToast(`Error generating draft: ${err.message}`);
      }
    });
  }

  rewriteDraft(draft: any, instruction: string): void {
    this.isRewritingDraft = true;
    this.apiService.rewriteMailDraft(draft.id, instruction).subscribe({
      next: (res) => {
        this.isRewritingDraft = false;
        this.showToast(res.message);
        this.selectDraft(res.draft);
        this.loadDrafts();
      },
      error: (err) => {
        this.isRewritingDraft = false;
        this.showToast(`Rewrite error: ${err.message}`);
      }
    });
  }

  selectDraft(draft: any): void {
    this.selectedDraft = draft;
    this.draftRecipientEdit = { name: draft?.recipient_name || '', email: draft?.recipient_email || '' };
    this.placeholderValues = Object.fromEntries((draft?.placeholders || []).map((p: string) => [p, '']));
  }

  // Values typed for the draft's [placeholders]; they must be filled before approval or sending.
  placeholderValues: Record<string, string> = {};
  get filledPlaceholders(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.placeholderValues).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
  }

  fillDraftPlaceholders(draft: any): void {
    const replacements = this.filledPlaceholders;
    if (!Object.keys(replacements).length) { this.showToast('Type a value for each placeholder first.'); return; }
    this.apiService.updateMailDraft(draft.id, { replacements }).subscribe({
      next: (res) => { this.showToast('Placeholders filled. Approve the draft again before sending.'); this.selectDraft(res.draft); this.loadDrafts(); },
      error: (err) => this.showToast(`Not saved: ${this.apiError(err)}`)
    });
  }

  /** A send with an unknown outcome (or stuck): the user says whether it arrived. */
  resolveDraft(draft: any, outcome: 'sent' | 'not_sent'): void {
    const q = outcome === 'sent'
      ? `Mark "${draft.subject}" as sent? Only if you confirmed it reached ${draft.recipient_email}.`
      : `Mark "${draft.subject}" as NOT sent? Only if you checked it did not reach ${draft.recipient_email}. You can then send it again.`;
    if (!confirm(q)) return;
    this.apiService.resolveMailDraft(draft.id, outcome).subscribe({
      next: (res) => { this.showToast(res.message); this.selectDraft(res.draft); this.loadDrafts(); },
      error: (err) => this.showToast(this.apiError(err))
    });
  }

  /** Server error text (e.g. "Approve the draft before sending it.") rather than the generic HTTP message. */
  apiError(err: any): string {
    return err?.error?.error || err?.message || 'Request failed';
  }

  saveDraftRecipient(draft: any): void {
    this.apiService.updateMailDraft(draft.id, { recipient_name: this.draftRecipientEdit.name.trim(), recipient_email: this.draftRecipientEdit.email.trim() }).subscribe({
      next: (res) => {
        this.showToast(res.message);
        this.selectDraft(res.draft);
        this.loadDrafts();
      },
      error: (err) => this.showToast(`Recipient not saved: ${this.apiError(err)}`)
    });
  }

  approveDraft(draft: any): void {
    this.apiService.approveMailDraft(draft.id).subscribe({
      next: (res) => {
        this.showToast(res.message);
        this.loadDrafts();
        if (this.selectedDraft?.id === draft.id) this.selectDraft(res.draft);
      },
      error: (err) => this.showToast(`Approval error: ${this.apiError(err)}`)
    });
  }

  // Sending always asks for explicit confirmation; an unapproved draft is approved first.
  sendApprovedDraft(draft: any): void {
    if (!draft.recipient_email) {
      this.showToast('Add a recipient email address before sending.');
      return;
    }
    if (!confirm(`Send "${draft.subject}" to ${draft.recipient_email} now? This cannot be undone.`)) return;
    const send = () => this.apiService.sendMailDraft(draft.id, true).subscribe({
      next: (res) => {
        this.showToast(res.message);
        this.loadDrafts();
        this.loadEmails();
        if (this.selectedDraft?.id === draft.id) this.selectedDraft.status = 'Sent';
      },
      error: (err) => {
        this.showToast(this.sendErrorText(err));
        this.loadDrafts();
        if (this.selectedDraft?.id === draft.id && err?.error?.code === 'MAIL_OUTCOME_UNKNOWN') this.selectedDraft.status = 'Needs Review';
      }
    });
    if (draft.status === 'Approved') {
      send();
      return;
    }
    this.apiService.approveMailDraft(draft.id).subscribe({
      next: () => send(),
      error: (err) => this.showToast(`Email not sent: ${this.apiError(err)}`)
    });
  }

  deleteDraft(draftId: number): void {
    if (!confirm('Are you sure you want to delete this email draft?')) return;
    this.apiService.deleteMailDraft(draftId).subscribe({
      next: () => {
        this.showToast('Draft deleted');
        this.loadDrafts();
        this.selectedDraft = null;
      },
      error: (err) => this.showToast(`Error: ${err.message}`)
    });
  }

  // ==========================================
  // 6. CONNECTED BUSINESSES & DYNAMIC CAMPAIGNS
  // ==========================================
  loadConnectedBusinesses(): void {
    this.apiService.getConnectedBusinesses().subscribe({
      next: (res) => {
        this.connectedBusinesses = res.businesses || [];
        if (this.connectedBusinesses.length > 0 && !this.selectedBusiness) {
          this.selectBusiness(this.connectedBusinesses[0]);
        }
      },
      error: (err) => console.warn('Error loading connected businesses:', err)
    });
  }

  // Selecting a business never generates anything; generation is an explicit click.
  selectBusiness(biz: any): void {
    if (this.selectedBusiness?.id === biz?.id) return;
    this.selectedBusiness = biz;
    this.generatedIdeas = [];
    this.playbookError = '';
    this.playbookMissing = [];
  }

  generateIdeasForSelectedBusiness(): void {
    if (!this.selectedBusiness || this.isGeneratingIdeas) return;
    this.isGeneratingIdeas = true;
    this.playbookError = '';
    this.apiService.generateMarketingIdeas({ businessId: this.selectedBusiness.id, productId: this.playbookProductId, goal: this.playbookGoal.trim() || undefined }).subscribe({
      next: (res) => {
        this.isGeneratingIdeas = false;
        this.generatedIdeas = res.ideas || [];
        this.playbookMissing = res.missing_context || [];
      },
      error: (err) => {
        this.isGeneratingIdeas = false;
        this.generatedIdeas = [];
        this.playbookError = err?.error?.code === 'AI_UNAVAILABLE' || err?.status === 503
          ? `AI is unavailable, so no playbooks were generated. ${this.apiError(err)}`
          : `Playbooks were not generated: ${this.apiError(err)}`;
      }
    });
  }

  openDispatch(idea: any): void {
    this.dispatchIdea = idea;
    this.dispatchSubject = idea.subject || '';
    this.dispatchBody = idea.email_body || '';
    this.dispatchLeadIds = new Set<number>();
  }

  closeDispatch(): void {
    this.dispatchIdea = null;
  }

  toggleDispatchLead(id: number): void {
    if (this.dispatchLeadIds.has(id)) this.dispatchLeadIds.delete(id);
    else this.dispatchLeadIds.add(id);
  }

  get dispatchSelectedCount(): number {
    return this.dispatchLeadIds.size;
  }

  confirmDispatch(): void {
    if (!this.dispatchIdea || !this.dispatchLeadIds.size) return;
    this.isDispatching = true;
    this.apiService.dispatchCampaign({
      businessId: this.selectedBusiness?.id,
      productId: this.playbookProductId,
      subject: this.dispatchSubject.trim(),
      body: this.dispatchBody.trim(),
      leadIds: [...this.dispatchLeadIds]
    }).subscribe({
      next: (res) => {
        this.isDispatching = false;
        this.showToast(res.message);
        this.dispatchIdea = null;
        this.loadDrafts();
      },
      error: (err) => {
        this.isDispatching = false;
        this.showToast(`Drafts not created: ${this.apiError(err)}`);
      }
    });
  }


  submitNewBusiness(): void {
    if (!this.newBusiness.name || !this.newBusiness.industry) return;
    const products = this.newBusiness.productsText.split('\n').filter(p => p.trim());
    this.apiService.connectBusiness({
      ...this.newBusiness,
      products
    }).subscribe({
      next: (res) => {
        this.showToast(res.message);
        this.showNewBusinessModal = false;
        this.newBusiness = { name: '', industry: '', website: '', description: '', productsText: '', target_audience: '', business_type: 'client' };
        this.loadConnectedBusinesses();
      },
      error: (err) => this.showToast(`Error connecting business: ${err.message}`)
    });
  }

  // ==========================================
  // 7. APPOINTMENTS
  // ==========================================
  loadAppointments(): void {
    this.apiService.getAppointments().subscribe({
      next: (res) => {
        this.appointments = res.appointments || [];
      },
      error: (err) => console.warn('Error loading appointments:', err)
    });
  }

  submitBooking(): void {
    if (!this.newBooking.customer_name || !this.newBooking.date || !this.newBooking.time) return;
    this.apiService.bookAppointment(this.newBooking).subscribe({
      next: (res) => {
        this.showToast(res.message);
        this.showBookingModal = false;
        this.loadAppointments();
      },
      error: (err) => this.showToast(`Booking error: ${err.message}`)
    });
  }

  loadExecutiveBriefing(): void {
    this.apiService.getExecutiveBriefing().subscribe({
      next: (res) => {
        this.executiveBriefing = res.briefing;
        this.dialogueTranscript.unshift({
          sender: 'MARK',
          text: res.briefing?.spokenSummary || 'Executive briefing compiled.',
          role: 'agent',
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
        this.showToast('Executive briefing delivered.');
      },
      error: (err) => this.showToast(`Error: ${err.message}`)
    });
  }

  // ==========================================
  // 9. COMPANY MAIL AUTHORIZATION (SMTP & IMAP)
  // ==========================================
  loadMailConfig(): void {
    this.apiService.getMailConfig().subscribe({
      next: (res) => {
        if (res.config) {
          this.mailConfig = {
            ...this.mailConfig,
            ...res.config,
            smtp_secure: !!res.config.smtp_secure,
            imap_tls: !!res.config.imap_tls
          };
        }
      },
      error: (err) => console.warn('Error loading mail config:', err)
    });
  }

  saveMailConfig(): void {
    this.isSavingMailConfig = true;
    this.apiService.saveMailConfig({
      ...this.mailConfig,
      smtp_secure: this.mailConfig.smtp_secure ? 1 : 0,
      imap_tls: this.mailConfig.imap_tls ? 1 : 0
    }).subscribe({
      next: (res) => {
        this.isSavingMailConfig = false;
        this.mailConfig = {
          ...this.mailConfig,
          ...res.config,
          smtp_secure: !!res.config.smtp_secure,
          imap_tls: !!res.config.imap_tls
        };
        this.showToast('Company mail authorization saved successfully.');
      },
      error: (err) => {
        this.isSavingMailConfig = false;
        this.showToast(`Error saving mail config: ${err.message}`);
      }
    });
  }

  testSmtp(): void {
    this.isTestingSmtp = true;
    this.smtpTestResult = null;
    this.apiService.testSmtp({
      ...this.mailConfig,
      smtp_secure: this.mailConfig.smtp_secure ? 1 : 0
    }).subscribe({
      next: (res) => {
        this.isTestingSmtp = false;
        this.smtpTestResult = res;
        if (res.success) {
          this.showToast('SMTP handshake verified! Company email is ready to send.');
          this.mailConfig.status = 'Connected';
        } else {
          this.showToast(`SMTP test failed: ${res.error}`);
        }
      },
      error: (err) => {
        this.isTestingSmtp = false;
        this.smtpTestResult = { success: false, error: err.message };
        this.showToast(`SMTP connection error: ${err.message}`);
      }
    });
  }

  syncCompanyMail(): void {
    this.isSyncingMail = true;
    this.apiService.syncCompanyMail().subscribe({
      next: (res) => {
        this.isSyncingMail = false;
        if (res.success) {
          this.showToast(res.message || 'Mailbox synchronized successfully.');
          this.loadEmails();
          this.loadMailConfig();
        } else {
          this.showToast(res.error || 'IMAP sync is not configured.');
        }
      },
      error: (err) => {
        this.isSyncingMail = false;
        this.showToast(`Mailbox notice: ${err.message}`);
      }
    });
  }
}
