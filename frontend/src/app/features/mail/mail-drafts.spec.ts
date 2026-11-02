import { ComponentFixture, TestBed, fakeAsync, flush, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MailDraftsComponent } from './mail-drafts.component';

const draft = (o: any = {}) => ({ id: 1, subject: 'Hello Dana', recipient_name: 'Dana', recipient_email: 'dana@acme.io', product_name: 'BusTrack', status: 'Draft', tone: 'Professional', body_html: '<p>Hi</p>', placeholders: [], updated_at: '2026-10-26T10:00:00Z', ...o });

// Marketing delivery status returned by GET /mail/marketing (overridable per test).
let marketingStatus: any = { allowed: true, code: null, reason: null };

describe('MailDraftsComponent', () => {
  let fixture: ComponentFixture<MailDraftsComponent>;
  let comp: MailDraftsComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const button = (text: string) => Array.from(el().querySelectorAll('button')).find(b => b.textContent!.trim().includes(text)) as HTMLButtonElement | undefined;

  function init(drafts: any[] = [draft()], caps: string[] | null = ['mail.view', 'mail.compose', 'mail.send']): void {
    fixture = TestBed.createComponent(MailDraftsComponent);
    comp = fixture.componentInstance;
    comp.products = [{ id: 7, name: 'BusTrack' }, { id: 8, name: 'FleetPro' }];
    fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/api/drafts')).flush({ drafts });
    const me = http.expectOne(r => r.url.endsWith('/auth/me'));
    if (caps) me.flush({ capabilities: caps }); else me.flush({}, { status: 500, statusText: 'x' });
    http.expectOne(r => r.url.endsWith('/mail/marketing')).flush({ marketing: marketingStatus });
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [MailDraftsComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('shows the queue and the selected draft; the old always-visible generator is gone', async () => {
    init([draft(), draft({ id: 2, subject: 'Second', status: 'Sent' })]);
    await fixture.whenStable();
    expect(el().textContent).not.toContain('Generate High-Converting');
    expect(el().querySelectorAll('.md-item').length).toBe(2);
    expect((el().querySelector('.md-subject-input') as HTMLInputElement).value).toBe('Hello Dana');
    expect(button('Create AI Draft')).toBeTruthy();
  });

  it('filters by status (only statuses present) and searches subject/recipient/product', () => {
    init([draft(), draft({ id: 2, subject: 'Fleet offer', status: 'Approved', product_name: 'FleetPro' })]);
    const chips = Array.from(el().querySelectorAll('.fchip')).map(c => c.textContent!.trim().split(/\s+/)[0]);
    expect(chips).toEqual(['All', 'Draft', 'Approved']);
    comp.statusFilter = 'Approved';
    expect(comp.filtered.map(d => d.id)).toEqual([2]);
    comp.statusFilter = 'all';
    comp.query = 'fleetpro';
    expect(comp.filtered.map(d => d.id)).toEqual([2]);
  });

  it('generating sends only what the user chose: no guessed recipient, never a send', () => {
    init([]);
    comp.openCreate();
    comp.form.goal = 'Intro';
    comp.form.productId = 7;
    comp.generate();
    comp.generate(); // a double click does not submit twice
    const req = http.expectOne(r => r.url.endsWith('/api/drafts/generate'));
    expect(req.request.body.recipientEmail).toBe('');
    expect(req.request.body.leadId).toBeUndefined();
    expect(req.request.body.productId).toBe(7);
    expect(comp.generating).toBeTrue();
    req.flush({ draft: draft({ id: 9, subject: 'New one' }), message: 'Email draft created. Awaiting your approval before sending.' });
    http.expectOne(r => r.url.endsWith('/api/drafts')).flush({ drafts: [draft({ id: 9, subject: 'New one' })] });
    http.expectNone(r => r.url.includes('/send'));
    expect(comp.showCreate).toBeFalse();
    expect(comp.selected.id).toBe(9, 'the new draft is selected');
  });

  it('a generation error stays in the modal; Escape or the backdrop asks before discarding input', () => {
    init([]);
    comp.openCreate();
    comp.form.goal = 'Something';
    comp.generate();
    http.expectOne(r => r.url.endsWith('/api/drafts/generate')).flush({ error: 'No AI model is configured.' }, { status: 503, statusText: 'x' });
    expect(comp.showCreate).toBeTrue();
    expect(comp.createError).toContain('No AI model');
    const confirmSpy = spyOn(window, 'confirm').and.returnValue(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(comp.showCreate).toBeTrue();
    confirmSpy.and.returnValue(true);
    comp.closeCreate();
    expect(comp.showCreate).toBeFalse();
  });

  it('an empty modal closes without asking', () => {
    init([]);
    const confirmSpy = spyOn(window, 'confirm');
    comp.openCreate();
    comp.closeCreate();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(comp.showCreate).toBeFalse();
  });

  it('approval and sending are blocked, with a reason, for unsaved edits, placeholders, bad recipients and roles without mail.send', () => {
    init([draft()]);
    comp.edit.subject = 'Changed';
    expect(comp.sendBlocker).toContain('Save your changes');
    comp.discard();
    comp.selected = draft({ placeholders: ['[Your name]'] });
    comp.discard();
    expect(comp.sendBlocker).toContain('placeholder');
    comp.selected = draft({ recipient_email: '' });
    comp.discard();
    expect(comp.sendBlocker).toContain('Select a contact');
  });

  it('a member without mail.send sees why they cannot approve or send', () => {
    init([draft()], ['mail.view', 'mail.compose']);
    expect(comp.sendBlocker).toContain('cannot approve or send');
    expect(button('Approve & Send')!.disabled).toBeTrue();
    expect(el().textContent).toContain('cannot approve or send');
  });

  it('saving sends only changed fields, and an approved draft is reported as needing approval again', () => {
    init([draft({ status: 'Approved' })]);
    comp.edit.body = '<p>New body</p>';
    comp.save();
    const req = http.expectOne(r => r.method === 'PATCH');
    expect(req.request.body).toEqual({ body_html: '<p>New body</p>' });
    req.flush({ draft: draft({ status: 'Draft', body_html: '<p>New body</p>' }) });
    expect(comp.selected.status).toBe('Draft');
  });

  it('Approve & Send asks first, approves, then sends; cancelling sends nothing', () => {
    init([draft()]);
    const confirmSpy = spyOn(window, 'confirm').and.returnValue(false);
    comp.send();
    http.expectNone(r => r.url.includes('/approve') || r.url.includes('/send'));
    confirmSpy.and.returnValue(true);
    comp.send();
    http.expectOne(r => r.url.endsWith('/approve')).flush({ draft: draft({ status: 'Approved' }) });
    const send = http.expectOne(r => r.url.endsWith('/send'));
    expect(send.request.body).toEqual({ confirm: true });
    send.flush({ message: 'Email sent.' });
    http.expectOne(r => r.url.endsWith('/api/drafts')).flush({ drafts: [draft({ status: 'Sent' })] });
  });

  it('an unknown delivery outcome is shown as such and never retried automatically', fakeAsync(() => {
    init([draft({ status: 'Approved' })]);
    spyOn(window, 'confirm').and.returnValue(true);
    comp.send();
    http.expectOne(r => r.url.endsWith('/send')).flush({ error: 'The mail server did not answer.', code: 'MAIL_OUTCOME_UNKNOWN' }, { status: 502, statusText: 'x' });
    http.expectOne(r => r.url.endsWith('/api/drafts')).flush({ drafts: [draft({ status: 'Needs Review' })] });
    tick();
    fixture.detectChanges();
    expect(el().textContent).toContain('Delivery unknown');
    expect(el().textContent).toContain('never resent automatically');
    expect(button('Approve & Send')).toBeUndefined();
    expect(button('Send email')).toBeUndefined();
    expect(button('It was delivered')).toBeTruthy();
    // A draft whose outcome is unknown shows its tracking (read-only).
    http.expectOne(r => r.url.endsWith('/mail/tracking/drafts/1')).flush({ tracking: { tracked: false } });
    http.expectNone(r => r.url.endsWith('/send'));
    flush(); // the preview's own timers
  }));

  it('deleting asks for confirmation', () => {
    init([draft()]);
    spyOn(window, 'confirm').and.returnValue(false);
    comp.remove();
    http.expectNone(r => r.method === 'DELETE');
  });

  it('switching drafts with unsaved changes asks first', () => {
    init([draft(), draft({ id: 2, subject: 'Other' })]);
    comp.edit.subject = 'Edited';
    spyOn(window, 'confirm').and.returnValue(false);
    comp.select(comp.drafts[1]);
    expect(comp.selected.id).toBe(1);
  });

  it('a product or template chosen elsewhere opens the generator with it selected', () => {
    init([]);
    comp.startProduct = { id: 8 };
    comp.ngOnChanges({ startProduct: { currentValue: comp.startProduct } as any });
    expect(comp.showCreate).toBeTrue();
    expect(comp.form.productId).toBe(8);
    comp.startTemplate = { id: 3, name: 'Welcome' };
    comp.ngOnChanges({ startTemplate: { currentValue: comp.startTemplate } as any });
    expect(comp.template?.name).toBe('Welcome');
  });

  it('the email preview is rendered only in a fully sandboxed iframe', () => {
    init([draft({ body_html: '<p id="x">Hi</p><script>window.__mdpwn = 1</script>' })]);
    const frame = el().querySelector('.md-preview iframe') as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(el().querySelector('#x')).toBeNull();
    expect((window as any).__mdpwn).toBeUndefined();
  });

  it('the selected draft shows one recipient card (no name/email inputs) with the contact\'s details', () => {
    init([draft({ lead_id: 4, contact: { id: 4, name: 'Priya Shah', email: 'priya@acme.io', company: 'Acme' } })]);
    const card = el().querySelector('.md-detail .rcard') as HTMLElement;
    expect(card.textContent).toContain('Priya Shah');
    expect(card.textContent).toContain('priya@acme.io');
    expect(card.textContent).toContain('Acme');
    expect(el().querySelector('.md-detail input[aria-label="Recipient email"]')).toBeNull();
    expect(el().querySelector('.md-detail input[aria-label="Recipient name"]')).toBeNull();
    expect(button('Change Contact')).toBeTruthy();
  });

  it('changing the contact saves the lead link on the server and an approved draft needs approval again', () => {
    init([draft({ status: 'Approved' })]);
    spyOn(window, 'confirm').and.returnValue(true);
    comp.openContactPicker('detail');
    expect(comp.picker).toBe('detail');
    comp.onContactPicked({ id: 12, name: 'Ken Ito', email: 'ken@ito.jp', company: null });
    const req = http.expectOne(r => r.method === 'PATCH');
    expect(req.request.body).toEqual({ lead_id: 12 });
    req.flush({ draft: draft({ status: 'Draft', lead_id: 12, recipient_email: 'ken@ito.jp', contact: { id: 12, name: 'Ken Ito', email: 'ken@ito.jp', company: null } }) });
    expect(comp.selected.status).toBe('Draft');
    expect(comp.selected.contact.id).toBe(12);
  });

  it('cancelling the re-approval warning changes nothing; unsaved edits block a recipient change', () => {
    init([draft({ status: 'Approved' })]);
    spyOn(window, 'confirm').and.returnValue(false);
    comp.picker = 'detail';
    comp.onContactPicked({ id: 12, name: 'Ken', email: 'ken@ito.jp', company: null });
    http.expectNone(r => r.method === 'PATCH');
    comp.edit.subject = 'Edited';
    comp.openContactPicker('detail');
    expect(comp.picker).toBeNull();
  });

  it('a deleted contact blocks approval with a clear reason', () => {
    init([draft({ lead_id: 3, contact: { id: 3, missing: true } })]);
    expect(comp.sendBlocker).toContain('deleted from Leads');
  });

  it('a new draft uses the chosen contact (leadId) or, separately and explicitly, a typed address', () => {
    init([]);
    comp.openCreate();
    comp.picker = 'create';
    comp.onContactPicked({ id: 5, name: 'Dana', email: 'dana@acme.io', company: 'Acme' });
    comp.generate();
    let req = http.expectOne(r => r.url.endsWith('/api/drafts/generate'));
    expect(req.request.body.leadId).toBe(5);
    expect(req.request.body.recipientEmail).toBe('');
    req.flush({}, { status: 500, statusText: 'x' });
    comp.picker = 'create';
    comp.onManualRecipient({ name: 'One-off', email: 'oneoff@x.io' });
    expect(comp.contact).toBeNull();
    comp.generate();
    req = http.expectOne(r => r.url.endsWith('/api/drafts/generate'));
    expect(req.request.body.leadId).toBeUndefined();
    expect(req.request.body.recipientEmail).toBe('oneoff@x.io');
    req.flush({}, { status: 500, statusText: 'x' });
  });

  it('Escape with the contact picker open does not close the Create window', () => {
    init([]);
    comp.openCreate();
    comp.form.goal = 'x';
    comp.picker = 'create';
    const confirmSpy = spyOn(window, 'confirm');
    comp.onEscape();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(comp.showCreate).toBeTrue();
  });
  // ---- product-aware contacts ----
  it('the contact picker starts filtered by the generator product, or by the draft\'s product in the detail view', () => {
    init([draft({ product_id: 8 })]);
    comp.openCreate();
    comp.setFormProduct(7);
    comp.openContactPicker('create');
    fixture.detectChanges();
    expect(http.expectOne(r => r.url.includes('/leads')).request.params.get('productId')).toBe('7');
    comp.picker = null;
    comp.showCreate = false;
    fixture.detectChanges();
    comp.openContactPicker('detail');
    fixture.detectChanges();
    expect(http.expectOne(r => r.url.includes('/leads')).request.params.get('productId')).toBe('8');
  });

  it('a generic draft lists all contacts and needs no product decision', () => {
    init([]);
    comp.openCreate();
    comp.openContactPicker('create');
    fixture.detectChanges();
    expect(http.expectOne(r => r.url.includes('/leads')).request.params.has('productId')).toBeFalse();
    comp.onContactPicked({ id: 5, name: 'Dana', email: 'dana@acme.io', company: null, productId: 8 });
    expect(comp.contactMismatch).toBeFalse();
    comp.generate();
    http.expectOne(r => r.url.endsWith('/api/drafts/generate')).flush({}, { status: 500, statusText: 'x' });
  });

  it('changing the product does not silently keep an incompatible contact: Generate waits for Keep or Choose another', () => {
    init([]);
    comp.openCreate();
    comp.setFormProduct(7);
    comp.picker = 'create';
    comp.onContactPicked({ id: 5, name: 'Dana', email: 'dana@acme.io', company: null, productId: 7 });
    expect(comp.contactMismatch).toBeFalse();
    comp.setFormProduct(8);
    fixture.detectChanges();
    expect(comp.contactDecisionNeeded).toBeTrue();
    expect(el().textContent).toContain('Dana is linked to BusTrack in Leads, not FleetPro');
    expect(button('Generate Draft')!.disabled).toBeTrue();
    comp.generate();
    http.expectNone(r => r.url.endsWith('/api/drafts/generate'));
    expect(comp.contact!.id).toBe(5, 'the contact is not dropped silently either');
    button('Keep this contact')!.click();
    fixture.detectChanges();
    expect(button('Generate Draft')!.disabled).toBeFalse();
    comp.setFormProduct(7);
    comp.setFormProduct(8);
    fixture.detectChanges();
    button('Choose another contact')!.click();
    expect(comp.picker).toBe('create');
    fixture.detectChanges();
    http.expectOne(r => r.url.includes('/leads') && r.params.get('productId') === '8').flush({ leads: [] });
  });

  it('the detail view keeps an existing recipient from another product, explains it, and replaces nothing on its own', () => {
    init([draft({ product_id: 7, lead_id: 4, contact: { id: 4, name: 'Priya Shah', email: 'priya@acme.io', company: null, productId: 8 } })]);
    expect(comp.detailMismatch).toBeTrue();
    expect(el().textContent).toContain('Priya Shah is linked to FleetPro in Leads, not BusTrack');
    expect(el().querySelector('.md-detail .rcard')!.textContent).toContain('priya@acme.io');
    http.expectNone(r => r.method === 'PATCH');
    expect(comp.sendBlocker).toBeNull();
  });

  it('a draft whose contact has the draft\'s product shows no mismatch', () => {
    init([draft({ product_id: 7, lead_id: 4, contact: { id: 4, name: 'Priya', email: 'priya@acme.io', company: null, productId: 7 } })]);
    expect(comp.detailMismatch).toBeFalse();
  });
  // ---- Mail Center: approvals view and Create Email ----
  function initWith(setup: (c: MailDraftsComponent) => void, drafts: any[], caps: string[] = ['mail.view', 'mail.compose', 'mail.send']): void {
    fixture = TestBed.createComponent(MailDraftsComponent);
    comp = fixture.componentInstance;
    comp.products = [{ id: 7, name: 'BusTrack' }];
    setup(comp);
    fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/api/drafts')).flush({ drafts });
    http.expectOne(r => r.url.endsWith('/auth/me')).flush({ capabilities: caps });
    http.expectOne(r => r.url.endsWith('/mail/marketing')).flush({ marketing: marketingStatus });
    fixture.detectChanges();
  }

  it('the approvals view lists only drafts awaiting approval, ready to send or with unknown delivery', () => {
    initWith(c => c.view = 'approvals', [draft({ id: 1 }), draft({ id: 2, status: 'Approved' }), draft({ id: 3, status: 'Sent' }), draft({ id: 4, status: 'Needs Review' }), draft({ id: 5, status: 'Sending' })]);
    expect(comp.filtered.map(d => d.id)).toEqual([1, 2, 4]);
    const chips = Array.from(el().querySelectorAll('.fchip')).map(c => c.textContent!.trim().split(/\s+/)[0]);
    expect(chips).toEqual(['All', 'Draft', 'Approved', 'Needs']);
    expect(el().querySelector('h2')!.textContent).toBe('Approvals');
    expect(button('Create AI Draft')).toBeUndefined();
  });

  it('approving from the approvals view uses the same approval request as Drafts', () => {
    initWith(c => c.view = 'approvals', [draft({ id: 1 })]);
    spyOn(window, 'confirm').and.returnValue(true);
    expect(comp.selected.id).toBe(1);
    comp.approve();
    const req = http.expectOne(r => r.url.endsWith('/api/drafts/1/approve'));
    expect(req.request.method).toBe('PUT');
    req.flush({ draft: draft({ id: 1, status: 'Approved' }) });
    http.match(r => r.url.endsWith('/api/drafts')).forEach(r => r.flush({ drafts: [draft({ id: 1, status: 'Approved' })] }));
    expect(comp.selected.status).toBe('Approved');
    http.expectNone(r => r.url.includes('/send'));
  });

  it('an empty approvals queue says so', () => {
    initWith(c => c.view = 'approvals', [draft({ status: 'Sent' })]);
    expect(el().textContent).toContain('Nothing waiting for approval');
  });

  it('a role without mail.send is told in the approvals view that it cannot approve', () => {
    initWith(c => c.view = 'approvals', [draft()], ['mail.view', 'mail.compose']);
    expect(el().querySelector('.md-head')!.textContent).toContain('which your role does not have');
  });

  it('opens with the status filter or the draft chosen in the overview', () => {
    initWith(c => { c.initialStatus = 'Approved'; c.openDraftId = 3; }, [draft({ id: 1 }), draft({ id: 2, status: 'Approved' }), draft({ id: 3 })]);
    expect(comp.statusFilter).toBe('Approved');
    expect(comp.selected.id).toBe(3);
  });

  it('Create Email: "Generate with AI" opens the generator; "Start from a template" also opens the template picker', () => {
    init([]);
    comp.startAction = 'ai';
    const consumed: number[] = [];
    comp.actionConsumed.subscribe(() => consumed.push(1));
    comp.ngOnChanges({ startAction: { currentValue: 'ai' } as any });
    expect(comp.showCreate).toBeTrue();
    expect(comp.showTemplatePicker).toBeFalse();
    comp.showCreate = false;
    comp.startAction = 'template';
    comp.ngOnChanges({ startAction: { currentValue: 'template' } as any });
    expect(comp.showCreate).toBeTrue();
    expect(comp.showTemplatePicker).toBeTrue();
    expect(consumed.length).toBe(2);
    http.expectNone(r => r.url.endsWith('/api/drafts/generate'));
  });

  it('Create Email does not open the generator for a role without mail.compose', () => {
    init([], ['mail.view', 'mail.send']);
    const toasts: string[] = [];
    comp.toast.subscribe(t => toasts.push(t));
    comp.startAction = 'ai';
    comp.ngOnChanges({ startAction: { currentValue: 'ai' } as any });
    expect(comp.showCreate).toBeFalse();
    expect(toasts[0]).toContain('cannot create drafts');
  });

  // ---- Drafts are marketing email ----
  it('without a mailbox approved for marketing, Send is disabled with the reason, but approval still works', () => {
    marketingStatus = { allowed: false, code: 'MARKETING_PROVIDER_BLOCKED', reason: 'Marketing emails cannot be sent through ZeptoMail.' };
    try {
      init([draft()]);
      const sendBtn = Array.from(el().querySelectorAll('button')).find(b => /Approve & Send|Send email/.test(b.textContent!)) as HTMLButtonElement;
      expect(sendBtn.disabled).toBeTrue();
      expect(el().textContent).toContain("Drafts are marketing email and can't be sent from this workspace yet");
      expect(el().textContent).toContain('cannot be sent through ZeptoMail');
      expect(button('Approve')!.disabled).toBeFalse();
      spyOn(window, 'confirm').and.returnValue(true);
      comp.send();
      http.expectNone(r => r.url.includes('/send'));
    } finally { marketingStatus = { allowed: true, code: null, reason: null }; }
  });
});
