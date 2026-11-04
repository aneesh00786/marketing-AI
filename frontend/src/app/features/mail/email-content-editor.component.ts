import { Component, EventEmitter, HostListener, Input, OnChanges, Output, SimpleChanges, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IconComponent } from '../../shared/icon.component';
import { EmailPreviewComponent } from './email-preview.component';
import { VisualHtmlEditorComponent } from './visual-html-editor.component';
import { HtmlCodeEditorComponent } from './html-code-editor.component';
import { FormsModule } from '@angular/forms';
import { CONTACT_FIELDS, ContactField, INFO_TAGS, LINK_TAGS, contactTag, fallbackExample, fallbackQuestion } from './merge-tags';
import { describePlaceholder, fillPlaceholders, findPlaceholders, findSampleLinks, isWebLink } from './fill-placeholders';

const UNSUB_LINK = '<p style="text-align:center;font-size:12px;"><a href="$[LI:UNSUBSCRIBE]$">Unsubscribe</a></p>';
const UNSUB_TAG = /\$\[LI:(?:UNSUBSCRIBE|ORG_OPTOUT)\]\$/i;
/** A paragraph holding only the link, then a link inside other text. */
const UNSUB_PARAGRAPH = /[ \t]*<p\b[^>]*>\s*<a\b[^>]*\$\[LI:(?:UNSUBSCRIBE|ORG_OPTOUT)\]\$[^>]*>[\s\S]*?<\/a>\s*<\/p>\s*\n?/gi;
const UNSUB_ANCHOR = /<a\b[^>]*\$\[LI:(?:UNSUBSCRIBE|ORG_OPTOUT)\]\$[^>]*>[\s\S]*?<\/a>/gi;

/**
 * The email content panel shared by Campaigns and Email Templates: Edit (Visual or HTML source,
 * with a formatting toolbar) or Preview (the unsaved HTML, sandboxed, desktop or mobile width).
 * It holds no copy of the content: everything edits `html` and reports it through `htmlChange`,
 * so switching modes never loses an edit, and nothing here saves, validates or sends.
 */
@Component({
  selector: 'app-email-content-editor',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, EmailPreviewComponent, VisualHtmlEditorComponent, HtmlCodeEditorComponent],
  templateUrl: './email-content-editor.component.html',
  styleUrls: ['../command/command-center.component.css', './mail-ui.css', './email-content-editor.component.css']
})
export class EmailContentEditorComponent implements OnChanges {
  @Input() html = '';
  @Input() editable = false;
  /** Identifies the email being edited; a new one starts again in Edit → Visual. */
  @Input() contentKey: any = null;
  @Input() name = '';
  /** Campaign content needs Zoho's unsubscribe link; template content is reused in many places. */
  @Input() purpose: 'campaign' | 'template' = 'campaign';
  @Input() canChooseTemplate = true;
  @Output() htmlChange = new EventEmitter<string>();
  @Output() chooseTemplate = new EventEmitter<void>();
  @Output() toast = new EventEmitter<string>();

  contentMode: 'edit' | 'preview' = 'edit';
  /** 'visual' edits the email as it looks (like a document), 'html' edits the source. */
  editMode: 'visual' | 'html' = 'visual';
  previewWidth: 'desktop' | 'mobile' = 'desktop';
  @ViewChild(VisualHtmlEditorComponent) private visual?: VisualHtmlEditorComponent;
  @ViewChild('code') private code?: HtmlCodeEditorComponent;
  private get box(): HTMLTextAreaElement | undefined { return this.code?.textarea; }

  get purposeNoun(): string { return this.purpose === 'campaign' ? 'campaign' : 'template'; }

  ngOnChanges(ch: SimpleChanges): void {
    // A different email (or an email that became read-only) starts on its default view.
    if (ch['contentKey'] || (ch['editable'] && !ch['editable'].firstChange)) {
      this.contentMode = this.editable ? 'edit' : 'preview';
      if (ch['contentKey']) { this.editMode = 'visual'; this.previewWidth = 'desktop'; this.fills = {}; this.linkFills = {}; this.fillOpen = true; }
    }
  }

  // ---------- Fill in the template: one box per [placeholder] and per sample link ----------
  fills: Record<string, string> = {};
  linkFills: Record<string, string> = {};
  fillOpen = true;
  private scanned: { html: string; placeholders: { key: string; label: string; hint: string }[]; links: string[] } | null = null;

  private scan() {
    const html = this.html || '';
    if (!this.scanned || this.scanned.html !== html) {
      this.scanned = { html, placeholders: findPlaceholders(html).map(key => ({ key, ...describePlaceholder(key) })), links: findSampleLinks(html) };
    }
    return this.scanned;
  }

  get placeholders() { return this.scan().placeholders; }
  get sampleLinks(): string[] { return this.scan().links; }
  get fillCount(): number { return this.placeholders.length + this.sampleLinks.length; }

  /** Typed values ready to go in (links must be https://, mailto: or tel:). */
  get filledCount(): number {
    return this.placeholders.filter(p => (this.fills[p.key] || '').trim()).length
      + this.sampleLinks.filter(l => isWebLink(this.linkFills[l] || '')).length;
  }

  linkProblem(l: string): string {
    const v = (this.linkFills[l] || '').trim();
    return v && !isWebLink(v) ? 'Use a full https:// address, e.g. https://yourcompany.com/book' : '';
  }

  applyFills(): void {
    if (!this.editable || !this.filledCount) return;
    const before = this.fillCount;
    this.setHtml(fillPlaceholders(this.html, this.fills, this.linkFills));
    const left = this.fillCount;
    this.fills = {};
    this.linkFills = {};
    this.toast.emit(left ? `Filled in ${before - left}. ${left} still to fill.` : 'Template filled in. Check the preview, then save.');
  }

  setHtml(v: string): void {
    this.html = v;
    this.htmlChange.emit(v);
  }

  setMode(m: 'edit' | 'preview'): void { this.contentMode = m; }
  setEditMode(m: 'visual' | 'html'): void { this.editMode = m; }

  /** In Visual mode a toolbar command formats the email itself; false means use the HTML-source fallback. */
  private visualExec(command: string, value?: string): boolean {
    if (this.editMode !== 'visual' || !this.visual || !this.editable) return false;
    this.visual.exec(command, value);
    return true;
  }

  // ---------- Formatting toolbar ----------
  /**
   * Replaces the selection in the HTML source through the browser's own text insertion, so Undo/Redo
   * and Ctrl/⌘+Z keep working; falls back to setRangeText.
   */
  private replaceSelection(text: string): void {
    const box = this.box;
    if (!box || !this.editable) return;
    box.focus();
    const ok = typeof document.execCommand === 'function' && document.execCommand('insertText', false, text);
    if (!ok) {
      box.setRangeText(text, box.selectionStart, box.selectionEnd, 'end');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  private selected_(): string { const box = this.box; return box ? box.value.slice(box.selectionStart, box.selectionEnd) : ''; }

  wrapInline(tag: 'strong' | 'em' | 'u'): void {
    if (this.visualExec(({ strong: 'bold', em: 'italic', u: 'underline' } as const)[tag])) return;
    const sel = this.selected_() || 'text';
    this.replaceSelection(`<${tag}>${sel}</${tag}>`);
  }

  wrapBlock(tag: string): void {
    if (!['p', 'h1', 'h2', 'h3'].includes(tag)) return;
    if (this.visualExec('formatBlock', `<${tag}>`)) return;
    const sel = this.selected_() || (tag === 'p' ? 'Paragraph' : 'Heading');
    this.replaceSelection(`<${tag}>${sel}</${tag}>`);
  }

  insertList(): void {
    if (this.visualExec('insertUnorderedList')) return;
    const lines = (this.selected_() || 'First item\nSecond item').split('\n').map(l => l.trim()).filter(Boolean);
    this.replaceSelection(`<ul>\n${lines.map(l => `  <li>${l}</li>`).join('\n')}\n</ul>`);
  }

  private askHttps(label: string, problem: string): string | null {
    const url = (prompt(label, 'https://') || '').trim();
    if (!url || url === 'https://') return null;
    if (!/^https:\/\/[^\s"'<>]+$/i.test(url)) { this.toast.emit(problem); return null; }
    return url;
  }

  insertLink(): void {
    const url = this.askHttps('Link address (https://…)', 'Use a full https:// link.');
    if (!url) return;
    if (this.editMode === 'visual' && this.visual && this.editable) {
      // A link on the selected text, or the address itself as the link text when nothing is selected.
      if (!this.visual.exec('createLink', url)) this.visual.exec('insertHTML', `<a href="${url}">${url}</a>`);
      return;
    }
    this.replaceSelection(`<a href="${url}">${this.selected_() || url}</a>`);
  }

  insertImage(): void {
    const url = this.askHttps('Image address (https://…)', 'Images need an https:// address so they load for recipients.');
    if (!url) return;
    if (this.visualExec('insertHTML', `<img src="${url}" alt="" style="max-width:100%;height:auto;" />`)) return;
    this.replaceSelection(`<img src="${url}" alt="" style="max-width:100%;height:auto;" />`);
  }

  readonly contactFields = CONTACT_FIELDS;
  readonly fallbackQuestion = fallbackQuestion;
  readonly fallbackExample = fallbackExample;
  readonly linkTags = LINK_TAGS;
  readonly infoTags = INFO_TAGS;
  /** The 👤 Personalize panel is open. */
  personalizeOpen = false;
  /** A contact field waiting for its default value (Zoho asks for one the same way). */
  mergeAsk: { field: ContactField; label: string; fallback: string } | null = null;

  /**
   * The Merge Tags menu (as in Zoho's editor). Contact fields ask for a default value first; links
   * and organization tags go in at once. Zoho fills every tag per recipient when it sends.
   */
  pickMergeTag(key: string): void {
    if (!key || !this.editable) return;
    const field = CONTACT_FIELDS.find(f => f.key === key);
    if (field) { this.mergeAsk = { field: field.key, label: field.label, fallback: field.fallback }; return; }
    const link = LINK_TAGS.find(l => l.key === key);
    if (link) {
      const a = `<a href="${link.tag}">${link.text}</a>`;
      if (!this.visualExec('insertHTML', a)) this.replaceSelection(a);
      this.toast.emit(`${link.label} link added. Zoho fills in the address when it sends.`);
      return;
    }
    const info = INFO_TAGS.find(i => i.key === key);
    if (info) this.insertTagText(info.tag);
  }

  @HostListener('document:keydown.escape') closePersonalize(): void { this.personalizeOpen = false; }
  @HostListener('document:click', ['$event']) clickAway(e: Event): void {
    if (this.personalizeOpen && !(e.target as HTMLElement)?.closest?.('.ec-personalize')) this.personalizeOpen = false;
  }

  /** Inserts the contact field with the default value typed in the prompt. */
  confirmMergeTag(): void {
    const ask = this.mergeAsk;
    this.mergeAsk = null;
    if (!ask || !this.editable) return;
    this.insertTagText(contactTag(ask.field, ask.fallback));
    this.toast.emit(`${ask.label} added. Each contact sees their own ${ask.label.toLowerCase()}.`);
  }

  /** "Hello" + tag → "Hello $[FNAME…]$": a space is added after a letter, digit or punctuation. */
  private insertTagText(tag: string): void {
    const box = this.box;
    const before = this.editMode === 'visual' ? (this.visual?.charBeforeCursor() ?? '') : (box ? box.value.charAt(box.selectionStart - 1) : '');
    const text = before && /[\p{L}\p{N},.!?;:]/u.test(before) ? ' ' + tag : tag;
    if (!this.visualExec('insertText', text)) this.replaceSelection(text);
  }

  history(cmd: 'undo' | 'redo'): void {
    if (!this.editable || this.visualExec(cmd)) return;
    const box = this.box;
    if (!box) return;
    box.focus();
    if (typeof document.execCommand === 'function') document.execCommand(cmd);
  }

  /** True when the email already has Zoho's unsubscribe link (added here or written by hand). */
  get hasUnsubscribe(): boolean { return UNSUB_TAG.test(this.html || ''); }

  /** The "Add unsubscribe link" checkbox: adds the link at the end of the email, or removes it. */
  setUnsubscribe(on: boolean): void {
    if (!this.editable || on === this.hasUnsubscribe) return;
    const html = this.html || '';
    if (on) {
      const body = /<\/body\s*>/i.exec(html);
      this.setHtml(body ? html.slice(0, body.index) + UNSUB_LINK + '\n' + html.slice(body.index) : `${html}\n${UNSUB_LINK}`.trimStart());
      return;
    }
    this.setHtml(html
      .replace(UNSUB_PARAGRAPH, '')
      .replace(UNSUB_ANCHOR, '')
      .replace(new RegExp(UNSUB_TAG.source, 'gi'), ''));
  }

  /** Reminders while editing (the server's validation is unchanged and still decides). */
  get contentHints(): string[] {
    const html = this.html || '';
    const out: string[] = [];
    if (!html.trim()) return [`Add the email content: write HTML${this.canChooseTemplate ? ' or choose a template' : ''}.`];
    if (this.purpose === 'campaign' && !html.includes('$[LI:UNSUBSCRIBE]$')) out.push('No unsubscribe link yet: Zoho requires one. Tick "Add unsubscribe link" below.');
    if (/<img\b[^>]*\bsrc\s*=\s*["']?http:\/\//i.test(html)) out.push('Some images use http://. Use https:// image URLs so they load for recipients.');
    return out;
  }
}
