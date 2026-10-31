import { Component, EventEmitter, HostListener, Input, OnChanges, OnDestroy, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { apiRoot } from '../../core/api-base';
import { IconComponent } from '../../shared/icon.component';
import { CampaignContactRowsComponent } from './campaign-contact-rows.component';

const PAGE_SIZE = 50;
const SEARCH_DELAY_MS = 300;

/**
 * Contacts chosen one by one for a campaign. They are added to Zoho when the campaign is sent.
 * Leads are picked here (Select all covers every lead that can be emailed, on all pages); contacts
 * from a Zoho list are picked in its View contacts window and shown under that list, so this panel
 * shows only what no list row shows. The server decides who may be emailed:
 * the reasons shown here come from it, and it checks again at send time.
 */
@Component({
  selector: 'app-campaign-contacts',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, CampaignContactRowsComponent],
  templateUrl: './campaign-contacts.component.html',
  styleUrls: ['../command/command-center.component.css', './mail-ui.css', './zoho-list-contacts.component.css', './campaign-contacts.component.css']
})
export class CampaignContactsComponent implements OnChanges, OnDestroy {
  @Input() campaignId: number | null = null;
  @Input() editable = false;
  /** False when the Zoho connection predates contact sync and must be reconnected. */
  @Input() canSync = true;
  @Input() canReconnect = false;
  /** The Zoho lists shown as recipient rows: contacts picked from them are shown there. */
  @Input() zohoLists: any[] | null = null;
  /** The campaign after a change (back to draft: the audience is part of what was approved). */
  @Output() changed = new EventEmitter<any>();
  /** The whole selection, whenever the server returns it. */
  @Output() contactsChange = new EventEmitter<any[]>();
  @Output() reconnect = new EventEmitter<void>();
  @Output() toast = new EventEmitter<string>();

  contacts: any[] = [];
  eligible = 0;
  max = 1000;
  error = '';
  busy = false;

  // The lead picker
  picking = false;
  leads: any[] = [];
  query = '';
  filter: '' | 'eligible' | 'ineligible' = '';
  page = 1;
  totalLeads = 0;
  eligibleIds: number[] = [];
  truncated = false;
  chosen = new Set<number>();
  loading = false;
  pickerError = '';
  private seq = 0;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private base = `${apiRoot()}/api/v1/mail/campaigns`;

  constructor(private http: HttpClient) {}

  get url(): string { return `${this.base}/${this.campaignId}/contacts`; }
  /** Leads, and any contact whose Zoho list has no row here (it was deleted, or lists are not loaded). */
  get rows(): any[] {
    const shown = new Set((this.zohoLists || []).map(l => l.key));
    return this.contacts.filter(c => !c.sourceListKey || !shown.has(c.sourceListKey));
  }
  get rowsEligible(): number { return this.rows.filter(c => c.eligible).length; }
  get hasMore(): boolean { return this.page * PAGE_SIZE < this.totalLeads; }
  /** Every lead the filter matches that can be emailed is selected, on all pages. */
  get allChosen(): boolean { return this.eligibleIds.length > 0 && this.eligibleIds.every(id => this.chosen.has(id)); }
  get someChosen(): boolean { return !this.allChosen && this.eligibleIds.some(id => this.chosen.has(id)); }

  ngOnChanges(ch: SimpleChanges): void {
    if (ch['campaignId']) { this.picking = false; this.load(); }
  }

  ngOnDestroy(): void { if (this.searchTimer) clearTimeout(this.searchTimer); }

  @HostListener('document:keydown.escape') onEscape(): void { this.picking = false; }

  load(): void {
    const id = this.campaignId;
    this.contacts = [];
    this.eligible = 0;
    this.error = '';
    if (!id) return;
    this.http.get<any>(this.url).subscribe({
      next: r => { if (id === this.campaignId) this.apply(r); },
      error: e => { if (id === this.campaignId) this.error = this.err(e); }
    });
  }

  /** Shows a server result: this panel's own changes and contacts added from a Zoho list. */
  apply(r: any): void {
    this.contacts = r.contacts || [];
    this.eligible = r.eligible || 0;
    this.max = r.max || this.max;
    this.contactsChange.emit(this.contacts);
  }

  private done(r: any, message: string): void {
    this.busy = false;
    this.apply(r);
    this.changed.emit(r.campaign);
    this.toast.emit(message);
  }

  private failed(e: any): void {
    this.busy = false;
    this.toast.emit(this.err(e));
  }

  remove(c: any): void {
    this.busy = true;
    this.http.post<any>(`${this.url}/remove`, { ids: [c.id] }).subscribe({
      next: r => this.done(r, 'Contact removed. Approve the campaign before sending.'),
      error: e => this.failed(e)
    });
  }

  /** The row's checkbox: ticking opens the picker, unticking clears the selection. */
  onRowToggle(ev: Event): void {
    const rows = this.rows;
    (ev.target as HTMLInputElement).checked = rows.length > 0; // only the server's selection decides
    if (rows.length) this.clearRows(rows); else this.openPicker();
  }

  private clearRows(rows: any[]): void {
    if (!confirm(`Remove all ${rows.length} selected leads from this campaign?`)) return;
    this.busy = true;
    this.http.post<any>(`${this.url}/remove`, { ids: rows.map(c => c.id) }).subscribe({
      next: r => this.done(r, 'Leads removed. Approve the campaign before sending.'),
      error: e => this.failed(e)
    });
  }

  // ---------- Lead picker ----------
  openPicker(): void {
    this.chosen = new Set(this.contacts.filter(c => c.leadId).map(c => c.leadId));
    this.query = '';
    this.filter = '';
    this.picking = true;
    this.fetch(1);
  }

  setFilter(f: '' | 'eligible' | 'ineligible'): void {
    this.filter = f;
    this.fetch(1);
  }

  onSearch(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.fetch(1), SEARCH_DELAY_MS);
  }

  fetch(page: number): void {
    const mine = ++this.seq;
    this.page = page;
    this.loading = true;
    this.pickerError = '';
    const params: Record<string, string> = { page: String(page), pageSize: String(PAGE_SIZE) };
    if (this.query.trim()) params['q'] = this.query.trim();
    if (this.filter) params['eligibility'] = this.filter;
    this.http.get<any>(`${this.base}/lead-options`, { params }).subscribe({
      next: r => {
        if (mine !== this.seq) return;
        this.loading = false;
        this.leads = r.leads || [];
        this.totalLeads = r.total || 0;
        this.eligibleIds = r.eligibleIds || [];
        this.truncated = !!r.truncated;
      },
      error: e => { if (mine !== this.seq) return; this.loading = false; this.leads = []; this.totalLeads = 0; this.eligibleIds = []; this.pickerError = this.err(e); }
    });
  }

  toggle(id: number): void { this.chosen.has(id) ? this.chosen.delete(id) : this.chosen.add(id); }

  toggleAll(): void {
    const on = !this.allChosen;
    for (const id of this.eligibleIds) on ? this.chosen.add(id) : this.chosen.delete(id);
  }

  reasonText(l: any): string {
    return (l.reasons || []).join('. ');
  }

  savePicker(): void {
    this.busy = true;
    this.http.put<any>(`${this.url}/leads`, { leadIds: [...this.chosen] }).subscribe({
      next: r => {
        this.picking = false;
        const refused = r.refused ? ` ${r.refused} could not be added.` : '';
        this.done(r, `${r.added} lead${r.added === 1 ? '' : 's'} selected.${refused} Approve the campaign before sending.`);
      },
      error: e => this.failed(e)
    });
  }

  private err(e: any): string { return e?.error?.error || e?.message || 'Request failed.'; }
}
