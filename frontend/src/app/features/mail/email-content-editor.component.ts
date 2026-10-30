import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IconComponent } from '../../shared/icon.component';
import { EmailPreviewComponent } from './email-preview.component';
import { VisualHtmlEditorComponent } from './visual-html-editor.component';
import { HtmlCodeEditorComponent } from './html-code-editor.component';

/**
 * The email content panel shared by Campaigns and Email Templates: Edit (Visual or HTML source,
 * with a formatting toolbar) or Preview (the unsaved HTML, sandboxed, desktop or mobile width).
 * It holds no copy of the content: everything edits `html` and reports it through `htmlChange`,
 * so switching modes never loses an edit, and nothing here saves, validates or sends.
 */
@Component({
  selector: 'app-email-content-editor',
  standalone: true,
  imports: [CommonModule, IconComponent, EmailPreviewComponent, VisualHtmlEditorComponent, HtmlCodeEditorComponent],
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
      if (ch['contentKey']) { this.editMode = 'visual'; this.previewWidth = 'desktop'; }
    }
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

  history(cmd: 'undo' | 'redo'): void {
    if (!this.editable || this.visualExec(cmd)) return;
    const box = this.box;
    if (!box) return;
    box.focus();
    if (typeof document.execCommand === 'function') document.execCommand(cmd);
  }

  /** Inserts Zoho's unsubscribe link at the cursor (only edits the unsaved content). */
  insertUnsubscribe(): void {
    if (!this.editable) return;
    if ((this.html || '').includes('$[LI:UNSUBSCRIBE]$')) { this.toast.emit('The unsubscribe link is already in the content.'); return; }
    const link = '<p><a href="$[LI:UNSUBSCRIBE]$">Unsubscribe</a></p>';
    if (!this.visualExec('insertHTML', link)) this.replaceSelection(link);
    if (!(this.html || '').includes('$[LI:UNSUBSCRIBE]$')) this.setHtml((this.html || '') + link);
  }

  /** Reminders while editing (the server's validation is unchanged and still decides). */
  get contentHints(): string[] {
    const html = this.html || '';
    const out: string[] = [];
    if (!html.trim()) return [`Add the email content: write HTML${this.canChooseTemplate ? ' or choose a template' : ''}.`];
    if (this.purpose === 'campaign' && !html.includes('$[LI:UNSUBSCRIBE]$')) out.push('No unsubscribe link yet: Zoho requires $[LI:UNSUBSCRIBE]$.');
    if (/<img\b[^>]*\bsrc\s*=\s*["']?http:\/\//i.test(html)) out.push('Some images use http://. Use https:// image URLs so they load for recipients.');
    return out;
  }
}
