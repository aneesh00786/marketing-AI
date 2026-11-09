import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { LeadFollowupsComponent } from './lead-followups.component';
import { ComposeRequestService } from '../../core/compose-request.service';
import { CallService } from '../../shared/calling/call.service';

const LEAD = { id: 7, name: 'Priya Shah', email: 'priya@shop.io', phone: '+61 412 345 678', status: 'New' };
const SUMMARY = (canAct = true) => ({ totalCalls: 1, totalEmails: 2, completedFollowups: 1, pendingFollowups: 1, overdueFollowups: 1, lastContacted: null, nextFollowup: null, lastCall: null, yourAccess: canAct ? 'owner' : 'view', canAct });
const ITEMS = [
  { kind: 'followup', id: 3, type: 'call', title: 'Call back', status: 'overdue', priority: 'high', dueAt: '2026-11-01T10:00:00Z', at: '2026-11-01T10:00:00Z' },
  { kind: 'call', id: 9, type: 'call', answered: true, durationSeconds: 95, callerName: 'Ann', transcribed: true, startedAt: '2026-11-02T10:00:00Z', at: '2026-11-02T10:00:00Z',
    conversation: [{ speaker: 'agent', start: 1, text: 'Hi Priya' }, { speaker: 'customer', start: 3, text: 'Send the quote please' }] },
  { kind: 'email', id: 4, type: 'email', direction: 'sent', title: 'Your quote', at: '2026-11-03T10:00:00Z', summary: 'Here it is' }
];

describe('LeadFollowupsComponent', () => {
  let fixture: ComponentFixture<LeadFollowupsComponent>;
  let http: HttpTestingController;
  const c = () => fixture.componentInstance;
  const el = () => fixture.nativeElement as HTMLElement;

  function open(canAct = true): void {
    TestBed.configureTestingModule({ imports: [LeadFollowupsComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(LeadFollowupsComponent);
    c().lead = LEAD;
    fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/calling/status')).flush({ canCall: true, configured: true });
    http.expectOne(r => r.url.endsWith('/leads/7/followup-summary')).flush(SUMMARY(canAct));
    http.expectOne(r => r.url.endsWith('/leads/7/timeline')).flush({ items: ITEMS, canAct });
    http.expectOne(r => r.url.endsWith('/leads/7/notes')).flush({ notes: [], canEdit: canAct });
    fixture.detectChanges();
  }
  afterEach(() => http.verify());

  it('shows the summary, the overdue follow-up first, the call transcript and the email', () => {
    open();
    expect(el().textContent).toContain('Overdue');
    expect(el().querySelector('.lf-fu.overdue')!.textContent).toContain('Call back');
    expect(el().textContent).toContain('Send the quote please');
    expect(el().textContent).toContain('Your quote');
    c().transcriptSearch[9] = 'quote';
    expect(c().shownLines(ITEMS[1]).length).toBe(1);
  });

  it('✉ opens the existing Compose and 📞 the existing call panel, linked to the lead and follow-up', () => {
    open();
    const compose = TestBed.inject(ComposeRequestService);
    const calls = TestBed.inject(CallService);
    spyOn(compose, 'open');
    spyOn(calls, 'prepare');
    c().emailLead();
    expect(compose.open).toHaveBeenCalledWith(jasmine.objectContaining({ email: 'priya@shop.io', name: 'Priya Shah' }));
    c().callLead(3);
    expect(calls.prepare).toHaveBeenCalledWith('+61 412 345 678', 'Priya Shah', null, null, { leadId: 7, followupId: 3 });
  });

  it('schedules a follow-up and adds a note through the lead API', () => {
    open();
    c().open('followup');
    c().fu.title = 'Send brochure';
    c().fu.type = 'email';
    c().saveFollowup();
    const req = http.expectOne(r => r.method === 'POST' && r.url.endsWith('/leads/7/followups'));
    expect(req.request.body).toEqual(jasmine.objectContaining({ title: 'Send brochure', type: 'email', priority: 'medium' }));
    req.flush({ followup: {} });
    http.expectOne(r => r.url.endsWith('/followup-summary')).flush(SUMMARY());
    http.expectOne(r => r.url.endsWith('/timeline')).flush({ items: [], canAct: true });
    http.expectOne(r => r.url.endsWith('/notes')).flush({ notes: [] });
    c().note = { category: 'objections', text: 'Too expensive' };
    c().saveNote();
    const n = http.expectOne(r => r.method === 'POST' && r.url.endsWith('/leads/7/activities'));
    expect(n.request.body).toEqual({ type: 'note', noteCategory: 'objections', description: 'Too expensive' });
    n.flush({});
    http.expectOne(r => r.url.endsWith('/followup-summary')).flush(SUMMARY());
    http.expectOne(r => r.url.endsWith('/timeline')).flush({ items: [], canAct: true });
    http.expectOne(r => r.url.endsWith('/notes')).flush({ notes: [] });
  });

  it('view-only: no quick actions, only the history', () => {
    open(false);
    expect(el().textContent).toContain('view-only access');
    expect(el().querySelector('.lf-actions')).toBeNull();
    expect(el().querySelector('.lf-fu-actions')).toBeNull();
  });
});
