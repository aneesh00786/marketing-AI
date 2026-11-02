import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CrmApiService, CrmParent, errorText } from './crm-api.service';

/** Notes, follow-up tasks and recorded changes of one record, oldest first. */
@Component({
  selector: 'app-crm-activities',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <section class="crm-stack" aria-label="Activity">
      <h4 class="mx-subhead">Activity</h4>
      <p class="mx-callout error" *ngIf="error" role="alert">{{ error }}</p>
      <p class="muted small" *ngIf="!loading && !error && !activities.length">No notes or follow-up tasks yet.</p>
      <ul class="crm-list" *ngIf="activities.length">
        <li *ngFor="let a of activities" class="ca-item" [class.done]="a.done">
          <input *ngIf="a.type === 'task'" type="checkbox" [checked]="a.done" [disabled]="!canManage" (change)="toggle(a)" [attr.aria-label]="'Mark done: ' + a.body" />
          <div class="ca-body">
            <div class="ca-meta">
              <span class="mx-tag" [class.info]="a.type === 'task'">{{ typeLabel(a.type) }}</span>
              <span class="muted small">{{ a.createdAt | date:'MMM d, y, h:mm a' }} · {{ a.createdBy || 'Former member' }}</span>
            </div>
            <p class="ca-text">{{ a.body }}</p>
            <span class="muted small" *ngIf="a.dueDate">Follow up by {{ a.dueDate | date:'MMM d, y' }}</span>
          </div>
        </li>
      </ul>
      <form class="ca-form" *ngIf="canManage" (ngSubmit)="add()">
        <div class="mx-seg compact" role="group" aria-label="Activity type">
          <button type="button" [class.on]="type === 'note'" [attr.aria-pressed]="type === 'note'" (click)="type = 'note'">{{ noteLabel }}</button>
          <button type="button" [class.on]="type === 'task'" [attr.aria-pressed]="type === 'task'" (click)="type = 'task'">Follow-up task</button>
        </div>
        <textarea class="hud-textarea" name="body" rows="2" maxlength="5000" [(ngModel)]="body" [placeholder]="type === 'task' ? 'What needs to happen?' : 'Add a note… (internal)'" aria-label="Details"></textarea>
        <div class="ca-actions">
          <label *ngIf="type === 'task'" class="small muted">Follow up by <input class="hud-input sm" type="date" name="due" [(ngModel)]="dueDate" /></label>
          <button type="submit" class="btn btn-secondary btn-sm" [disabled]="busy || !body.trim()">Add</button>
        </div>
      </form>
    </section>
  `,
  styleUrls: ['../command/command-center.component.css', '../mail/mail-ui.css', './crm-ui.css'],
  styles: [`
    .crm-list li.ca-item { align-items: flex-start; justify-content: flex-start; }
    .ca-item input { margin-top: 4px; }
    .ca-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .ca-meta { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .ca-text { margin: 0; white-space: pre-line; overflow-wrap: anywhere; }
    .ca-item.done .ca-text { text-decoration: line-through; color: var(--text-muted); }
    .ca-form { display: flex; flex-direction: column; gap: 8px; }
    .ca-actions { display: flex; justify-content: flex-end; align-items: center; gap: 10px; flex-wrap: wrap; }
  `]
})
export class CrmActivitiesComponent implements OnChanges {
  @Input() parent: CrmParent = 'contacts';
  @Input() parentId: number | null = null;
  @Input() canManage = false;

  activities: any[] = [];
  loading = false;
  error = '';
  busy = false;
  type: 'note' | 'task' = 'note';
  body = '';
  dueDate = '';

  constructor(private api: CrmApiService) {}

  get noteLabel(): string { return this.parent === 'tickets' ? 'Internal note' : 'Note'; }

  typeLabel(type: string): string {
    if (type === 'task') return 'Follow-up task';
    if (type === 'change') return 'Update';
    return this.noteLabel;
  }

  ngOnChanges(ch: SimpleChanges): void {
    if (ch['parentId'] || ch['parent']) this.load();
  }

  load(): void {
    const id = this.parentId;
    this.activities = [];
    if (!id) return;
    this.loading = true;
    this.error = '';
    this.api.activities(this.parent, id).subscribe({
      next: r => { if (id !== this.parentId) return; this.loading = false; this.activities = r.activities; },
      error: e => { if (id !== this.parentId) return; this.loading = false; this.error = errorText(e); }
    });
  }

  add(): void {
    if (!this.parentId || !this.body.trim()) return;
    this.busy = true;
    this.error = '';
    const body = { type: this.type, body: this.body, ...(this.type === 'task' && this.dueDate ? { dueDate: this.dueDate } : {}) };
    this.api.addActivity(this.parent, this.parentId, body).subscribe({
      next: r => { this.busy = false; this.activities = [...this.activities, r.activity]; this.body = ''; this.dueDate = ''; this.type = 'note'; },
      error: e => { this.busy = false; this.error = errorText(e); }
    });
  }

  toggle(a: any): void {
    this.error = '';
    this.api.setTaskDone(a.id, !a.done).subscribe({
      next: r => { this.activities = this.activities.map(x => x.id === a.id ? r.activity : x); },
      error: e => { this.error = errorText(e); this.activities = [...this.activities]; this.load(); }
    });
  }
}
