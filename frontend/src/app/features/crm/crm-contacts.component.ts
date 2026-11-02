import { Component, EventEmitter, HostListener, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CrmApiService, errorText, statusTone } from './crm-api.service';
import { CrmActivitiesComponent } from './crm-activities.component';
import { CrmPhoneInputComponent } from './crm-phone-input.component';
import { IconComponent } from '../../shared/icon.component';
import { CallButtonComponent } from '../../shared/calling/call-button.component';

const PAGE_SIZE = 25;
const SEARCH_DELAY_MS = 300;

/** Global CRM contacts. They are separate from workspace Leads, and nothing is copied between them. */
@Component({
  selector: 'app-crm-contacts',
  standalone: true,
  imports: [CallButtonComponent, CommonModule, FormsModule, IconComponent, CrmActivitiesComponent, CrmPhoneInputComponent],
  templateUrl: './crm-contacts.component.html',
  styleUrls: ['../command/command-center.component.css', '../mail/mail-ui.css', './crm-ui.css']
})
export class CrmContactsComponent implements OnInit, OnDestroy {
  @Input() canManage = false;
  @Input() canDeals = false;
  @Input() canSupport = false;
  @Input() set openId(id: number | null) { if (id) this.open(id); }
  /** Changes when the section is asked for again: back to the list. */
  @Input() set reset(_: number) { this.detail = null; }
  @Output() newDeal = new EventEmitter<any>();
  @Output() newTicket = new EventEmitter<any>();
  @Output() openDeal = new EventEmitter<number>();
  @Output() openTicket = new EventEmitter<number>();
  @Output() openCompany = new EventEmitter<number>();
  @Output() openCall = new EventEmitter<number>();
  @Output() toast = new EventEmitter<string>();

  readonly tone = statusTone;
  contacts: any[] = [];
  statuses: string[] = [];
  team: any[] = [];
  companies: any[] = [];
  total = 0;
  page = 1;
  q = '';
  status = '';
  assignedTo = '';
  loading = false;
  error = '';
  detail: any = null;
  form: any = null;
  formError = '';
  /** Possible duplicates the user can review before choosing to save anyway. */
  duplicates: any[] = [];
  busy = false;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private api: CrmApiService) {}

  get hasMore(): boolean { return this.page * PAGE_SIZE < this.total; }

  ngOnInit(): void {
    this.load(1);
    this.api.team().subscribe({ next: r => this.team = r.team, error: () => {} });
  }

  ngOnDestroy(): void { if (this.timer) clearTimeout(this.timer); }

  @HostListener('document:keydown.escape') onEscape(): void { this.form = null; }

  onSearch(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.load(1), SEARCH_DELAY_MS);
  }

  load(page: number): void {
    const mine = ++this.seq;
    this.page = page;
    this.loading = true;
    this.error = '';
    this.api.contacts({ q: this.q.trim(), status: this.status, assignedTo: this.assignedTo, page, limit: PAGE_SIZE }).subscribe({
      next: r => { if (mine !== this.seq) return; this.loading = false; this.contacts = r.contacts; this.total = r.total; this.statuses = r.statuses; },
      error: e => { if (mine !== this.seq) return; this.loading = false; this.contacts = []; this.total = 0; this.error = errorText(e); }
    });
  }

  open(id: number): void {
    this.api.contact(id).subscribe({ next: r => this.detail = r, error: e => this.toast.emit(errorText(e)) });
  }

  back(): void { this.detail = null; this.load(this.page); }

  openForm(c: any = null): void {
    this.formError = '';
    this.duplicates = [];
    this.form = c
      ? { id: c.id, fullName: c.fullName, email: c.email || '', phone: c.phone || '', companyId: c.companyId, status: c.status, assignedTo: c.assignedTo, notes: c.notes || '' }
      : { id: null, fullName: '', email: '', phone: '', companyId: null, status: 'Prospect', assignedTo: null, notes: '' };
    this.api.companies().subscribe({ next: r => this.companies = r.companies, error: () => {} });
  }

  save(allowDuplicate = false): void {
    const { id, ...body } = this.form;
    if (!body.fullName.trim()) { this.formError = 'Enter a name.'; return; }
    this.busy = true;
    this.formError = '';
    this.api.saveContact(id, allowDuplicate ? { ...body, allowDuplicate } : body).subscribe({
      next: r => {
        this.busy = false;
        this.form = null;
        this.duplicates = [];
        this.toast.emit(id ? 'Contact saved.' : 'Contact created.');
        if (this.detail) this.detail = r; else this.load(1);
      },
      error: e => {
        this.busy = false;
        if (e?.error?.code === 'DUPLICATE_CONTACT') this.duplicates = e.error.details?.matches || [];
        else this.formError = errorText(e);
      }
    });
  }

  viewDuplicate(id: number): void {
    this.form = null;
    this.duplicates = [];
    this.open(id);
  }
}
