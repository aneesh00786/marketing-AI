import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { LeadAccessComponent } from './lead-access.component';

const ACCESS = (o: any = {}) => ({
  leadId: 5, leadName: 'Acme', yourAccess: 'admin', canManageAccess: true, source: 'import',
  createdBy: { userId: 1, name: 'Ann', role: 'Member', active: true },
  owner: { userId: 1, name: 'Ann', role: 'Member', active: true },
  grants: [], members: [{ userId: 1, name: 'Ann', email: 'ann@x.io', role: 'Member' }, { userId: 3, name: 'Bo', email: 'bo@x.io', role: 'Member' }],
  ...o
});

describe('LeadAccessComponent: assign lead', () => {
  let fixture: ComponentFixture<LeadAccessComponent>;
  let http: HttpTestingController;
  const c = () => fixture.componentInstance;
  const el = () => fixture.nativeElement as HTMLElement;

  function open(data: any): void {
    TestBed.configureTestingModule({ imports: [LeadAccessComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(LeadAccessComponent);
    c().leadId = 5;
    fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/leads/5/access')).flush(data);
    fixture.detectChanges();
  }
  afterEach(() => http.verify());

  it('shows who created it and who it is assigned to; no sharing controls', () => {
    open(ACCESS());
    expect(el().textContent).toContain('Lead Assigned');
    expect(el().textContent).toContain('Excel / CSV import');
    expect(el().textContent).not.toContain('Share');
  });

  it('reassigns the lead to another member (the previous one keeps nothing)', () => {
    open(ACCESS());
    let msg = '';
    c().changed.subscribe(m => msg = m);
    c().ownerChoice = 3;
    c().changeOwner();
    const req = http.expectOne(r => r.method === 'PUT' && r.url.endsWith('/leads/5/owner'));
    expect(req.request.body).toEqual({ ownerUserId: 3, previousOwnerAccess: 'none' });
    req.flush({ access: ACCESS({ owner: { userId: 3, name: 'Bo', active: true } }) });
    expect(msg).toBe('Lead assigned to Bo.');
  });

  it('members see the facts only', () => {
    open(ACCESS({ canManageAccess: false, members: null }));
    expect(el().textContent).toContain('Only workspace Owners and Admins can assign leads');
    expect(el().querySelector('select')).toBeNull();
  });
});
