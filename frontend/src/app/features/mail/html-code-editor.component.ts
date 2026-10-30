import { Component, ElementRef, EventEmitter, Input, Output, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';

/** Above this size the source is shown without colouring, so typing stays fast. */
const HIGHLIGHT_LIMIT = 150000;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Colours HTML source for display: tags, attribute names and values, comments and merge tags
 * ({{first_name}}, $[LI:UNSUBSCRIBE]$). Every character of the source is escaped first, so the
 * result is only <span class="…"> wrappers around escaped text: nothing in the email is ever
 * interpreted as markup.
 */
export function highlightHtml(src: string): string {
  if (src.length > HIGHLIGHT_LIMIT) return esc(src);
  const merge = (t: string) => t.replace(/(\{\{\s*[\w.-]+\s*\}\}|\$\[[A-Z]+:[A-Z_]+\]\$)/g, '<span class="hc-merge">$1</span>');
  let out = '';
  const re = /<!--[\s\S]*?(?:-->|$)|<\/?[A-Za-z!][^<>]*>?/g;
  let last = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(src));) {
    out += merge(esc(src.slice(last, m.index)));
    const tok = m[0];
    if (tok.startsWith('<!--')) out += `<span class="hc-comment">${esc(tok)}</span>`;
    else {
      const t = /^(<\/?)([A-Za-z!][\w:-]*)([\s\S]*?)(\/?>)?$/.exec(tok);
      if (!t) out += esc(tok);
      else {
        const attrs = esc(t[3]).replace(/([\w:@.-]+)(\s*=\s*)?(&quot;[^]*?&quot;|"[^"]*"|'[^']*'|[^\s"'>]+)?/g, (all, name, eq, val) =>
          `<span class="hc-attr">${name}</span>${eq ? eq + (val ? `<span class="hc-val">${merge(val)}</span>` : '') : ''}`);
        out += `<span class="hc-punct">${esc(t[1])}</span><span class="hc-tag">${esc(t[2])}</span>${attrs}${t[4] ? `<span class="hc-punct">${esc(t[4])}</span>` : ''}`;
      }
    }
    last = m.index + tok.length;
  }
  return out + merge(esc(src.slice(last))) + '\n';
}

/**
 * The HTML source editor: a plain textarea (so typing, selection, undo and paste behave
 * natively) over a coloured copy of the same text, with line numbers and an expand control.
 */
@Component({
  selector: 'app-html-code-editor',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="hc" [class.expanded]="expanded" [class.disabled]="disabled">
      <div class="hc-gutter" #gutter aria-hidden="true"><span *ngFor="let n of lineNumbers">{{ n }}</span></div>
      <div class="hc-area">
        <pre class="hc-hl" #hl aria-hidden="true" [innerHTML]="highlighted"></pre>
        <textarea #box class="hc-input" [value]="value" (input)="onInput($event)" (scroll)="sync()" [disabled]="disabled"
          spellcheck="false" wrap="off" autocapitalize="off" autocomplete="off" [attr.aria-label]="label" [placeholder]="placeholder"></textarea>
      </div>
      <button type="button" class="hc-expand" (click)="expanded = !expanded" [attr.aria-pressed]="expanded"
        [attr.aria-label]="expanded ? 'Make the editor smaller' : 'Make the editor taller'" [title]="expanded ? 'Smaller' : 'Taller'">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <path *ngIf="!expanded" d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/><path *ngIf="expanded" d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>
        </svg>
      </button>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .hc { position: relative; display: flex; height: 460px; border: 1px solid var(--border-strong, var(--border)); border-radius: 0 0 10px 10px; background: var(--bg-elev, var(--surface)); overflow: hidden; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; line-height: 20px; }
    .hc.expanded { height: 75vh; }
    .hc-gutter { flex: none; min-width: 44px; padding: 10px 8px 10px 0; text-align: right; color: var(--text-subtle, var(--text-muted)); background: var(--surface-2); border-right: 1px solid var(--border); overflow: hidden; user-select: none; display: flex; flex-direction: column; }
    .hc-gutter span { display: block; height: 20px; }
    .hc-area { position: relative; flex: 1; min-width: 0; }
    .hc-hl, .hc-input { position: absolute; inset: 0; margin: 0; padding: 10px 12px; border: 0; font: inherit; line-height: inherit; tab-size: 2; white-space: pre; overflow: auto; }
    .hc-hl { pointer-events: none; color: var(--text); overflow: hidden; }
    .hc-input { resize: none; background: transparent; color: transparent; caret-color: var(--text); outline: none; }
    .hc-input::selection { background: rgba(99, 102, 241, 0.28); color: transparent; }
    .hc-input::placeholder { color: var(--text-muted); }
    .hc:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    .hc.disabled .hc-input { cursor: not-allowed; }
    .hc-expand { position: absolute; right: 8px; bottom: 8px; display: inline-flex; padding: 5px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text-muted); cursor: pointer; }
    .hc-expand:hover { color: var(--text); }
    .hc-expand:focus-visible { outline: 2px solid var(--accent); }
    :host ::ng-deep .hc-tag { color: #2563eb; }
    :host ::ng-deep .hc-punct { color: #64748b; }
    :host ::ng-deep .hc-attr { color: #b45309; }
    :host ::ng-deep .hc-val { color: #047857; }
    :host ::ng-deep .hc-comment { color: #94a3b8; font-style: italic; }
    :host ::ng-deep .hc-merge { color: #7c3aed; font-weight: 600; }
    :host-context([data-theme='dark']) ::ng-deep .hc-tag { color: #60a5fa; }
    :host-context([data-theme='dark']) ::ng-deep .hc-attr { color: #fbbf24; }
    :host-context([data-theme='dark']) ::ng-deep .hc-val { color: #34d399; }
    :host-context([data-theme='dark']) ::ng-deep .hc-merge { color: #c4b5fd; }
    @media (max-width: 900px) { .hc { height: 360px; } }
  `]
})
export class HtmlCodeEditorComponent {
  @Input() value = '';
  @Input() disabled = false;
  @Input() label = 'HTML source';
  @Input() placeholder = '';
  @Output() valueChange = new EventEmitter<string>();
  @ViewChild('box', { static: true }) boxRef!: ElementRef<HTMLTextAreaElement>;
  @ViewChild('hl', { static: true }) hlRef!: ElementRef<HTMLPreElement>;
  @ViewChild('gutter', { static: true }) gutterRef!: ElementRef<HTMLDivElement>;
  expanded = false;

  private cache: { src: string; html: string } = { src: '', html: '\n' };

  /** The textarea, for toolbar commands that insert at the cursor. */
  get textarea(): HTMLTextAreaElement { return this.boxRef.nativeElement; }

  get highlighted(): string {
    if (this.cache.src !== this.value) this.cache = { src: this.value, html: highlightHtml(this.value || '') };
    return this.cache.html;
  }

  get lineNumbers(): number[] {
    const n = (this.value || '').split('\n').length;
    return Array.from({ length: n }, (_, i) => i + 1);
  }

  onInput(ev: Event): void {
    this.value = (ev.target as HTMLTextAreaElement).value;
    this.valueChange.emit(this.value);
    setTimeout(() => this.sync());
  }

  /** Keeps the coloured copy and the line numbers aligned with the textarea's scroll position. */
  sync(): void {
    const box = this.boxRef.nativeElement;
    this.hlRef.nativeElement.scrollTop = box.scrollTop;
    this.hlRef.nativeElement.scrollLeft = box.scrollLeft;
    this.gutterRef.nativeElement.scrollTop = box.scrollTop;
  }
}
