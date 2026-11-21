/**
 * Time helpers. All timestamps are stored as UTC DATETIME ('YYYY-MM-DD HH:MM:SS').
 * Scheduling input arrives as a local wall-clock time plus an IANA time zone.
 */

function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (e) {
    return false;
  }
}

function toDbDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid date');
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

function nowDb() {
  return toDbDateTime(new Date());
}

/** Wall-clock parts of an instant in a time zone. */
function partsInZone(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = parseInt(p.value, 10);
  }
  return out;
}

function offsetMs(date, timeZone) {
  const p = partsInZone(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Converts 'YYYY-MM-DDTHH:mm' (local wall time in timeZone) to a UTC Date.
 * Throws for invalid input or for wall times skipped by a DST transition.
 */
function zonedLocalToUtc(localDateTime, timeZone) {
  if (!isValidTimeZone(timeZone)) {
    const err = new Error(`Unknown time zone: ${timeZone}`);
    err.status = 400;
    throw err;
  }
  const m = String(localDateTime || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) {
    const err = new Error('Scheduled time must be in the format YYYY-MM-DDTHH:mm.');
    err.status = 400;
    throw err;
  }
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] || '0'].map(v => parseInt(v, 10));
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  let utc = naive - offsetMs(new Date(naive), timeZone);
  const secondOffset = offsetMs(new Date(utc), timeZone);
  utc = naive - secondOffset;

  const check = partsInZone(new Date(utc), timeZone);
  if (check.year !== y || check.month !== mo || check.day !== d || check.hour !== h || check.minute !== mi) {
    const err = new Error(`${localDateTime} does not exist in ${timeZone} (daylight-saving transition). Choose another time.`);
    err.status = 400;
    throw err;
  }
  return new Date(utc);
}

/** Formats a UTC instant as 'YYYY-MM-DDTHH:mm' wall time in timeZone. */
function utcToZonedLocal(date, timeZone) {
  const p = partsInZone(date instanceof Date ? date : new Date(date), timeZone);
  const pad = n => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * The viewer's time zone: the browser sends it with every API call (X-Time-Zone, e.g. 'Asia/Kolkata').
 * Dates people pick ("From", "To") and per-day charts are days where they are; storage stays UTC.
 */
function requestTimeZone(req) {
  const tz = String(req?.headers?.['x-time-zone'] || '').trim();
  return tz && tz.length <= 64 && isValidTimeZone(tz) ? tz : 'UTC';
}

/** 'YYYY-MM-DD': the calendar day of an instant in timeZone. */
function dayInZone(date, timeZone) {
  return utcToZonedLocal(date, timeZone).slice(0, 10);
}

/** The UTC DATETIME at which a local calendar day ('YYYY-MM-DD') starts in timeZone. */
function dayStartUtc(day, timeZone) {
  // Midnight can be skipped by a daylight-saving change in a few zones: the day then starts at 01:00.
  for (const t of ['00:00', '01:00']) {
    try { return toDbDateTime(zonedLocalToUtc(`${day}T${t}`, timeZone)); } catch (e) { if (t === '01:00') throw e; }
  }
}

/** The day after 'YYYY-MM-DD' (calendar arithmetic, no time zone). */
function nextDay(day, n = 1) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * MySQL offset ('+05:30') of timeZone now, for grouping UTC DATETIMEs by local day with CONVERT_TZ
 * (numeric offsets need no time zone tables; across a daylight-saving change a day can be off by an hour).
 */
function sqlOffset(timeZone, at = new Date()) {
  const mins = Math.round(offsetMs(at, timeZone) / 60000);
  const sign = mins < 0 ? '-' : '+';
  const a = Math.abs(mins);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

module.exports = {
  requestTimeZone,
  dayInZone,
  dayStartUtc,
  nextDay,
  sqlOffset,
  isValidTimeZone,
  toDbDateTime,
  nowDb,
  zonedLocalToUtc,
  utcToZonedLocal,
  partsInZone
};
