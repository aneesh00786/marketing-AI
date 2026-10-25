import { Component, EventEmitter, HostListener, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { apiRoot } from '../../core/api-base';

export type TemplateUseTarget = 'email' | 'campaign' | 'draft';

/**
 * Mail Center → Email Templates: list/search, create (blank, .html/.htm, .zip), preview,
 * edit, duplicate, delete, and "use in" email/campaign/draft. Uploaded HTML is sanitized by the
 * server and only ever rendered inside a sandboxed iframe. Nothing is saved until "Save".
 */
@Component({
  selector: 'app-email-templates',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './email-templates.component.html',
  styleUrls: ['../command/command-center.component.css', './email-templates.component.css']
})
export class EmailTemplatesComponent implements OnInit {
  @Output() toast = new EventEmitter<string>();
  @Output() use = new EventEmitter<{ template: any; target: TemplateUseTarget }>();

  private base = `${apiRoot()}/api/v1/mail/templates`;
  // List
  templates: any[] = [];
  total = 0;
  page = 1;
  pageSize = 12;
  q = '';
  category = '';
  categories: string[] = [];
  tokens: string[] = [];
  canCompose = false;
  permissionsLoaded = false;
  limits = { htmlKb: 1024, zipMb: 10 };
  showCreateMenu = false;
  private searchTimer: any = null;
  // Upload / entry choice
  busy = '';
  error = '';
  pendingUpload: { file: File; entries: string[] } | null = null;
  // Editor (a working copy; the saved template changes only on Save)
  editing: any = null;
  original = '';
  viewport: 'desktop' | 'mobile' = 'desktop';

  constructor(private http: HttpClient, private sanitizer: DomSanitizer) {}

  ngOnInit(): void {
    // Permissions come from the template API itself (not from any other module's status).
    this.http.get<any>(`${this.base}/categories`).subscribe({
      next: r => {
        this.categories = r.categories; this.tokens = r.tokens;
        this.canCompose = !!r.canManage; this.permissionsLoaded = true;
        if (r.limits) this.limits = r.limits;
      },
      error: e => { this.permissionsLoaded = true; this.error = `Could not load template settings: ${this.err(e)}`; }
    });
    this.load();
  }

  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(e: BeforeUnloadEvent): void {
    if (this.dirty) { e.preventDefault(); e.returnValue = ''; }
  }

  get tokenList(): string { return this.tokens.map(t => `{{${t}}}`).join(', '); }
  get pages(): number { return Math.max(1, Math.ceil(this.total / this.pageSize)); }
  get dirty(): boolean { return !!this.editing && JSON.stringify(this.snapshot()) !== this.original; }
  get previewHtml(): SafeHtml {
    // Rendered only inside <iframe sandbox="">: no scripts, no access to the app, cookies or tokens.
    return this.sanitizer.bypassSecurityTrustHtml(this.editing?.html || '');
  }

  private snapshot(): any {
    const e = this.editing || {};
    return [e.name, e.description, e.category, e.html];
  }

  // ---------------------------------------------------------------- list

  load(): void {
    const params: any = { page: String(this.page), pageSize: String(this.pageSize) };
    if (this.q.trim()) params.q = this.q.trim();
    if (this.category) params.category = this.category;
    this.http.get<any>(this.base, { params }).subscribe({
      next: r => { this.templates = r.templates; this.total = r.total; this.error = ''; },
      error: e => this.error = this.err(e)
    });
  }

  search(): void {
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => { this.page = 1; this.load(); }, 250);
  }

  go(p: number): void {
    this.page = Math.min(Math.max(1, p), this.pages);
    this.load();
  }

  // ---------------------------------------------------------------- create / import

  newBlank(): void {
    this.showCreateMenu = false;
    if (!this.confirmDiscard()) return;
    this.startEditing({ id: null, name: 'Untitled template', description: '', category: 'Custom', source: 'blank', version: null,
      html: '<!doctype html>\n<html>\n<body style="margin:0;padding:0;">\n<table role="presentation" width="100%" cellpadding="0" cellspacing="0">\n  <tr><td style="padding:24px;font-family:Arial,sans-serif;">\n    <p>Hello {{first_name}},</p>\n    <p></p>\n    <p><a href="$[LI:UNSUBSCRIBE]$">Unsubscribe</a></p>\n  </td></tr>\n</table>\n</body>\n</html>',
      warnings: [], placeholders: [] });
  }

  /** kind: 'html' (.html/.htm), 'zip' (.zip package with HTML, CSS and images) or 'any'. */
  onFile(ev: Event, kind: 'html' | 'zip' | 'any' = 'any'): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    this.showCreateMenu = false;
    if (!file) return;
    // By extension, or by type for HTML files saved without one (the server checks the content again).
    const isHtml = /\.html?$/i.test(file.name) || file.type === 'text/html';
    const isZip = /\.zip$/i.test(file.name);
    const ok = kind === 'zip' ? isZip : kind === 'html' ? isHtml : (isHtml || isZip);
    if (!ok) { this.toast.emit(kind === 'zip' ? 'Choose a .zip package.' : kind === 'html' ? 'Choose an .html or .htm file.' : 'Choose an .html, .htm or .zip file.'); return; }
    if (!this.confirmDiscard()) return;
    this.upload(file);
  }

  upload(file: File, entry?: string): void {
    this.busy = 'upload';
    this.error = '';
    const params: any = { filename: file.name };
    if (entry) params.entry = entry;
    this.http.post<any>(`${this.base}/import`, file, { params, headers: { 'Content-Type': 'application/octet-stream' } }).subscribe({
      next: r => {
        this.busy = '';
        if (r.needsEntry) { this.pendingUpload = { file, entries: r.entries }; return; }
        this.pendingUpload = null;
        this.startEditing({ id: null, name: r.suggestedName, description: '', category: /\.zip$/i.test(file.name) ? 'Newsletter' : 'Custom',
          source: r.source, sourceFilename: r.sourceFilename, importId: r.importId, version: null, html: r.html, warnings: r.warnings, placeholders: r.placeholders });
        this.toast.emit('Preview ready. Review it, then Save to add it to your templates.');
      },
      error: e => { this.busy = ''; this.error = this.err(e); }
    });
  }

  // ---------------------------------------------------------------- edit

  open(t: any): void {
    if (!this.confirmDiscard()) return;
    this.http.get<any>(`${this.base}/${t.id}`).subscribe({
      next: r => this.startEditing({ ...r.template }),
      error: e => this.toast.emit(this.err(e))
    });
  }

  private startEditing(t: any): void {
    this.editing = t;
    this.original = JSON.stringify(this.snapshot());
  }

  validate(): void {
    this.busy = 'validate';
    this.http.post<any>(`${this.base}/analyze`, { html: this.editing.html }).subscribe({
      next: r => { this.busy = ''; this.editing.warnings = r.warnings; this.editing.placeholders = r.placeholders; this.editing.sanitized = r.html; },
      error: e => { this.busy = ''; this.toast.emit(this.err(e)); }
    });
  }

  save(): void {
    const e = this.editing;
    this.busy = 'save';
    const body: any = { name: e.name, description: e.description || null, category: e.category || 'Custom', html: e.html };
    const req = e.id
      ? this.http.patch<any>(`${this.base}/${e.id}`, { ...body, version: e.version })
      : this.http.post<any>(this.base, { ...body, source: e.source || 'blank', sourceFilename: e.sourceFilename || null, importId: e.importId || null });
    req.subscribe({
      next: r => { this.busy = ''; this.startEditing({ ...r.template }); this.toast.emit('Template saved.'); this.load(); this.refreshCategories(); },
      error: err => { this.busy = ''; this.toast.emit(this.err(err)); }
    });
  }

  cancel(): void {
    if (!this.confirmDiscard()) return;
    this.editing = null;
    this.original = '';
  }

  /** True when there is nothing unsaved, or the user agrees to discard it. */
  confirmDiscard(): boolean {
    return !this.dirty || confirm('Discard your unsaved changes to this template?');
  }

  duplicate(t: any): void {
    this.http.post<any>(`${this.base}/${t.id}/duplicate`, {}).subscribe({
      next: () => { this.toast.emit('Template duplicated.'); this.load(); },
      error: e => this.toast.emit(this.err(e))
    });
  }

  remove(t: any): void {
    if (!confirm(`Delete the template "${t.name}"? Emails and campaigns already made from it are not affected.`)) return;
    this.http.delete<any>(`${this.base}/${t.id}`).subscribe({
      next: () => { if (this.editing?.id === t.id) { this.editing = null; this.original = ''; } this.toast.emit('Template deleted.'); this.load(); },
      error: e => this.toast.emit(this.err(e))
    });
  }

  useIn(target: TemplateUseTarget): void {
    if (this.dirty) { this.toast.emit('Save the template first (or cancel your changes) to use it.'); return; }
    this.use.emit({ template: this.editing, target });
  }

  private refreshCategories(): void {
    this.http.get<any>(`${this.base}/categories`).subscribe({ next: r => this.categories = r.categories });
  }

  private err(e: any): string {
    return e?.error?.error || e?.message || 'Request failed.';
  }
}
