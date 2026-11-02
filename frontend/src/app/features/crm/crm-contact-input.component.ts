import { Component, EventEmitter, Input, OnChanges, OnDestroy, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CrmApiService } from './crm-api.service';

const SEARCH_DELAY_MS = 300;
const OPTIONS = 50;

/**
 * A searchable contact box for the deal and ticket forms. A choice sets the contact and clearing
 * it removes the contact. Text that matches nobody emits `unmatched`, so the form can refuse it.
 */
@Component({
  selector: 'app-crm-contact-input',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <label>Contact
      <input class="hud-input" name="contactSearch" [attr.list]="listId" [(ngModel)]="text" (ngModelChange)="onText()" placeholder="Search contacts…" autocomplete="off" />
    </label>
    <datalist [id]="listId"><option *ngFor="let c of options" [value]="label(c)"></option></datalist>
  `,
  styles: [':host { display: block; min-width: 0; } label { display: flex; flex-direction: column; gap: 4px; font-size: 0.8rem; font-weight: 600; color: var(--text-muted); }'],
  styleUrls: ['../command/command-center.component.css']
})
export class CrmContactInputComponent implements OnChanges, OnDestroy {
  @Input() contactId: number | null = null;
  @Input() contactName: string | null = null;
  @Output() contactIdChange = new EventEmitter<number | null>();
  @Output() unmatched = new EventEmitter<boolean>();

  readonly listId = `crm-contacts-${Math.random().toString(36).slice(2, 8)}`;
  text = '';
  options: any[] = [];
  private start: { text: string; id: number | null } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private api: CrmApiService) {}

  ngOnChanges(): void {
    if (this.start) return;
    this.text = this.contactName || '';
    this.start = { text: this.text, id: this.contactId };
    this.search();
  }

  ngOnDestroy(): void { if (this.timer) clearTimeout(this.timer); }

  label(c: any): string { return c.email ? `${c.fullName} (${c.email})` : c.fullName; }

  private search(): void {
    this.api.contacts({ q: this.text.trim().replace(/\s*\(.*$/, ''), limit: OPTIONS }).subscribe({ next: r => this.options = r.contacts, error: () => {} });
  }

  onText(): void {
    const text = this.text.trim();
    const hit = this.options.find(c => this.label(c) === text);
    const id = hit ? hit.id : text === this.start?.text ? this.start.id : null;
    this.contactIdChange.emit(id);
    this.unmatched.emit(!!text && !id);
    if (this.timer) clearTimeout(this.timer);
    if (!hit) this.timer = setTimeout(() => this.search(), SEARCH_DELAY_MS);
  }
}
