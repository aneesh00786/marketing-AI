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
import { CampaignContactsComponent } from './campaign-contacts.component';

@Component({ selector: 'app-zoho-campaigns', standalone: true, template: '' })
class ZohoStub { @Input() oauthResult: any; @Output() toast = new EventEmitter<string>(); @Output() statusChange = new EventEmitter<any>(); }

@Component({ selector: 'app-campaign-contacts', standalone: true, template: '' })
class ContactsStub {
  @Input() campaignId: any; @Input() editable: any; @Input() canSync: any; @Input() canReconnect: any; @Input() zohoLists: any;
  @Output() contactsChange = new EventEmitter<any[]>();
  @Output() changed = new EventEmitter<any>(); @Output() reconnect = new EventEmitter<void>(); @Output() toast = new EventEmitter<string>();
}

const ORIGINAL = '<p>Original campaign content</p>';

describe('EmailCampaignsComponent: Choose Template', () => {
  let fixture: ComponentFixture<EmailCampaignsComponent>;
  let comp: EmailCampaignsComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const button = (text: string) => Array.from(el().querySelectorAll('button')).find(b => b.textContent!.includes(text)) as HTMLButtonElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [EmailCampaignsComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    TestBed.overrideComponent(EmailCampaignsComponent, { remove: { imports: [ZohoCampaignsComponent, CampaignContactsComponent] }, add: { imports: [ZohoStub, ContactsStub] } });
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
    http.expectNone(r => r.method !== 'GET' && !/\/(duplicate|refresh)$/.test(r.url));
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
  const unsubBox = () => el().querySelector('.ec-unsub input') as HTMLInputElement | null;
  const tickUnsub = (on: boolean) => { const b = unsubBox()!; b.checked = on; b.dispatchEvent(new Event('change')); fixture.detectChanges(); };
  const editor = () => el().querySelector('textarea[aria-label="Email HTML"]') as HTMLTextAreaElement;
  const toHtmlEditor = () => { (el().querySelector('#ec-edit-html') as HTMLButtonElement).click(); fixture.detectChanges(); };
  const typeHtml = (v: string) => { if (!editor()) toHtmlEditor(); editor().value = v; editor().dispatchEvent(new Event('input')); fixture.detectChanges(); };
  const previewDoc = () => (el().querySelector('.ec-preview iframe') as HTMLIFrameElement).getAttribute('srcdoc') || '';
  const previewCmp = () => fixture.debugElement.query(By.directive(EmailPreviewComponent)).componentInstance as EmailPreviewComponent;

  it('the campaign HTML renders in a visible, sandboxed preview', () => {
    comp.step = 3; // the Email content step
    fixture.detectChanges();
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
    expect(el().querySelector('[aria-label=Bold]')).withContext('the toolbar shows in Edit').toBeTruthy();
    toPreview();
    expect(editor()).toBeNull();
    expect(el().querySelector('[aria-label=Bold]')).withContext('and not in Preview').toBeNull();
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

  it('the unsubscribe checkbox adds the link once at the end, shows its state, and removes it again', () => {
    typeHtml('<p>Hello</p>');
    expect(unsubBox()!.checked).toBeFalse();
    expect(el().querySelector('.ec-hints')!.textContent).toContain('No unsubscribe link yet');
    tickUnsub(true);
    expect(comp.form.html).toBe('<p>Hello</p>\n<p style="text-align:center;font-size:12px;"><a href="$[LI:UNSUBSCRIBE]$">Unsubscribe</a></p>');
    expect(unsubBox()!.checked).toBeTrue();
    expect(el().querySelector('.ec-hints')).toBeNull();
    tickUnsub(false);
    expect(comp.form.html.trim()).toBe('<p>Hello</p>');
    expect(unsubBox()!.checked).toBeFalse();
    http.expectNone(() => true);
  });

  it('the unsubscribe link goes before </body> in full documents; a link written by hand is recognised and can be removed', () => {
    typeHtml('<html><body><p>Hi</p></body></html>');
    tickUnsub(true);
    expect(comp.form.html).toMatch(/<p>Hi<\/p><p style[^>]*><a href="\$\[LI:UNSUBSCRIBE\]\$">Unsubscribe<\/a><\/p>\n<\/body>/);
    typeHtml('<p>Hi, <a class="x" href="$[LI:ORG_OPTOUT]$">leave here</a> anytime.</p>');
    expect(unsubBox()!.checked).toBeTrue();
    tickUnsub(false);
    expect(comp.form.html).toBe('<p>Hi,  anytime.</p>');
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
    expect(unsubBox()).withContext('read-only campaigns have no checkbox').toBeNull();
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
    const menuFor = (i: number) => { (el().querySelectorAll('.ec-kebab')[i] as HTMLButtonElement).click(); fixture.detectChanges(); return Array.from(el().querySelectorAll('.ec-item .ec-menu button')).map(b => b.textContent!.trim()); };
    expect(menuFor(2)).withContext('submitted to Zoho').toEqual(['Open', 'Duplicate']);
    expect(menuFor(0)).toEqual(['Open', 'Duplicate', 'Delete']);
    spyOn(window, 'confirm').and.returnValue(false);
    (Array.from(el().querySelectorAll('.ec-item .ec-menu button')).find(b => b.textContent!.trim() === 'Delete') as HTMLButtonElement).click();
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
    expect(items).toEqual(['Blank campaign', 'Sample email', 'From a template', 'New email template']);
    (el().querySelectorAll('.ec-create-menu button')[2] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(comp.picker).toBe('new');
    http.expectOne(r => /\/mail\/templates$/.test(r.url)).flush({ templates: [] });
  });

  it('"New email template" in the New Campaign menu asks to open the template editor, without creating anything', () => {
    let asked = 0;
    comp.createTemplate.subscribe(() => asked++);
    (Array.from(el().querySelectorAll('.ec-page-head button')).find(b => b.textContent!.includes('New Campaign')) as HTMLButtonElement).click();
    fixture.detectChanges();
    (Array.from(el().querySelectorAll('.ec-create-menu button')).find(b => b.textContent!.includes('New email template')) as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(asked).toBe(1);
    expect(el().querySelector('.ec-create-menu')).withContext('the menu closes').toBeNull();
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

  // ---- Zoho list contacts ----
  it('each Zoho list has View contacts for roles that can send; ticking a list is separate from viewing it', () => {
    comp.audiences = { lists: [{ key: 'L1', name: 'Customers', contacts: 2 }], topics: [] };
    comp.zoho = { canCompose: true, canSend: false, connection: { connected: true, missingScopes: [] } };
    fixture.detectChanges();
    expect(button('View contacts')).withContext('Members cannot see addresses').toBeUndefined();
    comp.zoho = { ...comp.zoho, canSend: true };
    fixture.detectChanges();
    button('View contacts').click();
    fixture.detectChanges();
    expect(comp.form.listKeys.has('L1')).withContext('viewing does not select the list').toBeFalse();
    const req = http.expectOne(r => r.url.endsWith('/mail/campaigns/audiences/L1/contacts'));
    expect(req.request.params.get('status')).toBe('subscribed');
    req.flush({ contacts: [{ email: 'kim@client.io', name: 'Kim Lee', company: 'Acme', phone: null }], page: 1, hasMore: false });
    fixture.detectChanges();
    expect(el().querySelector('[role=dialog]')!.textContent).toContain('kim@client.io');
    expect(el().querySelector('[role=dialog]')!.textContent).toContain('Customers');
    (el().querySelector('app-zoho-list-contacts .zc-close') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el().querySelector('[role=dialog]')).toBeNull();
  });

  // ---- Selected contacts ----
  const contactsStub = () => fixture.debugElement.query(By.directive(ContactsStub)).componentInstance as ContactsStub;

  it('changing the selected contacts keeps unsaved edits and shows the campaign is back to draft', () => {
    (comp as any).setSelected({ id: 5, name: 'Autumn', status: 'approved', approved: true, version: 3, html: ORIGINAL, lists: [] });
    comp.form.subject = 'Unsaved subject';
    fixture.detectChanges();
    contactsStub().changed.emit({ id: 5, name: 'Autumn', status: 'draft', approved: false, version: 4, html: ORIGINAL, lists: [], contactCount: 2 });
    http.expectOne(r => /\/mail\/campaigns$/.test(r.url)).flush({ campaigns: [] });
    fixture.detectChanges();
    expect(comp.selected.status).toBe('draft');
    expect(comp.form.subject).withContext('the form is not reloaded').toBe('Unsaved subject');
    expect(comp.dirty).toBeTrue();
  });

  it('the send confirmation popup names the lists and the selected contacts; Cancel sends nothing', () => {
    (comp as any).setSelected({ id: 5, name: 'Autumn', status: 'approved', approved: true, version: 3, html: ORIGINAL, lists: [{ key: 'L1', name: 'Customers' }], contactCount: 2 });
    comp.send();
    fixture.detectChanges();
    const dialog = () => el().querySelector('[role=dialog][aria-labelledby=ec-send-title]') as HTMLElement | null;
    expect(dialog()!.textContent).toContain('Zoho lists Customers and 2 selected contacts (added to Zoho first)');
    (Array.from(dialog()!.querySelectorAll('button')).find(b => b.textContent!.trim() === 'Cancel') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(dialog()).withContext('Cancel closes the popup').toBeNull();
    http.expectNone(r => r.url.endsWith('/send'));
    (comp as any).setSelected({ id: 5, name: 'Autumn', status: 'approved', approved: true, version: 3, html: ORIGINAL, lists: [], contactCount: 1 });
    comp.send();
    expect(comp.sendConfirm!.recipients).toBe('1 selected contact (added to Zoho first)');
  });

  it('Send now in the popup sends once, with confirm: true', () => {
    (comp as any).setSelected({ id: 5, name: 'Autumn', status: 'approved', approved: true, version: 3, html: ORIGINAL, lists: [{ key: 'L1', name: 'Customers' }] });
    comp.send();
    fixture.detectChanges();
    (Array.from(el().querySelectorAll('[aria-labelledby=ec-send-title] button')).find(b => b.textContent!.includes('Send now')) as HTMLButtonElement).click();
    comp.confirmSend(); // a second click while sending does nothing
    const req = http.expectOne(r => r.method === 'POST' && r.url.endsWith('/campaigns/5/send'));
    expect(req.request.body).toEqual({ confirm: true });
    req.flush({ campaign: { id: 5, name: 'Autumn', status: 'submitted', version: 3, html: ORIGINAL, lists: [] } });
    http.expectOne(r => /\/mail\/campaigns$/.test(r.url)).flush({ campaigns: [] });
    expect(comp.sendConfirm).toBeNull();
  });

  it('merge tags (as in Zoho): subject and editor insert Zoho tags with the default value typed in', () => {
    const typeFallback = (scope: Element, v: string) => {
      const inp = scope.querySelector('.ec-merge-ask input') as HTMLInputElement;
      inp.value = v; inp.dispatchEvent(new Event('input'));
    };
    comp.form.subject = 'Big news';
    fixture.detectChanges();
    button('Add first name').click(); fixture.detectChanges();
    expect(el().textContent).toContain("If we don't have any name for a contact, what should the email say instead?");
    expect(comp.subjectAsk!.fallback).withContext('a subject is not a greeting').toBe('you');
    const preview = () => Array.from(el().querySelectorAll('.ec-subject-preview li b')).map(b => b.textContent!.trim());
    expect(preview()).toEqual(['Big news Priya', 'Big news Big Red Packaging team', 'Big news you']);
    typeFallback(el(), 'Customer|x');
    fixture.detectChanges();
    expect(preview()[2]).toBe('Big news Customerx');
    button('Insert').click();
    expect(comp.form.subject).toBe('Big news $[FNAME|Customerx]$');
    expect(comp.subjectAsk).toBeNull();

    comp.step = 3;
    fixture.detectChanges();
    (el().querySelector('#ec-edit-html') as HTMLButtonElement).click();
    fixture.detectChanges();
    const openPanel = () => { button('Personalize').click(); fixture.detectChanges(); };
    const choose = (label: string) => { openPanel(); (Array.from(el().querySelectorAll('.ec-personalize-panel button')).find(x => x.querySelector('b')!.textContent!.trim() === label) as HTMLButtonElement).click(); fixture.detectChanges(); };
    openPanel();
    expect(Array.from(el().querySelectorAll('.ec-personalize-panel b')).map(x => x.textContent!.trim())).toEqual(['First name', 'Last name', 'View in browser link', 'Update profile link', 'Forward to a friend link', 'Your company address']);
    expect(el().querySelector('.ec-personalize-panel')!.textContent).toContain('e.g. “Hi Priya,”');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); fixture.detectChanges();
    expect(el().querySelector('.ec-personalize-panel')).withContext('Escape closes it').toBeNull();
    // A contact field: the default value is asked first (prefilled "there"), then inserted, with a space after a word.
    comp.form.html = '<p>Hello,</p>';
    fixture.detectChanges();
    const box = el().querySelector('textarea[aria-label="Email HTML"]') as HTMLTextAreaElement;
    box.focus(); box.setSelectionRange(8, 8);
    choose('First name');
    expect((el().querySelector('.ec-merge-ask input') as HTMLInputElement)).toBeTruthy();
    button('Insert').click();
    fixture.detectChanges();
    expect(comp.form.html).toBe('<p>Hello $[FNAME|there]$,</p>');
    // A link goes in straight away as a link Zoho fills in.
    const b2 = el().querySelector('textarea[aria-label="Email HTML"]') as HTMLTextAreaElement;
    b2.focus(); b2.setSelectionRange(0, 0);
    choose('View in browser link');
    expect(comp.form.html.startsWith('<a href="$[LI:VIEWINBROWSER]$">View in browser</a>')).withContext(comp.form.html).toBeTrue();
    expect(el().querySelector('.ec-merge-ask')).toBeNull();
  });

  it('sender (as in Zoho): addresses grouped by domain, verified ones marked, name filled in, new address checked', () => {
    comp.campaigns = [
      { id: 1, fromEmail: 'News@Acme.com.au', fromName: 'Acme News', status: 'submitted' },
      { id: 2, fromEmail: 'sales@acme.com.au', fromName: '', status: 'draft' },
      { id: 3, fromEmail: 'hello@beta.io', fromName: 'Beta', status: 'failed' },
      { id: 4, fromEmail: 'me@gmail.com', status: 'draft' }
    ];
    comp.form.fromName = '';
    comp.form.fromEmail = '';
    fixture.detectChanges();
    const sel = () => el().querySelector('#ec-sender-select') as HTMLSelectElement;
    expect(Array.from(sel().querySelectorAll('optgroup')).map(g => g.label)).toEqual(['acme.com.au', 'beta.io']);
    expect(Array.from(sel().options).map(o => o.textContent!.trim())).toEqual(['Choose a sender address', 'news@acme.com.au ✓', 'sales@acme.com.au', 'hello@beta.io', '+ Add sender address…']);
    sel().value = 'news@acme.com.au'; sel().dispatchEvent(new Event('change')); fixture.detectChanges();
    expect(comp.form.fromEmail).toBe('news@acme.com.au');
    expect(comp.form.fromName).toBe('Acme News');
    expect(el().textContent).toContain('Verified: Zoho has already sent a campaign from this address');
    sel().value = 'hello@beta.io'; sel().dispatchEvent(new Event('change')); fixture.detectChanges();
    expect(comp.form.fromName).withContext('a typed name is kept').toBe('Acme News');
    expect(el().textContent).toContain('Not used with Zoho yet');

    sel().value = '__add'; sel().dispatchEvent(new Event('change')); fixture.detectChanges();
    const box = el().querySelector('.ec-sender-add input') as HTMLInputElement;
    box.value = 'boss@yahoo.com'; box.dispatchEvent(new Event('input'));
    button('Use address').click(); fixture.detectChanges();
    expect(el().textContent).toContain('Zoho does not send from Gmail, Yahoo');
    expect(comp.form.fromEmail).toBe('hello@beta.io');
    box.value = ' Team@NewCo.com '; box.dispatchEvent(new Event('input'));
    button('Use address').click(); fixture.detectChanges();
    expect(comp.form.fromEmail).toBe('team@newco.com');
    expect(Array.from(sel().querySelectorAll('optgroup')).map(g => g.label)).toEqual(['acme.com.au', 'beta.io', 'newco.com']);
    expect(sel().value).toBe('team@newco.com');
  });

  it('Sample email: creates a campaign with the ready-made layout, Zoho merge tags and [bracketed] parts to fill in', () => {
    try { localStorage.setItem('tradesage_workspace', JSON.stringify({ name: 'Acme <Packaging>' })); } catch { /* storage blocked */ }
    comp.form = null; comp.selected = null; fixture.detectChanges();
    comp.newCampaign('sample');
    const req = http.expectOne(r => r.method === 'POST' && /\/mail\/campaigns$/.test(r.url));
    const b = req.request.body;
    expect(b.name).toBe('Sample campaign');
    expect(b.subject).toBe('A quick idea for $[FNAME|you]$');
    for (const tag of ['Hi $[FNAME|there]$,', '$[LI:UNSUBSCRIBE]$', '$[LI:VIEWINBROWSER]$', '$[HF:ORGADDRESS]$', '$[LI:UPDATEPROFILE]$', '[Your name]', 'https://example.com']) expect(b.html).toContain(tag);
    expect(b.html).toContain('Acme &lt;Packaging&gt;');
    expect(b.html).not.toContain('<Packaging>');
    req.flush({ campaign: { id: 8, name: 'Sample campaign', status: 'draft', version: 1, html: b.html, subject: b.subject, lists: [] } });
    http.match(r => r.method === 'GET').forEach(r => r.flush(r.request.url.endsWith('/campaigns/8') ? { campaign: { id: 8, name: 'Sample campaign', status: 'draft', version: 1, html: b.html, lists: [] } } : { campaigns: [] }));
    expect(comp.form?.name).toBe('Sample campaign');
    try { localStorage.removeItem('tradesage_workspace'); } catch { /* storage blocked */ }
  });

  it('steps: a draft opens on Details; Review runs the checks; a sent campaign opens on Review', () => {
    expect(comp.step).toBe(1);
    expect(comp.stepDone(3)).withContext('the campaign has content').toBeTrue();
    expect(comp.stepDone(2)).withContext('no recipients yet').toBeFalse();
    comp.goStep(4);
    http.expectOne(r => r.method === 'POST' && r.url.endsWith('/campaigns/5/validate')).flush({ validation: { ready: false, problems: ['Add a subject.'], warnings: [] } });
    fixture.detectChanges();
    expect(el().querySelector('.ec-checks')!.textContent).toContain('Add a subject.');
    expect(el().querySelector('.ec-fill-go')).withContext('nothing to fill in').toBeNull();
    comp.validation = { ready: false, problems: ['Replace the placeholders: [Your name].'], warnings: [] };
    fixture.detectChanges();
    (el().querySelector('.ec-fill-go') as HTMLButtonElement).click();
    expect(comp.step).toBe(3);
    (comp as any).setSelected({ id: 7, name: 'Sent one', status: 'submitted', version: 2, html: ORIGINAL, lists: [] });
    expect(comp.step).toBe(4);
  });

  it('Zoho contacts can be picked only while the campaign can change and the connection allows it', () => {
    comp.zoho = { canCompose: true, canSend: true, connection: { connected: true, missingScopes: [], canSyncContacts: true } };
    expect(comp.canPickFromZoho).toBeTrue();
    comp.zoho = { ...comp.zoho, connection: { connected: true, missingScopes: [], canSyncContacts: false } };
    expect(comp.canPickFromZoho).withContext('reconnect needed').toBeFalse();
    comp.zoho = { canCompose: true, canSend: false, connection: { connected: true, missingScopes: [], canSyncContacts: true } };
    expect(comp.canPickFromZoho).withContext('role cannot read addresses').toBeFalse();
    comp.zoho = { canCompose: true, canSend: true, connection: { connected: true, missingScopes: [], canSyncContacts: true } };
    comp.selected = { ...comp.selected, status: 'submitted' };
    expect(comp.canPickFromZoho).withContext('already sent').toBeFalse();
  });

  it('contacts picked from a Zoho list show on its row, part-ticked; ticking the whole list covers them', () => {
    comp.audiences = { lists: [{ key: 'L1', name: 'Customers', contacts: 5 }, { key: 'L2', name: 'Other', contacts: 3 }], topics: [] };
    comp.zoho = { canCompose: true, canSend: true, connection: { connected: true, missingScopes: [] } };
    comp.onContacts([{ id: 1, email: 'kim@client.io', name: 'Kim', source: 'zoho_list', sourceListKey: 'L1', eligible: true, reasons: [] }]);
    fixture.detectChanges();
    const boxes = () => Array.from(el().querySelectorAll('.ec-list-row input')) as HTMLInputElement[];
    expect([boxes()[0].indeterminate, boxes()[0].checked]).toEqual([true, false]);
    expect(boxes()[1].indeterminate).toBeFalse();
    expect(el().textContent).toContain('· 1 selected');
    expect(el().querySelector('app-campaign-contact-rows')!.textContent).toContain('kim@client.io');
    boxes()[0].click();
    fixture.detectChanges();
    expect([boxes()[0].indeterminate, boxes()[0].checked]).toEqual([false, true]);
    expect(el().querySelector('app-campaign-contact-rows')).toBeNull();
    expect(el().textContent).not.toContain('· 1 selected');
  });

  it('the send confirmation does not count contacts already covered by a ticked list', () => {
    (comp as any).setSelected({ id: 5, name: 'Autumn', status: 'approved', approved: true, version: 3, html: ORIGINAL, lists: [{ key: 'L1', name: 'Customers' }] });
    comp.onContacts([{ id: 1, sourceListKey: 'L1', eligible: true }, { id: 2, leadId: 4, eligible: true }]);
    comp.send();
    expect(comp.sendConfirm!.recipients).toContain('Zoho lists Customers and 1 selected contact (added to Zoho first)');
  });

  // ---- Duplicate ----
  const FULL = { id: 5, name: 'Autumn', status: 'submitted', version: 2, html: ORIGINAL, lists: [] };
  const COPY = { id: 6, name: 'Autumn (copy)', status: 'draft', version: 1, html: ORIGINAL, lists: [] };

  it('Duplicate on a sent campaign opens the copy as a draft and reports contacts left out', () => {
    (comp as any).setSelected(FULL);
    fixture.detectChanges();
    const toasts: string[] = [];
    comp.toast.subscribe(t => toasts.push(t));
    button('Duplicate').click();
    http.expectOne(r => r.method === 'POST' && r.url.endsWith('/campaigns/5/duplicate')).flush({ campaign: COPY, contactsDropped: 2 });
    http.expectOne(r => /\/mail\/campaigns$/.test(r.url)).flush({ campaigns: [] });
    fixture.detectChanges();
    expect(comp.selected.id).toBe(6);
    expect(comp.form.name).toBe('Autumn (copy)');
    expect(comp.editable).toBeTrue();
    expect(toasts[0]).toContain('2 contacts were left out');
  });

  it('Duplicate asks first when there are unsaved changes, and Cancel creates nothing', () => {
    comp.form.subject = 'Edited';
    spyOn(window, 'confirm').and.returnValue(false);
    comp.duplicate(comp.selected);
    expect(window.confirm).toHaveBeenCalled();
    http.expectNone(r => r.url.endsWith('/duplicate'));
  });

  it('roles that cannot write campaigns have no Duplicate action', () => {
    comp.zoho = { canCompose: false, canSend: false, connection: { connected: false } };
    fixture.detectChanges();
    expect(button('Duplicate')).toBeUndefined();
  });

  // ---- Results of a sent campaign ----
  const SENT = { id: 7, name: 'Sent one', status: 'submitted', version: 1, html: ORIGINAL, lists: [] };
  const openSent = (c: any) => {
    comp.open(c);
    http.expectOne(r => r.method === 'GET' && r.url.endsWith('/campaigns/7')).flush({ campaign: c });
  };

  it('opening a sent campaign reads its latest figures from Zoho', () => {
    openSent({ ...SENT, lastCheckedAt: null });
    http.expectOne(r => r.method === 'POST' && r.url.endsWith('/campaigns/7/refresh')).flush({ campaign: { ...SENT, report: { emails_sent_count: '10' } } });
    http.expectOne(r => /\/mail\/campaigns$/.test(r.url)).flush({ campaigns: [] });
    expect(comp.selected.report.emails_sent_count).toBe('10');
  });

  it('figures read in the last few minutes are not read again, and drafts never are', () => {
    openSent({ ...SENT, lastCheckedAt: new Date(Date.now() - 60000).toISOString() });
    http.expectNone(r => r.url.endsWith('/refresh'));
    comp.open(comp.campaigns[0] || { id: 5 });
    http.expectOne(r => r.url.endsWith('/campaigns/5')).flush({ campaign: { id: 5, name: 'Autumn', status: 'draft', version: 1, html: ORIGINAL, lists: [] } });
    http.expectNone(r => r.url.endsWith('/refresh'));
  });

  it('if Zoho cannot be reached the campaign stays open with its last figures, and a late answer cannot replace another campaign', () => {
    openSent({ ...SENT, lastCheckedAt: null, report: { emails_sent_count: '3' } });
    http.expectOne(r => r.url.endsWith('/refresh')).flush({ error: 'x' }, { status: 502, statusText: 'x' });
    expect(comp.selected.report.emails_sent_count).toBe('3');
    openSent({ ...SENT, lastCheckedAt: null });
    const late = http.expectOne(r => r.url.endsWith('/refresh'));
    comp.open({ id: 5 });
    http.expectOne(r => r.url.endsWith('/campaigns/5')).flush({ campaign: { id: 5, name: 'Autumn', status: 'draft', version: 1, html: ORIGINAL, lists: [] } });
    late.flush({ campaign: { ...SENT, name: 'Stale' } });
    http.expectOne(r => /\/mail\/campaigns$/.test(r.url)).flush({ campaigns: [] });
    expect(comp.selected.id).toBe(5);
  });
});
