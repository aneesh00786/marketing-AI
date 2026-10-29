import { AfterViewInit, Component, ElementRef, EventEmitter, HostListener, Input, OnDestroy, OnInit, Output, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { apiRoot } from '../../core/api-base';
import { EmailPreviewComponent } from './email-preview.component';

/**
 * Modal for picking a saved template (search, preview, use). Emits the full template only when the
 * user clicks "Use This Template"; the caller copies its HTML into an email, draft or campaign, so
 * nothing changes before that and later edits never change the template. The modal carries its own
 * styles, so it looks the same wherever it is used.
 */
@Component({
  selector: 'app-template-picker',
  standalone: true,
  imports: [CommonModule, FormsModule, EmailPreviewComponent],
  templateUrl: './template-picker.component.html',
  styleUrls: ['../command/command-center.component.css', './mail-ui.css', './template-picker.component.css']
})
export class TemplatePickerComponent implements OnInit, AfterViewInit, OnDestroy {
  @Input() title = 'Choose an Email Template';
  /** What the chosen template will be used for (shown under the title). */
  @Input() subtitle = '';
  @Output() picked = new EventEmitter<any>();
  @Output() closed = new EventEmitter<void>();
  @ViewChild('searchBox') searchBox?: ElementRef<HTMLInputElement>;

  private base = `${apiRoot()}/api/v1/mail/templates`;
  q = '';
  templates: any[] = [];
  loading = false;
  loadError: string | null = null;
  /** The highlighted card, and its full template once loaded (the list has no HTML). */
  selectedId: number | null = null;
  selected: any = null;
  previewLoading = false;
  previewError: string | null = null;
  private timer: any = null;
  private listSeq = 0;
  private previewSeq = 0;

  constructor(private http: HttpClient) {}

  ngOnInit(): void { this.load(); }
  ngAfterViewInit(): void { setTimeout(() => this.searchBox?.nativeElement.focus()); }
  ngOnDestroy(): void { clearTimeout(this.timer); }

  /** "Use This Template" works only once the highlighted template has loaded. */
  get canUse(): boolean { return !!this.selected && this.selected.id === this.selectedId; }

  @HostListener('document:keydown.escape', ['$event'])
  onEscape(ev: Event): void {
    ev.stopImmediatePropagation(); // a modal underneath (e.g. the draft generator) stays open
    this.close();
  }

  close(): void { this.closed.emit(); }

  use(): void { if (this.canUse) this.picked.emit(this.selected); }

  search(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.load(), 250);
  }

  load(): void {
    const seq = ++this.listSeq;
    this.loading = true;
    this.loadError = null;
    this.http.get<any>(this.base, { params: { q: this.q.trim(), pageSize: '50' } }).subscribe({
      next: r => { if (seq !== this.listSeq) return; this.loading = false; this.templates = r.templates || []; },
      error: e => {
        if (seq !== this.listSeq) return;
        this.loading = false;
        this.templates = [];
        this.loadError = e?.status === 403 ? 'Your role cannot view email templates.' : (e?.error?.error || 'Templates could not be loaded.');
      }
    });
  }

  choose(t: any): void {
    if (this.selectedId === t.id && (this.selected || this.previewLoading)) return;
    const seq = ++this.previewSeq;
    this.selectedId = t.id;
    this.selected = null;
    this.previewError = null;
    this.previewLoading = true;
    this.http.get<any>(`${this.base}/${t.id}`).subscribe({
      next: r => { if (seq !== this.previewSeq) return; this.previewLoading = false; this.selected = r.template; },
      error: e => { if (seq !== this.previewSeq) return; this.previewLoading = false; this.previewError = e?.error?.error || 'This template could not be loaded.'; }
    });
  }

  /** Kept for callers and tests that preview a template directly. */
  preview(t: any): void { this.choose(t); }

  /** Arrow keys move between cards; Enter/Space selects (native button behaviour). */
  onCardKey(ev: KeyboardEvent): void {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    ev.preventDefault();
    const cards = Array.from((ev.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('.tp-card') || []);
    const i = cards.indexOf(ev.currentTarget as HTMLButtonElement);
    cards[ev.key === 'ArrowDown' ? Math.min(cards.length - 1, i + 1) : Math.max(0, i - 1)]?.focus();
  }

  sourceLabel(s: string): string {
    return ({ zip: 'ZIP import', html: 'HTML import', manual: 'Written here', ai: 'AI' } as Record<string, string>)[s] || '';
  }
}
