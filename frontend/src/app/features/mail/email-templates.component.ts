import { Component, EventEmitter, HostListener, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IconComponent } from '../../shared/icon.component';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { apiRoot } from '../../core/api-base';
import { EmailPreviewComponent } from './email-preview.component';
import { EmailContentEditorComponent } from './email-content-editor.component';
import { TemplatePickerComponent } from './template-picker.component';

export type TemplateUseTarget = 'email' | 'campaign' | 'draft';

/**
 * Mail Center → Email Templates: list (search, category, sort, thumbnails), create (blank,
 * .html/.htm, .zip), edit in the shared Email content editor (Visual / HTML / Preview), duplicate,
 * delete, and "use in" email/campaign/draft. Uploaded HTML is sanitized by the
 * server and only ever rendered inside a sandboxed iframe. Nothing is saved until "Save".
 */
@Component({
  selector: 'app-email-templates',
  standalone: true,
  imports: [CommonModule, IconComponent, FormsModule, EmailPreviewComponent, EmailContentEditorComponent, TemplatePickerComponent],
  templateUrl: './email-templates.component.html',
  styleUrls: ['../command/command-center.component.css', './mail-ui.css', './email-templates.component.css']
})
export class EmailTemplatesComponent implements OnInit {
  /** Open straight into a new blank template (Campaigns → New Campaign → "New email template"). */
  @Input() startNew = false;
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
  /** Changes for every template opened, so the content editor starts again in Edit → Visual. */
  editKey = '';
  private editSeq = 0;
  sort: 'newest' | 'oldest' | 'name' = 'newest';
  menuFor: number | null = null;
  /** "Choose template" in the editor: load a copy of another template's HTML. */
  picker = false;
  zipInfoOpen = true;

  constructor(private http: HttpClient) {}

  ngOnInit(): void {
    if (this.startNew) this.newBlank();
    // On phones the ZIP explanation starts folded so the list is visible straight away.
    try { this.zipInfoOpen = !(window.innerWidth < 700); } catch { /* no window */ }
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

  private snapshot(): any {
    const e = this.editing || {};
    return [e.name, e.description, e.category, e.html];
  }

  // ---------------------------------------------------------------- list

  load(): void {
    // thumbs=1: the start of each template's HTML for the list thumbnails (capped by the server).
    const params: any = { page: String(this.page), pageSize: String(this.pageSize), sort: this.sort, thumbs: '1' };
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

  // ---------- Create with AI ----------
  readonly aiTypes = ['Promotion', 'Newsletter', 'Announcement', 'Welcome', 'Follow-up'];
  readonly aiTones = ['Friendly', 'Professional', 'Persuasive', 'Formal', 'Playful'];
  readonly aiLanguages = ['English', 'Hindi', 'Malayalam', 'Tamil', 'Arabic', 'Spanish', 'French', 'German', 'Portuguese', 'Italian', 'Chinese', 'Japanese'];
  readonly aiTabs = [{ key: 'content', label: 'Content' }, { key: 'design', label: 'Design' }, { key: 'sections', label: 'Sections' }, { key: 'branding', label: 'Branding' }];
  readonly aiStyles = [
    { key: 'modern', label: 'Modern', help: 'Colour banner, cards' },
    { key: 'minimal', label: 'Minimal', help: 'Clean and text-led' },
    { key: 'corporate', label: 'Corporate', help: 'Formal, structured' },
    { key: 'newsletter', label: 'Newsletter', help: 'Articles with pictures' },
    { key: 'bold', label: 'Bold promo', help: 'Big headline and offer' }
  ];
  readonly aiSections = [
    { key: 'features', label: 'Feature cards', help: 'Key benefits with icons' },
    { key: 'products', label: 'Product grid', help: 'Products or services, with pictures' },
    { key: 'stats', label: 'Numbers row', help: 'Key figures, e.g. customers, years' },
    { key: 'testimonial', label: 'Testimonial', help: 'A customer quote' },
    { key: 'steps', label: 'How it works', help: 'Numbered steps' },
    { key: 'faq', label: 'FAQ', help: 'Common questions and answers' },
    { key: 'event', label: 'Event details', help: 'Date, time and place' },
    { key: 'comparison', label: 'Comparison', help: 'Without us vs with us' },
    { key: 'secondCta', label: 'Second call to action', help: 'E.g. book a demo' }
  ];
  readonly aiSocials = [
    { key: 'website', label: 'Website', placeholder: 'https://yourcompany.com' },
    { key: 'linkedin', label: 'LinkedIn', placeholder: 'https://linkedin.com/company/…' },
    { key: 'facebook', label: 'Facebook', placeholder: 'https://facebook.com/…' },
    { key: 'instagram', label: 'Instagram', placeholder: 'https://instagram.com/…' },
    { key: 'x', label: 'X', placeholder: 'https://x.com/…' },
    { key: 'youtube', label: 'YouTube', placeholder: 'https://youtube.com/…' },
    { key: 'tiktok', label: 'TikTok', placeholder: 'https://tiktok.com/@…' }
  ];
  ai: {
    tab: string; prompt: string; url: string; type: string; tone: string; color: string; pictures: boolean;
    style: string; theme: string; font: string; buttonShape: string; sections: Set<string>;
    length: string; audience: string; language: string; ctaUrl: string;
    logo: { id: string; url: string } | null; uploading: boolean; socials: Record<string, string>; address: string; importId: string;
    busy: boolean; error: string; result: any; runs: number;
  } | null = null;

  openAi(): void {
    this.showCreateMenu = false;
    const rnd = new Uint8Array(16);
    crypto.getRandomValues(rnd);
    this.ai = {
      tab: 'content', prompt: '', url: '', type: 'Promotion', tone: 'Friendly', color: '', pictures: true,
      style: 'modern', theme: 'light', font: 'sans', buttonShape: 'rounded', sections: new Set(['features']),
      length: 'medium', audience: '', language: 'English', ctaUrl: '',
      logo: null, uploading: false, socials: {}, address: '', importId: Array.from(rnd, b => b.toString(16).padStart(2, '0')).join(''),
      busy: false, error: '', result: null, runs: 0
    };
  }

  closeAi(): void { if (!this.ai?.busy) this.ai = null; }

  toggleAiSection(key: string): void { const s = this.ai?.sections; if (s) s.has(key) ? s.delete(key) : s.add(key); }

  private static https(v: string): boolean { return !v.trim() || /^https:\/\/[^\s"'<>]+\.[^\s"'<>]+$/i.test(v.trim()); }

  get aiProblem(): string {
    const a = this.ai;
    if (!a) return '';
    if (!a.prompt.trim() && !a.url.trim()) return 'Describe the email, or give a website link (Content).';
    if (a.color && !/^#[0-9a-fA-F]{6}$/.test(a.color.trim())) return 'Use a colour like #4f46e5, or leave it empty (Design).';
    if (!EmailTemplatesComponent.https(a.ctaUrl)) return 'The button link must start with https:// (Content).';
    const bad = this.aiSocials.find(so => !EmailTemplatesComponent.https(a.socials[so.key] || ''));
    if (bad) return `The ${bad.label} link must start with https:// (Branding).`;
    return '';
  }

  /** "Modern · Light · 3 sections" under the form. */
  get aiSummary(): string {
    const a = this.ai;
    if (!a) return '';
    const st = this.aiStyles.find(x => x.key === a.style)?.label;
    return `${st} · ${a.theme === 'dark' ? 'Dark' : 'Light'} · ${a.sections.size} extra section${a.sections.size === 1 ? '' : 's'}${a.logo ? ' · your logo' : ''}`;
  }

  uploadAiLogo(ev: Event): void {
    const a = this.ai;
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!a || !file) return;
    if (file.size > 1024 * 1024) { a.error = 'The logo must be 1 MB or smaller.'; return; }
    a.uploading = true; a.error = '';
    this.http.post<any>(`${this.base}/ai-logo`, file, { params: { importId: a.importId }, headers: { 'Content-Type': file.type || 'application/octet-stream' } }).subscribe({
      next: r => { a.uploading = false; a.logo = { id: r.id, url: r.url }; },
      error: err => { a.uploading = false; a.error = this.err(err); }
    });
  }

  /** "1 from your website, 1 stock photo", or why there are none. */
  aiPicturesText(r: any): string {
    const i = r?.images;
    if (!i) return '';
    const parts = [i.website && `${i.website} from your website`, i.stock && `${i.stock} stock photo${i.stock > 1 ? 's' : ''}`].filter(Boolean);
    if (parts.length) return parts.join(', ');
    return i.stockAvailable ? 'None suitable found: a colour banner is used' : 'None found: a colour banner is used (add PIXABAY_API_KEY for stock photos)';
  }

  /** How many [bracketed] parts the person still has to fill in. */
  aiPlaceholders(html: string): number {
    const visible = String(html || '').replace(/<(style|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\$\[[^\]]+\]\$/g, ' ');
    return new Set(visible.match(/\[[^\[\]{}<>\n]{1,160}\]/g) || []).size;
  }

  generateAi(): void {
    const a = this.ai;
    if (!a || a.busy || a.uploading || this.aiProblem) return;
    a.busy = true; a.error = '';
    const socials = Object.fromEntries(Object.entries(a.socials).map(([k, v]) => [k, String(v || '').trim()]).filter(([, v]) => v));
    const body = {
      prompt: a.prompt.trim(), url: a.url.trim(), type: a.type, tone: a.tone, brandColor: a.color.trim(), images: a.pictures,
      style: a.style, theme: a.theme, font: a.font, buttonShape: a.buttonShape, sections: [...a.sections],
      length: a.length, audience: a.audience.trim(), language: a.language, ctaUrl: a.ctaUrl.trim(),
      logoAssetId: a.logo?.id || '', importId: a.importId, socials, address: a.address.trim()
    };
    this.http.post<any>(`${this.base}/generate`, body).subscribe({
      next: r => { a.busy = false; a.result = r; a.runs++; },
      error: err => { a.busy = false; a.error = this.err(err); }
    });
  }

  /** Opens the generated template in the editor (not saved until Save). */
  useAi(): void {
    const r = this.ai?.result;
    if (!r || !this.confirmDiscard()) return;
    this.ai = null;
    // importId: the pictures and logo stored for this preview become the template's when it is saved.
    this.startEditing({ id: null, name: r.name || 'AI template', description: `Subject: ${r.subject}`, category: r.category || 'Custom', source: 'ai', version: null,
      html: r.html, importId: r.importId || null, warnings: [], placeholders: [] });
    this.toast.emit('Template created. Fill in the [placeholders], then Save.');
  }

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
    this.editKey = `${t.id ?? 'new'}:${++this.editSeq}`;
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

  // ---------------------------------------------------------------- list helpers

  toggleCreateMenu(ev: Event): void { ev.stopPropagation(); this.showCreateMenu = !this.showCreateMenu; this.menuFor = null; }
  toggleMenu(id: number, ev: Event): void { ev.stopPropagation(); this.menuFor = this.menuFor === id ? null : id; this.showCreateMenu = false; }
  toggleZipInfo(): void { this.zipInfoOpen = !this.zipInfoOpen; }

  @HostListener('document:click') closeMenus(): void { this.menuFor = null; this.showCreateMenu = false; }
  @HostListener('document:keydown.escape') escMenus(): void { this.menuFor = null; this.showCreateMenu = false; this.closeAi(); }

  /** Tag tone by category: transactional/welcome, marketing kinds, everything else. */
  tone(category: string): string {
    const c = String(category || '').toLowerCase();
    if (['transactional', 'welcome'].includes(c)) return 'good';
    if (['newsletter', 'promotion', 'announcement', 'marketing'].includes(c)) return 'warn';
    return 'info';
  }

  sourceLabel(t: any): string {
    if (t.source === 'ai') return 'Created with AI';
    return t.source === 'zip' ? `Imported ZIP${t.sourceFilename ? ' · ' + t.sourceFilename : ''}` : t.source === 'html' ? `Uploaded HTML${t.sourceFilename ? ' · ' + t.sourceFilename : ''}` : 'Created here';
  }

  /** The category list, including a custom category already on this template. */
  get categoryOptions(): string[] {
    const c = this.editing?.category;
    return c && !this.categories.includes(c) ? [...this.categories, c] : this.categories;
  }

  /** "Use in …" from the list: the full template is loaded first (the list has no HTML). */
  useTemplate(t: any, target: TemplateUseTarget): void {
    if (this.editing?.id === t.id) { this.useIn(target); return; }
    this.http.get<any>(`${this.base}/${t.id}`).subscribe({
      next: r => this.use.emit({ template: r.template, target }),
      error: e => this.toast.emit(this.err(e))
    });
  }

  /** "Choose template" in the editor replaces this template's HTML with a copy (not saved until Save). */
  onTemplatePicked(t: any): void {
    this.picker = false;
    if (!this.editing || !t?.html) return;
    if ((this.editing.html || '').trim() && !confirm(`Replace this template's content with a copy of "${t.name}"?`)) return;
    this.editing.html = t.html;
    this.toast.emit(`Loaded a copy of "${t.name}". Review it, then Save.`);
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
