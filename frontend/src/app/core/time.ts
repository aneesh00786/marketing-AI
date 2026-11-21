/**
 * Time where the person is. The server stores and sends UTC (ISO strings ending in "Z"), which Angular's date
 * pipe shows in the browser's time zone. Calendar days people pick or see ("today", "From", "To") are local
 * days: never take them from toISOString(), which gives the UTC day.
 */

/** The browser's IANA time zone (e.g. "Asia/Kolkata"), sent to the server with every API call. */
export function userTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** 'YYYY-MM-DD' of a moment in the browser's time zone (default: now). */
export function localDay(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The local day `offset` calendar days from today (daylight-saving safe). */
export function localDayFromToday(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return localDay(d);
}

/**
 * A server time as a Date. ISO strings with a zone are exact; a bare 'YYYY-MM-DD HH:mm:ss' is a UTC DATETIME
 * (the database is UTC), not a local time.
 */
export function serverTime(v: any): Date | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v;
  const s = String(v);
  const d = new Date(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? s.replace(' ', 'T') + 'Z' : s);
  return Number.isNaN(d.getTime()) ? null : d;
}
