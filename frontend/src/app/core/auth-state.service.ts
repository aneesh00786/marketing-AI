import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { Subject } from 'rxjs';

// The sign-in token lives only in an HttpOnly cookie the page cannot read. The browser keeps a
// non-secret marker of the session (id, user, workspace) so tabs can tell when it changes.
const SESSION_KEY = 'marketech_session';
const USER_KEY = 'tradesage_user';
const WORKSPACE_KEY = 'tradesage_workspace';
// Where earlier versions kept the token itself; removed on load so it is not left behind.
const LEGACY_TOKEN_KEY = 'tradesage_token';

/** Header the app adds to its API requests (the server requires it for cookie-authenticated changes). */
export const APP_REQUEST_HEADER = { 'X-Requested-With': 'marketech' };

export interface SessionMarker { id: string | null; userId: number | string; workspaceId: number | string }

/** How the shared session changed in another tab, compared with the one this tab is using. */
export type SessionChangeKind = 'signed-out' | 'signed-in' | 'other-user' | 'switched-workspace' | 'replaced';

/**
 * Holds the signed-in session. The cookie proves identity only; the server
 * resolves workspace membership and permissions on every request.
 *
 * The session marker is stored in localStorage, which all tabs share. Each tab keeps the session it
 * started with (or set itself); when another tab switches workspace, signs out or signs in, the
 * stored session no longer matches and this tab is "stale": it stops sending API requests and
 * reports the change once through sessionChanged$, so it never shows or submits data under the
 * wrong workspace. Reloading picks up the current session.
 */
@Injectable({ providedIn: 'root' })
export class AuthStateService implements OnDestroy {
  readonly sessionExpired$ = new Subject<void>();
  readonly sessionChanged$ = new Subject<SessionChangeKind>();

  private tabSession: string | null;
  private tabUser: any;
  private tabWorkspace: any;
  private notifiedFor: string | null | undefined = undefined;
  private readonly onStorage = (e: StorageEvent) => {
    if (e.key === SESSION_KEY || e.key === null) this.zone.run(() => this.checkSession());
  };
  private readonly onFocus = () => this.zone.run(() => this.checkSession());

  constructor(private zone: NgZone) {
    try { localStorage.removeItem(LEGACY_TOKEN_KEY); } catch { /* storage unavailable */ }
    this.tabSession = this.storedSession;
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

  /** The session marker currently stored (possibly written by another tab). */
  private get storedSession(): string | null {
    return this.read(SESSION_KEY);
  }

  get user(): any {
    return this.tabUser;
  }

  get workspace(): any {
    return this.tabWorkspace;
  }

  get isLoggedIn(): boolean {
    return !!this.tabSession;
  }

  /** True when another tab replaced or ended the session this tab is showing. */
  get isStale(): boolean {
    return this.storedSession !== this.tabSession;
  }

  /** Detects a session change made elsewhere; reports it once. Returns true when stale. */
  checkSession(): boolean {
    const stored = this.storedSession;
    if (stored === this.tabSession) return false;
    if (this.notifiedFor !== stored) {
      this.notifiedFor = stored;
      this.sessionChanged$.next(this.describeChange(stored));
    }
    return true;
  }

  private describeChange(stored: string | null): SessionChangeKind {
    if (!stored) return 'signed-out';
    if (!this.tabSession) return 'signed-in';
    const mine = parseMarker(this.tabSession);
    const theirs = parseMarker(stored);
    if (mine?.userId == null || theirs?.userId == null) return 'replaced';
    if (String(mine.userId) !== String(theirs.userId)) return 'other-user';
    if (String(mine.workspaceId) !== String(theirs.workspaceId)) return 'switched-workspace';
    return 'replaced';
  }

  /** Records a session the server just started (its cookie is already set by the response). */
  setSession(res: { session?: SessionMarker; user: any; workspace: any }): void {
    const marker = res.session ? JSON.stringify({ id: res.session.id ?? null, userId: res.session.userId, workspaceId: res.session.workspaceId }) : null;
    try {
      if (marker) localStorage.setItem(SESSION_KEY, marker); else localStorage.removeItem(SESSION_KEY);
      localStorage.setItem(USER_KEY, JSON.stringify(res.user || null));
      localStorage.setItem(WORKSPACE_KEY, JSON.stringify(res.workspace || null));
    } catch { /* storage unavailable: session lasts for this page only */ }
    this.tabSession = this.storedSession ?? marker;
    this.tabUser = this.tabSession ? res.user || null : null;
    this.tabWorkspace = this.tabSession ? res.workspace || null : null;
    this.notifiedFor = undefined;
  }

  /** Ends this tab's session. Only removes the stored session if it is still this tab's own. */
  clear(): void {
    if (!this.isStale) {
      try {
        localStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(USER_KEY);
        localStorage.removeItem(WORKSPACE_KEY);
      } catch { /* ignore */ }
      this.notifiedFor = undefined;
    }
    this.tabSession = null;
    this.tabUser = null;
    this.tabWorkspace = null;
  }

  expire(): void {
    if (!this.tabSession) return;
    this.clear();
    this.sessionExpired$.next();
  }
}

function parseMarker(marker: string): any {
  try { return JSON.parse(marker); } catch { return null; }
}
