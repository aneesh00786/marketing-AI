import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MembersComponent } from './members.component';

const CAP = 'mail.send_transactional';
const data = (o: any = {}) => ({
  canManage: true, canManageOwners: true, roles: ['Workspace Owner', 'Workspace Admin', 'Marketing Manager', 'Approver', 'Member'], invitations: [],
  grantable: [{ capability: CAP, label: 'Send transactional email (Compose)', requires: 'mail.send' }],
  members: [
    { userId: 1, email: 'own@x.io', role: 'Workspace Owner', status: 'Active', isYou: true, grants: { [CAP]: 'role' } },
    { userId: 2, email: 'mm@x.io', role: 'Marketing Manager', status: 'Active', grants: { [CAP]: 'eligible' } },
    { userId: 3, email: 'ap@x.io', role: 'Approver', status: 'Active', grants: { [CAP]: 'granted' } },
    { userId: 4, email: 'mem@x.io', role: 'Member', status: 'Active', grants: { [CAP]: 'not_eligible' } }
  ],
  ...o
});

describe('MembersComponent: transactional email grants', () => {
  let fixture: ComponentFixture<MembersComponent>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const row = (email: string) => Array.from(el().querySelectorAll('tbody tr')).find(r => r.textContent!.includes(email)) as HTMLElement;

  function init(d: any): void {
    fixture = TestBed.createComponent(MembersComponent);
    fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/workspace/members')).flush(d);
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [MembersComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('shows the grant state per member: included in role, grantable, granted, not eligible', () => {
    init(data());
    expect(el().querySelector('thead')!.textContent).toContain('Transactional email');
    expect(row('own@x.io').textContent).toContain('Included in role');
    expect((row('mm@x.io').querySelector('input[type=checkbox]') as HTMLInputElement).checked).toBeFalse();
    expect((row('ap@x.io').querySelector('input[type=checkbox]') as HTMLInputElement).checked).toBeTrue();
    expect(row('mem@x.io').querySelector('input[type=checkbox]')).toBeNull();
  });

  it('granting asks first, then calls the grant API; revoking calls DELETE', () => {
    init(data());
    spyOn(window, 'confirm').and.returnValue(true);
    (row('mm@x.io').querySelector('input[type=checkbox]') as HTMLInputElement).dispatchEvent(new Event('change'));
    const put = http.expectOne(r => r.method === 'PUT' && r.url.endsWith(`/workspace/members/2/grants/${CAP}`));
    put.flush({ granted: true });
    http.expectOne(r => r.url.endsWith('/workspace/members')).flush(data());
    fixture.detectChanges();
    (row('ap@x.io').querySelector('input[type=checkbox]') as HTMLInputElement).dispatchEvent(new Event('change'));
    http.expectOne(r => r.method === 'DELETE' && r.url.endsWith(`/workspace/members/3/grants/${CAP}`)).flush({ granted: false });
    http.expectOne(r => r.url.endsWith('/workspace/members')).flush(data());
  });

  it('members who cannot manage see no grant column', () => {
    init(data({ canManage: false, grantable: [], members: data().members.map((m: any) => ({ ...m, grants: undefined })) }));
    expect(el().querySelector('thead')!.textContent).not.toContain('Transactional email');
  });
});
