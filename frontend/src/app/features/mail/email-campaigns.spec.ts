import { Component, EventEmitter, Input, Output } from '@angular/core';
import { ComponentFixture, TestBed, fakeAsync, flush, tick } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { EmailPreviewComponent } from './email-preview.component';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { EmailCampaignsComponent } from './email-campaigns.component';
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
  const modeTab = (m: string) => el().querySelector(`#ec-mode-${m}`) as HTMLButtonElement;
  const toPreview = () => { modeTab('preview').click(); fixture.detectChanges(); };
  const toEdit = () => { modeTab('edit').click(); fixture.detectChanges(); };
  const editor = () => el().querySelector('textarea[aria-label="Email HTML"]') as HTMLTextAreaElement;
  const typeHtml = (v: string) => { editor().value = v; editor().dispatchEvent(new Event('input')); fixture.detectChanges(); };
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
    expect(comp.contentMode).withContext('a newly opened campaign starts in Edit').toBe('edit');
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
    expect(modeTab('edit').getAttribute('aria-selected')).toBe('true');
    expect(modeTab('preview').getAttribute('aria-selected')).toBe('false');
    expect(editor().value).toBe(ORIGINAL);
    expect(el().querySelector('.ec-preview')).toBeNull();
    expect(button('Insert unsubscribe link')).withContext('the toolbar shows in Edit').toBeTruthy();
    toPreview();
    expect(editor()).toBeNull();
    expect(button('Insert unsubscribe link')).withContext('and not in Preview').toBeUndefined();
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
    tick();
    expect(editor().value).toBe('<p>Template HTML</p>');
    flush();
  }));

  it('switching modes never saves, validates, approves or sends (no request at all)', () => {
    toPreview(); toEdit(); toPreview();
    (el().querySelector('[aria-label="Preview width"] button:last-child') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(comp.previewWidth).toBe('mobile');
    http.expectNone(() => true);
  });

  it('arrow keys switch between Edit and Preview', fakeAsync(() => {
    el().querySelector('[aria-label="Email content view"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    fixture.detectChanges();
    tick();
    expect(comp.contentMode).toBe('preview');
    flush();
  }));

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
    button('Insert unsubscribe link').click();
    fixture.detectChanges();
    expect(comp.form.html).toContain('$[LI:UNSUBSCRIBE]$');
    expect(el().querySelector('.ec-hints')).toBeNull();
    const toasts: string[] = [];
    comp.toast.subscribe(t => toasts.push(t));
    button('Insert unsubscribe link').click();
    expect(comp.form.html.split('$[LI:UNSUBSCRIBE]$').length).toBe(2);
    expect(toasts[0]).toContain('already');
  });

  it('http:// images get a reminder to use https://', () => {
    typeHtml('<p><a href="$[LI:UNSUBSCRIBE]$">u</a></p><img src="http://cdn.example.com/a.png">');
    expect(el().querySelector('.ec-hints')!.textContent).toContain('https://');
  });

  it('a campaign that can no longer be edited opens on its preview, with the editor read-only', fakeAsync(() => {
    (comp as any).setSelected({ id: 9, name: 'Sent', status: 'submitted', version: 2, html: '<p>Sent content</p>', lists: [] });
    fixture.detectChanges();
    expect(comp.contentMode).toBe('preview');
    expect(button('Choose template')).toBeUndefined();
    toEdit();
    tick();
    expect(editor().disabled).toBeTrue();
    expect(button('Insert unsubscribe link')).toBeUndefined();
    flush();
  }));
});
