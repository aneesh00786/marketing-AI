/**
 * API origin. During `ng serve` (port 4200) the API runs on localhost:8000;
 * when the backend serves the built app, the API is same-origin (works over LAN too).
 */
export function apiRoot(): string {
  if (typeof window === 'undefined') return 'http://localhost:8000';
  return window.location.port === '4200' ? 'http://localhost:8000' : window.location.origin;
}
