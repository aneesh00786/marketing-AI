import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { LoginComponent } from './login.component';

const TOKEN = 'a'.repeat(43);

describe('LoginComponent: invitations and passwords', () => {
  let fixture: ComponentFixture<LoginComponent>;
  let http: HttpTestingController;
  const c = () => fixture.componentInstance;

  function create(): void {
    fixture = TestBed.createComponent(LoginComponent);
    fixture.detectChanges();
  }

  beforeEach(() => {
    sessionStorage.removeItem('marketech_invite_token');
    sessionStorage.removeItem('marketech_reset_token');
    TestBed.configureTestingModule({ imports: [LoginComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    http.verify();
    sessionStorage.removeItem('marketech_invite_token');
    sessionStorage.removeItem('marketech_reset_token');
  });

  it('a new invitee sets a password and joins (email fixed to the invitation)', () => {
    sessionStorage.setItem('marketech_invite_token', TOKEN);
    create();
    http.expectOne(r => r.url.endsWith('/invitations/public-preview')).flush({
      valid: true, accountExists: false, invitation: { email: 'new@corp.io', role: 'Member', workspaceName: 'Acme', invitedBy: 'Ann' }
    });
    fixture.detectChanges();
    expect(c().mode).toBe('join');
    expect(c().heading).toBe('Join Acme');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Ann invited new@corp.io to Acme as Member.');

    c().password = 'a-good-password'; c().confirm = 'different-password';
    c().submit();
    expect(c().error).toContain('do not match');
    c().confirm = 'a-good-password'; c().displayName = 'New';
    spyOn(c().loggedIn, 'emit');
    c().submit();
    const req = http.expectOne(r => r.url.endsWith('/invitations/signup'));
    expect(req.request.body).toEqual({ token: TOKEN, password: 'a-good-password', displayName: 'New' });
    req.flush({ user: { id: 9 }, workspace: { id: 3 }, session: { id: 'j', userId: 9, workspaceId: 3 } });
    expect(c().loggedIn.emit).toHaveBeenCalled();
    expect(sessionStorage.getItem('marketech_invite_token')).toBeNull();
  });

  it('an invitee who already has an account is asked to sign in, email filled in', () => {
    sessionStorage.setItem('marketech_invite_token', TOKEN);
    create();
    http.expectOne(r => r.url.endsWith('/invitations/public-preview')).flush({
      valid: true, accountExists: true, invitation: { email: 'old@corp.io', role: 'Member', workspaceName: 'Acme' }
    });
    expect(c().mode).toBe('login');
    expect(c().email).toBe('old@corp.io');
    expect(c().heading).toBe('Sign in to accept your invitation');
  });

  it('forgot password sends the email and shows the neutral message', () => {
    create();
    c().go('forgot');
    c().email = 'me@corp.io';
    c().submit();
    http.expectOne(r => r.url.endsWith('/auth/forgot-password')).flush({ message: 'If an account exists for that email, we have sent a link to reset the password.' });
    expect(c().info).toContain('If an account exists');
  });

  it('a reset link opens the new-password form and returns to sign in afterwards', () => {
    sessionStorage.setItem('marketech_reset_token', TOKEN);
    create();
    expect(c().mode).toBe('reset');
    c().password = 'new-password-123'; c().confirm = 'new-password-123';
    c().submit();
    const req = http.expectOne(r => r.url.endsWith('/auth/reset-password'));
    expect(req.request.body).toEqual({ token: TOKEN, password: 'new-password-123' });
    req.flush({ success: true });
    expect(c().mode).toBe('login');
    expect(c().info).toContain('Password changed');
    expect(sessionStorage.getItem('marketech_reset_token')).toBeNull();
  });
});
