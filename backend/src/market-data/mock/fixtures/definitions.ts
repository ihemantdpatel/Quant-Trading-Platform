import { DateTime } from 'luxon';
import { formatEt, nextSessionDay, parseEtDate, sessionBarTimes } from '../../session';
import { Bar, BarSize, ET_ZONE, Fixture } from '../../types';
import { mulberry32, roundPrice } from '../generator';

/**
 * Fixture definitions: the five scenarios from `stories.md`.
 *
 * Each scenario's *decisive* structure — the gap, the floor breach, the chop
 * turns, the session edges — is authored explicitly as a price path. Filler
 * noise comes from the seeded generator. That split keeps the file readable
 * (you can see what each scenario proves) while avoiding 78 hand-typed bars
 * per session.
 *
 * The committed JSON these produce is the source of truth. This script only
 * regenerates it, and any change to output must be reviewed as a diff — a
 * silent shift here would move every downstream expectation in Stories 3 and 4.
 */

const SYMBOL = 'TQQQ';

interface SessionShape {
  /** ET calendar date, `yyyy-MM-dd`. */
  date: string;
  /** Session open price. Omit to continue from the previous session's close. */
  open?: number;
  /** Close price the session must reach; bars interpolate from open to close. */
  close: number;
  /** Extra bars outside 09:30–16:00, for the session-edges scenario. */
  includeExtendedHours?: boolean;
}

/**
 * Builds one session's 5-minute bars, walking price from open to close with
 * seeded noise layered on a linear path. Interpolating rather than random-
 * walking guarantees the session actually lands on its specified close, which
 * is what makes the scenario's documented expectation exact.
 */
function buildSession(
  shape: SessionShape,
  startPrice: number,
  rand: () => number,
  noise: number,
): Bar[] {
  const sessionDate = parseEtDate(shape.date);
  const open = shape.open ?? startPrice;
  const times = sessionBarTimes(sessionDate);

  const bars: Bar[] = [];
  let price = open;

  const extendedBefore: DateTime<true>[] = shape.includeExtendedHours
    ? [
        sessionDate.set({ hour: 8, minute: 0, second: 0, millisecond: 0 }) as DateTime<true>,
        sessionDate.set({ hour: 9, minute: 0, second: 0, millisecond: 0 }) as DateTime<true>,
      ]
    : [];

  const extendedAfter: DateTime<true>[] = shape.includeExtendedHours
    ? [
        sessionDate.set({ hour: 16, minute: 0, second: 0, millisecond: 0 }) as DateTime<true>,
        sessionDate.set({ hour: 17, minute: 0, second: 0, millisecond: 0 }) as DateTime<true>,
      ]
    : [];

  const emit = (time: DateTime<true>, barOpen: number, barClose: number): void => {
    const wick = Math.abs(barOpen) * noise;
    bars.push({
      symbol: SYMBOL,
      barSize: BarSize.FIVE_MIN,
      timestamp: formatEt(time),
      open: roundPrice(barOpen),
      high: roundPrice(Math.max(barOpen, barClose) + rand() * wick),
      low: roundPrice(Math.min(barOpen, barClose) - rand() * wick),
      close: roundPrice(barClose),
      volume: Math.floor(500_000 + rand() * 2_000_000),
    });
  };

  for (const time of extendedBefore) {
    const next = price * (1 + (rand() - 0.5) * noise);
    emit(time, price, next);
    price = next;
  }

  const step = (shape.close - open) / times.length;
  for (let i = 0; i < times.length; i += 1) {
    const target = open + step * (i + 1);
    // Noise is symmetric around the interpolated path, so it perturbs the route
    // without moving the endpoint the scenario depends on.
    const next = i === times.length - 1 ? shape.close : target + (rand() - 0.5) * open * noise;
    emit(times[i], price, next);
    price = next;
  }

  for (const time of extendedAfter) {
    const next = price * (1 + (rand() - 0.5) * noise);
    emit(time, price, next);
    price = next;
  }

  return bars;
}

function buildFixture(
  name: string,
  expectation: string,
  invariants: Fixture['invariants'],
  sessions: SessionShape[],
  seed: number,
  noise = 0.002,
): Fixture {
  const rand = mulberry32(seed);
  const bars: Bar[] = [];
  let price = sessions[0].open ?? 100;

  for (const shape of sessions) {
    const sessionBars = buildSession(shape, price, rand, noise);
    bars.push(...sessionBars);
    price = sessionBars[sessionBars.length - 1].close;
  }

  return { name, symbol: SYMBOL, barSize: BarSize.FIVE_MIN, expectation, invariants, bars };
}

/** Consecutive weekday dates starting from `start`, skipping weekends. */
function weekdays(start: string, count: number): string[] {
  const dates: string[] = [];
  let cursor = parseEtDate(start);

  for (let i = 0; i < count; i += 1) {
    while (cursor.weekday > 5) {
      cursor = cursor.plus({ days: 1 });
    }
    dates.push(cursor.toISODate()!);
    cursor = nextSessionDay(cursor);
  }

  return dates;
}

export function buildAllFixtures(): Fixture[] {
  const days = weekdays('2025-01-02', 12);

  return [
    /**
     * Session 1 closes at 100. Session 2 opens at 96 — a 4% overnight gap down.
     * Story 3's bootstrap anchor must re-base to the gapped open rather than
     * anchoring to the stale 100 close.
     */
    buildFixture(
      'gap-down-open',
      'Session 1 closes at 100.00; session 2 gaps down 4% to open at 96.00 and drifts lower. ' +
        'The anchor must re-base to the gapped-down open (96.00), placing the first rung a further ' +
        'spacing unit below that — not treating the gap as "almost there" against the 100.00 close.',
      [
        { kind: 'gapDownFromPreviousClosePct', value: 3.9 },
        { kind: 'minBarCount', value: 156 },
      ],
      [
        { date: days[0], open: 100, close: 100 },
        { date: days[1], open: 96, close: 95 },
      ],
      1001,
    ),

    /**
     * Same 4% gap, but price recovers past the prior close. Because the anchor
     * takes max(prev close, open), it must not be left stranded below market.
     */
    buildFixture(
      'gap-down-recover',
      'Session 1 closes at 100.00; session 2 gaps down 4% to 96.00 then recovers to close at 102.00, ' +
        'trading back above the prior close. Because the anchor takes max(previous close, open), no ' +
        'stale anchor is left stranded below the market.',
      [
        { kind: 'gapDownFromPreviousClosePct', value: 3.9 },
        { kind: 'recoversToPreviousClose' },
        { kind: 'minBarCount', value: 156 },
      ],
      [
        { date: days[0], open: 100, close: 100 },
        { date: days[1], open: 96, close: 102 },
      ],
      1002,
    ),

    /**
     * A sustained fall well past the 25% hard floor. Story 3 asserts the ladder
     * fully extends, then stops adding at the floor while still holding — and
     * critically, emits no sell intent.
     *
     * The first session falls 12%, not the ~4% of the sessions that follow.
     * That is deliberate and load-bearing: while the ladder is flat the anchor
     * re-bases each session to `max(prev close, open)`, so a decline of a
     * constant ~4% per session keeps every session's first rung (5% below its
     * own anchor) permanently just out of reach and the ladder never gets a
     * first entry. A deeper opening session gives the ladder its first lot,
     * after which the anchor chains off the lowest *held* lot rather than the
     * session open and the remaining sessions extend it. The endpoint and the
     * >25% total decline the scenario exists to demonstrate are unchanged.
     */
    buildFixture(
      'steady-decline',
      'Ten sessions falling steadily from 100.00 to 68.00 — a 32% decline that carries price ' +
        'through the 25% hard floor. The first session falls 12% so the ladder takes its first ' +
        'entry; thereafter the anchor chains off the lowest held lot and the ladder extends to ' +
        'its 5-rung limit. The ladder should extend fully, then stop adding while continuing to ' +
        'hold. No sell intent may be generated at any point.',
      [
        { kind: 'closesBelowFirstBarByPct', value: 25 },
        { kind: 'minBarCount', value: 780 },
      ],
      [
        { date: days[0], open: 100, close: 88 },
        { date: days[1], close: 86 },
        { date: days[2], close: 84 },
        { date: days[3], close: 82 },
        { date: days[4], close: 80 },
        { date: days[5], close: 77 },
        { date: days[6], close: 74 },
        { date: days[7], close: 72 },
        { date: days[8], close: 70 },
        { date: days[9], close: 68 },
      ],
      1003,
    ),

    /**
     * The headline scenario for Story 4. Price oscillates through a band
     * repeatedly so one rung can fire → hit target → exit → re-arm → fire again,
     * while a lower lot stays held and untouched throughout.
     */
    buildFixture(
      'chop-range',
      'Price oscillates between roughly 88.00 and 100.00 across twelve sessions, crossing the band ' +
        'at least three times. This is the scenario that motivates per-lot exits: an upper rung ' +
        'should fire, reach its target, exit, re-arm at its original price, and fire again — ' +
        'repeatedly — while a lower lot remains held and untouched.',
      [
        { kind: 'bandCrossings', low: 90, high: 98, minCrossings: 3 },
        { kind: 'minBarCount', value: 936 },
      ],
      [
        { date: days[0], open: 100, close: 88 },
        { date: days[1], close: 100 },
        { date: days[2], close: 88 },
        { date: days[3], close: 100 },
        { date: days[4], close: 88 },
        { date: days[5], close: 100 },
        { date: days[6], close: 88 },
        { date: days[7], close: 100 },
        { date: days[8], close: 88 },
        { date: days[9], close: 100 },
        { date: days[10], close: 88 },
        { date: days[11], close: 100 },
      ],
      1004,
    ),

    /**
     * Boundary bars for Story 3's session window: 09:30, 09:44/09:45 (the
     * firing threshold), 15:55, and 16:00, plus pre/post-market bars that must
     * be excluded entirely.
     */
    buildFixture(
      'session-edges',
      'Two sessions including pre-market (08:00, 09:00) and post-market (16:00, 17:00) bars ' +
        'alongside the regular session. Exercises the 09:45 firing threshold and the 16:00 close: ' +
        'no intent may fire at 09:30 or 09:40, the first eligible bar is 09:45, and nothing fires ' +
        'at or after 16:00 or outside the regular session at all. ' +
        'Note: `stories.md` names 09:44 as the "must not fire" case; 09:44 is not a 5-minute ' +
        'boundary, so the bar covering it is the one opening at 09:40 (covering 09:40:00–09:44:59). ' +
        'That is the bar asserted here.',
      [
        { kind: 'containsSessionTime', time: '09:30' },
        { kind: 'containsSessionTime', time: '09:40' },
        { kind: 'containsSessionTime', time: '09:45' },
        { kind: 'containsSessionTime', time: '15:55' },
        { kind: 'containsPreMarketBars' },
        { kind: 'containsPostMarketBars' },
      ],
      [
        { date: days[0], open: 100, close: 98, includeExtendedHours: true },
        { date: days[1], close: 97, includeExtendedHours: true },
      ],
      1005,
    ),
  ];
}

export { ET_ZONE };
