import { DateTime } from 'luxon';
import { BarSize, ET_ZONE } from './types';

/**
 * Regular US equity session in ET wall-clock terms. These are wall-clock
 * constants, not fixed UTC offsets — 09:30 ET is 14:30Z in winter and 13:30Z in
 * summer, which is exactly why every conversion here goes through the IANA
 * database rather than arithmetic on a stored offset.
 */
export const SESSION_OPEN = { hour: 9, minute: 30 };
export const SESSION_CLOSE = { hour: 16, minute: 0 };

/** Parses an ISO timestamp into an ET-zoned DateTime. */
export function toEt(timestamp: string): DateTime {
  return DateTime.fromISO(timestamp, { setZone: true }).setZone(ET_ZONE);
}

/** Formats an ET DateTime back to the ISO-with-offset form stored in fixtures. */
export function formatEt(dt: DateTime): string {
  return dt.setZone(ET_ZONE).toISO({ suppressMilliseconds: false })!;
}

/**
 * True when the timestamp falls inside the regular session, half-open on the
 * close: a bar stamped 16:00 opens at the closing bell and belongs to
 * post-market, so it is excluded.
 */
export function isRegularSession(timestamp: string): boolean {
  const dt = toEt(timestamp);
  const minutes = dt.hour * 60 + dt.minute;
  const open = SESSION_OPEN.hour * 60 + SESSION_OPEN.minute;
  const close = SESSION_CLOSE.hour * 60 + SESSION_CLOSE.minute;

  return minutes >= open && minutes < close;
}

export function isPreMarket(timestamp: string): boolean {
  const dt = toEt(timestamp);
  const minutes = dt.hour * 60 + dt.minute;
  return minutes < SESSION_OPEN.hour * 60 + SESSION_OPEN.minute;
}

export function isPostMarket(timestamp: string): boolean {
  const dt = toEt(timestamp);
  const minutes = dt.hour * 60 + dt.minute;
  return minutes >= SESSION_CLOSE.hour * 60 + SESSION_CLOSE.minute;
}

/**
 * True when the timestamp lands on a legitimate boundary for its bar size.
 *
 * Checked against ET wall-clock minutes rather than epoch arithmetic: US
 * DST transitions occur at 02:00 ET, outside the trading session, so session
 * bars stay on clean 5-minute wall-clock boundaries across the transition even
 * though the UTC offset shifts by an hour.
 */
export function isOnBarBoundary(timestamp: string, barSize: BarSize): boolean {
  const dt = toEt(timestamp);

  if (dt.second !== 0 || dt.millisecond !== 0) {
    return false;
  }

  if (barSize === BarSize.DAILY) {
    // Daily bars are stamped at the opening bell.
    return dt.hour === SESSION_OPEN.hour && dt.minute === SESSION_OPEN.minute;
  }

  return dt.minute % 5 === 0;
}

/**
 * Advances by whole calendar days in ET, skipping weekends.
 *
 * Uses `plus({ days })` rather than adding 24h of milliseconds so the result
 * keeps the same wall-clock time across a DST transition — 09:30 ET stays
 * 09:30 ET, which is what a trading session means.
 */
export function nextSessionDay(dt: DateTime<true>): DateTime<true> {
  let next = dt.plus({ days: 1 });
  while (next.weekday > 5) {
    next = next.plus({ days: 1 });
  }
  return next;
}

/**
 * Parses an ET calendar date (`yyyy-MM-dd`), throwing on anything luxon cannot
 * resolve. Returning a validity-narrowed `DateTime<true>` keeps every caller
 * free of validity checks, and turns a typo in a fixture definition into an
 * immediate error rather than a series of `Invalid DateTime` timestamps.
 */
export function parseEtDate(date: string): DateTime<true> {
  const dt = DateTime.fromISO(date, { zone: ET_ZONE });

  if (!dt.isValid) {
    throw new Error(`Invalid ET date "${date}": ${dt.invalidReason}`);
  }

  return dt;
}

/**
 * Generates the sequence of 5-minute bar open times for one regular session.
 * 09:30 through 15:55 inclusive — 78 bars.
 */
export function sessionBarTimes(sessionDate: DateTime<true>): DateTime<true>[] {
  // luxon widens to DateTime<boolean> after .set(), but a valid input shifted
  // to a fixed wall-clock time within the same day cannot become invalid.
  const start = sessionDate.setZone(ET_ZONE).set({
    hour: SESSION_OPEN.hour,
    minute: SESSION_OPEN.minute,
    second: 0,
    millisecond: 0,
  }) as DateTime<true>;

  const times: DateTime<true>[] = [];
  const barsPerSession = ((SESSION_CLOSE.hour - SESSION_OPEN.hour) * 60 - SESSION_OPEN.minute) / 5;

  for (let i = 0; i < barsPerSession; i += 1) {
    times.push(start.plus({ minutes: i * 5 }));
  }

  return times;
}
