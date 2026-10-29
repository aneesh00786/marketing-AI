import { Component, ElementRef, EventEmitter, HostListener, Input, OnInit, Output, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
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

/**
 * Mail Center: one place for the mailbox, drafts, approvals, product emails, campaigns, templates, logs and settings.
 * It only arranges the existing mail components; drafting, approval and sending stay in those
 * components and on the server, which enforces permissions. Every count shown comes from data the
 * app has loaded (drafts list, latest mailbox messages); nothing is estimated.
 */
@Component({
  selector: 'app-mail-center',
  standalone: true,
  imports: [CommonModule, MailDraftsComponent, ProductEmailsComponent, EmailCampaignsComponent, EmailTemplatesComponent, MailSettingsComponent, MailActivityChartsComponent, MailLogsComponent],
  templateUrl: './mail-center.component.html',
  styleUrls: ['../command/command-center.component.css', './mail-center.component.css']
})
export class MailCenterComponent implements OnInit {
  @Input() section: MailSection = 'overview';
  @Output() sectionChange = new EventEmitter<MailSection>();
  @Input() productEmailsEnabled = false;
  @Input() products: any[] = [];
  /** The shell's lists, for the overview (drafts: all of them; emails: the latest messages the API returns). */
  @Input() drafts: any[] = [];
  @Input() draftsState: DataState = 'loading';
  @Input() emails: any[] = [];
  @Input() emailsState: DataState = 'loading';
  /** Handed over from elsewhere in the app (product card, Email Templates "Use in"). */
  @Input() draftTemplate: { id: number; name: string } | null = null;
  @Input() draftProduct: { id: number } | null = null;
  @Input() campaignStartTemplate: { id: number; name: string } | null = null;
  @Input() zohoOauthResult: { zoho?: string; reason?: string } | null = null;
  @Output() templateConsumed = new EventEmitter<void>();
  @Output() productConsumed = new EventEmitter<void>();
  @Output() templateUse = new EventEmitter<{ template: any; target: TemplateUseTarget }>();
  @Output() toast = new EventEmitter<string>();
  @Output() draftsChanged = new EventEmitter<void>();
  @Output() mailSent = new EventEmitter<void>();
  /** Mailbox settings saved or the inbox synced in Settings. */
  @Output() settingsChanged = new EventEmitter<void>();
  @ViewChild('createBtn') createBtn?: ElementRef<HTMLButtonElement>;

  // Capabilities of the signed-in member (null = unknown: the server still decides).
  caps: Set<string> | null = null;
  createMenuOpen = false;
  /** What the drafts view does when it opens: start the generator, filter, or open a draft. */
  draftAction: 'ai' | 'template' | null = null;
  draftStatus: any = null;
  draftId: number | null = null;

  constructor(private api: ApiService) {}

  ngOnInit(): void {
    this.api.getMe().subscribe({
      next: (me: any) => { if (Array.isArray(me?.capabilities)) this.caps = new Set(me.capabilities); },
      error: () => { this.caps = null; }
    });
  }

  can(cap: string): boolean { return this.caps === null || this.caps.has(cap); }
  get canView(): boolean { return this.can('mail.view'); }
  get canCompose(): boolean { return this.can('mail.compose'); }

  get sections() {
    const keys = visibleMailSections({ productEmails: this.productEmailsEnabled });
    return MAIL_SECTIONS.filter(s => keys.includes(s.key));
  }

  /** The section shown: the requested one if this workspace has it, otherwise the overview. */
  get active(): MailSection {
    return this.sections.some(s => s.key === this.section) ? this.section : 'overview';
  }

  go(section: MailSection, opts: { status?: string | null; draftId?: number | null } = {}): void {
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

  get notSentCount(): number { return this.emails.filter(e => e.status === 'Not Sent').length; }
  get urgentUnreadCount(): number { return this.emails.filter(e => (e.is_urgent === 1 || e.ai_priority === 'Urgent') && !e.is_read).length; }

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
