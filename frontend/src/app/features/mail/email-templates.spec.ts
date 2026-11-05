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
    const list = http.expectOne(r => r.url === BASE);
    expect(list.request.params.get('thumbs')).withContext('thumbnails requested').toBe('1');
    expect(list.request.params.get('sort')).toBe('newest');
    list.flush({ templates: [{ id: 7, name: 'Welcome', category: 'Welcome', source: 'zip', updatedAt: '2026-10-01T00:00:00Z', version: 1, thumbHtml: '<p>Welcome</p>' }], total: 1, page: 1, pageSize: 12 });
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [EmailTemplatesComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    delete (window as any).__pwned;
  });
  afterEach(() => http.verify());

  it('startNew (from Campaigns → New email template) opens a new, unsaved blank template', () => {
    fixture = TestBed.createComponent(EmailTemplatesComponent);
    comp = fixture.componentInstance;
    comp.startNew = true;
    fixture.detectChanges();
    http.expectOne(`${BASE}/categories`).flush({ categories: ['Custom'], tokens: [], canManage: true, limits: { htmlKb: 1024, zipMb: 10 } });
    http.expectOne(r => r.url === BASE).flush({ templates: [], total: 0, page: 1, pageSize: 12 });
    fixture.detectChanges();
    expect(comp.editing).toBeTruthy();
    expect(comp.editing.id).withContext('not saved until the user clicks Save').toBeNull();
    expect(comp.editing.name).toBe('Untitled template');
    http.expectNone(r => r.method === 'POST');
  });

  it('Create with AI: needs a description or link; previews the result in a sandbox; Use opens it unsaved in the editor', () => {
    init();
    const el: HTMLElement = fixture.nativeElement;
    const buttonsNamed = (t: string) => Array.from(el.querySelectorAll('button')).filter(b => b.textContent!.includes(t));
    expect(buttonsNamed('Create with AI').length).withContext('only inside the Create Template menu').toBe(0);
    expect(buttonsNamed('Import from ZIP').length).withContext('duplicate of Upload ZIP package').toBe(0);
    expect(buttonsNamed('New template').length).withContext('duplicate of Blank template').toBe(0);
    buttonsNamed('Create Template')[0].click();
    fixture.detectChanges();
    buttonsNamed('Create with AI')[0].click();
    fixture.detectChanges();
    const dlg = () => el.querySelector('.tpl-ai') as HTMLElement;
    expect(dlg().textContent).toContain('Describe the email, or give a website link (Content).');
    const go = () => dlg().querySelector('button[type=submit]') as HTMLButtonElement;
    expect(go().disabled).toBeTrue();
    comp.ai!.url = 'brightcart.com';
    comp.ai!.color = 'red';
    fixture.detectChanges();
    expect(comp.aiProblem).toContain('#4f46e5');
    comp.ai!.color = '#0f766e';
    comp.ai!.prompt = 'Promote boxes';
    fixture.detectChanges();
    go().click();
    const req = http.expectOne(r => r.method === 'POST' && r.url === `${BASE}/generate`);
    expect(req.request.body).toEqual(jasmine.objectContaining({ prompt: 'Promote boxes', url: 'brightcart.com', type: 'Promotion', tone: 'Friendly', brandColor: '#0f766e', images: true,
      style: 'modern', theme: 'light', font: 'sans', buttonShape: 'rounded', sections: ['features'], length: 'medium', language: 'English', logoAssetId: '', socials: {} }));
    expect(req.request.body.importId).toMatch(/^[a-f0-9]{32}$/);
    req.flush({ name: 'Boxes promo', subject: 'Packaging they can compost', category: 'Promotion', provider: 'OpenAI',
      html: '<p>Hi {{first_name}}, save [Discount] by [Offer end date]. $[LI:UNSUBSCRIBE]$ [Discount]</p><script>window.__pwned = 1</script>',
      importId: 'a'.repeat(32), images: { website: 1, stock: 1, stockAvailable: true },
      website: { url: 'https://brightcart.com/', title: 'BrightCart', logo: true, color: '#0f766e' } });
    fixture.detectChanges();
    expect(dlg().textContent).toContain('Packaging they can compost');
    expect(dlg().textContent).toContain('2 placeholder(s)');
    expect(dlg().textContent).toContain('1 from your website, 1 stock photo');
    expect(go().textContent).toContain('Regenerate');
    const frame = dlg().querySelector('app-email-preview iframe') as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect((window as any).__pwned).toBeUndefined();
    (Array.from(dlg().querySelectorAll('button')).find(b => b.textContent!.includes('Use this template')) as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(comp.ai).toBeNull();
    expect(comp.editing.id).withContext('not saved until Save').toBeNull();
    expect([comp.editing.name, comp.editing.category, comp.editing.source, comp.editing.description]).toEqual(['Boxes promo', 'Promotion', 'ai', 'Subject: Packaging they can compost']);
    expect(comp.editing.importId).withContext('the pictures are saved with the template').toBe('a'.repeat(32));
    http.expectNone(r => r.method === 'POST' && r.url === BASE);
  });

  it('Create with AI options: tabs for design, sections and branding; links must be https; the logo is uploaded with the preview', () => {
    init();
    comp.openAi();
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const tab = (label: string) => { (Array.from(el.querySelectorAll('.tpl-ai-tabs button')).find(b => b.textContent!.trim() === label) as HTMLButtonElement).click(); fixture.detectChanges(); };
    comp.ai!.prompt = 'Spring sale';
    tab('Design');
    (Array.from(el.querySelectorAll('.tpl-ai-styles button')).find(b => b.textContent!.includes('Bold promo')) as HTMLButtonElement).click();
    comp.ai!.theme = 'dark';
    tab('Sections');
    expect(el.querySelectorAll('.tpl-ai-sec').length).toBe(9);
    (Array.from(el.querySelectorAll('.tpl-ai-sec')).find(l => l.textContent!.includes('Testimonial'))!.querySelector('input') as HTMLInputElement).click();
    (Array.from(el.querySelectorAll('.tpl-ai-sec')).find(l => l.textContent!.includes('Feature cards'))!.querySelector('input') as HTMLInputElement).click();
    tab('Branding');
    comp.ai!.socials['linkedin'] = 'http://linkedin.com/x';
    fixture.detectChanges();
    expect(comp.aiProblem).toContain('LinkedIn link must start with https://');
    comp.ai!.socials['linkedin'] = 'https://linkedin.com/company/x';
    comp.ai!.address = 'Level 2, Sydney';
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', { type: 'image/png' });
    comp.uploadAiLogo({ target: { files: [file], value: 'x' } } as any);
    const up = http.expectOne(r => r.method === 'POST' && r.url === `${BASE}/ai-logo`);
    expect(up.request.params.get('importId')).toBe(comp.ai!.importId);
    up.flush({ id: 'L'.repeat(43), url: 'https://app/api/v1/mail/assets/' + 'L'.repeat(43) });
    fixture.detectChanges();
    expect((el.querySelector('.tpl-ai-logo img') as HTMLImageElement).src).toContain('L'.repeat(43));
    expect(comp.aiSummary).toBe('Bold promo · Dark · 1 extra section · your logo');
    comp.generateAi();
    const req = http.expectOne(`${BASE}/generate`);
    expect(req.request.body).toEqual(jasmine.objectContaining({ style: 'bold', theme: 'dark', sections: ['testimonial'], logoAssetId: 'L'.repeat(43), importId: comp.ai!.importId,
      socials: { linkedin: 'https://linkedin.com/company/x' }, address: 'Level 2, Sydney' }));
    req.flush({ error: 'x' }, { status: 503, statusText: 'x' });
  });

  it('Create with AI popup stays open on outside clicks and Escape; only the close button closes it; the description box shows a count', () => {
    init();
    comp.openAi();
    comp.ai!.prompt = 'Spring sale';
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    (el.querySelector('.tpl-ai-backdrop') as HTMLElement).click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(comp.ai).withContext('still open, nothing typed is lost').not.toBeNull();
    expect(el.querySelector('.tpl-ai-count')!.textContent).toContain('11 / 1,500');
    expect((el.querySelector('.tpl-ai-prompt') as HTMLTextAreaElement).rows).toBe(9);
    (el.querySelector('.tpl-ai .zc-close') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(comp.ai).toBeNull();
  });

  it('Create with AI shows the server\'s message when no AI model is set up', () => {
    init();
    comp.openAi();
    comp.ai!.prompt = 'Spring sale';
    comp.generateAi();
    http.expectOne(`${BASE}/generate`).flush({ error: 'No AI language model is configured or reachable.' }, { status: 503, statusText: 'x' });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.tpl-ai .note.error')!.textContent).toContain('No AI language model');
  });

  it('previews template HTML only inside a sandboxed iframe; nothing runs in the app', () => {
    init();
    comp.open({ id: 7 });
    http.expectOne(`${BASE}/7`).flush({ template: { id: 7, name: 'Welcome', category: 'Welcome', version: 1, html: HOSTILE, warnings: [], placeholders: [] } });
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    // Edit → Visual: the editing frame never allows scripts.
    const editing = el.querySelector('app-visual-html-editor iframe') as HTMLIFrameElement;
    expect(editing.getAttribute('sandbox')).toBe('allow-same-origin', 'no allow-scripts');
    (el.querySelector('#ec-mode-preview') as HTMLButtonElement).click();
    fixture.detectChanges();
    const frame = el.querySelector('.ec-preview iframe') as HTMLIFrameElement;
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
    expect(text).not.toContain('Create or import');
    expect(text).not.toContain('Duplicate');
    expect(text).toContain('needs the Member role or higher');
  });

  it('offers Create / Import → Upload ZIP package, with a ZIP-only file picker wired to the importer', () => {
    init();
    const el: HTMLElement = fixture.nativeElement;
    const toggle = Array.from(el.querySelectorAll('button')).find(b => /Create Template/.test(b.textContent || '')) as HTMLButtonElement;
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

  it('the list shows a sandboxed thumbnail, the category and the date; sorting reloads from the server', () => {
    init();
    const el: HTMLElement = fixture.nativeElement;
    const thumb = el.querySelector('.tpl-thumb iframe') as HTMLIFrameElement;
    expect(thumb.getAttribute('sandbox')).toBe('');
    expect(el.querySelector('.tpl-item')!.textContent).toContain('Welcome');
    comp.sort = 'name';
    comp.load();
    expect(http.expectOne(r => r.url === BASE).request.params.get('sort')).toBe('name');
  });

  it('the item menu offers Use in…, Duplicate and Delete; "Use in a new campaign" loads the full template first', () => {
    init();
    const el: HTMLElement = fixture.nativeElement;
    (el.querySelector('.tpl-kebab') as HTMLButtonElement).click();
    fixture.detectChanges();
    const items = Array.from(el.querySelectorAll('.tpl-menu button')).map(b => b.textContent!.trim());
    expect(items).toEqual(['Open', 'Use in a new email', 'Use in a new draft', 'Use in a new campaign', 'Duplicate', 'Delete']);
    const used: any[] = [];
    comp.use.subscribe(u => used.push(u));
    (Array.from(el.querySelectorAll('.tpl-menu button')).find(b => b.textContent!.includes('new campaign')) as HTMLButtonElement).click();
    http.expectOne(`${BASE}/7`).flush({ template: { id: 7, name: 'Welcome', html: '<p>Hi</p>' } });
    expect(used).toEqual([{ template: { id: 7, name: 'Welcome', html: '<p>Hi</p>' }, target: 'campaign' }]);
  });

  it('the editor uses the shared content editor; Choose template replaces the HTML only after confirming (not saved)', () => {
    init();
    comp.open({ id: 7 });
    http.expectOne(`${BASE}/7`).flush({ template: { id: 7, name: 'Welcome', category: 'Welcome', version: 1, html: '<p>Old</p>', warnings: [], placeholders: [] } });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-email-content-editor')).toBeTruthy();
    const c = spyOn(window, 'confirm').and.returnValue(false);
    comp.onTemplatePicked({ name: 'Promo', html: '<p>New</p>' });
    expect(comp.editing.html).toBe('<p>Old</p>');
    c.and.returnValue(true);
    comp.onTemplatePicked({ name: 'Promo', html: '<p>New</p>' });
    expect(comp.editing.html).toBe('<p>New</p>');
    expect(comp.dirty).toBeTrue();
    http.expectNone(r => r.method === 'PATCH' || r.method === 'POST');
  });

  it('the ZIP information card can be collapsed and expanded', () => {
    init();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.zip-text p')).toBeTruthy();
    (el.querySelector('.zip-toggle') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el.querySelector('.zip-text p')).toBeNull();
    expect(el.querySelector('.zip-toggle')!.getAttribute('aria-expanded')).toBe('false');
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
    (fixture.nativeElement.querySelector('.tp-foot .btn-primary') as HTMLButtonElement).click();
    expect(picked.id).toBe(1);
    http.verify();
  });
});
