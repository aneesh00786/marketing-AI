import { AfterViewInit, Component, ElementRef, EventEmitter, HostListener, Input, OnInit, Output, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { apiRoot } from '../../core/api-base';
import { IconComponent } from '../../shared/icon.component';

/**
 * Contacts of one Zoho mailing list, read on demand. Contacts and consent are managed in Zoho, and
 * nothing shown here is stored unless it is selected. With `selectable`, subscribed contacts can
 * be ticked and added to the open campaign (the server re-reads Zoho and accepts only subscribed
 * contacts). The server allows it for roles with mail.send.
 */
@Component({
  selector: 'app-zoho-list-contacts',
  standalone: true,
  imports: [CommonModule, IconComponent],
  templateUrl: './zoho-list-contacts.component.html',
  styleUrls: ['../command/command-center.component.css', './mail-ui.css', './zoho-list-contacts.component.css']
})
export class ZohoListContactsComponent implements OnInit, AfterViewInit {
  @Input() listKey = '';
  @Input() listName = '';
  /** Contact count Zoho reported for the list, when known. */
  @Input() total: number | null = null;
  /** The open campaign, when its contacts can be chosen here. */
  @Input() campaignId: number | null = null;
  @Input() selectable = false;
  /** Contacts of this list already selected for the campaign: shown ticked, removed from the campaign editor. */
  @Input() set selectedContacts(list: any[] | null | undefined) {
    this.existing = new Set((list || []).map(c => String(c.email).toLowerCase()));
  }
  @Output() closed = new EventEmitter<void>();
  /** The server's answer after contacts were added to the campaign. */
  @Output() added = new EventEmitter<any>();
  @ViewChild('closeBtn') closeBtn?: ElementRef<HTMLButtonElement>;

  readonly statuses: { key: 'subscribed' | 'unsubscribed' | 'bounced'; label: string }[] = [
    { key: 'subscribed', label: 'Subscribed' }, { key: 'unsubscribed', label: 'Unsubscribed' }, { key: 'bounced', label: 'Bounced' }
  ];
  status: 'subscribed' | 'unsubscribed' | 'bounced' = 'subscribed';
  page = 1;
  contacts: any[] = [];
  hasMore = false;
  loading = false;
  error: string | null = null;
  saving = false;
  /** Ticked addresses by page: the server re-reads those pages to verify them. */
  private picked = new Map<number, Set<string>>();
  private existing = new Set<string>();
  private seq = 0;

  constructor(private http: HttpClient) {}

  /** Only subscribed contacts can be selected. */
  get picking(): boolean { return this.selectable && this.status === 'subscribed'; }
  get pickedCount(): number { return [...this.picked.values()].reduce((n, set) => n + set.size, 0); }
  private get pageSet(): Set<string> { return this.picked.get(this.page) || new Set<string>(); }
  /** Contacts on this page that can still be ticked. */
  private get open(): any[] { return this.contacts.filter(c => !this.isExisting(c)); }
  get allOnPage(): boolean { return this.open.length > 0 && this.open.every(c => this.pageSet.has(c.email)); }
  get someOnPage(): boolean { return !this.allOnPage && this.open.some(c => this.pageSet.has(c.email)); }
  get noneOpen(): boolean { return !this.open.length; }

  ngOnInit(): void { this.load(1); }
  ngAfterViewInit(): void { this.closeBtn?.nativeElement.focus(); }

  @HostListener('document:keydown.escape') onEscape(): void { this.closed.emit(); }

  setStatus(s: 'subscribed' | 'unsubscribed' | 'bounced'): void {
    if (s === this.status) return;
    this.status = s;
    this.load(1);
  }

  isExisting(c: any): boolean { return this.existing.has(String(c.email).toLowerCase()); }
  isPicked(c: any): boolean { return this.pageSet.has(c.email); }

  private setPicked(emails: string[], on: boolean): void {
    const set = this.picked.get(this.page) || new Set<string>();
    for (const email of emails) on ? set.add(email) : set.delete(email);
    if (set.size) this.picked.set(this.page, set); else this.picked.delete(this.page);
  }

  toggle(c: any): void { this.setPicked([c.email], !this.isPicked(c)); }
  toggleAll(): void { this.setPicked(this.open.map(c => c.email), !this.allOnPage); }

  addPicked(): void {
    this.saving = true;
    this.error = null;
    const pages = [...this.picked].map(([page, set]) => ({ page, emails: [...set] }));
    this.http.post<any>(`${apiRoot()}/api/v1/mail/campaigns/${this.campaignId}/contacts/zoho`, { listKey: this.listKey, pages }).subscribe({
      next: r => { this.saving = false; this.added.emit(r); this.closed.emit(); },
      error: e => { this.saving = false; this.error = e?.error?.error || 'The contacts could not be added.'; }
    });
  }

  load(page: number): void {
    const mine = ++this.seq;
    this.page = page;
    this.loading = true;
    this.error = null;
    const url = `${apiRoot()}/api/v1/mail/campaigns/audiences/${encodeURIComponent(this.listKey)}/contacts`;
    this.http.get<any>(url, { params: { status: this.status, page: String(page) } }).subscribe({
      next: r => { if (mine !== this.seq) return; this.loading = false; this.contacts = r.contacts || []; this.hasMore = !!r.hasMore; },
      error: e => { if (mine !== this.seq) return; this.loading = false; this.contacts = []; this.hasMore = false; this.error = e?.error?.error || 'The contacts could not be loaded from Zoho.'; }
    });
  }
}
