import { Component, EventEmitter, HostListener, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CrmApiService, errorText, statusTone } from './crm-api.service';
import { CrmActivitiesComponent } from './crm-activities.component';
import { CrmPhoneInputComponent } from './crm-phone-input.component';
import { IconComponent } from '../../shared/icon.component';
import { CallButtonComponent } from '../../shared/calling/call-button.component';

const SEARCH_DELAY_MS = 300;

@Component({
  selector: 'app-crm-companies',
  standalone: true,
  imports: [CallButtonComponent, CommonModule, FormsModule, IconComponent, CrmActivitiesComponent, CrmPhoneInputComponent],
  templateUrl: './crm-companies.component.html',
  styleUrls: ['../command/command-center.component.css', '../mail/mail-ui.css', './crm-ui.css']
})
export class CrmCompaniesComponent implements OnInit, OnDestroy {
  @Input() canManage = false;
  @Input() set openId(id: number | null) { if (id) this.open(id); }
  @Input() set reset(_: number) { this.detail = null; }
  @Output() openContact = new EventEmitter<number>();
  @Output() openDeal = new EventEmitter<number>();
  @Output() openTicket = new EventEmitter<number>();
  @Output() toast = new EventEmitter<string>();

  readonly tone = statusTone;
  companies: any[] = [];
  truncated = false;
  q = '';
  loading = false;
  error = '';
  detail: any = null;
  form: any = null;
  formError = '';
  busy = false;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private api: CrmApiService) {}

  ngOnInit(): void { this.load(); }
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
    this.api.companies({ q: this.q.trim() }).subscribe({
      next: r => { if (mine !== this.seq) return; this.loading = false; this.companies = r.companies; this.truncated = r.truncated; },
      error: e => { if (mine !== this.seq) return; this.loading = false; this.companies = []; this.error = errorText(e); }
    });
  }

  open(id: number): void {
    this.api.company(id).subscribe({ next: r => this.detail = r, error: e => this.toast.emit(errorText(e)) });
  }

  back(): void { this.detail = null; this.load(); }

  openForm(c: any = null): void {
    this.formError = '';
    this.form = c
      ? { id: c.id, name: c.name, website: c.website || '', industry: c.industry || '', email: c.email || '', phone: c.phone || '', notes: c.notes || '' }
      : { id: null, name: '', website: '', industry: '', email: '', phone: '', notes: '' };
  }

  save(): void {
    const { id, ...body } = this.form;
    if (!body.name.trim()) { this.formError = 'Enter a company name.'; return; }
    this.busy = true;
    this.formError = '';
    this.api.saveCompany(id, body).subscribe({
      next: r => {
        this.busy = false;
        this.form = null;
        this.toast.emit(id ? 'Company saved.' : 'Company created.');
        if (this.detail) this.detail = r; else this.load();
      },
      error: e => { this.busy = false; this.formError = errorText(e); }
    });
  }
}
