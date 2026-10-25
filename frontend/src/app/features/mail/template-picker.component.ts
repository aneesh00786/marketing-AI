import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { apiRoot } from '../../core/api-base';

/**
 * Pick a saved template (search, preview, use). Emits the full template; the caller copies its
 * HTML into an email, draft or campaign, so later edits never change the template.
 */
@Component({
  selector: 'app-template-picker',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="modal-backdrop" (click)="closed.emit()">
      <div class="modal-card wide-modal picker" (click)="$event.stopPropagation()" role="dialog" aria-modal="true" aria-label="Choose a template">
        <div class="modal-header">
          <h3>{{ title }}</h3>
          <button class="close-btn" (click)="closed.emit()" aria-label="Close">✕</button>
        </div>
        <div class="modal-body picker-body">
          <div class="picker-list">
            <input class="hud-input" [(ngModel)]="q" (ngModelChange)="search()" placeholder="Search templates" aria-label="Search templates" />
            <p class="muted small" *ngIf="!loading && !templates.length">No templates yet. Create one in Mail Center → Email Templates.</p>
            <button *ngFor="let t of templates" class="picker-item" [class.active]="selected?.id === t.id" (click)="preview(t)">
              <b>{{ t.name }}</b><small>{{ t.category }} · {{ t.updatedAt | date:'mediumDate' }}</small>
            </button>
          </div>
          <div class="picker-preview">
            <ng-container *ngIf="selected; else none">
              <iframe sandbox="" title="Template preview" [srcdoc]="previewHtml"></iframe>
              <p class="muted small" *ngIf="selected.placeholders?.length">Placeholders: {{ selected.placeholders.join(', ') }}</p>
            </ng-container>
            <ng-template #none><p class="muted small">Select a template to preview it.</p></ng-template>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" (click)="closed.emit()">Cancel</button>
          <button class="btn btn-primary" [disabled]="!selected" (click)="picked.emit(selected)">Use this template</button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .picker-body { display: grid; grid-template-columns: minmax(200px, 280px) 1fr; gap: 12px; }
    .picker-list { display: flex; flex-direction: column; gap: 6px; max-height: 60vh; overflow: auto; }
    .picker-item { text-align: left; border: 1px solid var(--border); border-radius: 8px; padding: 8px; background: var(--surface); color: var(--text); cursor: pointer; display: flex; flex-direction: column; gap: 2px; font: inherit; }
    .picker-item.active { border-color: var(--accent); }
    .picker-item small, .muted { color: var(--text-muted); }
    .small { font-size: 12px; }
    .picker-preview iframe { width: 100%; height: 55vh; border: 1px solid var(--border); border-radius: 8px; background: #fff; }
    @media (max-width: 760px) { .picker-body { grid-template-columns: 1fr; } }
  `]
})
export class TemplatePickerComponent implements OnInit {
  @Input() title = 'Choose a template';
  @Output() picked = new EventEmitter<any>();
  @Output() closed = new EventEmitter<void>();

  private base = `${apiRoot()}/api/v1/mail/templates`;
  q = '';
  templates: any[] = [];
  selected: any = null;
  loading = false;
  private timer: any = null;

  constructor(private http: HttpClient, private sanitizer: DomSanitizer) {}

  ngOnInit(): void { this.load(); }

  get previewHtml(): SafeHtml {
    // Shown only inside a sandboxed iframe (no scripts, no same-origin access).
    return this.sanitizer.bypassSecurityTrustHtml(this.selected?.html || '');
  }

  search(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.load(), 250);
  }

  load(): void {
    this.loading = true;
    this.http.get<any>(this.base, { params: { q: this.q, pageSize: '50' } }).subscribe({
      next: r => { this.loading = false; this.templates = r.templates; },
      error: () => { this.loading = false; this.templates = []; }
    });
  }

  preview(t: any): void {
    this.http.get<any>(`${this.base}/${t.id}`).subscribe({ next: r => this.selected = r.template });
  }
}
