import { Component, EventEmitter, HostListener, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CrmApiService, errorText, statusTone } from './crm-api.service';
import { CrmActivitiesComponent } from './crm-activities.component';
import { CrmContactInputComponent } from './crm-contact-input.component';
import { IconComponent } from '../../shared/icon.component';

const SEARCH_DELAY_MS = 300;

/** Deals in a list or a pipeline. Stages change by dragging a card or with its stage menu. */
@Component({
  selector: 'app-crm-deals',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, CrmActivitiesComponent, CrmContactInputComponent],
  templateUrl: './crm-deals.component.html',
  styleUrls: ['../command/command-center.component.css', '../mail/mail-ui.css', './crm-ui.css', './crm-deals.component.css']
})
export class CrmDealsComponent implements OnInit, OnDestroy {
  @Input() canDeals = false;
  @Input() set openId(id: number | null) { if (id) this.open(id); }
  @Input() set reset(_: number) { this.detail = null; }
  /** A contact to start a new deal for, from the contact's page. */
  @Input() set prefillContact(c: any) { if (c) this.openForm(null, c); }
  @Output() openContact = new EventEmitter<number>();
  @Output() openCompany = new EventEmitter<number>();
  @Output() toast = new EventEmitter<string>();

  readonly tone = statusTone;
  stages: string[] = ['New', 'Contacted', 'Qualified', 'Proposal', 'Won', 'Lost'];
  view: 'pipeline' | 'list' = 'pipeline';
  deals: any[] = [];
  truncated = false;
  team: any[] = [];
  companies: any[] = [];
  contactUnmatched = false;
  q = '';
  stage = '';
  assignedTo = '';
  loading = false;
  error = '';
  detail: any = null;
  form: any = null;
  formError = '';
  busy = false;
  dragId: number | null = null;
  dropStage: string | null = null;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private api: CrmApiService) {}

  ngOnInit(): void {
    this.load();
    this.api.team().subscribe({ next: r => this.team = r.team, error: () => {} });
  }

  ngOnDestroy(): void { if (this.timer) clearTimeout(this.timer); }

  @HostListener('document:keydown.escape') onEscape(): void { this.form = null; }

  dealsIn(stage: string): any[] { return this.deals.filter(d => d.stage === stage); }
  totalIn(stage: string): number { return this.dealsIn(stage).reduce((n, d) => n + (d.value || 0), 0); }
  trackId(_: number, d: any): number { return d.id; }

  onSearch(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.load(), SEARCH_DELAY_MS);
  }

  load(): void {
    const mine = ++this.seq;
    this.loading = true;
    this.error = '';
    this.api.deals({ q: this.q.trim(), stage: this.view === 'list' ? this.stage : '', assignedTo: this.assignedTo }).subscribe({
      next: r => { if (mine !== this.seq) return; this.loading = false; this.deals = r.deals; this.stages = r.stages; this.truncated = r.truncated; },
      error: e => { if (mine !== this.seq) return; this.loading = false; this.deals = []; this.error = errorText(e); }
    });
  }

  setView(v: 'pipeline' | 'list'): void {
    if (v === this.view) return;
    this.view = v;
    if (this.stage) this.load();
  }

  /** The card moves at once; if the server refuses, it goes back and says why. */
  move(d: any, stage: string): void {
    if (!this.canDeals || d.stage === stage) return;
    const from = d.stage;
    this.deals = this.deals.map(x => x.id === d.id ? { ...x, stage } : x);
    this.api.saveDeal(d.id, { stage }).subscribe({
      next: r => {
        this.deals = this.deals.map(x => x.id === d.id ? r.deal : x);
        if (this.detail?.id === d.id) this.detail = r.deal;
        this.toast.emit(`${d.name} moved to ${stage}.`);
      },
      error: e => {
        this.deals = this.deals.map(x => x.id === d.id ? { ...x, stage: from } : x);
        this.toast.emit(errorText(e));
      }
    });
  }

  onDragStart(ev: DragEvent, d: any): void {
    this.dragId = d.id;
    ev.dataTransfer?.setData('text/plain', String(d.id));
  }

  onDrop(ev: DragEvent, stage: string): void {
    ev.preventDefault();
    const d = this.deals.find(x => x.id === this.dragId);
    this.dragId = null;
    this.dropStage = null;
    if (d) this.move(d, stage);
  }

  open(id: number): void {
    this.api.deal(id).subscribe({ next: r => this.detail = r.deal, error: e => this.toast.emit(errorText(e)) });
  }

  back(): void { this.detail = null; this.load(); }

  remove(): void {
    if (!confirm(`Delete the deal "${this.detail.name}" and its notes and tasks?`)) return;
    this.api.deleteDeal(this.detail.id).subscribe({
      next: () => { this.toast.emit('Deal deleted.'); this.back(); },
      error: e => this.toast.emit(errorText(e))
    });
  }

  // ---------- Create and edit ----------
  openForm(d: any = null, contact: any = null): void {
    this.formError = '';
    this.contactUnmatched = false;
    this.form = d
      ? { id: d.id, name: d.name, contactId: d.contactId, contactName: d.contactName, companyId: d.companyId, value: d.value, stage: d.stage, assignedTo: d.assignedTo, expectedCloseDate: d.expectedCloseDate || '', notes: d.notes || '' }
      : { id: null, name: '', contactId: contact?.id ?? null, contactName: contact?.fullName ?? null, companyId: contact?.companyId ?? null, value: null, stage: 'New', assignedTo: contact?.assignedTo ?? null, expectedCloseDate: '', notes: '' };
    this.api.companies().subscribe({ next: r => this.companies = r.companies, error: () => {} });
  }

  save(): void {
    const { id, contactName, ...body } = this.form;
    if (!body.name.trim()) { this.formError = 'Enter a deal name.'; return; }
    if (this.contactUnmatched) { this.formError = 'Choose a contact from the list, or leave it empty.'; return; }
    this.busy = true;
    this.formError = '';
    // Left out on a new deal so the server can use the contact's company.
    if (!id && body.companyId === null) delete body.companyId;
    this.api.saveDeal(id, { ...body, value: body.value === '' ? null : body.value }).subscribe({
      next: r => {
        this.busy = false;
        this.form = null;
        this.toast.emit(id ? 'Deal saved.' : 'Deal created.');
        if (this.detail) this.detail = r.deal;
        this.load();
      },
      error: e => { this.busy = false; this.formError = errorText(e); }
    });
  }
}
