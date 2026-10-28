import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, Input, OnChanges, OnDestroy, SimpleChanges, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { prepareEmailPreview } from './email-preview';

/**
 * The one email HTML preview used across the app (campaigns, drafts, templates, product emails,
 * compose and the mailbox viewer). See email-preview.ts for how the HTML is made safe.
 *
 * Why it writes srcdoc itself instead of binding [srcdoc]: Chrome leaves a sandbox="" iframe blank
 * when srcdoc is set again while the previous load is still in progress, and a binding to a
 * freshly created SafeHtml is re-set on every change detection (three times in a few ms when a
 * campaign opens). Here the document is written once per real change: immediately the first time,
 * debounced while typing, and never before the previous write has finished loading.
 */
@Component({
  selector: 'app-email-preview',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="ep" [class.mobile]="viewport === 'mobile'">
      <div class="ep-state" *ngIf="isEmpty">{{ emptyText }}</div>
      <div class="ep-state ep-error" *ngIf="!isEmpty && state === 'error'" role="alert">
        The preview could not be shown. <button type="button" class="ep-link" (click)="retry()">Try again</button>
      </div>
      <p class="ep-note" *ngIf="!isEmpty && nothingVisible && state !== 'error'" role="status">This HTML has no visible content. Check for unclosed tags or an empty body.</p>
      <div class="ep-frame-wrap" [hidden]="isEmpty || state === 'error'">
        <iframe #frame class="ep-frame" sandbox="" referrerpolicy="no-referrer" loading="eager" [title]="title" (load)="onLoad()"></iframe>
        <span class="ep-busy" *ngIf="slow" aria-hidden="true">Updating preview…</span>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; height: 420px; min-height: 160px; }
    .ep { height: 100%; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .ep-frame-wrap { position: relative; flex: 1; min-height: 0; display: flex; justify-content: center; border: 1px solid var(--border); border-radius: 10px; background: #f1f5f9; overflow: hidden; }
    .ep-frame { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
    .ep.mobile .ep-frame { width: 375px; max-width: 100%; border-left: 1px solid var(--border); border-right: 1px solid var(--border); }
    .ep-state { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; text-align: center; padding: 16px; border: 1px dashed var(--border); border-radius: 10px; color: var(--text-muted); font-size: 0.88rem; }
    .ep-error { color: var(--danger-text); border-style: solid; border-color: rgba(239, 68, 68, 0.45); }
    .ep-note { margin: 0; font-size: 0.8rem; color: var(--warning-text); }
    .ep-link { background: none; border: none; padding: 0; color: var(--info-text, var(--accent)); text-decoration: underline; cursor: pointer; font: inherit; }
    .ep-busy { position: absolute; right: 8px; top: 8px; font-size: 0.72rem; padding: 2px 8px; border-radius: 999px; background: rgba(15, 23, 42, 0.7); color: #fff; }
  `]
})
export class EmailPreviewComponent implements OnChanges, AfterViewInit, OnDestroy {
  @Input() html: string | null | undefined = '';
  @Input() title = 'Email preview';
  @Input() emptyText = 'No HTML content yet. Add HTML or choose a template to see the preview.';
  @Input() viewport: 'desktop' | 'mobile' = 'desktop';
  /** Delay before re-rendering after an edit (the first render is immediate). */
  @Input() debounceMs = 250;
  /** Identity of what is previewed (e.g. campaign id): when it changes, render at once, never showing the previous item. */
  @Input() contentKey: unknown = null;
  @ViewChild('frame') frame?: ElementRef<HTMLIFrameElement>;

  state: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  nothingVisible = false;
  slow = false;

  private viewReady = false;
  private written: string | null = null;   // document currently in (or loading into) the iframe
  private queued: string | null = null;    // newer document waiting for the current load
  private loadPending = false;
  private debounce: any = null;
  private loadTimeout: any = null;
  private slowTimer: any = null;

  /** How long to wait for the iframe to report it has loaded before showing the error state. */
  static loadTimeoutMs = 6000;

  constructor(private cdr: ChangeDetectorRef) {}

  get isEmpty(): boolean { return !String(this.html ?? '').trim(); }

  ngOnChanges(ch: SimpleChanges): void {
    if (!this.viewReady) return;
    clearTimeout(this.debounce);
    if (ch['contentKey'] && !ch['contentKey'].firstChange) { this.render(); return; }
    this.debounce = setTimeout(() => this.render(), this.debounceMs);
  }

  ngAfterViewInit(): void {
    this.viewReady = true;
    this.render();
  }

  ngOnDestroy(): void {
    clearTimeout(this.debounce);
    clearTimeout(this.loadTimeout);
    clearTimeout(this.slowTimer);
  }

  retry(): void {
    this.written = null;
    this.queued = null;
    this.loadPending = false;
    this.state = 'idle';
    this.render();
  }

  private render(): void {
    if (this.isEmpty) {
      this.nothingVisible = false;
      this.write(prepareEmailPreview('').doc);
      return;
    }
    try {
      const prepared = prepareEmailPreview(String(this.html));
      this.nothingVisible = prepared.nothingVisible;
      this.write(prepared.doc);
    } catch {
      this.state = 'error';
    }
    this.cdr.markForCheck();
  }

  private write(doc: string): void {
    const frame = this.frame?.nativeElement;
    if (!frame) return;
    if (this.loadPending) { this.queued = doc; return; }
    if (doc === this.written) return;
    this.written = doc;
    this.loadPending = true;
    if (this.state !== 'ready') this.state = 'loading';
    frame.srcdoc = doc;
    clearTimeout(this.loadTimeout);
    clearTimeout(this.slowTimer);
    this.slowTimer = setTimeout(() => { if (this.loadPending) { this.slow = true; this.cdr.markForCheck(); } }, 600);
    this.loadTimeout = setTimeout(() => {
      if (!this.loadPending) return;
      this.loadPending = false;
      this.slow = false;
      this.state = 'error';
      this.cdr.markForCheck();
    }, EmailPreviewComponent.loadTimeoutMs);
  }

  onLoad(): void {
    // The iframe also fires load for its initial about:blank, before anything was written.
    if (!this.loadPending) return;
    this.loadPending = false;
    this.slow = false;
    clearTimeout(this.loadTimeout);
    clearTimeout(this.slowTimer);
    if (this.queued !== null && this.queued !== this.written) {
      const next = this.queued;
      this.queued = null;
      this.write(next);
      return;
    }
    this.queued = null;
    this.state = 'ready';
  }
}
