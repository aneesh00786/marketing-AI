import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CRM_SECTIONS, CrmAccess, CrmSection } from './crm-api.service';
import { CrmOverviewComponent } from './crm-overview.component';
import { CrmContactsComponent } from './crm-contacts.component';
import { CrmCompaniesComponent } from './crm-companies.component';
import { CrmDealsComponent } from './crm-deals.component';
import { CrmSupportComponent } from './crm-support.component';
import { CrmCallsComponent } from './crm-calls.component';
import { IconComponent } from '../../shared/icon.component';

const DESCRIPTIONS: Record<CrmSection, string> = {
  dashboard: 'Customers, deals and support at a glance.',
  contacts: 'Your customers and contacts. Separate from workspace Leads.',
  companies: 'Companies, with their contacts, deals and tickets.',
  deals: 'Sales opportunities from New to Won or Lost.',
  support: 'Internal support tickets.',
  calls: 'Calls made from the app, with transcripts where the caller turned them on.'
};

/** The global CRM page. The server enforces access; the flags here only hide what cannot be used. */
@Component({
  selector: 'app-crm',
  standalone: true,
  imports: [CommonModule, IconComponent, CrmOverviewComponent, CrmContactsComponent, CrmCompaniesComponent, CrmDealsComponent, CrmSupportComponent, CrmCallsComponent],
  template: `
    <section class="crm-stack">
      <header class="mx-head">
        <div><h2>CRM · {{ title }}</h2><p class="mx-desc">{{ description }}</p></div>
      </header>
      <p class="mx-empty" *ngIf="!access">You do not have access to the CRM. Ask an administrator to grant it.</p>
      <ng-container *ngIf="access">
        <div class="mx-subtabs" role="tablist" aria-label="CRM sections">
          <button *ngFor="let s of sections" type="button" role="tab" [class.on]="section === s.key" [attr.aria-selected]="section === s.key" (click)="show(s.key)">
            <app-icon [name]="s.icon" [size]="15"></app-icon>{{ s.label }}
          </button>
        </div>
        <app-crm-overview *ngIf="section === 'dashboard'" (openSection)="show($event)" (openRecord)="openActivity($event)"></app-crm-overview>
        <app-crm-contacts *ngIf="section === 'contacts'" [canManage]="can('crm.manage')" [canDeals]="can('crm.deals')" [canSupport]="can('crm.support')" [openId]="contactId" [reset]="key"
          (newDeal)="startDeal($event)" (newTicket)="startTicket($event)" (openDeal)="openDeal($event)" (openTicket)="openTicket($event)" (openCompany)="openCompany($event)" (openCall)="openCall($event)" (toast)="toast.emit($event)"></app-crm-contacts>
        <app-crm-companies *ngIf="section === 'companies'" [canManage]="can('crm.manage')" [openId]="companyId" [reset]="key"
          (openContact)="openContact($event)" (openDeal)="openDeal($event)" (openTicket)="openTicket($event)" (toast)="toast.emit($event)"></app-crm-companies>
        <app-crm-deals *ngIf="section === 'deals'" [canDeals]="can('crm.deals')" [openId]="dealId" [reset]="key" [prefillContact]="prefill"
          (openContact)="openContact($event)" (openCompany)="openCompany($event)" (toast)="toast.emit($event)"></app-crm-deals>
        <app-crm-support *ngIf="section === 'support'" [canSupport]="can('crm.support')" [openId]="ticketId" [reset]="key" [prefillContact]="prefill"
          (openContact)="openContact($event)" (openCompany)="openCompany($event)" (toast)="toast.emit($event)"></app-crm-support>
        <app-crm-calls *ngIf="section === 'calls'" [canManage]="can('crm.manage')" [openId]="callId" [reset]="key" (openContact)="openContact($event)" (toast)="toast.emit($event)"></app-crm-calls>
      </ng-container>
    </section>
  `,
  styleUrls: ['../command/command-center.component.css', '../mail/mail-ui.css', './crm-ui.css']
})
export class CrmComponent {
  @Input() section: CrmSection = 'dashboard';
  @Input() access: CrmAccess | null = null;
  /** Changes when the sidebar is clicked, so an open record closes. */
  @Input() set resetKey(_: number) { this.clear(); }
  @Output() sectionChange = new EventEmitter<CrmSection>();
  @Output() toast = new EventEmitter<string>();

  readonly sections = CRM_SECTIONS;
  contactId: number | null = null;
  companyId: number | null = null;
  dealId: number | null = null;
  ticketId: number | null = null;
  callId: number | null = null;
  prefill: any = null;
  key = 0;

  get title(): string { return CRM_SECTIONS.find(s => s.key === this.section)?.label || ''; }
  get description(): string { return DESCRIPTIONS[this.section]; }
  can(capability: string): boolean { return !!this.access?.capabilities.includes(capability); }

  private clear(): void {
    this.contactId = this.companyId = this.dealId = this.ticketId = this.callId = null;
    this.prefill = null;
    this.key++;
  }

  show(s: CrmSection): void {
    this.clear();
    this.section = s;
    this.sectionChange.emit(s);
  }

  openContact(id: number): void { this.show('contacts'); this.contactId = id; }
  openCompany(id: number): void { this.show('companies'); this.companyId = id; }
  openDeal(id: number): void { this.show('deals'); this.dealId = id; }
  openTicket(id: number): void { this.show('support'); this.ticketId = id; }
  openCall(id: number): void { this.show('calls'); this.callId = id; }
  startDeal(contact: any): void { this.show('deals'); this.prefill = contact; }
  startTicket(contact: any): void { this.show('support'); this.prefill = contact; }

  openActivity(a: any): void {
    if (a.ticketId) this.openTicket(a.ticketId);
    else if (a.dealId) this.openDeal(a.dealId);
    else if (a.companyId) this.openCompany(a.companyId);
    else if (a.contactId) this.openContact(a.contactId);
  }
}
