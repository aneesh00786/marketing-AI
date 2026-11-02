import { Component, EventEmitter, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CrmApiService, errorText } from './crm-api.service';
import { CallButtonComponent } from '../../shared/calling/call-button.component';

const SEARCH_DELAY_MS = 300;
const PAGE_SIZE = 25;
const TRANSCRIPT_LABELS: Record<string, string> = { done: 'Transcript', pending: 'Processing', failed: 'Failed' };

/** The call log. Audio is never kept; a transcript is text, made only when the caller asked. */
@Component({
  selector: 'app-crm-calls',
  standalone: true,
  imports: [CommonModule, FormsModule, CallButtonComponent],
  templateUrl: './crm-calls.component.html',
  styleUrls: ['../command/command-center.component.css', '../mail/mail-ui.css', './crm-ui.css'],
  styles: [`
    .cl-lines { display: flex; flex-direction: column; gap: 8px; }
    .cl-line { max-width: 85%; padding: 8px 11px; border-radius: 12px; background: var(--surface-2); font-size: 0.86rem; line-height: 1.45; overflow-wrap: anywhere; }
    .cl-line.agent { align-self: flex-end; background: var(--accent-soft); }
    .cl-line small { display: block; margin-bottom: 2px; font-size: 0.72rem; font-weight: 600; color: var(--text-muted); }
    .cl-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
  `]
})
export class CrmCallsComponent implements OnInit, OnDestroy {
  @Input() canManage = false;
  @Input() set openId(id: number | null) { if (id) this.open(id); }
  @Input() set reset(_: number) { this.detail = null; }
  @Output() openContact = new EventEmitter<number>();
  @Output() toast = new EventEmitter<string>();

  calls: any[] = [];
  total = 0;
  page = 1;
  q = '';
  loading = false;
  error = '';
  detail: any = null;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private api: CrmApiService) {}

  get hasMore(): boolean { return this.page * PAGE_SIZE < this.total; }

  ngOnInit(): void { this.load(1); }
  ngOnDestroy(): void { if (this.timer) clearTimeout(this.timer); }

  onSearch(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.load(1), SEARCH_DELAY_MS);
  }

  load(page: number): void {
    const mine = ++this.seq;
    this.page = page;
    this.loading = true;
    this.error = '';
    this.api.calls({ q: this.q.trim(), page }).subscribe({
      next: r => { if (mine !== this.seq) return; this.loading = false; this.calls = r.calls; this.total = r.total; },
      error: e => { if (mine !== this.seq) return; this.loading = false; this.calls = []; this.total = 0; this.error = errorText(e); }
    });
  }

  open(id: number): void {
    this.api.call(id).subscribe({ next: r => this.detail = r.call, error: e => this.toast.emit(errorText(e)) });
  }

  back(): void { this.detail = null; this.load(this.page); }

  duration(c: any): string {
    if (!c.answered) return 'Not answered';
    const s = c.durationSeconds || 0;
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  transcriptLabel(c: any): string { return TRANSCRIPT_LABELS[c.transcriptStatus] || ''; }

  removeTranscript(): void {
    if (!confirm('Delete this transcript? The call stays in the log. This cannot be undone.')) return;
    this.api.removeTranscript(this.detail.id).subscribe({
      next: r => { this.detail = r.call; this.toast.emit('Transcript deleted.'); },
      error: e => this.toast.emit(errorText(e))
    });
  }
}
