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

module.exports = {
  isValidTimeZone,
  toDbDateTime,
  nowDb,
  zonedLocalToUtc,
  utcToZonedLocal
};
