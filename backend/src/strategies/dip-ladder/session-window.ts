import { SESSION_CLOSE, toEt } from '../../market-data/session';

/**
 * The firing window: 09:45–16:00 ET (`PRD.md:96`).
 *
 * The first 15 minutes are excluded because that is the opening auction, where
 * spreads are widest and TQQQ's leveraged rebalancing makes prints least
 * reliable. Pre- and post-market are excluded entirely.
 *
 * **The exclusion applies to firing, not to anchoring.** The bootstrap anchor
 * is still computed from the 09:30 open — a rule this module deliberately
 * cannot affect, since it only ever answers "may a bar fire?".
 *
 * Every comparison runs through the IANA database via `toEt` rather than
 * arithmetic on a stored UTC offset: 09:45 ET is 14:45Z in winter and 13:45Z
 * in summer, and a fixed-offset shortcut would silently shift the window by an
 * hour twice a year.
 */

/** No entry before 09:45 ET. */
export const FIRING_OPEN = { hour: 9, minute: 45 };

/** Firing ends at the closing bell; `SESSION_CLOSE` is reused so the two cannot drift. */
export const FIRING_CLOSE = SESSION_CLOSE;

function minutesOfDay(hour: number, minute: number): number {
  return hour * 60 + minute;
}

/**
 * True when a bar stamped `timestamp` is eligible to fire.
 *
 * Bars are stamped at their OPEN time (`market-data/types.ts`), and firing is
 * evaluated on bar *close*. This gates on the open time, which means the bar
 * covering 09:40:00–09:44:59 does not fire even though it closes exactly at
 * 09:45, and the 09:45 bar is the first eligible one. That is the correct
 * reading of "no entry before 09:45": an entry triggered by the 09:40 bar is
 * an entry decided on opening-auction prints, which is what the exclusion
 * exists to avoid.
 *
 * Half-open at both ends: 09:45 fires, 16:00 does not. A bar stamped 16:00
 * opens at the closing bell and belongs to post-market.
 */
export function isWithinFiringWindow(timestamp: string): boolean {
  const dt = toEt(timestamp);
  const minutes = minutesOfDay(dt.hour, dt.minute);

  return (
    minutes >= minutesOfDay(FIRING_OPEN.hour, FIRING_OPEN.minute) &&
    minutes < minutesOfDay(FIRING_CLOSE.hour, FIRING_CLOSE.minute)
  );
}

/** The ET calendar date (`yyyy-MM-dd`) a timestamp falls on — the session key. */
export function sessionDateOf(timestamp: string): string {
  return toEt(timestamp).toISODate()!;
}

/**
 * True when a bar is the regular-session open (09:30 ET).
 *
 * This is what the bootstrap anchor keys off, and it is intentionally distinct
 * from the firing window — the 09:30 bar sets the anchor and may not fire.
 */
export function isSessionOpenBar(timestamp: string): boolean {
  const dt = toEt(timestamp);
  return dt.hour === 9 && dt.minute === 30;
}
