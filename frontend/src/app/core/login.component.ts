import { Component, EventEmitter, Output } from '@angular/core';
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
        <p class="sub">{{ mode === 'login' ? 'Sign in to your workspace' : 'Create a workspace' }}</p>
        <div *ngIf="expired" class="note">Your session ended. Please sign in again.</div>
        <div *ngIf="invited" class="note">You have a workspace invitation. Sign in, or create an account, with the email address the invitation was sent to; you can accept it next.</div>
        <label>Email<input name="email" type="email" [(ngModel)]="email" required autocomplete="username" /></label>
        <label>Password<input name="password" type="password" [(ngModel)]="password" required [attr.autocomplete]="mode === 'login' ? 'current-password' : 'new-password'" /></label>
        <ng-container *ngIf="mode === 'register'">
          <label>Your name<input name="displayName" [(ngModel)]="displayName" /></label>
          <label>Business / workspace name<input name="workspaceName" [(ngModel)]="workspaceName" required /></label>
          <label>Industry<input name="industry" [(ngModel)]="industry" /></label>
          <div class="hint">At least 10 characters for the password.</div>
        </ng-container>
        <div *ngIf="error" class="error" role="alert">{{ error }}</div>
        <button type="submit" [disabled]="busy">{{ busy ? 'Please wait…' : (mode === 'login' ? 'Sign in' : 'Create workspace') }}</button>
        <button type="button" class="link" (click)="mode = mode === 'login' ? 'register' : 'login'; error = null">
          {{ mode === 'login' ? 'New here? Create a workspace' : 'Already have an account? Sign in' }}
        </button>
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
    .hint { color: var(--text-subtle); font-size: 0.8rem; }
    @keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  `]
})
export class LoginComponent {
  @Output() loggedIn = new EventEmitter<void>();
  mode: 'login' | 'register' = 'login';
  email = '';
  password = '';
  displayName = '';
  workspaceName = '';
  industry = '';
  busy = false;
  error: string | null = null;
  expired = false;
  // Set when the page was opened from an invitation link (the app keeps the token for this tab).
  invited = (() => { try { return !!sessionStorage.getItem('marketech_invite_token'); } catch { return false; } })();

  constructor(private api: ApiService, private auth: AuthStateService) {}

  submit(): void {
    this.busy = true;
    this.error = null;
    const req = this.mode === 'login'
      ? this.api.login({ email: this.email, password: this.password })
      : this.api.register({ email: this.email, password: this.password, displayName: this.displayName, workspaceName: this.workspaceName, industry: this.industry });
    req.subscribe({
      next: (res: any) => {
        this.busy = false;
        this.auth.setSession(res);
        this.password = '';
        this.loggedIn.emit();
      },
      error: (err) => {
        this.busy = false;
        this.error = err?.error?.error || 'Sign-in failed.';
      }
    });
  }
}
