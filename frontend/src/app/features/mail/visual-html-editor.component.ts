import { AfterViewInit, Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, Output, SimpleChanges, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { PREVIEW_CSP } from './email-preview';

/**
 * Visual ("normal") editing of email HTML: the email is shown as it looks and edited in place,
 * like a document. Every change is written back as HTML through `htmlChange`, so the HTML editor,
 * the preview and saving all use the same content.
 *
 * Safety: the email is edited inside an iframe sandboxed WITHOUT allow-scripts, with a
 * Content-Security-Policy of script-src 'none' — nothing in the email can run. allow-same-origin is
 * needed only so this component can switch on design mode and read the edited HTML back; without
 * scripts the email itself cannot use it. Before loading, scripts, frames, event-handler attributes
 * and javascript: URLs are removed (the server sanitizes campaign HTML on every save as well).
 * Links keep their href (including merge tags such as $[LI:UNSUBSCRIBE]$) but are not followed.
 */
const STRIP = 'script, noscript, iframe, frame, frameset, object, embed, applet, base, portal, meta[http-equiv]';
const DANGEROUS_URL = /^\s*(javascript|vbscript|data\s*:\s*text\/html)/i;
const URL_ATTRS = ['href', 'src', 'action', 'formaction', 'background', 'poster', 'srcset', 'xlink:href'];
const EDITOR_STYLE = 'html,body{margin:0}body{padding:16px;min-height:calc(100% - 32px);outline:none;overflow-wrap:anywhere;font-family:Arial,Helvetica,sans-serif}img{max-width:100%;height:auto}a{cursor:text}';

/** The HTML as the visual editor loads it: active content removed, editor helpers marked data-ve. */
export function prepareVisualDoc(html: string): string {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  doc.querySelectorAll(STRIP).forEach(el => el.remove());
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      else if (URL_ATTRS.includes(name) && DANGEROUS_URL.test(attr.value)) el.removeAttribute(attr.name);
    }
    if (el.hasAttribute('target')) el.removeAttribute('target');
  }
  const head = doc.head;
  const add = (tag: string, attrs: Record<string, string>, text = '') => {
    const n = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    n.setAttribute('data-ve', '');
    if (text) n.textContent = text;
    head.insertBefore(n, head.firstChild);
  };
  add('style', {}, EDITOR_STYLE);
  add('meta', { 'http-equiv': 'Content-Security-Policy', content: PREVIEW_CSP });
  add('meta', { charset: 'utf-8' });
  return '<!doctype html>\n' + doc.documentElement.outerHTML;
}

/** Edited document back to email HTML: a full document stays a full document, a fragment stays a fragment. */
export function serializeVisualDoc(doc: Document, fullDocument: boolean): string {
  const root = doc.documentElement.cloneNode(true) as HTMLElement;
  root.querySelectorAll('[data-ve]').forEach(n => n.remove());
  root.querySelectorAll('[contenteditable]').forEach(n => n.removeAttribute('contenteditable'));
  if (fullDocument) return '<!DOCTYPE html>\n' + root.outerHTML;
  return (root.querySelector('body')?.innerHTML || '').trim();
}

const isFullDocument = (html: string) => /<\s*(!doctype|html|head|body)\b/i.test(html || '');

@Component({
  selector: 'app-visual-html-editor',
  standalone: true,
  imports: [CommonModule],
  template: `<iframe #frame class="ve-frame" sandbox="allow-same-origin" referrerpolicy="no-referrer" [title]="title" (load)="onLoad()"></iframe>`,
  styles: [`
    :host { display: block; height: 480px; min-height: 200px; }
    .ve-frame { display: block; width: 100%; height: 100%; border: 1px solid var(--border-strong, var(--border)); border-radius: 0 0 10px 10px; background: #fff; }
  `]
})
export class VisualHtmlEditorComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() html = '';
  @Input() disabled = false;
  @Input() title = 'Visual email editor';
  @Output() htmlChange = new EventEmitter<string>();
  @ViewChild('frame', { static: true }) frame!: ElementRef<HTMLIFrameElement>;

  /** The HTML this editor last loaded or emitted, so its own changes are not reloaded. */
  private current: string | null = null;
  private full = false;
  private doc: Document | null = null;
  private readonly onInput = () => this.emit();

  ngAfterViewInit(): void { this.load(); }

  ngOnChanges(ch: SimpleChanges): void {
    if (!this.frame) return;
    if (ch['html'] && this.html !== this.current) this.load();
    else if (ch['disabled']) this.applyEditable();
  }

  ngOnDestroy(): void { this.detach(); }

  /** Runs an editing command (bold, createLink, insertHTML, undo…) in the email. */
  /** The character just before the cursor in the email ('' at the start or when there is no cursor). */
  charBeforeCursor(): string {
    const sel = this.doc?.getSelection();
    if (!sel || !sel.rangeCount) return '';
    const r = sel.getRangeAt(0);
    const node = r.startContainer;
    return node.nodeType === Node.TEXT_NODE ? String(node.textContent || '').charAt(r.startOffset - 1) : '';
  }

  exec(command: string, value?: string): boolean {
    const d = this.doc;
    if (!d || this.disabled) return false;
    this.frame.nativeElement.contentWindow?.focus();
    const ok = d.execCommand(command, false, value);
    this.emit();
    return ok;
  }

  onLoad(): void {
    this.detach();
    const d = this.frame.nativeElement.contentDocument;
    if (!d || !d.body) return;
    this.doc = d;
    d.addEventListener('input', this.onInput);
    this.applyEditable();
  }

  private load(): void {
    this.current = this.html || '';
    this.full = isFullDocument(this.current);
    this.frame.nativeElement.srcdoc = prepareVisualDoc(this.current);
  }

  private applyEditable(): void {
    if (this.doc) this.doc.designMode = this.disabled ? 'off' : 'on';
  }

  private emit(): void {
    if (!this.doc || this.disabled) return;
    const html = serializeVisualDoc(this.doc, this.full);
    if (html === this.current) return;
    this.current = html;
    this.htmlChange.emit(html);
  }

  private detach(): void {
    this.doc?.removeEventListener('input', this.onInput);
    this.doc = null;
  }
}
