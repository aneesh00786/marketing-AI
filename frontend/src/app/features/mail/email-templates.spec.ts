import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { EmailTemplatesComponent } from './email-templates.component';
import { TemplatePickerComponent } from './template-picker.component';
import { findTokens, fillTokens, defaultTokenValues } from './template-utils';
import { apiRoot } from '../../core/api-base';

const BASE = `${apiRoot()}/api/v1/mail/templates`;
const HOSTILE = '<p id="tpl-content">Hello</p><img src="x" onerror="window.__pwned = true"><script>window.__pwned = true</script>';

describe('template utils', () => {
  it('finds tokens and fills them with escaped values, leaving unfilled ones', () => {
    const html = '<p>Hi {{first_name}} from {{ company }} and {{other}}</p>';
    expect(findTokens(html)).toEqual(['first_name', 'company', 'other']);
    const out = fillTokens(html, { first_name: 'Ann <b>', company: 'A&B "Co"' });
    expect(out).toBe('<p>Hi Ann &lt;b&gt; from A&amp;B &quot;Co&quot; and {{other}}</p>');
    expect(defaultTokenValues(['first_name', 'company'], 'Dana Smith')).toEqual({ first_name: 'Dana', company: '' });
  });
});

describe('EmailTemplatesComponent', () => {
  let fixture: ComponentFixture<EmailTemplatesComponent>;
  let comp: EmailTemplatesComponent;
  let http: HttpTestingController;

  function init(canCompose = true): void {
    fixture = TestBed.createComponent(EmailTemplatesComponent);
    comp = fixture.componentInstance;
    fixture.detectChanges();
    http.expectNone(`${apiRoot()}/api/v1/mail/zoho/status`); // permissions no longer depend on Zoho
    http.expectOne(`${BASE}/categories`).flush({ categories: ['Newsletter', 'Custom'], tokens: ['first_name', 'company'], canManage: canCompose, limits: { htmlKb: 1024, zipMb: 10 } });
    http.expectOne(r => r.url === BASE).flush({ templates: [{ id: 7, name: 'Welcome', category: 'Welcome', source: 'zip', updatedAt: '2026-10-01T00:00:00Z' }], total: 1, page: 1, pageSize: 12 });
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [EmailTemplatesComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    delete (window as any).__pwned;
  });
  afterEach(() => http.verify());

  it('previews template HTML only inside a sandboxed iframe; nothing runs in the app', () => {
    init();
    comp.open({ id: 7 });
    http.expectOne(`${BASE}/7`).flush({ template: { id: 7, name: 'Welcome', category: 'Welcome', version: 1, html: HOSTILE, warnings: [], placeholders: [] } });
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const frame = el.querySelector('iframe') as HTMLIFrameElement;
    expect(frame).toBeTruthy();
    expect(frame.getAttribute('sandbox')).toBe('', 'no allow-scripts / allow-same-origin');
    expect(frame.getAttribute('srcdoc')).toContain('tpl-content');
    // The template is not part of the application's DOM, and none of its code ran.
    expect(el.querySelector('#tpl-content')).toBeNull();
    expect(el.querySelector('img[onerror]')).toBeNull();
    expect((window as any).__pwned).toBeUndefined();
  });

  it('protects unsaved changes and does not save without "Save"', () => {
    init();
    comp.newBlank();
    expect(comp.dirty).toBeFalse();
    comp.editing.html = '<p>Changed</p>';
    expect(comp.dirty).toBeTrue();
    const confirmSpy = spyOn(window, 'confirm').and.returnValue(false);
    comp.cancel();
    expect(confirmSpy).toHaveBeenCalled();
    expect(comp.editing).not.toBeNull('kept when the user declines to discard');
    confirmSpy.and.returnValue(true);
    comp.cancel();
    expect(comp.editing).toBeNull();
    http.expectNone(r => r.method === 'POST' || r.method === 'PATCH');
  });

  it('uploads a ZIP, asks for the entry point when several HTML files exist, then previews unsaved', () => {
    init();
    const file = new File(['PK'], 'pack.zip', { type: 'application/zip' });
    comp.upload(file);
    const first = http.expectOne(r => r.url === `${BASE}/import`);
    expect(first.request.params.get('filename')).toBe('pack.zip');
    first.flush({ needsEntry: true, entries: ['a.html', 'b.html'] });
    fixture.detectChanges();
    expect(comp.pendingUpload?.entries).toEqual(['a.html', 'b.html']);
    comp.upload(file, 'b.html');
    const second = http.expectOne(r => r.url === `${BASE}/import`);
    expect(second.request.params.get('entry')).toBe('b.html');
    second.flush({ needsEntry: false, suggestedName: 'pack', source: 'zip', sourceFilename: 'pack.zip', importId: 'a'.repeat(32), html: '<p>B</p>', warnings: ['Removed 1 <script> element(s)'], placeholders: [] });
    fixture.detectChanges();
    expect(comp.editing.id).toBeNull();
    expect(comp.editing.importId).toBe('a'.repeat(32));
    expect(fixture.nativeElement.textContent).toContain('Removed 1 <script> element(s)');
    comp.save();
    const save = http.expectOne(r => r.method === 'POST' && r.url === BASE);
    expect(save.request.body.importId).toBe('a'.repeat(32));
    expect(save.request.body.source).toBe('zip');
    save.flush({ template: { id: 9, name: 'pack', version: 1, html: '<p>B</p>', warnings: [], placeholders: [] } });
    http.expectOne(r => r.url === BASE && r.method === 'GET').flush({ templates: [], total: 0 });
    http.expectOne(`${BASE}/categories`).flush({ categories: [] });
  });

  it('edits send the version (no silent overwrite) and delete asks for confirmation', () => {
    init();
    comp.open({ id: 7 });
    http.expectOne(`${BASE}/7`).flush({ template: { id: 7, name: 'Welcome', category: 'Welcome', version: 3, html: '<p>x</p>', warnings: [], placeholders: [] } });
    comp.editing.name = 'Welcome v2';
    comp.save();
    const patch = http.expectOne(r => r.method === 'PATCH');
    expect(patch.request.body.version).toBe(3);
    patch.flush({ template: { id: 7, name: 'Welcome v2', version: 4, html: '<p>x</p>' } });
    http.expectOne(r => r.url === BASE && r.method === 'GET').flush({ templates: [], total: 0 });
    http.expectOne(`${BASE}/categories`).flush({ categories: [] });

    spyOn(window, 'confirm').and.returnValue(false);
    comp.remove({ id: 7, name: 'Welcome v2' });
    http.expectNone(r => r.method === 'DELETE');
  });

  it('accepts an HTML file chosen through "Upload HTML file" (including .htm and files typed text/html)', () => {
    init();
    const fake = (file: File) => ({ target: { files: [file], value: 'x' } } as any as Event);
    comp.onFile(fake(new File(['<p>Hello</p>'], 'promo.HTM', { type: 'text/html' })), 'html');
    const req = http.expectOne(r => r.url === `${BASE}/import`);
    expect(req.request.params.get('filename')).toBe('promo.HTM');
    req.flush({ needsEntry: false, suggestedName: 'promo', source: 'html', sourceFilename: 'promo.HTM', importId: null, html: '<p>Hello</p>', warnings: [], placeholders: [] });
    expect(comp.editing.source).toBe('html');
  });

  it('shows the empty-state upload buttons, which open the file pickers', () => {
    init();
    comp.templates = [];
    fixture.detectChanges();
    const opened: string[] = [];
    spyOn(HTMLInputElement.prototype, 'click').and.callFake(function (this: HTMLInputElement) { opened.push(this.id); });
    const btn = Array.from(fixture.nativeElement.querySelectorAll('.empty button') as NodeListOf<HTMLButtonElement>).find(b => /Upload an HTML file/.test(b.textContent || ''))!;
    btn.click();
    expect(opened).toEqual(['tplUploadHtml']);
  });

  it('hides write controls for members without mail.compose, and says why', () => {
    init(false);
    const text = fixture.nativeElement.textContent;
    expect(text).not.toContain('Create / Import template');
    expect(text).not.toContain('Duplicate');
    expect(text).toContain('needs the Member role or higher');
  });

  it('offers Create / Import → Upload ZIP package, with a ZIP-only file picker wired to the importer', () => {
    init();
    const el: HTMLElement = fixture.nativeElement;
    const toggle = Array.from(el.querySelectorAll('button')).find(b => /Create \/ Import template/.test(b.textContent || '')) as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    toggle.click();
    fixture.detectChanges();
    const items = Array.from(el.querySelectorAll('.menu-item')).map(i => i.textContent || '');
    expect(items.some(t => t.includes('Blank template'))).toBeTrue();
    expect(items.some(t => t.includes('Upload HTML file'))).toBeTrue();
    expect(items.some(t => t.includes('Upload ZIP package') && t.includes('10 MB'))).toBeTrue();
    const zipInput = el.querySelector('#tplUploadZip') as HTMLInputElement;
    const htmlInput = el.querySelector('#tplUploadHtml') as HTMLInputElement;
    expect(zipInput.type).toBe('file');
    expect(zipInput.accept).toBe('.zip');
    expect(htmlInput.accept).toBe('.html,.htm', 'extensions only, so .html files are never greyed out');
    // Inputs are visually hidden, not display:none, and the menu buttons open them.
    expect(getComputedStyle(htmlInput).display).not.toBe('none');
    expect(htmlInput.hasAttribute('hidden')).toBeFalse();
    const opened: string[] = [];
    spyOn(HTMLInputElement.prototype, 'click').and.callFake(function (this: HTMLInputElement) { opened.push(this.id); });
    const menuButtons = Array.from(el.querySelectorAll('button.menu-item')) as HTMLButtonElement[];
    menuButtons.find(b => /Upload HTML file/.test(b.textContent || ''))!.click();
    menuButtons.find(b => /Upload ZIP package/.test(b.textContent || ''))!.click();
    expect(opened).toEqual(['tplUploadHtml', 'tplUploadZip']);

    // Choosing a non-ZIP file in the ZIP picker is refused; a .zip goes to the importer.
    let toastMsg = '';
    comp.toast.subscribe(m => toastMsg = m);
    const fake = (file: File) => ({ target: { files: [file], value: 'x' } } as any as Event);
    comp.onFile(fake(new File(['<p>x</p>'], 'page.html')), 'zip');
    expect(toastMsg).toBe('Choose a .zip package.');
    http.expectNone(r => r.url === `${BASE}/import`);
    comp.onFile(fake(new File(['PK'], 'newsletter.zip')), 'zip');
    const req = http.expectOne(r => r.url === `${BASE}/import`);
    expect(req.request.params.get('filename')).toBe('newsletter.zip');
    req.flush({ needsEntry: false, suggestedName: 'newsletter', source: 'zip', sourceFilename: 'newsletter.zip', importId: 'b'.repeat(32), html: '<p>ok</p>', warnings: [], placeholders: [] });
    expect(comp.editing.source).toBe('zip');
    expect(comp.editing.id).toBeNull('a preview, not saved yet');
  });
});

describe('TemplatePickerComponent', () => {
  it('previews in a sandboxed iframe and emits the chosen template', () => {
    TestBed.configureTestingModule({ imports: [TemplatePickerComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(TemplatePickerComponent);
    const comp = fixture.componentInstance;
    let picked: any = null;
    comp.picked.subscribe(t => picked = t);
    fixture.detectChanges();
    http.expectOne(r => r.url === BASE).flush({ templates: [{ id: 1, name: 'Promo', category: 'Promotion' }] });
    comp.preview({ id: 1 });
    http.expectOne(`${BASE}/1`).flush({ template: { id: 1, name: 'Promo', html: HOSTILE, placeholders: ['{{first_name}}'] } });
    fixture.detectChanges();
    const frame = fixture.nativeElement.querySelector('iframe');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(fixture.nativeElement.querySelector('#tpl-content')).toBeNull();
    (fixture.nativeElement.querySelector('.modal-footer .btn-primary') as HTMLButtonElement).click();
    expect(picked.id).toBe(1);
    http.verify();
  });
});
