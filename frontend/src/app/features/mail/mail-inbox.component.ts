import { Component, EventEmitter, Input, OnChanges, OnDestroy, OnInit, Output, SimpleChanges } from '@angular/core';
import { Subscription } from 'rxjs';
import { SendersUiService } from '../../core/senders-ui.service';
import { CommonModule } from '@angular/common';
import { IconComponent } from '../../shared/icon.component';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { EmailPreviewComponent } from './email-preview.component';
import { textToPreviewHtml } from './email-preview';

/**
 * Mail Center → Inbox: messages received by the workspace mailbox and the person's own inbox (synced over IMAP), with search,
 * read/unread and date filters, a reading pane, read/unread, AI analysis, reply and forward.
 * Only received messages are listed (sent mail is in Sent Mail). Reply and forward open Compose,
 * where the purpose, permission and suppression checks apply as usual; nothing is sent from here.
 */
@Component({
  selector: 'app-mail-inbox',
  standalone: true,
  imports: [CommonModule, IconComponent, FormsModule, EmailPreviewComponent],
  templateUrl: './mail-inbox.component.html',
  styleUrls: ['../command/command-center.component.css', './mail-ui.css', './mailbox.css']
})
export class MailInboxComponent implements OnInit, OnChanges, OnDestroy {
  /** Whether a reply mailbox (IMAP) is set up; null while unknown. Without one nothing new arrives. */
  @Input() imapReady: boolean | null = null;
  /** Shows the "Set up replies" link (Mail Center → Settings) only to people who may manage mail settings. */
  @Input() canConfigure = false;
  /** Bumped by the shell after a sync elsewhere: reload the list. */
  @Input() refreshKey = 0;
  @Output() reply = new EventEmitter<any>();
  @Output() forward = new EventEmitter<any>();
  @Output() smartReply = new EventEmitter<{ reply: any; email: any }>();
  /** Unread count or messages changed (after sync or read/unread). */
  @Output() changed = new EventEmitter<number>();
  @Output() toast = new EventEmitter<string>();
  @Output() openSettings = new EventEmitter<void>();

  filters = { q: '', read: '', folder: '', from: '', to: '' };
  page = 1;
  list: any = null;
  loading = false;
  error: string | null = null;

  selectedId: number | null = null;
  detail: any = null;
  detailLoading = false;
  detailError: string | null = null;

  syncing = false;
  analyzing = false;
  private seq = 0;

  /** The person's own sender address and its inbox ("My sender email" → Inbox); null until loaded. */
  myInbox: { email: string | null; connected: boolean; error: string | null; host: string | null } | null = null;
  private sendersSub?: Subscription;

  constructor(private api: ApiService, private senders: SendersUiService = new SendersUiService()) {}

  ngOnInit(): void {
    this.load(1);
    this.loadMyInbox();
    this.sendersSub = this.senders.changed$.subscribe(() => this.loadMyInbox());
  }
  ngOnDestroy(): void { this.sendersSub?.unsubscribe(); }

  loadMyInbox(): void {
    if (!this.api.getMySenders) return;
    this.api.getMySenders().subscribe({
      next: (r: any) => {
        const verified = (r?.senders || []).filter((x: any) => x.status === 'verified');
        const withInbox = verified.find((x: any) => x.inbox?.connected);
        const s = withInbox || verified[0] || null;
        this.myInbox = { email: s?.email || null, connected: !!withInbox, error: withInbox?.inbox?.error || null, host: withInbox?.inbox?.host || null };
      },
      error: () => { this.myInbox = null; }
    });
  }

  /** Opens "My sender email", where the person connects the inbox of their own address. */
  setUpMyInbox(): void { this.senders.open(); }

  /** Something can be synced: the workspace mailbox, or the person's own inbox. */
  get canSync(): boolean { return !!this.imapReady || !!this.myInbox?.connected; }

  ngOnChanges(ch: SimpleChanges): void {
    if (ch['refreshKey'] && !ch['refreshKey'].firstChange) this.load(this.page);
  }

  get emails(): any[] { return this.list?.emails || []; }
  get filtered(): boolean { return !!(this.filters.q || this.filters.read || this.filters.from || this.filters.to); }
  get inSpam(): boolean { return this.filters.folder === 'spam'; }

  /** Downloads a file of the open email. */
  downloadingId: number | null = null;
  download(a: any): void {
    if (!this.detail || !a?.stored || this.downloadingId) return;
    this.downloadingId = a.id;
    this.api.getEmailAttachment(this.detail.id, a.id).subscribe({
      next: (blob: Blob) => {
        this.downloadingId = null;
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url; link.download = a.filename || 'attachment';
        document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
      error: () => { this.downloadingId = null; this.toast.emit(`${a.filename} could not be downloaded.`); }
    });
  }
  fileSize(n: number): string {
    if (!n) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  load(page = 1): void {
    const mine = ++this.seq;
    this.page = page;
    this.loading = true;
    this.error = null;
    this.api.getInbox({ ...this.filters, page }).subscribe({
      next: (r: any) => { if (mine !== this.seq) return; this.loading = false; this.list = r; this.changed.emit(r.unread); },
      error: (e: any) => { if (mine !== this.seq) return; this.loading = false; this.error = e?.error?.error || 'The inbox could not be loaded.'; }
    });
  }

  clearFilters(): void {
    this.filters = { q: '', read: '', folder: '', from: '', to: '' };
    this.load(1);
  }

  open(e: any): void {
    this.selectedId = e.id;
    this.detail = null;
    this.detailError = null;
    this.detailLoading = true;
    this.api.getEmail(e.id).subscribe({
      next: (r: any) => {
        if (this.selectedId !== e.id) return;
        this.detailLoading = false;
        this.detail = r.email;
        if (!r.email.read) this.setRead(true, true);
      },
      error: (err: any) => { if (this.selectedId !== e.id) return; this.detailLoading = false; this.detailError = err?.error?.error || 'This email could not be opened.'; }
    });
  }

  close(): void { this.selectedId = null; this.detail = null; }

  /** Opening an unread message marks it read (quietly); the button toggles it either way. */
  setRead(read: boolean, quiet = false): void {
    const d = this.detail;
    if (!d) return;
    this.api.setEmailRead(d.id, read).subscribe({
      next: () => {
        d.read = read;
        const row = this.emails.find(x => x.id === d.id);
        if (row && row.read !== read && this.list) { row.read = read; this.list.unread = Math.max(0, (this.list.unread || 0) + (read ? -1 : 1)); }
        this.changed.emit(this.list?.unread ?? 0);
        if (!quiet) this.toast.emit(read ? 'Marked as read.' : 'Marked as unread.');
      },
      error: (err: any) => this.toast.emit(err?.error?.error || 'Could not update the read status.')
    });
  }

  /** Arrow keys move through the list and open the message. */
  onListKey(ev: KeyboardEvent): void {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    const i = this.emails.findIndex(x => x.id === this.selectedId);
    const next = this.emails[ev.key === 'ArrowDown' ? Math.min(this.emails.length - 1, i + 1) : Math.max(0, i - 1)];
    if (!next) return;
    ev.preventDefault();
    this.open(next);
    setTimeout(() => (document.getElementById(`mb-in-${next.id}`) as HTMLElement | null)?.focus());
  }

  sync(): void {
    if (this.syncing) return;
    this.syncing = true;
    // Without a workspace mailbox, only the person's own inbox is synced.
    const call = this.imapReady ? this.api.syncCompanyMail() : this.api.syncMyInboxes();
    call.subscribe({
      next: (r: any) => {
        this.syncing = false;
        const ownOnly = !this.imapReady;
        const ok = ownOnly ? !r?.failed : r?.success;
        this.toast.emit(ownOnly
          ? (ok ? `Inbox synced: ${r?.fetchedCount || 0} new email${r?.fetchedCount === 1 ? '' : 's'}.` : 'Your inbox could not be synced. Open "My inbox" to see why.')
          : (ok ? (r.message || 'Inbox synced.') : (r?.error || 'Inbox sync is not set up.')));
        this.load(1);
        this.loadMyInbox();
      },
      error: (e: any) => { this.syncing = false; this.toast.emit(`Inbox sync failed: ${e?.error?.error || e?.message || 'error'}`); }
    });
  }

  analyze(): void {
    const d = this.detail;
    if (!d || this.analyzing) return;
    this.analyzing = true;
    this.api.analyzeEmailWithAi(d.id).subscribe({
      next: () => { this.analyzing = false; if (this.selectedId === d.id) this.open(d); },
      error: (e: any) => { this.analyzing = false; this.toast.emit(`AI analysis failed: ${e?.error?.error || e?.message || 'error'}`); }
    });
  }

  previewHtml(d: any): string { return d.html_body || textToPreviewHtml(d.body || ''); }
  sender(e: any): string { return e.fromName || e.sender || e.from || e.sender_email || 'Unknown sender'; }
}
