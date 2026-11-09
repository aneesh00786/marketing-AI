import { Component, OnInit, OnDestroy, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import * as XLSX from 'xlsx';
import { readWorkbook, SheetData, LeadSheetRow } from './features/leads/lead-sheet';
import { LeadImportMapperComponent } from './features/leads/lead-import-mapper.component';
import { LeadAccessComponent } from './features/leads/lead-access.component';
import { LeadFollowupsComponent } from './features/leads/lead-followups.component';
import { CrmPhoneInputComponent, phoneProblem } from './features/crm/crm-phone-input.component';
import { ImportSync, importSyncBody, importSyncProblem, newImportSync } from './features/leads/import-sync';
import { ImportSyncOptionsComponent } from './features/leads/import-sync-options.component';
import { LeadsToListComponent } from './features/leads/leads-to-list.component';
import { ApiService } from './services/api.service';
import { SpeechService } from './services/speech.service';
import { AuthStateService, SessionChangeKind } from './core/auth-state.service';
import { ThemeService } from './core/theme.service';
import { ComposeRequestService } from './core/compose-request.service';
import { LoginComponent } from './core/login.component';
import { SocialHubComponent } from './features/social/social-hub.component';
import { CommandCenterComponent } from './features/command/command-center.component';
import { IconComponent } from './shared/icon.component';
import { CallButtonComponent } from './shared/calling/call-button.component';
import { CountryFilterComponent } from './shared/leads/country-filter.component';
import { SoftphoneComponent } from './shared/calling/softphone.component';
import { DashboardComponent, DashboardNavigation } from './features/dashboard/dashboard.component';
import { LeadDiscoveryComponent } from './features/leads/lead-discovery.component';
import { CrmComponent } from './features/crm/crm.component';
import { PlatformAdminComponent } from './features/platform/platform-admin.component';
import { CRM_SECTIONS, CrmAccess, CrmSection, crmSectionFromLink } from './features/crm/crm-api.service';
import { MembersComponent } from './features/members/members.component';
import type { TemplateUseTarget } from './features/mail/email-templates.component';
import { TemplatePickerComponent } from './features/mail/template-picker.component';
import { MailCenterComponent } from './features/mail/mail-center.component';
import { DataState, MAIL_SECTIONS, MailSection, mailSectionFromLink, visibleMailSections } from './features/mail/mail-nav';
import { EmailPreviewComponent } from './features/mail/email-preview.component';
import { findTokens, fillTokens, defaultTokenValues } from './features/mail/template-utils';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, LoginComponent, LeadImportMapperComponent, LeadAccessComponent, LeadFollowupsComponent, CrmPhoneInputComponent, SocialHubComponent, CommandCenterComponent, IconComponent, DashboardComponent, LeadDiscoveryComponent, CrmComponent, PlatformAdminComponent, CallButtonComponent, SoftphoneComponent, MembersComponent, TemplatePickerComponent, MailCenterComponent, EmailPreviewComponent, ImportSyncOptionsComponent, LeadsToListComponent, CountryFilterComponent],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent implements OnInit, OnDestroy {
  // Navigation: Directly accessible HUD
  // Mail Center section (Overview, Drafts, Approvals, Product Emails, Campaigns, Email Templates).
  mailSection: MailSection = 'overview';
  // Template picker for Compose; template handed to Campaigns or Drafts.
  templatePickerFor: 'compose' | null = null;
  campaignStartTemplate: { id: number; name: string } | null = null;
  draftTemplate: { id: number; name: string } | null = null;
  composeTemplateName = '';
  composeTokenValues: Record<string, string> = {};
  currentRoute: 'dashboard' | 'products' | 'crm' | 'admin' | 'leads' | 'emails' | 'businesses' | 'social' | 'voice' | 'appointments' | 'members' = 'dashboard';

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
        { route: 'crm', label: 'CRM', icon: 'briefcase', subtitle: 'Customers, companies, deals and support' },
        { route: 'leads', label: 'Leads', icon: 'leads', subtitle: 'AI-scored leads, Excel import and follow-up advice' },
        { route: 'appointments', label: 'Demos', icon: 'calendar', subtitle: 'Booked demos and appointments' }
      ]
    },
    {
      label: 'Communicate',
      items: [
        { route: 'emails', label: 'Mail Center', icon: 'mail', subtitle: 'Inbox, sent mail, drafts, approvals, campaigns and templates' }
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
        { route: 'members', label: 'Members', icon: 'building', subtitle: 'People in this workspace, roles and invitations' },
        { route: 'admin', label: 'Platform Admin', icon: 'settings', subtitle: 'All workspaces, users and activity' }
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
      appointments: this.appointments.length
    };
    return route in counts ? counts[route] : null;
  }

  /**
   * Sidebar navigation opens a module at its default view. 'drafts' is the former Mail Drafts page:
   * it now opens Mail Center's Drafts section, so links to it from elsewhere keep working.
   */
  /** Mail Center sections for the sidebar sub-menu (Product Emails only while its feature is on). */
  get mailSubnav() {
    const keys = visibleMailSections({ productEmails: !!this.serverStatus?.features?.productEmails });
    return MAIL_SECTIONS.filter(s => keys.includes(s.key));
  }
  get pendingApprovalCount(): number { return this.drafts.filter(d => ['Draft', 'Approved', 'Needs Review'].includes(d.status)).length; }

  readonly crmSubnav = CRM_SECTIONS;
  crmSection: CrmSection = 'dashboard';
  crmResetKey = 0;
  /** The user's global CRM grant. The CRM stays hidden without one. */
  crmAccess: CrmAccess | null = null;

  /** Listed only for the platform admin. The server refuses everyone else. */
  platformAdmin = false;

  /** The global CRM is listed only for users with a CRM grant, and Platform Admin only for the admin. */
  showNavItem(route: AppComponent['currentRoute']): boolean {
    if (route === 'crm') return !!this.crmAccess;
    if (route === 'admin') return this.platformAdmin;
    return this.canOpen(route);
  }

  groupVisible(group: { items: { route: AppComponent['currentRoute'] }[] }): boolean {
    return group.items.some(i => this.showNavItem(i.route));
  }

  /** Change password (user menu). */
  pwForm: { current: string; next: string; confirm: string; busy: boolean; error: string | null } | null = null;

  openChangePassword(): void {
    this.pwForm = { current: '', next: '', confirm: '', busy: false, error: null };
  }

  changePassword(): void {
    const f = this.pwForm;
    if (!f) return;
    f.error = null;
    if (f.next !== f.confirm) { f.error = 'The two new passwords do not match.'; return; }
    if (f.next.length < 10) { f.error = 'The new password must be at least 10 characters.'; return; }
    f.busy = true;
    this.apiService.changePassword(f.current, f.next).subscribe({
      next: (res: any) => {
        this.auth.setSession(res);
        this.pwForm = null;
        this.showToast('Password changed. Your other devices have been signed out.');
      },
      error: (err: any) => { f.busy = false; f.error = err?.error?.error || 'Could not change the password.'; }
    });
  }

  /** Sections a member may open (Members > Section access). Unknown yet (null): everything. */
  myModules: Set<string> | null = null;
  private readonly ROUTE_MODULE: Partial<Record<string, string>> = {
    products: 'products', leads: 'leads', emails: 'mail', social: 'social', businesses: 'campaigns', appointments: 'appointments', voice: 'voice'
  };

  hasModule(key: string): boolean {
    return this.myModules === null || this.myModules.has(key);
  }

  canOpen(route: string): boolean {
    const key = this.ROUTE_MODULE[route];
    return !key || this.hasModule(key);
  }

  navigate(route: AppComponent['currentRoute'] | 'drafts', mailSection: MailSection = 'overview', crmSection: CrmSection = 'dashboard'): void {
    this.socialSection = null;
    this.socialCampaignId = null;
    this.socialLibraryStatus = null;
    this.showPlaybooks = false;
    if (route === 'drafts') { route = 'emails'; mailSection = 'drafts'; }
    if (!this.canOpen(route)) {
      this.showToast('You do not have access to that section. Ask a workspace Owner or Admin.');
      route = 'dashboard';
    }
    if (route === 'emails') this.mailSection = mailSection;
    if (route === 'crm') { this.crmSection = crmSection; this.crmResetKey++; }
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

  /** Leaves a workspace opened from Platform Admin. */
  leaveAdminAccess(): void {
    const home = this.workspaces.find(w => w.id !== this.auth.workspace?.id) || this.workspaces[0];
    if (home) this.switchWorkspace(home);
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

  /** Platform Admin cleared data: when it was this workspace, reload what the sidebar counts. */
  onWorkspaceCleared(workspaceId: number): void {
    if (workspaceId !== this.auth.workspace?.id) return;
    this.leadPage = 1;
    this.loadLeads();
    this.loadDigitalProducts();
    this.loadEmails();
    if (this.legacyModules) this.loadAppointments();
  }

  reloadForSession(): void {
    window.location.reload();
  }

  startSession(res: any): void {
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
  get notifications(): { icon: string; title: string; detail: string; route: AppComponent['currentRoute']; mailSection?: MailSection; tone: 'danger' | 'warning' | 'info' }[] {
    const out: { icon: string; title: string; detail: string; route: AppComponent['currentRoute']; mailSection?: MailSection; tone: 'danger' | 'warning' | 'info' }[] = [];
    const urgent = this.emails.filter(e => (e.is_urgent === 1 || e.ai_priority === 'Urgent') && !e.is_read);
    if (urgent.length) out.push({ icon: 'mail', title: `${urgent.length} urgent email${urgent.length > 1 ? 's' : ''}`, detail: urgent[0].subject || 'Needs a reply', route: 'emails', mailSection: 'inbox', tone: 'danger' });
    const pendingDrafts = this.drafts.filter(d => d.status === 'Draft' || d.status === 'Pending Approval');
    if (pendingDrafts.length) out.push({ icon: 'drafts', title: `${pendingDrafts.length} draft${pendingDrafts.length > 1 ? 's' : ''} awaiting approval`, detail: pendingDrafts[0].subject || 'Review before sending', route: 'emails', mailSection: 'approvals', tone: 'warning' });
    const hot = this.leads.filter(l => l.category === 'Hot');
    if (hot.length) out.push({ icon: 'leads', title: `${hot.length} hot lead${hot.length > 1 ? 's' : ''}`, detail: hot[0].name || 'High purchase intent', route: 'leads', tone: 'info' });
    const mf = this.myFollowups;
    if (mf?.overdue.length) out.push({ icon: 'calendar', title: `${mf.overdue.length} overdue follow-up${mf.overdue.length > 1 ? 's' : ''}`, detail: `${mf.overdue[0].title} · ${mf.overdue[0].leadName}`, route: 'leads', tone: 'danger', leadId: mf.overdue[0].leadId } as any);
    if (mf?.upcoming.length) out.push({ icon: 'calendar', title: `${mf.upcoming.length} follow-up${mf.upcoming.length > 1 ? 's' : ''} due today`, detail: `${mf.upcoming[0].title} · ${mf.upcoming[0].leadName}`, route: 'leads', tone: 'warning', leadId: mf.upcoming[0].leadId } as any);
    if (mf?.newlyAssigned.length) out.push({ icon: 'leads', title: `${mf.newlyAssigned.length} follow-up${mf.newlyAssigned.length > 1 ? 's' : ''} assigned to you`, detail: `${mf.newlyAssigned[0].title} · ${mf.newlyAssigned[0].leadName}`, route: 'leads', tone: 'info', leadId: mf.newlyAssigned[0].leadId } as any);
    if (mf?.failedTranscripts.length) out.push({ icon: 'phone', title: `${mf.failedTranscripts.length} call transcript${mf.failedTranscripts.length > 1 ? 's' : ''} failed`, detail: mf.failedTranscripts[0].leadName, route: 'leads', tone: 'warning', leadId: mf.failedTranscripts[0].leadId } as any);
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

  // Company mailbox status for the Mail Center status bar (edited in Mail Center → Settings)
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
  isSyncingMail: boolean = false;

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
      text: 'Standing by, sir. Tap the orb or speak in English. I can extract features for your digital products, score leads, draft approved HTML emails, and run marketing campaigns for your business.',
      role: 'agent',
      time: 'Ready'
    }
  ];

  // Quick Chat Input Box
  quickTextInput: string = '';
  isProcessingChat: boolean = false;

  // 1. Digital Products Hub (URL Extractor)
  digitalProducts: any[] = [];
  selectedProduct: any = null;
  productUrlInput: string = '';
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
  leadFilters = { view: 'all', productId: '', status: '', country: '', q: '' };
  /** Ownership views the server allows this person (admins: all; others: all / mine / shared with me). */
  leadViews: string[] = ['all', 'mine', 'shared_with_me'];
  leadCanManageAccess = false;
  accessLeadId: number | null = null;
  /** The lead whose Follow-ups panel is open. */
  followupLead: any = null;
  /** My follow-ups for the notification bell (overdue, due within a day, newly assigned, failed transcripts). */
  myFollowups: { overdue: any[]; upcoming: any[]; newlyAssigned: any[]; failedTranscripts: any[] } | null = null;
  loadMyFollowups(): void {
    if (!this.hasModule('leads')) return;
    this.apiService.getMyFollowups().subscribe({ next: (r: any) => { this.myFollowups = r; }, error: () => { this.myFollowups = null; } });
  }
  openFollowupLead(leadId: number): void {
    const found = this.leads.find(l => l.id === leadId);
    if (found) { this.followupLead = found; return; }
    this.apiService.getLead(leadId).subscribe({ next: (r: any) => { this.followupLead = r.lead; }, error: () => this.showToast('This lead is no longer available to you.') });
  }
  leadMembers: any[] = [];
  bulkOwnerId: number | null = null;
  bulkAssigning = false;
  leadViewLabel(v: string): string {
    return ({ all: this.leadCanManageAccess ? 'All leads' : 'All my leads', mine: 'Assigned to me', user_created: 'Created by users',
      admin_created: 'Created by admins', assigned: 'Assigned by an admin', unassigned: 'Unassigned' } as any)[v] || v;
  }
  leadSourceLabel(s: string | null): string {
    return ({ manual: 'Manual', import: 'Excel import', discovery: 'AI Discovery', social: 'Social', phone: 'Phone', api: 'API' } as any)[s || ''] || '—';
  }
  /** Owners/Admins: leads ticked in the list, to assign them to one member in one action. */
  selectedLeadIds = new Set<number>();
  get allLeadsShownSelected(): boolean { return !!this.leads.length && this.leads.every(l => this.selectedLeadIds.has(l.id)); }
  toggleLeadSelected(id: number): void { this.selectedLeadIds.has(id) ? this.selectedLeadIds.delete(id) : this.selectedLeadIds.add(id); }
  toggleAllShownLeads(): void {
    const all = this.allLeadsShownSelected;
    for (const l of this.leads) all ? this.selectedLeadIds.delete(l.id) : this.selectedLeadIds.add(l.id);
  }
  assignSelectedLeads(): void {
    const ids = [...this.selectedLeadIds];
    if (!this.bulkOwnerId || !ids.length) return;
    const name = this.leadMembers.find(m => m.userId === this.bulkOwnerId)?.name || 'the member';
    if (!confirm(`Assign the ${ids.length} selected lead(s) to ${name}? Whoever they were assigned to before no longer sees them.`)) return;
    this.bulkAssigning = true;
    this.apiService.bulkLeadOwner(ids, this.bulkOwnerId).subscribe({
      next: (r: any) => { this.bulkAssigning = false; this.selectedLeadIds.clear(); this.showToast(`${r.changed} lead(s) assigned to ${name}.`); this.loadLeads(); },
      error: (e: any) => { this.bulkAssigning = false; this.showToast(e?.error?.error || 'Could not assign the leads.'); }
    });
  }

  /** Countries of this workspace's leads with counts (null = no country), for the country filter. */
  leadCountries: { country: string | null; count: number }[] = [];
  leadPage = 1;
  leadTotal = 0;
  readonly leadPageSize = 50;
  leadsLoading = false;
  leadImportResult: any = null;
  excelSkippedNoName = 0;

  // 3. Email Command Center (Visual HTML Rendering & AI Summaries)
  emails: any[] = [];
  showComposeModal: boolean = false;
  composeTab: 'write' | 'code' | 'visual' = 'write';
  /** Set when Send was pressed, so missing fields are pointed out (not before the user starts). */
  composeTouched = false;
  composeEmail = {
    recipient_email: '',
    recipient_name: '',
    subject: '',
    body: '',
    html_body: '',
    is_html: true
  };

  // 4. Mail Drafts: the page itself is MailDraftsComponent; the shell keeps the list for counts and
  // hands over a product or template chosen elsewhere ("Create AI Email Draft", "Use in a draft").
  drafts: any[] = [];
  /** Bumped when mail was sent or synced, so Mail Center → Inbox / Sent Mail reload. */
  mailboxVersion = 0;
  /** True once the mail settings have been read (Owners/Admins); otherwise IMAP status is unknown. */
  mailConfigLoaded = false;
  draftsState: DataState = 'loading';
  emailsState: DataState = 'loading';
  draftProduct: { id: number } | null = null;

  /** "Create AI Email Draft" on a product card: Mail Center's Drafts section with the generator open. */
  openDraftForProduct(productId: number): void {
    this.draftProduct = { id: productId };
    this.navigate('emails', 'drafts');
  }

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
  /** Country filter in Create Mail Drafts ('' all, 'none' without a country). */
  dispatchCountry = '';
  get dispatchLeads(): any[] {
    const c = this.dispatchCountry;
    return c ? this.leads.filter(l => c === 'none' ? !l.country : l.country === c) : this.leads;
  }
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
    service: '',
    date: '2026-10-24',
    time: '02:00 PM',
    notes: ''
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
    private composeRequests: ComposeRequestService = new ComposeRequestService()
  ) {}

  ngOnInit(): void {
    try { this.sidebarCollapsed = localStorage.getItem('tradesage_sidebar_collapsed') === '1'; } catch { this.sidebarCollapsed = false; }
    this.readDeepLink();
    this.sessionSub = this.auth.sessionExpired$.subscribe(() => this.showToast('Session ended — please sign in again.'));
    this.sessionChangeSub = this.auth.sessionChanged$.subscribe(kind => this.onSessionChanged(kind));
    // Other screens (e.g. campaign results) open Compose prefilled.
    this.composeRequestSub = this.composeRequests.requests$.subscribe(r => this.openComposeFor(r));
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
    // Password reset link (/?reset=<token>): kept for this tab; the sign-in screen asks for the new password.
    const reset = params.get('reset');
    if (reset && /^[A-Za-z0-9_-]{40,64}$/.test(reset)) {
      try { sessionStorage.setItem('marketech_reset_token', reset); } catch { /* storage unavailable */ }
      window.history.replaceState({}, '', window.location.pathname);
    }
    const invite = params.get('invite');
    if (invite && /^[A-Za-z0-9_-]{40,64}$/.test(invite)) {
      try { sessionStorage.setItem(this.INVITE_KEY, invite); } catch { /* storage unavailable */ }
      window.history.replaceState({}, '', window.location.pathname);
    }
    // Mail Center links: /?view=mail&section=<section> and the former Mail Drafts page (/?view=drafts).
    const mailSection = mailSectionFromLink(params.get('view'), params.get('section'));
    if (mailSection) {
      this.currentRoute = 'emails';
      this.mailSection = mailSection;
      window.history.replaceState({}, '', window.location.pathname);
    }
    const crmSection = crmSectionFromLink(params.get('view'), params.get('section'));
    if (crmSection) {
      this.currentRoute = 'crm';
      this.crmSection = crmSection;
      window.history.replaceState({}, '', window.location.pathname);
    }
    if (params.get('view') === 'social') {
      this.currentRoute = 'social';
      this.socialSection = params.get('section');
      if (params.get('oauth')) {
        this.socialOauthResult = Object.fromEntries(['oauth', 'provider', 'reason', 'connected', 'selection'].filter(k => params.get(k)).map(k => [k, params.get(k) as string]));
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

  /**
   * Sign out. The server is told first, so this sign-in stops working everywhere it may have been
   * copied; the browser is cleared either way (also when the server cannot be reached).
   */
  logout(everywhere = false): void {
    if (everywhere && !confirm('Sign out on every device? You will need to sign in again everywhere.')) return;
    const done = () => this.clearSession();
    const call = everywhere ? this.apiService.signOutEverywhere() : this.apiService.signOutOnServer();
    call.subscribe({ next: done, error: done });
  }

  private clearSession(): void {
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
    this.myCaps = null;
    this.myModules = null;
    // Section data loads once the member's sections are known, so no request is made for a section they cannot open.
    const loadSections = () => {
      this.loadDigitalProducts();
      this.loadLeads();
      this.loadEmails();
      this.loadDrafts();
      this.loadMailConfig();
      this.loadConnectedBusinesses();
      if (!this.canOpen(this.currentRoute)) this.currentRoute = 'dashboard';
    };
    this.apiService.getMe().subscribe({
      next: (me: any) => {
        this.myCaps = Array.isArray(me?.capabilities) ? new Set(me.capabilities) : null;
        this.myModules = Array.isArray(me?.modules) ? new Set(me.modules) : null;
        loadSections();
      },
      error: () => { this.myCaps = null; loadSections(); }
    });
    this.platformAdmin = false;
    this.apiService.getPlatformAccess().subscribe({ next: (r: any) => { this.platformAdmin = !!r.admin; }, error: () => { this.platformAdmin = false; } });
    this.crmAccess = null;
    this.apiService.getCrmAccess().subscribe({ next: (r: any) => { this.crmAccess = r.access; }, error: () => { this.crmAccess = null; } });
    // Appointments are a workspace-1-only module: load them only once the server confirms they
    // work here (sessions from before multi-workspace support carry no flag).
    this.loadWorkspaces(() => { if (this.legacyModules && this.hasModule('appointments')) this.loadAppointments(); });
  }

  ngOnDestroy(): void {
    this.voiceManualStop = true;
    this.clearVoiceRetry();
    this.removeVoiceGestureHandler();
    this.stopCallTimer();
    this.speechService.stopElevenLabsSession();
    this.sessionSub?.unsubscribe();
    this.sessionChangeSub?.unsubscribe();
    this.composeRequestSub?.unsubscribe();
  }

  showToast(msg: string): void {
    this.toastMessage = msg;
    if (this.toastTimeout) clearTimeout(this.toastTimeout);
    this.toastTimeout = setTimeout(() => this.toastMessage = '', 4000);
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
        // Products can change anywhere (added, deleted, cleared): drop what no longer exists.
        if (this.selectedProduct && !this.digitalProducts.some(p => p.id === this.selectedProduct.id)) this.selectedProduct = null;
        if (this.digitalProducts.length > 0 && !this.selectedProduct) {
          this.selectedProduct = this.digitalProducts[0];
        }
        // The Leads product filter and lead form use their own list: keep it in step.
        this.loadLeadProducts();
      },
      error: (err) => console.warn('Error loading digital products:', err)
    });
  }

  extractFeaturesFromUrl(): void {
    const url = (this.productUrlInput || '').trim();
    if (!url) {
      this.showToast('Please enter a product website URL (e.g. https://www.yourproduct.com)');
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
    const prodName = prod?.name || 'my product';
    this.currentRoute = 'voice';
    this.quickTextInput = `Can you see the details and features of ${prodName}?`;
    this.sendQuickText();
  }

  // ==========================================
  // 3. LEADS CRM & EXCEL / CSV IMPORTER
  // ==========================================
  private blankLead(): any {
    return { name: '', phone: '', email: '', company_name: '', country: '', address: '', estimated_budget: '', notes: '', productId: null, status: 'New' };
  }

  leadExportOpen = false;
  leadExporting = false;

  /** Downloads every lead matching the current filters as Excel or CSV. */
  exportLeads(format: 'xlsx' | 'csv'): void {
    this.leadExportOpen = false;
    this.leadExporting = true;
    const params: any = {};
    if (this.leadFilters.productId) params.productId = this.leadFilters.productId;
    if (this.leadFilters.status) params.status = this.leadFilters.status;
    if (this.leadFilters.country) params.country = this.leadFilters.country;
    if (this.leadFilters.q.trim()) params.q = this.leadFilters.q.trim();
    if (this.leadFilters.view && this.leadFilters.view !== 'all') params.view = this.leadFilters.view;
    this.apiService.exportLeads(params).subscribe({
      next: (res) => {
        this.leadExporting = false;
        const rows = leadExportRows(res.leads || [], format === 'csv');
        const sheet = XLSX.utils.json_to_sheet(rows);
        sheet['!cols'] = Object.keys(rows[0] || {}).map(k => ({ wch: Math.min(Math.max(k.length, ...rows.map(r => String((r as any)[k] ?? '').length)) + 2, 60) }));
        const day = new Date().toISOString().slice(0, 10);
        if (format === 'csv') {
          // A byte-order mark lets Excel open the file with accented names intact.
          const blob = new Blob(['\ufeff' + XLSX.utils.sheet_to_csv(sheet)], { type: 'text/csv;charset=utf-8' });
          downloadBlob(blob, `leads-${day}.csv`);
        } else {
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, sheet, 'Leads');
          XLSX.writeFile(wb, `leads-${day}.xlsx`);
        }
        this.showToast(res.truncated ? `Exported the first ${res.max} leads. Narrow the filters to export the rest.` : `Exported ${rows.length} lead(s).`);
      },
      error: (err) => {
        this.leadExporting = false;
        this.showToast(err?.error?.error || 'Export failed.');
      }
    });
  }


  loadLeads(): void {
    if (!this.hasModule('leads')) return;
    this.leadsLoading = true;
    const params: any = { page: this.leadPage, limit: this.leadPageSize };
    if (this.leadFilters.productId) params.productId = this.leadFilters.productId;
    if (this.leadFilters.status) params.status = this.leadFilters.status;
    if (this.leadFilters.country) params.country = this.leadFilters.country;
    if (this.leadFilters.q.trim()) params.q = this.leadFilters.q.trim();
    if (this.leadFilters.view && this.leadFilters.view !== 'all') params.view = this.leadFilters.view;
    this.apiService.getLeads(params).subscribe({
      next: (res) => {
        this.leadsLoading = false;
        this.leads = res.leads || [];
        if (Array.isArray(res.views)) this.leadViews = res.views;
        this.leadCanManageAccess = !!res.canManageAccess;
        this.loadMyFollowups();
        if (!this.leadMembers.length) {
          this.apiService.getMembers().subscribe({ next: (m: any) => { this.leadMembers = (m.members || []).filter((x: any) => x.status === 'Active').map((x: any) => ({ userId: x.userId, name: x.displayName || x.email, role: x.role })); }, error: () => null });
        }
        this.leadTotal = res.total ?? this.leads.length;
        this.leadStatuses = res.statuses || this.leadStatuses;
        if (res.countries) this.leadCountries = res.countries;
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
      next: (res) => {
        this.leadProducts = res.products || [];
        const f = this.leadFilters.productId;
        if (f && f !== 'none' && !this.leadProducts.some(p => String(p.id) === String(f))) { this.leadFilters.productId = ''; this.applyLeadFilters(); }
      },
      error: () => this.leadProducts = []
    });
  }

  applyLeadFilters(): void {
    this.leadPage = 1;
    this.selectedLeadIds.clear(); // a new filter starts a new selection
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
  // Full notes tooltip for the Leads table. Fixed-positioned so the scrolling table never clips it.
  noteTip: { text: string; top: number; left: number } | null = null;

  showNoteTip(event: Event, text: string): void {
    const el = event.target as HTMLElement | null;
    if (!el || !text) return;
    const r = el.getBoundingClientRect();
    const width = Math.min(380, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    // Below the line, or above it when there is no room underneath.
    const top = r.bottom + 220 > window.innerHeight ? Math.max(8, r.top - 8 - 200) : r.bottom + 6;
    this.noteTip = { text, top, left };
  }

  @HostListener('document:wheel')
  @HostListener('window:resize')
  hideNoteTip(): void { if (this.noteTip) this.noteTip = null; }

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
      name: ld.name || '', phone: ld.phone || '', email: ld.email || '', company_name: ld.companyName || '', country: ld.country || '', address: ld.address || '',
      estimated_budget: ld.estimatedBudget || '', notes: ld.notes || '', productId: ld.productId ?? null, status: ld.status || 'New'
    };
    this.editingLeadOriginalPhone = String(ld.phone || '').trim();
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

  /** The file box stays closed until a product is selected (never returns false: that would cancel the click). */
  onImportDropzoneClick(event: Event): void {
    if (!this.importProductId) {
      event.preventDefault();
      this.showToast('Select the product for these leads first.');
    }
  }

  onExcelFileSelected(event: any): void {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    if (!this.importProductId) { event.target.value = ''; this.showToast('Select the product for these leads first.'); return; }
    const file = files[0];
    this.excelFileName = file.name;
    this.leadImportResult = null;
    if (!this.leadProducts.length) this.loadLeadProducts();
    this.excelSheets = [];
    this.excelPreviewRows = [];
    // The column-matching step (app-lead-import-mapper) builds the leads from the sheets.
    readWorkbook(file).then(sheets => { this.excelSheets = sheets; })
      .catch(err => { this.excelFileName = ''; this.showToast(err.message); });
    event.target.value = '';
  }

  /** Sheets of the chosen import file; the column-matching step turns them into leads. */
  excelSheets: SheetData[] = [];
  onMappedRows(e: { rows: LeadSheetRow[]; skippedNoName: number }): void {
    // Emitted while the matching step renders: applied after this change-detection pass.
    Promise.resolve().then(() => { this.excelPreviewRows = e.rows; this.excelSkippedNoName = e.skippedNoName; });
  }

  /** Leads → "Add to contact list" popup. */
  showLeadsToList = false;

  /** Consent and contact list for the Excel import (see ImportSyncOptionsComponent). */
  importSync: ImportSync = newImportSync();
  get canSendCampaigns(): boolean { return !!this.myCaps?.has('mail.send'); }
  /** The product the imported leads are for (required); fills rows whose Product cell is blank. */
  importProductId = '';
  get importSyncProblem(): string {
    if (this.excelPreviewRows.length && !this.importProductId) {
      return this.leadProducts.length ? 'Select the product these leads are for.' : 'Add a product in Digital Products first, then import.';
    }
    return importSyncProblem(this.importSync);
  }
  openExcelImport(): void {
    this.showExcelImportModal = true;
    this.leadImportResult = null;
    this.excelSheets = [];
    this.excelPreviewRows = [];
    this.excelFileName = '';
    this.importSync = newImportSync();
    // Preselect the product the Leads list is filtered by, if any.
    const f = this.leadFilters?.productId;
    this.importProductId = f && f !== 'none' ? String(f) : '';
    if (!this.leadProducts.length) this.loadLeadProducts();
  }

  get importProductName(): string {
    return this.leadProducts.find(p => String(p.id) === String(this.importProductId))?.name || '';
  }

  /** Rows that name their own product in the file (they keep it; the others get the selected product). */
  get excelOwnProductCount(): number {
    return this.excelPreviewRows.filter(r => r.productId || (r.product && String(r.product).trim())).length;
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
    if (this.importProductName) return { label: this.importProductName, ok: true };
    return { label: 'No product selected', ok: null };
  }

  get excelUnmatchedCount(): number {
    return this.excelPreviewRows.filter(r => this.previewProductMatch(r).ok === false).length;
  }

  confirmImportExcelLeads(): void {
    if (this.excelPreviewRows.length === 0) return;
    if (this.importSyncProblem) { this.showToast(this.importSyncProblem); return; }
    this.isImportingLeads = true;
    // Rows without a product in the file get the selected product (the server checks it belongs to this workspace).
    const rows = this.excelPreviewRows.map(r => (r.productId || (r.product && String(r.product).trim())) ? r : { ...r, productId: Number(this.importProductId) });
    this.apiService.importLeadsBulk(rows, importSyncBody(this.importSync)).subscribe({
      next: (res) => {
        this.isImportingLeads = false;
        this.showToast(res.message);
        this.leadImportResult = res;
        this.excelPreviewRows = [];
        this.excelSheets = [];
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

  /** A changed phone number must include its country code (an older saved number may stay as it is). */
  private editingLeadOriginalPhone = '';
  get newLeadPhoneProblem(): string {
    const p = String(this.newLead?.phone || '').trim();
    if (this.editingLeadId && p === this.editingLeadOriginalPhone) return '';
    return phoneProblem(p);
  }

  submitNewLead(): void {
    if (!this.newLead.name?.trim()) { this.showToast('Lead name is required.'); return; }
    if (this.newLeadPhoneProblem) { this.showToast(this.newLeadPhoneProblem); return; }
    const payload: any = {
      name: this.newLead.name.trim(),
      email: this.newLead.email?.trim() || null,
      phone: this.newLead.phone?.trim() || null,
      companyName: this.newLead.company_name?.trim() || null,
      country: this.newLead.country?.trim() || null,
      address: this.newLead.address?.trim() || null,
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
        this.composePurpose = null; // an email to a lead: the sender must choose the purpose
        this.composeTemplate = null;
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
    if (!this.hasModule('mail')) return;
    this.apiService.getEmails().subscribe({
      next: (res) => {
        this.emails = res.emails || [];
        this.emailsState = 'ready';
      },
      error: (err) => { this.emailsState = 'error'; console.warn('Error loading emails:', err); }
    });
  }

  onHtmlTemplateUpload(event: any): void {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    event.target.value = ''; // so choosing the same file again still loads it
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
  /**
   * Required purpose of a Compose email. The server validates it against the content and template:
   * promotional content or a marketing template is always sent as marketing (approved SMTP mailbox,
   * unsubscribe link, marketing opt-outs respected); without a purpose the server uses marketing.
   */
  composePurpose: 'transactional' | 'marketing' | null = null;
  /** Template the email was loaded from (its category decides whether transactional is possible). */
  composeTemplate: { id: number; category: string } | null = null;

  /** Capabilities of the signed-in member (null = unknown; the server still decides). */
  myCaps: Set<string> | null = null;
  /** Sending Compose email as transactional needs mail.send_transactional (Owners/Admins by default). */
  get canSendTransactional(): boolean { return this.myCaps === null || this.myCaps.has('mail.send_transactional'); }

  /** Templates whose category is not Transactional, Welcome or Custom are marketing (as on the server). */
  get composeTemplateIsMarketing(): boolean {
    const cat = String(this.composeTemplate?.category || '').trim().toLowerCase();
    return !!this.composeTemplate && !['transactional', 'welcome', 'custom'].includes(cat);
  }

  private composeKey(): string {
    const c = this.composeEmail;
    const fingerprint = JSON.stringify([c.recipient_email, c.recipient_name, c.subject, c.body, c.is_html ? c.html_body : '', this.composePurpose, this.composeTemplate?.id ?? null]);
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

  // ---------- Templates in Mail Center workflows (always a working copy) ----------

  /** "Use in" from Email Templates. */
  onTemplateUse(e: { template: any; target: TemplateUseTarget }): void {
    if (e.target === 'email') this.composeFromTemplate(e.template);
    if (e.target === 'draft') {
      this.draftTemplate = { id: e.template.id, name: e.template.name };
      this.mailSection = 'drafts';
      this.showToast(`Draft generator will start from "${e.template.name}".`);
    }
    if (e.target === 'campaign') {
      this.mailSection = 'campaigns';
      this.campaignStartTemplate = { id: e.template.id, name: e.template.name };
    }
  }

  onTemplatePicked(t: any): void {
    const target = this.templatePickerFor;
    this.templatePickerFor = null;
    if (target === 'compose') this.composeFromTemplate(t, true);
  }

  /** Loads a copy of the template into Compose; editing it never changes the saved template. */
  composeFromTemplate(t: any, keepRecipient = false): void {
    if (!keepRecipient) this.composeEmail = { recipient_email: '', recipient_name: '', subject: '', body: '', html_body: '', is_html: true };
    if (this.composeEmail.html_body?.trim() && keepRecipient && !confirm('Replace the current email content with the template?')) return;
    this.composeEmail.html_body = t.html;
    this.composeEmail.is_html = true;
    this.composeTab = 'visual';
    this.composeTemplateName = t.name;
    this.composeTemplate = t.id ? { id: t.id, category: t.category || 'Custom' } : null;
    if (this.composeTemplateIsMarketing) this.composePurpose = 'marketing';
    else if (!keepRecipient) this.composePurpose = null;
    this.composeTokenValues = defaultTokenValues(findTokens(t.html), this.composeEmail.recipient_name);
    this.composeSend = null;
    this.showComposeModal = true;
  }

  get composeTokens(): string[] {
    return this.composeEmail.is_html ? findTokens(this.composeEmail.html_body) : [];
  }

  applyComposeTokens(): void {
    this.composeEmail.html_body = fillTokens(this.composeEmail.html_body, this.composeTokenValues);
    const left = findTokens(this.composeEmail.html_body);
    this.showToast(left.length ? `Still to fill: ${left.join(', ')}` : 'Placeholders filled.');
  }

  saveComposeAsTemplate(): void {
    if (!this.composeEmail.html_body?.trim()) { this.showToast('There is no HTML content to save.'); return; }
    const name = prompt('Template name', this.composeTemplateName ? `${this.composeTemplateName} (edited)` : (this.composeEmail.subject || 'New template'));
    if (!name?.trim()) return;
    this.apiService.saveEmailAsTemplate({ name: name.trim().slice(0, 150), html: this.composeEmail.html_body }).subscribe({
      next: () => this.showToast(`Saved as template "${name.trim()}".`),
      error: (err) => this.showToast(`Template not saved: ${this.apiError(err)}`)
    });
  }

  sendOutboundEmail(): void {
    if (this.isSendingCompose) return;
    if (!this.composeEmail.recipient_email || !this.composeEmail.subject) {
      this.showToast('Recipient email and subject are required');
      return;
    }
    if (!this.composePurpose) {
      this.showToast('Choose the email purpose: Transactional / Direct or Marketing.');
      return;
    }
    const asMarketing = this.composePurpose === 'marketing' ? ' as marketing (with an unsubscribe link)' : '';
    if (!confirm(`Send "${this.composeEmail.subject}" to ${this.composeEmail.recipient_email}${asMarketing} now?`)) return;

    const key = this.composeKey();
    const done = {
      next: (res: any) => {
        this.isSendingCompose = false;
        this.composeSend = null;
        this.composePurpose = null;
        this.composeTemplate = null;
        this.showToast(res.message);
        this.showComposeModal = false;
        this.composeTouched = false;
        this.onMailboxChanged();
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
        body_text: this.composeEmail.body,
        purpose: this.composePurpose,
        templateId: this.composeTemplate?.id ?? null
      }, true, key).subscribe(done);
    } else {
      this.apiService.sendEmail({ ...this.composeEmail, purpose: this.composePurpose, templateId: this.composeTemplate?.id ?? null }, true, key).subscribe(done);
    }
  }

  applySmartReply(reply: any, email: any): void {
    const toEmail = email.sender_email || email.recipient_email || '';
    const toName = email.sender || email.recipient_name || '';

    this.composeEmail = {
      recipient_email: toEmail,
      recipient_name: toName,
      subject: email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject}`,
      body: reply.text || reply,
      html_body: '',
      is_html: false
    };
    // A reply to an inbound email: direct by default when allowed (the sender can change it; the server re-checks).
    this.composePurpose = this.canSendTransactional ? 'transactional' : null;
    this.composeTemplate = null;
    this.composeTab = 'write';
    this.showComposeModal = true;
  }

  replyToEmail(email: any): void {
    const toEmail = email.sender_email || '';
    const toName = email.sender || '';
    this.composeEmail = {
      recipient_email: toEmail,
      recipient_name: toName,
      subject: /^re:/i.test(email.subject || '') ? email.subject : `Re: ${email.subject || ''}`,
      body: `\n\n${this.quoteEmail(email)}`,
      html_body: '',
      is_html: false
    };
    // A reply to an inbound email: direct by default when allowed (the sender can change it; the server re-checks).
    this.composePurpose = this.canSendTransactional ? 'transactional' : null;
    this.composeTemplate = null;
    this.composeSend = null;
    this.composeTab = 'write';
    this.showComposeModal = true;
  }

  /** Forward: a new email with the original content; the sender chooses the recipient and purpose. */
  forwardEmail(email: any): void {
    const html = email.html_body || '';
    this.composeEmail = {
      recipient_email: '',
      recipient_name: '',
      subject: /^fwd?:/i.test(email.subject || '') ? email.subject : `Fwd: ${email.subject || ''}`,
      body: html ? '' : `\n\n---------- Forwarded message ----------\n${this.quoteEmail(email, false)}`,
      html_body: html,
      is_html: !!html
    };
    this.composePurpose = null;
    this.composeTemplate = null;
    this.composeSend = null;
    this.composeTab = html ? 'visual' : 'write';
    this.showComposeModal = true;
  }

  /** A failed email opened in Compose as a new email: every check runs again and nothing is sent until confirmed. */
  sendEmailAgain(email: any): void {
    const html = email.html_body || '';
    this.composeEmail = {
      recipient_email: email.recipient_email || '',
      recipient_name: email.recipient_name || '',
      subject: email.subject || '',
      body: email.body || '',
      html_body: html,
      is_html: !!html
    };
    this.composePurpose = email.purpose === 'transactional' || email.purpose === 'marketing' ? email.purpose : null;
    this.composeTemplate = null;
    this.composeSend = null;
    this.composeTab = html ? 'visual' : 'write';
    this.showComposeModal = true;
  }

  private composeRequestSub: any = null;

  /** Compose prefilled for one person (campaign follow-up). The sender still chooses the purpose and sends. */
  openComposeFor(r: { email: string; name?: string | null; subject?: string; body?: string }): void {
    if (this.showComposeModal && !confirm('Replace the email you are writing?')) return;
    this.composeEmail = { recipient_email: r.email || '', recipient_name: r.name || '', subject: r.subject || '', body: r.body || '', html_body: '', is_html: false };
    this.composePurpose = null;
    this.composeTemplate = null;
    this.composeTemplateName = '';
    this.composeSend = null;
    this.composeTouched = false;
    this.composeTab = 'write';
    this.showComposeModal = true;
  }

  /** Compose Email (Mail Center header): a blank email. */
  openCompose(): void {
    this.composeEmail = { recipient_email: '', recipient_name: '', subject: '', body: '', html_body: '', is_html: true };
    this.composePurpose = null;
    this.composeTemplate = null;
    this.composeTemplateName = '';
    this.composeSend = null;
    this.composeTab = 'write';
    this.showComposeModal = true;
  }

  get composeRecipientValid(): boolean { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((this.composeEmail.recipient_email || '').trim()); }

  /** What is still missing before Compose can send (shown after the first Send attempt). */
  get composeProblems(): string[] {
    const out: string[] = [];
    if (!this.composeRecipientValid) out.push('a valid recipient email');
    if (!this.composeEmail.subject?.trim()) out.push('a subject');
    if (!this.composePurpose) out.push('the email purpose');
    if (!this.composeEmail.body?.trim() && !this.composeEmail.html_body?.trim()) out.push('a message');
    return out;
  }

  trySendCompose(): void {
    this.composeTouched = true;
    if (this.composeProblems.length) return;
    this.sendOutboundEmail();
  }

  /** Closing Compose with something written asks first, so a click outside the dialog loses nothing. */
  closeCompose(): void {
    const e = this.composeEmail;
    const hasContent = !!(e.recipient_email?.trim() || e.subject?.trim() || e.body?.trim() || e.html_body?.trim());
    if (hasContent && !this.isSendingCompose && !confirm('Discard this email? What you wrote is not saved.')) return;
    this.showComposeModal = false;
    this.composeTouched = false;
  }

  private quoteEmail(email: any, reply = true): string {
    const when = email.received_at || email.sent_at || '';
    const from = [email.sender, email.sender_email ? `<${email.sender_email}>` : ''].filter(Boolean).join(' ');
    const text = String(email.body || email.snippet || '').trim();
    const head = reply ? `On ${when}, ${from || 'the sender'} wrote:` : `From: ${from}\nDate: ${when}\nSubject: ${email.subject || ''}\nTo: ${email.recipient_email || ''}\n`;
    return reply ? `${head}\n${text.split('\n').map(l => `> ${l}`).join('\n')}` : `${head}\n${text}`;
  }

  /** Mail was sent or synced: refresh the shell's list and Mail Center's Inbox / Sent Mail. */
  onMailboxChanged(): void {
    this.loadEmails();
    this.mailboxVersion++;
  }


  // ==========================================
  // 5. MAIL DRAFTS & APPROVALS WORKFLOW
  // ==========================================
  loadDrafts(): void {
    if (!this.hasModule('mail')) return;
    this.apiService.getMailDrafts().subscribe({
      next: (res) => { this.drafts = res.drafts || []; this.draftsState = 'ready'; },
      error: (err) => { this.draftsState = 'error'; console.warn('Error loading drafts:', err); }
    });
  }

  /** Server error text (e.g. "Approve the draft before sending it.") rather than the generic HTTP message. */
  apiError(err: any): string {
    return err?.error?.error || err?.message || 'Request failed';
  }

  // ==========================================
  // 6. CONNECTED BUSINESSES & DYNAMIC CAMPAIGNS
  // ==========================================
  loadConnectedBusinesses(): void {
    if (!this.hasModule('campaigns')) return;
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
    this.dispatchCountry = '';
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
    if (!this.hasModule('appointments')) return;
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
    if (!this.hasModule('mail')) return;
    this.apiService.getMailConfig().subscribe({
      next: (res) => {
        if (res.config) {
          this.mailConfig = {
            ...this.mailConfig,
            ...res.config,
            smtp_secure: !!res.config.smtp_secure,
            imap_tls: !!res.config.imap_tls
          };
          this.mailConfigLoaded = true;
        }
      },
      error: (err) => console.warn('Error loading mail config:', err)
    });
  }

  syncCompanyMail(): void {
    this.isSyncingMail = true;
    this.apiService.syncCompanyMail().subscribe({
      next: (res) => {
        this.isSyncingMail = false;
        if (res.success) {
          this.showToast(res.message || 'Mailbox synchronized successfully.');
          this.onMailboxChanged();
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

/**
 * Spreadsheet rows for a leads export. For CSV, text that a spreadsheet would run as a formula
 * (starting with =, @, + or -) is prefixed with ' so it stays plain text; phone numbers like
 * +61 3 9000 1000 are left as they are.
 */
export function leadExportRows(leads: any[], forCsv: boolean): Record<string, string | number>[] {
  const safe = (v: any): string => {
    const s = v === null || v === undefined ? '' : String(v);
    if (!forCsv) return s;
    return /^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !/^[+-][\d\s().-]+$/.test(s)) ? `'${s}` : s;
  };
  return leads.map((l, i) => ({
    '#': i + 1,
    Name: safe(l.name),
    Company: safe(l.companyName),
    Country: safe(l.country),
    Address: safe(l.address),
    Email: safe(l.email),
    Phone: safe(l.phone),
    Product: safe(l.productName),
    Budget: safe(l.estimatedBudget),
    Status: safe(l.status),
    'Lead score': l.score ?? '',
    Category: safe(l.category),
    Source: l.googlePlace ? 'AI Lead Discovery' : 'Leads',
    'AI advice': safe(l.aiSuggestion),
    Notes: safe(l.notes),
    Created: safe(l.createdAt ? String(l.createdAt).slice(0, 10) : '')
  }));
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
