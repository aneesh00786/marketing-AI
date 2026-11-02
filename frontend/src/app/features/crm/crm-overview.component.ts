import { Component, EventEmitter, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CrmApiService, CrmSection, errorText } from './crm-api.service';

/** Real figures only; with no data it shows an empty state, never sample numbers. */
@Component({
  selector: 'app-crm-overview',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="crm-stack">
      <p class="mx-callout error" *ngIf="error" role="alert">{{ error }} <button type="button" class="link-btn" (click)="load()">Try again</button></p>
      <p class="muted small" *ngIf="!data && !error">Loading…</p>
      <ng-container *ngIf="data">
        <div class="crm-stats">
          <button type="button" class="crm-stat" (click)="openSection.emit('contacts')"><span>Contacts</span><b>{{ data.totalContacts | number }}</b></button>
          <button type="button" class="crm-stat" (click)="openSection.emit('companies')"><span>Companies</span><b>{{ data.totalCompanies | number }}</b></button>
          <button type="button" class="crm-stat" (click)="openSection.emit('deals')"><span>Active deals</span><b>{{ data.activeDeals | number }}</b></button>
          <button type="button" class="crm-stat" (click)="openSection.emit('deals')"><span>Pipeline value</span><b>{{ data.pipelineValue | number:'1.0-2' }}</b></button>
          <button type="button" class="crm-stat" (click)="openSection.emit('support')"><span>Open tickets</span><b>{{ data.openTickets | number }}</b></button>
        </div>
        <section class="mx-panel">
          <h3 class="mx-subhead">Recent activities</h3>
          <p class="mx-empty" *ngIf="!data.recentActivities.length">No activity yet. Notes, follow-up tasks and updates on your records appear here.</p>
          <ul class="crm-list" *ngIf="data.recentActivities.length">
            <li *ngFor="let a of data.recentActivities">
              <div>
                <span class="mx-tag" [class.info]="a.type === 'task'">{{ a.type === 'task' ? 'Follow-up task' : a.type === 'change' ? 'Update' : 'Note' }}</span>
                <button *ngIf="a.subject" type="button" class="crm-row-link" (click)="openRecord.emit(a)">{{ a.subject }}</button>
                <span class="crm-sub">{{ a.body | slice:0:140 }}{{ a.body.length > 140 ? '…' : '' }}</span>
              </div>
              <span class="muted small crm-when">{{ a.createdAt | date:'MMM d, h:mm a' }}<br />{{ a.createdBy || 'Former team member' }}</span>
            </li>
          </ul>
        </section>
      </ng-container>
    </div>
  `,
  styleUrls: ['../command/command-center.component.css', '../mail/mail-ui.css', './crm-ui.css'],
  styles: ['.crm-when { flex: none; text-align: right; } .crm-list .mx-tag { margin-right: 6px; }']
})
export class CrmOverviewComponent implements OnInit {
  @Output() openSection = new EventEmitter<CrmSection>();
  /** An activity, whose contactId, companyId, dealId or ticketId says what to open. */
  @Output() openRecord = new EventEmitter<any>();

  data: any = null;
  error = '';

  constructor(private api: CrmApiService) {}

  ngOnInit(): void { this.load(); }

  load(): void {
    this.error = '';
    this.api.overview().subscribe({ next: r => this.data = r, error: e => this.error = errorText(e) });
  }
}
