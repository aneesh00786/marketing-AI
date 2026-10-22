import { TestBed } from '@angular/core/testing';
import { HttpClient, HttpErrorResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AuthStateService, SessionChangeKind } from './auth-state.service';
import { authInterceptor } from './auth.interceptor';
import { apiRoot } from './api-base';
import { LeadDiscoveryComponent } from '../features/leads/lead-discovery.component';

// Cross-tab session sync. "Another tab" is simulated the way the browser does it: the shared
// localStorage is written directly, then a 'storage' event is dispatched in this window.
const TOKEN_KEY = 'tradesage_token';
const USER_KEY = 'tradesage_user';
const WORKSPACE_KEY = 'tradesage_workspace';

function fakeToken(userId: number, workspaceId: number, nonce = Math.random()): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ userId, workspaceId, nonce })}.signature`;
}

function store(token: string | null, user: any = null, workspace: any = null): void {
  if (token === null) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(WORKSPACE_KEY);
  } else {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(workspace));
  }
}

/** What another tab does: change the shared storage, which fires 'storage' here. */
function otherTab(token: string | null, user: any = null, workspace: any = null): void {
  store(token, user, workspace);
  window.dispatchEvent(new StorageEvent('storage', { key: token === null ? null : TOKEN_KEY }));
}

describe('Cross-tab session sync', () => {
  const API = `${apiRoot()}/api/v1/leads`;
  const userA = { id: 1, email: 'a@example.test' };
  const ws1 = { id: 1, name: 'Workspace One' };
  const ws2 = { id: 2, name: 'Workspace Two' };
  let tokenA1: string;
  let auth: AuthStateService;
  let http: HttpClient;
  let httpMock: HttpTestingController;
  let changes: SessionChangeKind[];

  function boot(): void {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([authInterceptor])), provideHttpClientTesting()]
    });
    auth = TestBed.inject(AuthStateService);
    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
    changes = [];
    auth.sessionChanged$.subscribe(k => changes.push(k));
  }

  /** Sends a request and reports whether it reached the network, and the error code if blocked. */
  function attempt(method: 'GET' | 'POST', body: any = null): { sent: boolean; blockedCode: string | null; authHeader: string | null } {
    let blockedCode: string | null = null;
    const obs = method === 'GET' ? http.get(API) : http.post(API, body);
    obs.subscribe({ next: () => {}, error: (e: HttpErrorResponse) => { blockedCode = e.error?.code || null; } });
    const pending = httpMock.match(API);
    const authHeader = pending[0]?.request.headers.get('Authorization') || null;
    pending.forEach(p => p.flush({ success: true }));
    return { sent: pending.length > 0, blockedCode, authHeader };
  }

  beforeEach(() => {
    localStorage.clear();
    tokenA1 = fakeToken(1, 1);
    store(tokenA1, userA, ws1);
    boot();
  });

  afterEach(() => {
    httpMock.verify();
    TestBed.inject(AuthStateService).ngOnDestroy();
    localStorage.clear();
  });

  it('sends requests with this tab\'s token while the session is unchanged', () => {
    expect(auth.isStale).toBeFalse();
    const r = attempt('GET');
    expect(r.sent).toBeTrue();
    expect(r.authHeader).toBe(`Bearer ${tokenA1}`);
    expect(changes).toEqual([]);
  });

  it('workspace switched in another tab: reported once, this tab keeps showing its own context and sends nothing', () => {
    otherTab(fakeToken(1, 2), userA, ws2);
    expect(changes).toEqual(['switched-workspace']);
    expect(auth.isStale).toBeTrue();
    // This tab still describes the workspace it loaded (it never mixes in the other tab's).
    expect(auth.workspace.id).toBe(1);
    expect(auth.token).toBe(tokenA1);

    const get = attempt('GET');
    expect(get.sent).toBeFalse();
    expect(get.blockedCode).toBe('SESSION_CHANGED');
    // Reported once, not on every blocked request.
    expect(changes).toEqual(['switched-workspace']);
  });

  it('a stale tab cannot submit data (no POST reaches the server under either workspace)', () => {
    otherTab(fakeToken(1, 2), userA, ws2);
    const post = attempt('POST', { name: 'Lead typed before the switch' });
    expect(post.sent).toBeFalse();
    expect(post.blockedCode).toBe('SESSION_CHANGED');
  });

  it('a change is detected even without a storage event (checked before each request)', () => {
    store(fakeToken(1, 2), userA, ws2); // e.g. the event was missed while the tab was suspended
    const r = attempt('POST', {});
    expect(r.sent).toBeFalse();
    expect(changes).toEqual(['switched-workspace']);
  });

  it('logout in another tab: reported as signed-out and requests stop', () => {
    otherTab(null);
    expect(changes).toEqual(['signed-out']);
    expect(attempt('GET').sent).toBeFalse();
  });

  it('a different user signing in in another tab is reported as other-user; nothing is sent', () => {
    otherTab(fakeToken(9, 1), { id: 9, email: 'b@example.test' }, ws1);
    expect(changes).toEqual(['other-user']);
    expect(auth.user.id).toBe(1);
    expect(attempt('POST', {}).sent).toBeFalse();
  });

  it('signing in in another tab while this tab is signed out is reported as signed-in', () => {
    TestBed.resetTestingModule();
    localStorage.clear();
    boot();
    expect(auth.isLoggedIn).toBeFalse();
    otherTab(fakeToken(1, 1), userA, ws1);
    expect(changes).toEqual(['signed-in']);
    expect(auth.isLoggedIn).toBeFalse(); // stays on its own (signed-out) state until reloaded
    expect(attempt('GET').sent).toBeFalse();
  });

  it('switching workspace in this tab (setSession) is not stale and uses the new token', () => {
    const tokenA2 = fakeToken(1, 2);
    auth.setSession({ token: tokenA2, user: userA, workspace: ws2 });
    expect(auth.isStale).toBeFalse();
    expect(changes).toEqual([]);
    expect(auth.workspace.id).toBe(2);
    expect(attempt('GET').authHeader).toBe(`Bearer ${tokenA2}`);
  });

  it('a request carrying the stored token explicitly still goes out with this tab\'s token only', () => {
    let blocked = false;
    http.get(API, { headers: { Authorization: 'Bearer something-else' } }).subscribe({ error: () => { blocked = true; } });
    const req = httpMock.expectOne(API);
    expect(req.request.headers.get('Authorization')).toBe(`Bearer ${tokenA1}`);
    req.flush({});
    expect(blocked).toBeFalse();
  });

  it('a stale tab signing out (or a late 401) does not erase the other tab\'s newer session', () => {
    const tokenA2 = fakeToken(1, 2);
    otherTab(tokenA2, userA, ws2);
    auth.clear();
    expect(localStorage.getItem(TOKEN_KEY)).toBe(tokenA2);
    expect(auth.isLoggedIn).toBeFalse();
  });

  it('signing out in this tab clears the shared session for every tab', () => {
    auth.clear();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(auth.isStale).toBeFalse();
    expect(changes).toEqual([]);
  });

  it('the streaming Lead Discovery search (fetch, not HttpClient) is not sent from a stale tab', async () => {
    const component = new LeadDiscoveryComponent(http, auth);
    spyOnProperty(component, 'canSearch', 'get').and.returnValue(true);
    const fetchSpy = spyOn(window, 'fetch').and.callFake(() => Promise.reject(new Error('should not be called')));
    otherTab(fakeToken(1, 2), userA, ws2);
    await component.search();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(component.error).toMatch(/another tab/);
    expect(component.phase).toBe('idle');
  });

  it('another change after a reported one is reported again', () => {
    otherTab(fakeToken(1, 2), userA, ws2);
    otherTab(null);
    expect(changes).toEqual(['switched-workspace', 'signed-out']);
  });
});
