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
  // ---- Campaign preview ----
  const previewDoc = () => (el().querySelector('.ec-preview iframe') as HTMLIFrameElement).getAttribute('srcdoc') || '';
  const previewCmp = () => fixture.debugElement.query(By.directive(EmailPreviewComponent)).componentInstance as EmailPreviewComponent;

  it('the campaign HTML renders in a visible, sandboxed preview', () => {
    const frame = el().querySelector('.ec-preview iframe') as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(previewDoc()).toContain('Original campaign content');
    const box = frame.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(100);
    expect(box.height).toBeGreaterThan(250);
  });

  it('editing the HTML updates the preview without saving anything', fakeAsync(() => {
    previewCmp().onLoad();
    comp.form.html = '<p>Edited text</p>';
    fixture.detectChanges();
    tick(300);
    expect(previewDoc()).toContain('Edited text');
    expect(comp.selected.html).toBe(ORIGINAL, 'the saved campaign is untouched until Save');
    flush();
  }));

  it('choosing a template updates the preview; cancelling leaves the preview and content as they were', fakeAsync(() => {
    spyOn(window, 'confirm').and.returnValue(true);
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
    previewCmp().onLoad();
    (comp as any).setSelected({ id: 6, name: 'Winter', status: 'draft', version: 1, html: '<h1>Winter campaign</h1>', lists: [] });
    fixture.detectChanges();
    expect(previewDoc()).toContain('Winter campaign');
    expect(previewDoc()).not.toContain('Original campaign content');
    flush();
  }));

  it('a campaign without HTML shows an empty state instead of a blank box', fakeAsync(() => {
    previewCmp().onLoad();
    (comp as any).setSelected({ id: 7, name: 'Empty', status: 'draft', version: 1, html: '', lists: [] });
    fixture.detectChanges();
    expect(el().querySelector('.ec-preview')!.textContent).toContain('No HTML content yet');
    flush();
  }));

  it('dangerous markup in a campaign cannot run in the preview', () => {
    (comp as any).setSelected({ id: 8, name: 'X', status: 'draft', version: 1, lists: [], html: '<p id="ecx">Hi</p><script>window.__ecPwn = 1</script><img src="x" onerror="window.__ecPwn2 = 1"><a href="javascript:alert(1)">x</a>' });
    fixture.detectChanges();
    const doc = previewDoc();
    expect(doc).not.toContain('<script>window.__ecPwn');
    expect(doc).not.toContain('onerror');
    expect(doc).not.toContain('javascript:');
    expect(el().querySelector('#ecx')).toBeNull();
    expect((window as any).__ecPwn).toBeUndefined();
    expect((window as any).__ecPwn2).toBeUndefined();
  });
});
