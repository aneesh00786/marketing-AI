import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

const TOKEN_KEY = 'tradesage_token';
const USER_KEY = 'tradesage_user';
const WORKSPACE_KEY = 'tradesage_workspace';

/**
 * Holds the signed-in session. The token proves identity only; the server
 * resolves workspace membership and permissions on every request.
 */
@Injectable({ providedIn: 'root' })
export class AuthStateService {
  readonly sessionExpired$ = new Subject<void>();

  private read(key: string): string | null {
    try {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    } catch {
      return null;
    }
  }

  get token(): string | null {
    return this.read(TOKEN_KEY);
  }

  get user(): any {
    try { return JSON.parse(this.read(USER_KEY) || 'null'); } catch { return null; }
  }

  get workspace(): any {
    try { return JSON.parse(this.read(WORKSPACE_KEY) || 'null'); } catch { return null; }
  }

  get isLoggedIn(): boolean {
    return !!this.token;
  }

  setSession(res: { token: string; user: any; workspace: any }): void {
    try {
      localStorage.setItem(TOKEN_KEY, res.token);
      localStorage.setItem(USER_KEY, JSON.stringify(res.user || null));
      localStorage.setItem(WORKSPACE_KEY, JSON.stringify(res.workspace || null));
    } catch { /* storage unavailable: session lasts for this page only */ }
  }

  clear(): void {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      localStorage.removeItem(WORKSPACE_KEY);
    } catch { /* ignore */ }
  }

  expire(): void {
    if (!this.token) return;
    this.clear();
    this.sessionExpired$.next();
  }
}
