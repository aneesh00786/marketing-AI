import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { AuthStateService } from './auth-state.service';
import { apiRoot } from './api-base';

/**
 * Attaches the bearer token to API calls and returns the user to sign-in when it is rejected.
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
  const token = auth.token;
  // A token from storage set by request code is replaced with this tab's own session token.
  const authed = isApi && token
    ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
    : req;
  return next(authed).pipe(
    catchError((err: HttpErrorResponse) => {
      if (isApi && err.status === 401 && !req.url.includes('/auth/login')) auth.expire();
      return throwError(() => err);
    })
  );
};
