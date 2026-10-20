import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { AuthStateService } from './auth-state.service';
import { apiRoot } from './api-base';

/** Attaches the bearer token to API calls and returns the user to sign-in when it is rejected. */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthStateService);
  const isApi = req.url.startsWith(`${apiRoot()}/api`) || req.url.startsWith('/api');
  const token = auth.token;
  const authed = isApi && token && !req.headers.has('Authorization')
    ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
    : req;
  return next(authed).pipe(
    catchError((err: HttpErrorResponse) => {
      if (isApi && err.status === 401 && !req.url.includes('/auth/login')) auth.expire();
      return throwError(() => err);
    })
  );
};
