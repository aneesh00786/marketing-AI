import { Component, ElementRef, EventEmitter, HostListener, Input, OnInit, Output, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IconComponent } from '../../shared/icon.component';
import { ApiService } from '../../services/api.service';
import { MailDraftsComponent } from './mail-drafts.component';
import { ProductEmailsComponent } from './product-emails.component';
import { EmailCampaignsComponent } from './email-campaigns.component';
import { EmailTemplatesComponent } from './email-templates.component';
import type { TemplateUseTarget } from './email-templates.component';
import { DataState, MAIL_SECTIONS, MailSection, visibleMailSections } from './mail-nav';
import { MailSettingsComponent } from './mail-settings.component';
import { MailActivityChartsComponent } from './mail-activity-charts.component';
import { MailLogsComponent } from './mail-logs.component';
import { MailInboxComponent } from './mail-inbox.component';
import { MailSentComponent } from './mail-sent.component';

/**
 * Mail Center: one place for the inbox, sent mail, drafts, approvals, product emails, campaigns,
 * templates, logs and settings.
 * It only arranges the existing mail components; drafting, approval and sending stay in those
 * components and on the server, which enforces permissions. Every count shown comes from data the
 * app has loaded (drafts list, latest mailbox messages); nothing is estimated.
 */
@Component({
  selector: 'app-mail-center',
  standalone: true,
  imports: [CommonModule, IconComponent, MailDraftsComponent, ProductEmailsComponent, EmailCampaignsComponent, EmailTemplatesComponent, MailSettingsComponent, MailActivityChartsComponent, MailLogsComponent, MailInboxComponent, MailSentComponent],
  templateUrl: './mail-center.component.html',
  styleUrls: ['../command/command-center.component.css', './mail-ui.css', './mail-center.component.css']
})
export class MailCenterComponent implements OnInit {
  @Input() section: MailSection = 'overview';
  @Output() sectionChange = new EventEmitter<MailSection>();
  @Input() productEmailsEnabled = false;
  @Input() products: any[] = [];
  /** The shell's drafts list, for the overview counts. */
  @Input() drafts: any[] = [];
  @Input() draftsState: DataState = 'loading';
  /** Whether a reply mailbox (IMAP) is set up (null while unknown). */
  @Input() imapReady: boolean | null = null;
  /** Bumped by the shell after mail was sent or synced: Inbox and Sent Mail reload. */
  @Input() mailboxVersion = 0;
  /** Handed over from elsewhere in the app (product card, Email Templates "Use in"). */
  @Input() draftTemplate: { id: number; name: string } | null = null;
  @Input() draftProduct: { id: number } | null = null;
  @Input() campaignStartTemplate: { id: number; name: string } | null = null;
  /** Set by Campaigns → New Campaign → "New email template": Email Templates opens a blank template. */
  templateStartNew = false;
  @Output() templateConsumed = new EventEmitter<void>();
  @Output() productConsumed = new EventEmitter<void>();
  @Output() templateUse = new EventEmitter<{ template: any; target: TemplateUseTarget }>();
  @Output() toast = new EventEmitter<string>();
  @Output() draftsChanged = new EventEmitter<void>();
  @Output() mailSent = new EventEmitter<void>();
  /** Mailbox settings saved or the inbox synced in Settings. */
  @Output() settingsChanged = new EventEmitter<void>();
  /** Open the shell's Compose (a new email, a reply, a forward, or a failed email to send again). */
  @Output() compose = new EventEmitter<void>();
  @Output() reply = new EventEmitter<any>();
  @Output() forward = new EventEmitter<any>();
  @Output() smartReply = new EventEmitter<{ reply: any; email: any }>();
  @Output() sendAgain = new EventEmitter<any>();
  @ViewChild('createBtn') createBtn?: ElementRef<HTMLButtonElement>;

  // Capabilities of the signed-in member (null = unknown: the server still decides).
  caps: Set<string> | null = null;
  createMenuOpen = false;
  /** What the drafts view does when it opens: start the generator, filter, or open a draft. */
  draftAction: 'ai' | 'template' | null = null;
  draftStatus: any = null;
  draftId: number | null = null;
  /** Status filter Sent Mail opens with (from an Overview shortcut). */
  sentStatus: string | null = null;
  /** Settings tab to open on (e.g. 'campaigns' from Campaigns); cleared when Settings is left. */
  settingsTab: any = null;
  /** Unread received emails (null until known). */
  inboxUnread: number | null = null;

  constructor(private api: ApiService) {}

  ngOnInit(): void {
    this.api.getMe().subscribe({
      next: (me: any) => { if (Array.isArray(me?.capabilities)) this.caps = new Set(me.capabilities); },
      error: () => { this.caps = null; }
    });
    this.loadUnread();
  }

  loadUnread(): void {
    this.api.getInbox({ read: 'unread' }).subscribe({
      next: (r: any) => { this.inboxUnread = typeof r?.unread === 'number' ? r.unread : null; },
      error: () => { this.inboxUnread = null; }
    });
  }

  can(cap: string): boolean { return this.caps === null || this.caps.has(cap); }
  get canView(): boolean { return this.can('mail.view'); }
  get canCompose(): boolean { return this.can('mail.compose'); }

  get sections() {
    const keys = visibleMailSections({ productEmails: this.productEmailsEnabled });
    return MAIL_SECTIONS.filter(s => keys.includes(s.key));
  }

  get activeLabel(): string { return this.sections.find(s => s.key === this.active)?.label || ''; }

  /** Drafts that need someone with mail.send (tab badge). */
  get pendingApprovals(): number { return this.draftCount('Draft') + this.draftCount('Approved') + this.draftCount('Needs Review'); }

  /** The section shown: the requested one if this workspace has it, otherwise the overview. */
  get active(): MailSection {
    return this.sections.some(s => s.key === this.section) ? this.section : 'overview';
  }

  go(section: MailSection, opts: { status?: string | null; draftId?: number | null } = {}): void {
    if (section !== 'templates') this.templateStartNew = false;
    if (section === 'sent') this.sentStatus = opts.status ?? null;
    if (section !== 'settings') this.settingsTab = null;
    this.draftStatus = opts.status ?? null;
    this.draftId = opts.draftId ?? null;
    this.section = section;
    this.sectionChange.emit(section);
  }

  /** Arrow keys, Home and End move between tabs (and open them), per the WAI-ARIA tabs pattern. */
  onTabKey(ev: KeyboardEvent): void {
    const keys = this.sections.map(s => s.key);
    const i = keys.indexOf(this.active);
    let next = -1;
    if (ev.key === 'ArrowRight') next = (i + 1) % keys.length;
    else if (ev.key === 'ArrowLeft') next = (i - 1 + keys.length) % keys.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = keys.length - 1;
    if (next < 0) return;
    ev.preventDefault();
    this.go(keys[next]);
    const list = (ev.currentTarget as HTMLElement).closest('[role=tablist]');
    setTimeout(() => (list?.querySelector(`#mc-tab-${keys[next]}`) as HTMLElement | null)?.focus());
  }

  // ---------- Create Email ----------
  toggleCreateMenu(ev: Event): void {
    ev.stopPropagation();
    this.createMenuOpen = !this.createMenuOpen;
    if (this.createMenuOpen) setTimeout(() => (document.querySelector('.mc-menu [role=menuitem]') as HTMLElement | null)?.focus());
  }

  /** Both options open the draft generator; nothing is sent until a draft is approved and confirmed. */
  create(kind: 'ai' | 'template'): void {
    this.createMenuOpen = false;
    this.draftAction = kind;
    this.go('drafts');
  }

  onMenuKey(ev: KeyboardEvent): void {
    const items = Array.from((ev.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role=menuitem]'));
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (ev.key === 'ArrowDown') { ev.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  }

  @HostListener('document:click')
  closeMenu(): void { this.createMenuOpen = false; }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (!this.createMenuOpen) return;
    this.createMenuOpen = false;
    this.createBtn?.nativeElement.focus();
  }

  // ---------- Overview (counts from loaded data only) ----------
  draftCount(status: string): number { return this.drafts.filter(d => d.status === status).length; }


  /** Drafts that need someone to act, most pressing first: unknown delivery, then unfinished drafts. */
  get attention(): { draft: any; reason: string; section: MailSection }[] {
    const out: { draft: any; reason: string; section: MailSection }[] = [];
    for (const d of this.drafts.filter(x => x.status === 'Needs Review')) out.push({ draft: d, reason: 'Delivery unknown: confirm whether it arrived', section: 'approvals' });
    for (const d of this.drafts.filter(x => x.status === 'Draft')) {
      if (d.contact?.missing) out.push({ draft: d, reason: 'Contact deleted from Leads', section: 'drafts' });
      else if (!d.recipient_email) out.push({ draft: d, reason: 'No recipient selected', section: 'drafts' });
      else if (d.placeholders?.length) out.push({ draft: d, reason: `${d.placeholders.length} placeholder${d.placeholders.length > 1 ? 's' : ''} to fill`, section: 'drafts' });
    }
    return out.slice(0, 5);
  }
}
