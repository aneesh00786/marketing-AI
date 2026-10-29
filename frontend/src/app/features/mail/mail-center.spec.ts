import { Component, EventEmitter, Input, Output } from '@angular/core';
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MailCenterComponent } from './mail-center.component';
import { MailDraftsComponent } from './mail-drafts.component';
import { ProductEmailsComponent } from './product-emails.component';
import { EmailCampaignsComponent } from './email-campaigns.component';
import { EmailTemplatesComponent } from './email-templates.component';
import { MailSettingsComponent } from './mail-settings.component';
import { MailActivityChartsComponent } from './mail-activity-charts.component';
import { MailLogsComponent } from './mail-logs.component';

// The hosted sections are tested in their own specs; here they are stand-ins that record their inputs.
@Component({ selector: 'app-mail-drafts', standalone: true, template: '<p class="stub-drafts">{{ view }}</p>' })
class DraftsStub {
  static last: DraftsStub | null = null;
  @Input() view = 'drafts'; @Input() products: any; @Input() initialStatus: any; @Input() openDraftId: any;
  @Input() startAction: any; @Input() startTemplate: any; @Input() startProduct: any;
  @Output() actionConsumed = new EventEmitter<void>(); @Output() templateConsumed = new EventEmitter<void>(); @Output() productConsumed = new EventEmitter<void>();
  @Output() toast = new EventEmitter<string>(); @Output() changed = new EventEmitter<void>(); @Output() sent = new EventEmitter<void>();
  constructor() { DraftsStub.last = this; }
}
@Component({ selector: 'app-product-emails', standalone: true, template: '<p class="stub-pe">product emails</p>' })
class ProductEmailsStub { @Output() toast = new EventEmitter<string>(); }
@Component({ selector: 'app-email-campaigns', standalone: true, template: '<p class="stub-campaigns">campaigns</p>' })
class CampaignsStub { @Input() oauthResult: any; @Input() startTemplate: any; @Output() toast = new EventEmitter<string>(); }
@Component({ selector: 'app-email-templates', standalone: true, template: '<p class="stub-templates">templates</p>' })
class TemplatesStub { @Output() toast = new EventEmitter<string>(); @Output() use = new EventEmitter<any>(); }
@Component({ selector: 'app-mail-activity-charts', standalone: true, template: '<p class="stub-charts">charts</p>' })
class ChartsStub { static last: ChartsStub | null = null; @Output() openLogs = new EventEmitter<void>(); constructor() { ChartsStub.last = this; } }
@Component({ selector: 'app-mail-logs', standalone: true, template: '<p class="stub-logs">logs</p>' })
class LogsStub { static last: LogsStub | null = null; @Input() canViewAudit = false; @Output() openSection = new EventEmitter<string>(); constructor() { LogsStub.last = this; } }
@Component({ selector: 'app-mail-settings', standalone: true, template: '<p class="stub-settings">settings</p>' })
class SettingsStub {
  static last: SettingsStub | null = null;
  @Output() toast = new EventEmitter<string>(); @Output() changed = new EventEmitter<void>(); @Output() openSection = new EventEmitter<string>();
  constructor() { SettingsStub.last = this; }
}

const d = (id: number, status: string, o: any = {}) => ({ id, status, subject: `Draft ${id}`, recipient_email: 'a@acme.io', placeholders: [], ...o });

describe('MailCenterComponent', () => {
  let fixture: ComponentFixture<MailCenterComponent>;
  let comp: MailCenterComponent;
  let http: HttpTestingController;
  let sections: string[];
  const el = () => fixture.nativeElement as HTMLElement;
  const tabs = () => Array.from(el().querySelectorAll('[role=tab]')) as HTMLButtonElement[];
  const tab = (label: string) => tabs().find(t => t.textContent!.trim().startsWith(label))!;
  const button = (text: string) => Array.from(el().querySelectorAll('button')).find(b => b.textContent!.includes(text)) as HTMLButtonElement;

  function init(opts: { caps?: string[] | null; productEmails?: boolean; drafts?: any[]; section?: any } = {}): void {
    fixture = TestBed.createComponent(MailCenterComponent);
    comp = fixture.componentInstance;
    comp.productEmailsEnabled = !!opts.productEmails;
    comp.drafts = opts.drafts ?? [];
    comp.draftsState = 'ready';
    comp.emails = [{ id: 1, status: 'Sent' }, { id: 2, status: 'Not Sent', is_urgent: 1, is_read: 0 }];
    comp.emailsState = 'ready';
    if (opts.section) comp.section = opts.section;
    sections = [];
    comp.sectionChange.subscribe(s => sections.push(s));
    fixture.detectChanges();
    const me = http.expectOne(r => r.url.endsWith('/auth/me'));
    const caps = opts.caps === undefined ? ['mail.view', 'mail.compose', 'mail.send'] : opts.caps;
    if (caps) me.flush({ capabilities: caps }); else me.flush({}, { status: 500, statusText: 'x' });
    fixture.detectChanges();
  }

  beforeEach(() => {
    DraftsStub.last = null;
    TestBed.configureTestingModule({ imports: [MailCenterComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    TestBed.overrideComponent(MailCenterComponent, {
      remove: { imports: [MailDraftsComponent, ProductEmailsComponent, EmailCampaignsComponent, EmailTemplatesComponent, MailSettingsComponent, MailActivityChartsComponent, MailLogsComponent] },
      add: { imports: [DraftsStub, ProductEmailsStub, CampaignsStub, TemplatesStub, SettingsStub, ChartsStub, LogsStub] }
    });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    // Nothing in Mail Center navigation sends mail or contacts a provider.
    http.expectNone(r => /send|zoho|zepto/i.test(r.url));
    http.verify();
  });

  it('shows one set of sections; Product Emails only while its feature is on', () => {
    init();
    expect(tabs().map(t => t.textContent!.trim().replace(/\s*\d+$/, ''))).toEqual(['Overview', 'Drafts', 'Approvals', 'Campaigns', 'Email Templates', 'Logs', 'Settings']);
    fixture.destroy();
    init({ productEmails: true });
    expect(tab('Product Emails')).toBeTruthy();
  });

  it('switching tabs shows that section and reports it to the shell', () => {
    init();
    expect(tab('Overview').getAttribute('aria-selected')).toBe('true');
    tab('Drafts').click();
    fixture.detectChanges();
    expect(sections).toEqual(['drafts']);
    expect(el().querySelector('.stub-drafts')!.textContent).toBe('drafts');
    tab('Approvals').click();
    fixture.detectChanges();
    expect(el().querySelector('.stub-drafts')!.textContent).toBe('approvals', 'Approvals reuses the drafts component in its approvals view');
    tab('Campaigns').click();
    fixture.detectChanges();
    expect(el().querySelector('.stub-campaigns')).toBeTruthy();
    tab('Email Templates').click();
    fixture.detectChanges();
    expect(el().querySelector('.stub-templates')).toBeTruthy();
  });

  it('tabs follow the keyboard pattern: arrows, Home and End move and open; only the active tab is in the tab order', fakeAsync(() => {
    init();
    expect(tabs().map(t => t.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1]);
    tab('Overview').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    fixture.detectChanges();
    tick();
    expect(comp.active).toBe('drafts');
    expect(document.activeElement).toBe(tab('Drafts'));
    tab('Drafts').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    fixture.detectChanges();
    tick();
    expect(comp.active).toBe('settings');
    tab('Settings').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    fixture.detectChanges();
    tick();
    expect(comp.active).toBe('overview', 'wraps around');
  }));

  it('a section this workspace does not have (Product Emails switched off) falls back to the overview', () => {
    init({ section: 'product-emails' });
    expect(comp.active).toBe('overview');
    expect(el().querySelector('.stub-pe')).toBeNull();
  });

  it('the overview counts only loaded drafts and messages, and its shortcuts open the matching filter', () => {
    init({ drafts: [d(1, 'Draft'), d(2, 'Draft'), d(3, 'Approved'), d(4, 'Needs Review'), d(5, 'Sent')] });
    const metrics = Array.from(el().querySelectorAll('.mc-metric')).map(m => m.querySelector('strong')!.textContent!.trim());
    expect(metrics).toEqual(['2', '1', '1', '1', '2']);
    expect(el().textContent).toContain('1 urgent unread · 1 not sent');
    expect(el().querySelector('.stub-settings')).withContext('settings live in their own tab').toBeNull();
    (el().querySelector('.mc-metric') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(sections).toEqual(['approvals']);
    expect(DraftsStub.last!.view).toBe('approvals');
    expect(DraftsStub.last!.initialStatus).toBe('Draft');
    expect(tab('Approvals').textContent).toContain('4');
  });

  it('counts are not shown (no zeros) while drafts are loading or failed', () => {
    init();
    comp.draftsState = 'loading';
    fixture.detectChanges();
    expect(el().querySelector('.mc-metric strong')!.textContent!.trim()).toBe('—');
    comp.draftsState = 'error';
    fixture.detectChanges();
    expect(el().textContent).toContain('Draft counts could not be loaded');
  });

  it('drafts needing attention link straight to that draft', () => {
    init({ drafts: [d(1, 'Draft', { recipient_email: '' }), d(2, 'Needs Review'), d(3, 'Draft', { placeholders: ['{{name}}'] }), d(4, 'Draft')] });
    const items = Array.from(el().querySelectorAll('.mc-attn-item')) as HTMLButtonElement[];
    expect(items.map(i => i.querySelector('small')!.textContent)).toEqual(['Delivery unknown: confirm whether it arrived', 'No recipient selected', '1 placeholder to fill']);
    items[1].click();
    fixture.detectChanges();
    expect(sections).toEqual(['drafts']);
    expect(DraftsStub.last!.openDraftId).toBe(1);
  });

  it('Create Email offers AI and template drafts; each opens the generator in Drafts and sends nothing', () => {
    init();
    button('Create Email').click();
    fixture.detectChanges();
    const items = Array.from(el().querySelectorAll('[role=menuitem]')).map(i => i.querySelector('strong')!.textContent);
    expect(items).toEqual(['Generate with AI', 'Start from a template']);
    (el().querySelectorAll('[role=menuitem]')[1] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(comp.createMenuOpen).toBeFalse();
    expect(sections).toEqual(['drafts']);
    expect(DraftsStub.last!.startAction).toBe('template');
    DraftsStub.last!.actionConsumed.emit();
    expect(comp.draftAction).toBeNull();
    button('Create Email').click();
    fixture.detectChanges();
    (el().querySelector('[role=menuitem]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(DraftsStub.last!.startAction).toBe('ai');
  });

  it('Escape and outside clicks close the Create Email menu', () => {
    init();
    button('Create Email').click();
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(comp.createMenuOpen).toBeFalse();
    button('Create Email').click();
    document.body.click();
    expect(comp.createMenuOpen).toBeFalse();
  });

  it('a role without mail.compose cannot open Create Email (the Approver role can still review approvals)', () => {
    init({ caps: ['mail.view', 'mail.send'] });
    expect(button('Create Email').disabled).toBeTrue();
    tab('Approvals').click();
    fixture.detectChanges();
    expect(el().querySelector('.stub-drafts')).toBeTruthy();
  });

  it('a role without mail.view sees why, and no mail sections load', () => {
    init({ caps: ['members.view'] });
    expect(el().textContent).toContain('cannot view mail');
    expect(el().querySelector('.mc-metrics')).toBeNull();
  });

  it('when permissions cannot be read, the page still works and the server decides', () => {
    init({ caps: null });
    expect(button('Create Email').disabled).toBeFalse();
    expect(el().querySelector('.mc-metrics')).toBeTruthy();
  });

  it('the overview shows the activity charts (no admin report); its log link opens Logs', () => {
    init();
    expect(el().querySelector('.stub-charts')).toBeTruthy();
    expect(el().querySelector('app-compose-report')).toBeNull();
    ChartsStub.last!.openLogs.emit();
    fixture.detectChanges();
    expect(sections).toEqual(['logs']);
    expect(el().querySelector('.stub-logs')).toBeTruthy();
  });

  it('Logs offers the Compose audit to Owners/Admins (mail.configure) only, and can open Campaigns', () => {
    init({ section: 'logs' });
    expect(LogsStub.last!.canViewAudit).toBeFalse();
    LogsStub.last!.openSection.emit('campaigns');
    fixture.detectChanges();
    expect(sections).toEqual(['campaigns']);
    fixture.destroy();
    init({ caps: ['mail.view', 'mail.compose', 'mail.send', 'mail.configure'], section: 'logs' });
    expect(LogsStub.last!.canViewAudit).toBeTrue();
  });

  it('Needs attention appears only when a draft needs someone', () => {
    init({ drafts: [d(1, 'Approved')] });
    expect(el().querySelector('.mc-attention')).toBeNull();
    fixture.destroy();
    init({ drafts: [d(2, 'Needs Review')] });
    expect(el().querySelector('.mc-attention')!.textContent).toContain('Delivery unknown');
  });

  it('all mail settings are in the Settings tab; it can send the user to Campaigns and reports saved changes', () => {
    init();
    let changed = 0;
    comp.settingsChanged.subscribe(() => changed++);
    tab('Settings').click();
    fixture.detectChanges();
    expect(sections).toEqual(['settings']);
    expect(el().querySelector('.stub-settings')).toBeTruthy();
    SettingsStub.last!.changed.emit();
    expect(changed).toBe(1);
    SettingsStub.last!.openSection.emit('campaigns');
    fixture.detectChanges();
    expect(sections).toEqual(['settings', 'campaigns']);
    expect(el().querySelector('.stub-campaigns')).toBeTruthy();
  });
});
