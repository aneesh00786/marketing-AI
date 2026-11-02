import { Component, EventEmitter, HostListener, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CrmApiService, errorText, statusTone } from './crm-api.service';
import { CrmActivitiesComponent } from './crm-activities.component';
import { CrmContactInputComponent } from './crm-contact-input.component';
import { IconComponent } from '../../shared/icon.component';
import { CallButtonComponent } from '../../shared/calling/call-button.component';

const SEARCH_DELAY_MS = 300;

/** Basic internal support tickets. Staff enter and work them; nothing is sent to the customer. */
@Component({
  selector: 'app-crm-support',
  standalone: true,
  imports: [CallButtonComponent, CommonModule, FormsModule, IconComponent, CrmActivitiesComponent, CrmContactInputComponent],
  templateUrl: './crm-support.component.html',
  styleUrls: ['../command/command-center.component.css', '../mail/mail-ui.css', './crm-ui.css']
})
export class CrmSupportComponent implements OnInit, OnDestroy {
  @Input() canSupport = false;
  @Input() set openId(id: number | null) { if (id) this.open(id); }
  @Input() set reset(_: number) { this.detail = null; }
  /** A contact to start a new ticket for, from the contact's page. */
  @Input() set prefillContact(c: any) { if (c) this.openForm(c); }
  @Output() openContact = new EventEmitter<number>();
  @Output() openCompany = new EventEmitter<number>();
  @Output() toast = new EventEmitter<string>();

  readonly tone = statusTone;
  tickets: any[] = [];
  statuses = ['Open', 'In Progress', 'Resolved', 'Closed'];
  priorities = ['Low', 'Medium', 'High'];
  team: any[] = [];
  companies: any[] = [];
  truncated = false;
  q = '';
  status = '';
  priority = '';
  assignedTo = '';
  loading = false;
  error = '';
  detail: any = null;
  /** Bumped after a change, so the history under the ticket reloads. */
  historyKey = 0;
  form: any = null;
  formError = '';
  contactUnmatched = false;
  busy = false;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private api: CrmApiService) {}

  ngOnInit(): void {
    this.load();
    this.api.team().subscribe({ next: r => this.team = r.team, error: () => {} });
  }

  ngOnDestroy(): void { if (this.timer) clearTimeout(this.timer); }

  @HostListener('document:keydown.escape') onEscape(): void { this.form = null; }

  onSearch(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.load(), SEARCH_DELAY_MS);
  }

  load(): void {
    const mine = ++this.seq;
    this.loading = true;
    this.error = '';
    this.api.tickets({ q: this.q.trim(), status: this.status, priority: this.priority, assignedTo: this.assignedTo }).subscribe({
      next: r => { if (mine !== this.seq) return; this.loading = false; this.tickets = r.tickets; this.statuses = r.statuses; this.priorities = r.priorities; this.truncated = r.truncated; },
      error: e => { if (mine !== this.seq) return; this.loading = false; this.tickets = []; this.error = errorText(e); }
    });
  }

  open(id: number): void {
    this.api.ticket(id).subscribe({ next: r => this.detail = r.ticket, error: e => this.toast.emit(errorText(e)) });
  }

  back(): void { this.detail = null; this.load(); }

  /** Status, priority or assignee from the ticket page. A refusal shows why and keeps the old value. */
  update(change: any): void {
    const previous = this.detail;
    this.detail = { ...previous, ...change };
    this.api.saveTicket(previous.id, change).subscribe({
      next: r => { this.detail = r.ticket; this.historyKey++; },
      error: e => { this.detail = { ...previous }; this.toast.emit(errorText(e)); }
    });
  }

  openForm(contact: any = null): void {
    this.formError = '';
    this.contactUnmatched = false;
    this.form = { subject: '', description: '', contactId: contact?.id ?? null, contactName: contact?.fullName ?? null, companyId: contact?.companyId ?? null, priority: 'Medium', assignedTo: null };
    this.api.companies().subscribe({ next: r => this.companies = r.companies, error: () => {} });
  }

  save(): void {
    const { contactName, ...body } = this.form;
    if (!body.subject.trim()) { this.formError = 'Enter a subject.'; return; }
    if (!body.description.trim()) { this.formError = 'Describe the issue.'; return; }
    if (this.contactUnmatched) { this.formError = 'Choose a contact from the list, or leave it empty.'; return; }
    // Left out when not chosen, so the server can use the contact's company.
    if (body.companyId === null) delete body.companyId;
    this.busy = true;
    this.formError = '';
    this.api.saveTicket(null, body).subscribe({
      next: r => { this.busy = false; this.form = null; this.toast.emit('Ticket created.'); this.detail = r.ticket; this.load(); },
      error: e => { this.busy = false; this.formError = errorText(e); }
    });
  }
}
