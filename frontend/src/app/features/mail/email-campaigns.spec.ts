import { Component, EventEmitter, Input, Output } from '@angular/core';
import { ComponentFixture, TestBed, fakeAsync, flush, tick } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { EmailPreviewComponent } from './email-preview.component';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { EmailCampaignsComponent } from './email-campaigns.component';
import { VisualHtmlEditorComponent } from './visual-html-editor.component';
import { EmailContentEditorComponent } from './email-content-editor.component';
import { ZohoCampaignsComponent } from './zoho-campaigns.component';

@Component({ selector: 'app-zoho-campaigns', standalone: true, template: '' })
class ZohoStub { @Input() oauthResult: any; @Output() toast = new EventEmitter<string>(); @Output() statusChange = new EventEmitter<any>(); }

const ORIGINAL = '<p>Original campaign content</p>';

describe('EmailCampaignsComponent: Choose Template', () => {
  let fixture: ComponentFixture<EmailCampaignsComponent>;
  let comp: EmailCampaignsComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const button = (text: string) => Array.from(el().querySelectorAll('button')).find(b => b.textContent!.includes(text)) as HTMLButtonElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [EmailCampaignsComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    TestBed.overrideComponent(EmailCampaignsComponent, { remove: { imports: [ZohoCampaignsComponent] }, add: { imports: [ZohoStub] } });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(EmailCampaignsComponent);
    comp = fixture.componentInstance;
    fixture.detectChanges();
    http.expectOne(r => /\/mail\/campaigns$/.test(r.url)).flush({ campaigns: [] });
    comp.zoho = { canCompose: true, canSend: false, connection: { connected: false } };
    (comp as any).setSelected({ id: 5, name: 'Autumn', status: 'draft', version: 1, html: ORIGINAL, lists: [] });
    fixture.detectChanges();
  });
  afterEach(() => {
    // Choosing a template never saves, sends or contacts Zoho by itself.
    http.expectNone(r => r.method !== 'GET');
    http.verify();
  });

  function openPicker(): void {
    button('Choose template').click();
    fixture.detectChanges();
    http.expectOne(r => /\/mail\/templates$/.test(r.url)).flush({ templates: [{ id: 9, name: 'Promo', category: 'Promotion' }] });
    fixture.detectChanges();
  }
  function selectPromo(): void {
    (el().querySelector('.tp-card') as HTMLButtonElement).click();
    http.expectOne(r => r.url.endsWith('/mail/templates/9')).flush({ template: { id: 9, name: 'Promo', html: '<p>Template HTML</p>' } });
    fixture.detectChanges();
  }
  const useBtn = () => Array.from(el().querySelectorAll('.tp-foot button')).find(b => b.textContent!.includes('Use This Template')) as HTMLButtonElement;

  it('Choose template opens the modal; previewing a template leaves the campaign HTML unchanged', () => {
    openPicker();
    expect(el().querySelector('app-template-picker [role=dialog]')).toBeTruthy();
    expect(el().textContent).toContain('Choose an Email Template');
    selectPromo();
    expect(comp.form.html).toBe(ORIGINAL);
  });

  it('Cancel and closing keep the existing content', () => {
    openPicker();
    selectPromo();
    (Array.from(el().querySelectorAll('.tp-foot button')).find(b => b.textContent!.trim() === 'Cancel') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(comp.picker).toBeNull();
    expect(el().querySelector('app-template-picker')).toBeNull();
    expect(comp.form.html).toBe(ORIGINAL);
    openPicker();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(comp.picker).toBeNull();
    expect(comp.form.html).toBe(ORIGINAL);
  });

  it('Use This Template replaces the HTML only after confirming, and only in the editor (Save is still needed)', () => {
    const confirmSpy = spyOn(window, 'confirm').and.returnValue(false);
    openPicker();
    selectPromo();
    useBtn().click();
    fixture.detectChanges();
    expect(confirmSpy).toHaveBeenCalled();
    expect(comp.form.html).toBe(ORIGINAL, 'declining the replacement keeps the content');
    confirmSpy.and.returnValue(true);
    openPicker();
    selectPromo();
    useBtn().click();
    fixture.detectChanges();
    expect(comp.form.html).toBe('<p>Template HTML</p>');
    expect(el().querySelector('app-template-picker')).toBeNull();
  });
  // ---- Campaign preview (Preview mode of the Email content panel) ----
  /** The shared Email content editor inside the campaign editor. */
  const ed = () => fixture.debugElement.query(By.directive(EmailContentEditorComponent)).componentInstance as EmailContentEditorComponent;
  const modeTab = (m: string) => el().querySelector(`#ec-mode-${m}`) as HTMLButtonElement;
  const toPreview = () => { modeTab('preview').click(); fixture.detectChanges(); };
  const toEdit = () => { modeTab('edit').click(); fixture.detectChanges(); };
  const unsubBtn = () => (el().querySelector('[aria-label="Insert unsubscribe link"]') as HTMLButtonElement | null) ?? undefined;
  const editor = () => el().querySelector('textarea[aria-label="Email HTML"]') as HTMLTextAreaElement;
  const toHtmlEditor = () => { (el().querySelector('#ec-edit-html') as HTMLButtonElement).click(); fixture.detectChanges(); };
  const typeHtml = (v: string) => { if (!editor()) toHtmlEditor(); editor().value = v; editor().dispatchEvent(new Event('input')); fixture.detectChanges(); };
  const previewDoc = () => (el().querySelector('.ec-preview iframe') as HTMLIFrameElement).getAttribute('srcdoc') || '';
  const previewCmp = () => fixture.debugElement.query(By.directive(EmailPreviewComponent)).componentInstance as EmailPreviewComponent;

  it('the campaign HTML renders in a visible, sandboxed preview', () => {
    toPreview();
    const frame = el().querySelector('.ec-preview iframe') as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(previewDoc()).toContain('Original campaign content');
    const box = frame.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(100);
    expect(box.height).toBeGreaterThan(250);
  });

  it('editing the HTML updates the preview without saving anything', fakeAsync(() => {
    typeHtml('<p>Edited text</p>');
    toPreview();
    tick(300);
    expect(previewDoc()).toContain('Edited text');
    expect(comp.selected.html).toBe(ORIGINAL, 'the saved campaign is untouched until Save');
    flush();
  }));

  it('choosing a template updates the preview; cancelling leaves the preview and content as they were', fakeAsync(() => {
    spyOn(window, 'confirm').and.returnValue(true);
    toPreview();
    previewCmp().onLoad();
    openPicker();
    selectPromo();
    (Array.from(el().querySelectorAll('.tp-foot button')).find(b => b.textContent!.trim() === 'Cancel') as HTMLButtonElement).click();
    fixture.detectChanges();
    tick(300);
    expect(previewDoc()).toContain('Original campaign content');
    openPicker();
    selectPromo();
    useBtn().click();
    fixture.detectChanges();
    tick(300);
    expect(previewDoc()).toContain('Template HTML');
    expect(previewDoc()).not.toContain('Original campaign content');
    flush();
  }));

  it('switching campaigns shows the other campaign\'s HTML at once, never the previous one', fakeAsync(() => {
    toPreview();
    previewCmp().onLoad();
    (comp as any).setSelected({ id: 6, name: 'Winter', status: 'draft', version: 1, html: '<h1>Winter campaign</h1>', lists: [] });
    fixture.detectChanges();
    expect(ed().contentMode).withContext('a newly opened campaign starts in Edit').toBe('edit');
    toPreview();
    expect(previewDoc()).toContain('Winter campaign');
    expect(previewDoc()).not.toContain('Original campaign content');
    flush();
  }));

  it('a campaign without HTML shows an empty state instead of a blank box', fakeAsync(() => {
    (comp as any).setSelected({ id: 7, name: 'Empty', status: 'draft', version: 1, html: '', lists: [] });
    fixture.detectChanges();
    expect(el().querySelector('.ec-hints')!.textContent).toContain('Add the email content');
    toPreview();
    expect(el().querySelector('.ec-preview')!.textContent).toContain('No HTML content yet');
    flush();
  }));

  it('dangerous markup in a campaign cannot run in the preview', () => {
    (comp as any).setSelected({ id: 8, name: 'X', status: 'draft', version: 1, lists: [], html: '<p id="ecx">Hi</p><script>window.__ecPwn = 1</script><img src="x" onerror="window.__ecPwn2 = 1"><a href="javascript:alert(1)">x</a>' });
    fixture.detectChanges();
    toPreview();
    expect((el().querySelector('.ec-preview iframe') as HTMLIFrameElement).getAttribute('sandbox')).withContext('no scripts, no access to the app').toBe('');
    const doc = previewDoc();
    expect(doc).not.toContain('<script>window.__ecPwn');
    expect(doc).not.toContain('onerror');
    expect(doc).not.toContain('javascript:');
    expect(el().querySelector('#ecx')).toBeNull();
    expect((window as any).__ecPwn).toBeUndefined();
    expect((window as any).__ecPwn2).toBeUndefined();
  });

  // ---- Email content panel: Edit / Preview ----
  it('opens in Edit with the HTML editor; the preview is not shown until Preview is chosen', async () => {
    await fixture.whenStable();
    expect(modeTab('edit').getAttribute('aria-pressed')).toBe('true');
    expect(modeTab('preview').getAttribute('aria-pressed')).toBe('false');
    expect(el().querySelector('[role=switch]')!.getAttribute('aria-checked')).toBe('false');
    expect(el().querySelector('app-visual-html-editor')).withContext('Edit opens in Visual (normal) editing').toBeTruthy();
    expect(el().querySelector('#ec-edit-visual')!.getAttribute('aria-pressed')).toBe('true');
    toHtmlEditor();
    await fixture.whenStable();
    expect(el().querySelector('app-visual-html-editor')).toBeNull();
    expect(editor().value).toBe(ORIGINAL);
    expect(el().querySelector('.ec-preview')).toBeNull();
    expect(unsubBtn()).withContext('the toolbar shows in Edit').toBeTruthy();
    toPreview();
    expect(editor()).toBeNull();
    expect(unsubBtn()).withContext('and not in Preview').toBeUndefined();
    expect(el().querySelector('.ec-preview')).toBeTruthy();
  });

  it('switching to Preview shows the unsaved HTML; switching back keeps every unsaved change', fakeAsync(() => {
    typeHtml('<h2>Unsaved headline</h2>');
    toPreview();
    tick(300);
    expect(previewDoc()).toContain('Unsaved headline');
    toEdit();
    tick();
    expect(editor().value).toBe('<h2>Unsaved headline</h2>');
    toPreview(); toEdit(); toPreview(); toEdit();
    expect(comp.form.html).toBe('<h2>Unsaved headline</h2>');
    expect(comp.selected.html).withContext('nothing saved').toBe(ORIGINAL);
    flush();
  }));

  it('a template chosen while previewing shows at once in the preview and in the editor', fakeAsync(() => {
    spyOn(window, 'confirm').and.returnValue(true);
    toPreview();
    previewCmp().onLoad();
    openPicker();
    selectPromo();
    useBtn().click();
    fixture.detectChanges();
    tick(300);
    expect(previewDoc()).toContain('Template HTML');
    toEdit();
    toHtmlEditor();
    tick();
    expect(editor().value).toBe('<p>Template HTML</p>');
    flush();
  }));

  it('switching modes never saves, validates, approves or sends (no request at all)', () => {
    toPreview(); toEdit(); toPreview();
    (el().querySelector('[aria-label="Preview width"] button:last-child') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(ed().previewWidth).toBe('mobile');
    http.expectNone(() => true);
  });

  it('the switch toggles Edit and Preview, like the labels', () => {
    const sw = el().querySelector('[role=switch]') as HTMLButtonElement;
    sw.click(); fixture.detectChanges();
    expect(ed().contentMode).toBe('preview');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    sw.click(); fixture.detectChanges();
    expect(ed().contentMode).toBe('edit');
  });

  it('the formatting toolbar wraps the selection in HTML and links need https://', () => {
    typeHtml('<p>Hello world</p>');
    const box = editor();
    box.setSelectionRange(9, 14); // "world"
    (el().querySelector('[aria-label=Bold]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(comp.form.html).toBe('<p>Hello <strong>world</strong></p>');
    const toasts: string[] = [];
    comp.toast.subscribe(t => toasts.push(t));
    spyOn(window, 'prompt').and.returnValue('http://insecure.example.com');
    (el().querySelector('[aria-label=Link]') as HTMLButtonElement).click();
    expect(toasts[0]).toContain('https://');
    expect(comp.form.html).not.toContain('insecure');
    (window.prompt as jasmine.Spy).and.returnValue('https://example.com/offer');
    editor().setSelectionRange(0, 0);
    (el().querySelector('[aria-label=Link]') as HTMLButtonElement).click();
    expect(comp.form.html).toContain('<a href="https://example.com/offer">https://example.com/offer</a>');
  });

  it('malformed HTML previews without breaking the page', fakeAsync(() => {
    typeHtml('<div><p>Unclosed <b>bold <table><tr><td>cell');
    toPreview();
    tick(300);
    expect(previewDoc()).toContain('Unclosed');
    expect(el().querySelector('.ec-content')).toBeTruthy();
    flush();
  }));

  it('Insert unsubscribe link adds Zoho\'s link once and clears the reminder', () => {
    typeHtml('<p>Hello</p>');
    expect(el().querySelector('.ec-hints')!.textContent).toContain('No unsubscribe link yet');
    unsubBtn()!.click();
    fixture.detectChanges();
    expect(comp.form.html).toContain('$[LI:UNSUBSCRIBE]$');
    expect(el().querySelector('.ec-hints')).toBeNull();
    const toasts: string[] = [];
    comp.toast.subscribe(t => toasts.push(t));
    unsubBtn()!.click();
    expect(comp.form.html.split('$[LI:UNSUBSCRIBE]$').length).toBe(2);
    expect(toasts[0]).toContain('already');
  });

  it('http:// images get a reminder to use https://', () => {
    typeHtml('<p><a href="$[LI:UNSUBSCRIBE]$">u</a></p><img src="http://cdn.example.com/a.png">');
    expect(el().querySelector('.ec-hints')!.textContent).toContain('https://');
  });

  it('a campaign that can no longer be edited opens on its preview, with the editor and toolbar read-only', fakeAsync(() => {
    (comp as any).setSelected({ id: 9, name: 'Sent', status: 'submitted', version: 2, html: '<p>Sent content</p>', lists: [] });
    fixture.detectChanges();
    expect(ed().contentMode).toBe('preview');
    expect(button('Choose template')).toBeUndefined();
    toEdit();
    toHtmlEditor();
    tick();
    expect(editor().disabled).toBeTrue();
    expect(unsubBtn()).toBeUndefined();
    flush();
  }));

  // ---- Campaign list ----
  const LIST = [
    { id: 1, name: 'Spring offers', subject: 'New this spring', status: 'draft', updatedAt: '2026-10-28 10:00:00' },
    { id: 2, name: 'Autumn recap', subject: 'Our year', status: 'submitted', updatedAt: '2026-10-20 10:00:00', report: { emails_sent_count: 273, open_percent: 41.2 } },
    { id: 3, name: 'Black Friday', subject: 'Deals', status: 'approved', updatedAt: '2026-10-25 10:00:00' }
  ];
  const names = () => Array.from(el().querySelectorAll('.ec-item b')).map(b => b.textContent!.trim());

  it('the list searches, filters by status and sorts, all without new requests', () => {
    comp.campaigns = LIST.map(c => ({ ...c }));
    fixture.detectChanges();
    expect(names()).toEqual(['Spring offers', 'Black Friday', 'Autumn recap']);
    expect(el().querySelector('.ec-item-stats')!.textContent).toContain('273 sent');
    expect(el().querySelector('.ec-item-stats')!.textContent).toContain('41.2% opened');
    comp.listSort = 'name'; fixture.detectChanges();
    expect(names()).toEqual(['Autumn recap', 'Black Friday', 'Spring offers']);
    comp.listStatus = 'approved'; fixture.detectChanges();
    expect(names()).toEqual(['Black Friday']);
    comp.listStatus = ''; comp.listQuery = 'spring'; fixture.detectChanges();
    expect(names()).toEqual(['Spring offers']);
    comp.listQuery = 'nothing'; fixture.detectChanges();
    expect(el().textContent).toContain('No campaigns match.');
  });

  it('the item menu offers Delete only for campaigns that can still change, and asks first', () => {
    comp.campaigns = LIST.map(c => ({ ...c }));
    fixture.detectChanges();
    const menuFor = (i: number) => { (el().querySelectorAll('.ec-kebab')[i] as HTMLButtonElement).click(); fixture.detectChanges(); return Array.from(el().querySelectorAll('.ec-menu button')).map(b => b.textContent!.trim()); };
    expect(menuFor(2)).withContext('submitted to Zoho').toEqual(['Open']);
    expect(menuFor(0)).toEqual(['Open', 'Delete']);
    spyOn(window, 'confirm').and.returnValue(false);
    (Array.from(el().querySelectorAll('.ec-menu button')).find(b => b.textContent!.trim() === 'Delete') as HTMLButtonElement).click();
    expect(window.confirm).toHaveBeenCalled();
    // declined: no DELETE request (checked in afterEach)
  });

  // ---- Visual and HTML editing ----
  it('Visual and HTML editing share the same content: switching keeps edits from either', fakeAsync(() => {
    expect(ed().editMode).toBe('visual');
    typeHtml('<p>Edited in HTML</p>');
    (el().querySelector('#ec-edit-visual') as HTMLButtonElement).click();
    fixture.detectChanges();
    const visual = fixture.debugElement.query(By.directive(VisualHtmlEditorComponent)).componentInstance as VisualHtmlEditorComponent;
    expect(visual.html).toBe('<p>Edited in HTML</p>');
    visual.htmlChange.emit('<p>Edited visually</p>'); // what the visual editor emits after an edit
    fixture.detectChanges();
    expect(comp.form.html).toBe('<p>Edited visually</p>');
    toHtmlEditor();
    tick();
    expect(editor().value).toBe('<p>Edited visually</p>');
    expect(comp.selected.html).withContext('nothing saved').toBe(ORIGINAL);
    flush();
  }));

  it('in Visual mode the toolbar formats the email itself (bold, headings, links need https://)', () => {
    const visual = fixture.debugElement.query(By.directive(VisualHtmlEditorComponent)).componentInstance as VisualHtmlEditorComponent;
    const exec = spyOn(visual, 'exec').and.returnValue(true);
    (el().querySelector('[aria-label=Bold]') as HTMLButtonElement).click();
    expect(exec).toHaveBeenCalledWith('bold', undefined);
    ed().wrapBlock('h2');
    expect(exec).toHaveBeenCalledWith('formatBlock', '<h2>');
    spyOn(window, 'prompt').and.returnValue('http://insecure.example.com');
    (el().querySelector('[aria-label=Link]') as HTMLButtonElement).click();
    expect(exec).not.toHaveBeenCalledWith('createLink', jasmine.anything());
    (window.prompt as jasmine.Spy).and.returnValue('https://example.com');
    (el().querySelector('[aria-label=Link]') as HTMLButtonElement).click();
    expect(exec).toHaveBeenCalledWith('createLink', 'https://example.com');
    http.expectNone(() => true);
  });

  it('a newly opened campaign starts in Visual editing', () => {
    toHtmlEditor();
    (comp as any).setSelected({ id: 12, name: 'Next', status: 'draft', version: 1, html: '<p>x</p>', lists: [] });
    fixture.detectChanges();
    expect(ed().editMode).toBe('visual');
  });

  // ---- Same pattern as Email Templates ----
  it('the header "New Campaign" menu offers a blank campaign or one from a template', () => {
    (Array.from(el().querySelectorAll('.ec-page-head button')).find(b => b.textContent!.includes('New Campaign')) as HTMLButtonElement).click();
    fixture.detectChanges();
    const items = Array.from(el().querySelectorAll('.ec-create-menu button')).map(b => b.querySelector('b')!.textContent!.trim());
    expect(items).toEqual(['Blank campaign', 'From a template']);
    (el().querySelectorAll('.ec-create-menu button')[1] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(comp.picker).toBe('new');
    http.expectOne(r => /\/mail\/templates$/.test(r.url)).flush({ templates: [] });
  });

  it('list items show a sandboxed thumbnail when the list has one', () => {
    comp.campaigns = [{ id: 31, name: 'With thumb', status: 'draft', version: 1, thumbHtml: '<p>Thumb</p>' }, { id: 32, name: 'No thumb', status: 'draft', version: 1 }];
    fixture.detectChanges();
    const thumbs = el().querySelectorAll('.ec-thumb');
    expect(thumbs[0].querySelector('iframe')!.getAttribute('sandbox')).toBe('');
    expect(thumbs[1].querySelector('iframe')).toBeNull();
  });

  it('the editor shows the campaign name and an Unsaved changes tag; Close asks before discarding', () => {
    expect(el().querySelector('.ec-detail-status h3')!.textContent).toBe('Autumn');
    expect(comp.dirty).toBeFalse();
    expect(el().querySelector('.ec-detail-status .mx-tag.warn')).toBeNull();
    comp.form.subject = 'Changed subject';
    fixture.detectChanges();
    expect(comp.dirty).toBeTrue();
    expect(el().querySelector('.ec-detail-status .mx-tag.warn')!.textContent).toContain('Unsaved changes');
    const c = spyOn(window, 'confirm').and.returnValue(false);
    (Array.from(el().querySelectorAll('.ec-actions button')).find(b => b.textContent!.includes('Cancel')) as HTMLButtonElement).click();
    expect(c).toHaveBeenCalled();
    expect(comp.selected).withContext('kept when the user declines').not.toBeNull();
    c.and.returnValue(true);
    comp.close();
    expect(comp.selected).toBeNull();
  });

  it('opening another campaign with unsaved edits asks first; declining keeps the edits', () => {
    comp.form.html = '<p>Unsaved</p>';
    spyOn(window, 'confirm').and.returnValue(false);
    comp.open({ id: 99 });
    http.expectNone(r => r.url.endsWith('/mail/campaigns/99'));
    expect(comp.form.html).toBe('<p>Unsaved</p>');
  });
});
