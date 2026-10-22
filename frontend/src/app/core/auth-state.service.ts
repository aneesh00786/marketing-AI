import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { Subject } from 'rxjs';

const TOKEN_KEY = 'tradesage_token';
const USER_KEY = 'tradesage_user';
const WORKSPACE_KEY = 'tradesage_workspace';

/** How the shared session changed in another tab, compared with the one this tab is using. */
export type SessionChangeKind = 'signed-out' | 'signed-in' | 'other-user' | 'switched-workspace' | 'replaced';

/**
 * Holds the signed-in session. The token proves identity only; the server
 * resolves workspace membership and permissions on every request.
 *
 * The session is stored in localStorage, which all tabs share. Each tab keeps the session it
 * started with (or set itself); when another tab switches workspace, signs out or signs in, the
 * stored session no longer matches and this tab is "stale": it stops sending API requests and
 * reports the change once through sessionChanged$, so it never shows or submits data under the
 * wrong workspace. Reloading picks up the current session.
 */
@Injectable({ providedIn: 'root' })
export class AuthStateService implements OnDestroy {
  readonly sessionExpired$ = new Subject<void>();
  readonly sessionChanged$ = new Subject<SessionChangeKind>();

  private tabToken: string | null;
  private tabUser: any;
  private tabWorkspace: any;
  private notifiedFor: string | null | undefined = undefined;
  private readonly onStorage = (e: StorageEvent) => {
    if (e.key === TOKEN_KEY || e.key === null) this.zone.run(() => this.checkSession());
  };
  private readonly onFocus = () => this.zone.run(() => this.checkSession());

  constructor(private zone: NgZone) {
    this.tabToken = this.storedToken;
    this.tabUser = this.readJson(USER_KEY);
    this.tabWorkspace = this.readJson(WORKSPACE_KEY);
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', this.onStorage);
      window.addEventListener('focus', this.onFocus);
    }
  }

  ngOnDestroy(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', this.onStorage);
      window.removeEventListener('focus', this.onFocus);
    }
  }

  private read(key: string): string | null {
    try {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    } catch {
      return null;
    }
  }

  private readJson(key: string): any {
    try { return JSON.parse(this.read(key) || 'null'); } catch { return null; }
  }

  /** The session currently stored (possibly written by another tab). */
  private get storedToken(): string | null {
    return this.read(TOKEN_KEY);
  }

  /** The token of the session this tab is using. */
  get token(): string | null {
    return this.tabToken;
  }

  get user(): any {
    return this.tabUser;
  }

  get workspace(): any {
    return this.tabWorkspace;
  }

  get isLoggedIn(): boolean {
    return !!this.tabToken;
  }

  /** True when another tab replaced or ended the session this tab is showing. */
  get isStale(): boolean {
    return this.storedToken !== this.tabToken;
  }

  /** Token to send with a request from this tab, or null when the tab is stale (do not send). */
  get requestToken(): string | null {
    if (this.checkSession()) return null;
    return this.tabToken;
  }

  /** Detects a session change made elsewhere; reports it once. Returns true when stale. */
  checkSession(): boolean {
    const stored = this.storedToken;
    if (stored === this.tabToken) return false;
    if (this.notifiedFor !== stored) {
      this.notifiedFor = stored;
      this.sessionChanged$.next(this.describeChange(stored));
    }
    return true;
  }

  private describeChange(stored: string | null): SessionChangeKind {
    if (!stored) return 'signed-out';
    if (!this.tabToken) return 'signed-in';
    // Display only: the server verifies tokens; the payload just tells user/workspace apart.
    const mine = decodePayload(this.tabToken);
    const theirs = decodePayload(stored);
    if (mine?.userId == null || theirs?.userId == null) return 'replaced';
    if (String(mine.userId) !== String(theirs.userId)) return 'other-user';
    if (String(mine.workspaceId) !== String(theirs.workspaceId)) return 'switched-workspace';
    return 'replaced';
  }

  setSession(res: { token: string; user: any; workspace: any }): void {
    try {
      localStorage.setItem(TOKEN_KEY, res.token);
      localStorage.setItem(USER_KEY, JSON.stringify(res.user || null));
      localStorage.setItem(WORKSPACE_KEY, JSON.stringify(res.workspace || null));
    } catch { /* storage unavailable: session lasts for this page only */ }
    this.tabToken = this.storedToken;
    this.tabUser = this.tabToken ? res.user || null : null;
    this.tabWorkspace = this.tabToken ? res.workspace || null : null;
    this.notifiedFor = undefined;
  }

  /** Ends this tab's session. Only removes the stored session if it is still this tab's own. */
  clear(): void {
    if (!this.isStale) {
      try {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        localStorage.removeItem(WORKSPACE_KEY);
      } catch { /* ignore */ }
      this.notifiedFor = undefined;
    }
    this.tabToken = null;
    this.tabUser = null;
    this.tabWorkspace = null;
  }

  expire(): void {
    if (!this.tabToken) return;
    this.clear();
    this.sessionExpired$.next();
  }
}

function decodePayload(token: string): any {
  try {
    const part = token.split('.')[1] || '';
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
    return JSON.parse(json);
  } catch {
    return null;
  }
}
