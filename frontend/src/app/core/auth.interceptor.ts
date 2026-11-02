import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { APP_REQUEST_HEADER, AuthStateService } from './auth-state.service';
import { apiRoot } from './api-base';

/**
 * Sends the session cookie with API calls and returns the user to sign-in when it is rejected.
 * When another tab has replaced or ended the session, API calls from this tab are not sent at
 * all, so nothing is read or written under a workspace this tab is no longer showing.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthStateService);
  const isApi = req.url.startsWith(`${apiRoot()}/api`) || req.url.startsWith('/api');
  if (isApi && auth.checkSession()) {
    return throwError(() => new HttpErrorResponse({
      url: req.url,
      status: 0,
      statusText: 'Session changed',
      error: { success: false, code: 'SESSION_CHANGED', error: 'Your session changed in another tab. Reload this page to continue.' }
    }));
  }
  // The session cookie goes with API calls (also to localhost:8000 during `ng serve`); the app
  // header lets the server accept cookie-authenticated changes. No token is ever read here.
  const authed = isApi
    ? req.clone({ withCredentials: true, setHeaders: APP_REQUEST_HEADER })
    : req;
  return next(authed).pipe(
    catchError((err: HttpErrorResponse) => {
      if (isApi && err.status === 401 && !req.url.includes('/auth/login')) auth.expire();
      return throwError(() => err);
    })
  );
};
