import { Component, EventEmitter, HostListener, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { apiRoot } from '../../core/api-base';

/**
 * Leads → "Add to contact list": pick leads (only those that may be emailed can be ticked; the others
 * show why) and a contact list in Marketech.ai, existing or new. Zoho gets them when a campaign is sent.
 */
@Component({
  selector: 'app-leads-to-zoho',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './leads-to-zoho.component.html',
  styleUrls: ['../command/command-center.component.css', '../mail/mail-ui.css', './leads-to-zoho.component.css']
})
export class LeadsToZohoComponent implements OnInit {
  /** Leads ticked when the popup opens (optional). */
  @Input() preselect: number[] = [];
  @Output() closed = new EventEmitter<void>();
  @Output() toast = new EventEmitter<string>();
  @Output() openCampaigns = new EventEmitter<void>();

  private base = `${apiRoot()}/api/v1/mail/campaigns`;
  lists: { id: number; name: string; total: number }[] = [];
  listsError = '';
  target: 'existing' | 'new' = 'existing';
  listKey = '';
  listName = '';
  q = '';
  show: 'eligible' | 'all' = 'eligible';
  leads: any[] = [];
  total = 0;
  eligibleCount = 0;
  loading = false;
  picked = new Set<number>();
  saving = false;
  result: { list: any; added: number; skipped: { email: string; reason: string }[] } | null = null;

  constructor(private http: HttpClient) {}

  ngOnInit(): void {
    for (const id of this.preselect) this.picked.add(id);
    this.http.get<any>(`${this.base}/contact-lists`).subscribe({
      next: r => { this.lists = r.lists || []; if (!this.lists.length) this.target = 'new'; },
      error: e => this.listsError = e?.error?.error || 'Contact lists could not be loaded.'
    });
    this.search();
  }

  search(): void {
    this.loading = true;
    const params: any = { q: this.q.trim(), pageSize: '100' };
    if (this.show === 'eligible') params.eligibility = 'eligible';
    this.http.get<any>(`${this.base}/lead-options`, { params }).subscribe({
      next: r => { this.loading = false; this.leads = r.leads || []; this.total = r.total || 0; this.eligibleCount = r.eligibleCount || 0; },
      error: e => { this.loading = false; this.leads = []; this.toast.emit(e?.error?.error || 'Could not load leads.'); }
    });
  }

  toggle(l: any): void { if (!l.eligible) return; this.picked.has(l.id) ? this.picked.delete(l.id) : this.picked.add(l.id); }
  selectAllShown(): void { for (const l of this.leads) if (l.eligible) this.picked.add(l.id); }
  clear(): void { this.picked.clear(); }

  get problem(): string {
    if (this.listsError) return this.listsError;
    if (this.target === 'existing' && !this.listKey) return 'Choose a contact list.';
    if (this.target === 'new' && !this.listName.trim()) return 'Enter a name for the new list.';
    if (!this.picked.size) return 'Tick the leads to add.';
    if (this.picked.size > 5000) return 'Add up to 5,000 leads at a time.';
    return '';
  }

  submit(): void {
    if (this.problem || this.saving) return;
    this.saving = true;
    const leadIds = [...this.picked];
    const req = this.target === 'new'
      ? this.http.post<any>(`${this.base}/contact-lists`, { name: this.listName.trim(), leadIds })
      : this.http.post<any>(`${this.base}/contact-lists/${encodeURIComponent(this.listKey)}/contacts`, { leadIds });
    req.subscribe({
      next: r => {
        this.saving = false;
        this.result = { list: r.list, added: r.added, skipped: r.skipped || [] };
        this.toast.emit(`${r.added} lead(s) added to “${r.list?.name}”.`);
      },
      error: e => { this.saving = false; this.toast.emit(e?.error?.error || 'Could not add the leads to the list.'); }
    });
  }

  @HostListener('document:keydown.escape') close(): void { this.closed.emit(); }
}
