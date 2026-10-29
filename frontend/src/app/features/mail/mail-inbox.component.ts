import { Component, EventEmitter, Input, OnChanges, OnInit, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IconComponent } from '../../shared/icon.component';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { EmailPreviewComponent } from './email-preview.component';
import { textToPreviewHtml } from './email-preview';

/**
 * Mail Center → Inbox: messages received by the workspace mailbox (synced over IMAP), with search,
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
export class MailInboxComponent implements OnInit, OnChanges {
  /** Whether a reply mailbox (IMAP) is set up; null while unknown. Without one nothing new arrives. */
  @Input() imapReady: boolean | null = null;
  /** Bumped by the shell after a sync elsewhere: reload the list. */
  @Input() refreshKey = 0;
  @Output() reply = new EventEmitter<any>();
  @Output() forward = new EventEmitter<any>();
  @Output() smartReply = new EventEmitter<{ reply: any; email: any }>();
  /** Unread count or messages changed (after sync or read/unread). */
  @Output() changed = new EventEmitter<number>();
  @Output() toast = new EventEmitter<string>();
  @Output() openSettings = new EventEmitter<void>();

  filters = { q: '', read: '', from: '', to: '' };
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

  constructor(private api: ApiService) {}

  ngOnInit(): void { this.load(1); }

  ngOnChanges(ch: SimpleChanges): void {
    if (ch['refreshKey'] && !ch['refreshKey'].firstChange) this.load(this.page);
  }

  get emails(): any[] { return this.list?.emails || []; }
  get filtered(): boolean { return !!(this.filters.q || this.filters.read || this.filters.from || this.filters.to); }

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
    this.filters = { q: '', read: '', from: '', to: '' };
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
    this.api.syncCompanyMail().subscribe({
      next: (r: any) => {
        this.syncing = false;
        this.toast.emit(r?.success ? (r.message || 'Inbox synced.') : (r?.error || 'Inbox sync is not set up.'));
        if (r?.success) this.load(1);
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
