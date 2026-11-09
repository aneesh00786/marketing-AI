import { Component, EventEmitter, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../services/api.service';
import { AuthStateService } from './auth-state.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="login-wrap">
      <form class="login-card" (ngSubmit)="submit()" autocomplete="on">
        <div class="brand"><div class="mark" aria-hidden="true"><span></span></div><h1>Marketech.ai <span>Mark · AI Workforce</span></h1></div>
        <p class="sub">{{ heading }}</p>
        <div *ngIf="expired" class="note">Your session ended. Please sign in again.</div>
        <div *ngIf="info" class="ok" role="status">{{ info }}</div>

        <!-- Invitation: who invited them where -->
        <div *ngIf="invite?.valid" class="invite">
          <b>{{ invite.invitation.invitedBy || 'A teammate' }}</b> invited <b>{{ invite.invitation.email }}</b> to
          <b>{{ invite.invitation.workspaceName }}</b> as {{ invite.invitation.role }}.
          <span *ngIf="mode === 'login'">Sign in with that email to accept.</span>
        </div>
        <div *ngIf="invite && !invite.valid" class="note">{{ invite.reason || 'This invitation link is not valid.' }}</div>
        <div *ngIf="invited && !invite && mode === 'login'" class="note">You have a workspace invitation. Sign in with the email address it was sent to; you can accept it next.</div>

        <ng-container *ngIf="mode === 'login' || mode === 'register'">
          <label>Email<input name="email" type="email" [(ngModel)]="email" required autocomplete="username" /></label>
          <label>Password<input name="password" type="password" [(ngModel)]="password" required [attr.autocomplete]="mode === 'login' ? 'current-password' : 'new-password'" /></label>
          <button *ngIf="mode === 'login'" type="button" class="link small" (click)="go('forgot')">Forgot password?</button>
        </ng-container>
        <ng-container *ngIf="mode === 'register'">
          <label>Your name<input name="displayName" [(ngModel)]="displayName" /></label>
          <label>Business / workspace name<input name="workspaceName" [(ngModel)]="workspaceName" required /></label>
          <label>Industry<input name="industry" [(ngModel)]="industry" /></label>
          <div class="hint">At least 10 characters for the password.</div>
        </ng-container>

        <!-- New person joining from the invitation: email fixed, they choose a password -->
        <ng-container *ngIf="mode === 'join'">
          <label>Email<input name="email" type="email" [value]="invite?.invitation?.email" readonly autocomplete="username" /></label>
          <label>Your name<input name="displayName" [(ngModel)]="displayName" maxlength="100" autocomplete="name" /></label>
          <label>Choose a password<input name="password" type="password" [(ngModel)]="password" required autocomplete="new-password" /></label>
          <label>Confirm password<input name="confirm" type="password" [(ngModel)]="confirm" required autocomplete="new-password" /></label>
          <div class="hint">At least 10 characters. You will use this email and password to sign in.</div>
        </ng-container>

        <ng-container *ngIf="mode === 'forgot'">
          <p class="hint">Enter your account email. We will email you a link to set a new password.</p>
          <label>Email<input name="email" type="email" [(ngModel)]="email" required autocomplete="username" /></label>
        </ng-container>

        <ng-container *ngIf="mode === 'reset'">
          <label>New password<input name="password" type="password" [(ngModel)]="password" required autocomplete="new-password" /></label>
          <label>Confirm new password<input name="confirm" type="password" [(ngModel)]="confirm" required autocomplete="new-password" /></label>
          <div class="hint">At least 10 characters. You will be signed out on every device.</div>
        </ng-container>

        <div *ngIf="error" class="error" role="alert">{{ error }}</div>
        <button type="submit" [disabled]="busy || loadingInvite">{{ busy ? 'Please wait…' : submitLabel }}</button>
        <button *ngIf="mode === 'login' && !invite?.valid" type="button" class="link" (click)="go('register')">New here? Create a workspace</button>
        <button *ngIf="mode === 'login' && invite?.valid && !invite.accountExists" type="button" class="link" (click)="go('join')">New to Marketech.ai? Set a password to join</button>
        <button *ngIf="mode === 'join'" type="button" class="link" (click)="go('login')">Already have an account? Sign in</button>
        <button *ngIf="mode === 'register' || mode === 'forgot' || mode === 'reset'" type="button" class="link" (click)="go('login')">Back to sign in</button>
      </form>
    </div>
  `,
  styles: [`
    .login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px;
      background: radial-gradient(1200px 600px at 15% -10%, rgba(123, 108, 246, 0.18), transparent 60%), radial-gradient(900px 500px at 110% 110%, rgba(79, 140, 255, 0.12), transparent 60%), var(--bg); }
    .login-card { width: min(420px, 100%); background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-xl); padding: 32px; display: flex; flex-direction: column; gap: 14px; box-shadow: var(--shadow-lg); animation: rise 0.3s var(--ease); }
    .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
    .mark { width: 40px; height: 40px; border-radius: 12px; background: var(--accent-gradient); display: grid; place-items: center; box-shadow: 0 8px 22px rgba(123, 108, 246, 0.4); }
    .mark span { width: 14px; height: 14px; border-radius: 50%; border: 3px solid #fff; }
    h1 { font-family: var(--font); font-size: 1.15rem; font-weight: 700; color: var(--text); margin: 0; letter-spacing: -0.01em; }
    h1 span { display: block; color: var(--text-muted); font-size: 0.8rem; font-weight: 500; }
    .sub { color: var(--text); margin: 0; font-weight: 600; font-size: 1rem; }
    label { display: flex; flex-direction: column; gap: 6px; color: var(--text-muted); font-size: 0.82rem; font-weight: 500; }
    input { background: var(--bg-elev); border: 1px solid var(--border-strong); color: var(--text); padding: 10px 12px; border-radius: var(--radius); font: 400 0.95rem var(--font); outline: none; transition: border-color 0.15s ease, box-shadow 0.15s ease; }
    input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    button[type=submit] { height: 42px; font: 600 0.92rem var(--font); background: var(--accent-gradient); color: #fff; border: none; border-radius: var(--radius); cursor: pointer; box-shadow: 0 6px 18px rgba(123, 108, 246, 0.35); margin-top: 4px; }
    button[type=submit]:hover:not([disabled]) { box-shadow: 0 8px 24px rgba(123, 108, 246, 0.5); }
    button[disabled] { opacity: 0.6; cursor: wait; }
    .link { background: none; border: none; color: var(--accent-text); cursor: pointer; font: 500 0.86rem var(--font); }
    .link:hover { text-decoration: underline; }
    .error { color: var(--danger-text); background: var(--danger-soft); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: var(--radius); padding: 8px 12px; font-size: 0.86rem; }
    .note { color: var(--warning-text); background: var(--warning-soft); border-radius: var(--radius); padding: 8px 12px; font-size: 0.86rem; }
    .hint { color: var(--text-subtle); font-size: 0.8rem; margin: 0; }
    .link.small { align-self: flex-end; font-size: 0.8rem; margin-top: -6px; }
    .ok { color: var(--success-text); background: var(--success-soft); border-radius: var(--radius); padding: 8px 12px; font-size: 0.86rem; }
    .invite { background: var(--accent-soft); color: var(--text); border-radius: var(--radius); padding: 10px 12px; font-size: 0.86rem; line-height: 1.45; }
    input[readonly] { opacity: 0.75; cursor: default; }
    @keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  `]
})
export class LoginComponent implements OnInit {
  @Output() loggedIn = new EventEmitter<void>();
  mode: 'login' | 'register' | 'join' | 'forgot' | 'reset' = 'login';
  email = '';
  password = '';
  confirm = '';
  displayName = '';
  workspaceName = '';
  industry = '';
  busy = false;
  loadingInvite = false;
  error: string | null = null;
  info: string | null = null;
  expired = false;
  /** The invitation behind the link this tab was opened from (workspace, email, whether they have an account). */
  invite: any = null;
  private readonly inviteToken = LoginComponent.stored('marketech_invite_token');
  private resetToken = LoginComponent.stored('marketech_reset_token');
  // Set when the page was opened from an invitation link (the app keeps the token for this tab).
  invited = !!this.inviteToken;

  constructor(private api: ApiService, private auth: AuthStateService) {}

  private static stored(key: string): string | null {
    try { return sessionStorage.getItem(key); } catch { return null; }
  }
  private static drop(key: string): void {
    try { sessionStorage.removeItem(key); } catch { /* ignore */ }
  }

  ngOnInit(): void {
    if (this.resetToken) { this.mode = 'reset'; return; }
    if (!this.inviteToken) return;
    this.loadingInvite = true;
    this.api.invitationPreview(this.inviteToken).subscribe({
      next: (r: any) => {
        this.loadingInvite = false;
        this.invite = r;
        if (!r.valid) return;
        this.email = r.invitation.email;
        this.mode = r.accountExists ? 'login' : 'join';
      },
      error: () => { this.loadingInvite = false; }
    });
  }

  get heading(): string {
    return {
      login: this.invite?.valid ? 'Sign in to accept your invitation' : 'Sign in to your workspace',
      register: 'Create a workspace',
      join: `Join ${this.invite?.invitation?.workspaceName || 'the workspace'}`,
      forgot: 'Reset your password',
      reset: 'Choose a new password'
    }[this.mode];
  }

  get submitLabel(): string {
    return { login: 'Sign in', register: 'Create workspace', join: 'Set password and join', forgot: 'Email me a reset link', reset: 'Save new password' }[this.mode];
  }

  go(mode: LoginComponent['mode']): void {
    this.mode = mode;
    this.error = null;
    this.info = null;
    this.password = '';
    this.confirm = '';
    if (mode === 'login' && this.resetToken) { LoginComponent.drop('marketech_reset_token'); this.resetToken = null; }
  }

  submit(): void {
    this.error = null;
    if ((this.mode === 'join' || this.mode === 'reset') && this.password !== this.confirm) {
      this.error = 'The two passwords do not match.';
      return;
    }
    if ((this.mode === 'join' || this.mode === 'reset' || this.mode === 'register') && this.password.length < 10) {
      this.error = 'Password must be at least 10 characters.';
      return;
    }
    this.busy = true;
    if (this.mode === 'forgot') {
      this.api.forgotPassword(this.email).subscribe({
        next: (r: any) => { this.busy = false; this.info = r.message || 'If an account exists for that email, we have sent a reset link.'; },
        error: err => { this.busy = false; this.error = err?.error?.error || 'Could not send the reset link. Try again.'; }
      });
      return;
    }
    if (this.mode === 'reset') {
      this.api.resetPassword(this.resetToken || '', this.password).subscribe({
        next: () => { this.busy = false; this.go('login'); this.info = 'Password changed. Sign in with your new password.'; },
        error: err => { this.busy = false; this.error = err?.error?.error || 'Could not reset the password.'; }
      });
      return;
    }
    const req = this.mode === 'join'
      ? this.api.invitationSignup({ token: this.inviteToken || '', password: this.password, displayName: this.displayName })
      : this.mode === 'login'
        ? this.api.login({ email: this.email, password: this.password })
        : this.api.register({ email: this.email, password: this.password, displayName: this.displayName, workspaceName: this.workspaceName, industry: this.industry });
    const joining = this.mode === 'join';
    req.subscribe({
      next: (res: any) => {
        this.busy = false;
        if (joining) LoginComponent.drop('marketech_invite_token'); // already accepted
        this.auth.setSession(res);
        this.password = '';
        this.confirm = '';
        this.loggedIn.emit();
      },
      error: (err) => {
        this.busy = false;
        this.error = err?.error?.error || 'Sign-in failed.';
        if (joining && err?.error?.code === 'ACCOUNT_EXISTS') { this.go('login'); this.error = err.error.error; }
      }
    });
  }
}
