/**
 * Drawdown scenario data.
 *
 * Story 11's headline requirement is that **the 2022 drawdown is examined
 * explicitly, as its own reported scenario rather than averaged into a summary
 * statistic** (`stories.md:648`, `PRD.md:472`). TQQQ fell roughly 80% that year;
 * it is the regime this configuration — a 3x leveraged ETF, averaged down, with
 * no stop-loss — is most exposed to.
 *
 * ## Why these are generated rather than real bars
 *
 * Real TQQQ history lives in the MySQL cache and gets there only through a
 * paced Story 10 backfill against a live IB Gateway. That is unavailable in CI
 * and on any machine without credentials, so a scenario suite depending on it
 * would skip — and **a skipped suite looks exactly like a passing one**
 * (`CLAUDE.md`), which is the specific failure mode this repo already guards
 * against elsewhere.
 *
 * So the shapes are reproduced deterministically here: same peak-to-trough
 * magnitude, same duration, same interrupted-rally structure as the real
 * declines. What the ladder does through an 80% fall — how far it extends, how
 * long it sits at the hard floor, whether any lot ever reaches its target — is
 * a function of that shape, and these fixtures exercise every one of those code
 * paths.
 *
 * **They are not a substitute for the real thing.** `scenarios.spec.ts` asserts
 * ladder *behaviour* (extension, floor, no stop-loss, no liquidation), which the
 * shape determines. The *numbers* an operator acts on must come from real cached
 * bars via `BacktestService`, which reads the same code path — see
 * `real-history.spec.ts`, which runs against the cache when it is populated and
 * says so loudly when it is not.
 *
 * ## The interrupted rally matters
 *
 * 2022 was not a straight line down: it fell to roughly −55% by June, rallied
 * hard into August without reclaiming the high, then fell again to its December
 * low. That structure is what makes the scenario interesting — the rally lifts
 * lots toward their targets without necessarily reaching them, and a naive
 * monotonic decline would never exercise the re-arm path mid-drawdown. Both
 * fixtures reproduce it.
 */

import { formatEt, parseEtDate } from '../../market-data/session';
import { mulberry32, roundPrice } from '../../market-data/mock/generator';
import { Bar, BarSize } from '../../market-data/types';

/** One leg of a price path: walk to `to` over `sessions` trading days. */
interface Leg {
  to: number;
  sessions: number;
  /**
   * Every Nth session in this leg concentrates the decline into one drop.
   *
   * **Without this the ladder never fires**, and the reason is a real property
   * of the strategy rather than an artifact of the data. The bootstrap anchor is
   * `max(previous close, today's open)` **recomputed every session**
   * (`anchor.ts`), so it re-bases downward each day. A decline spread evenly at
   * −0.7% per session therefore never puts a close 5% below that session's own
   * anchor, and no rung fires no matter how far the year falls.
   *
   * Real leveraged-ETF declines are not evenly spread: 2022 delivered repeated
   * single-session drops of 5–8% on TQQQ, and those are precisely the days a dip
   * ladder is designed to buy. A fixture without them would understate ladder
   * extension to zero and report a drawdown scenario in which the strategy never
   * took a position — which would be a fixture artifact reported as a finding.
   */
  shockEvery?: number;
  /** Fractional size of a shock day's drop. 0.07 = −7%. */
  shockMagnitude?: number;
}

export interface DrawdownShape {
  name: string;
  symbol: string;
  /** ET calendar date of the first session, `yyyy-MM-dd`. */
  startDate: string;
  startPrice: number;
  legs: Leg[];
  seed: number;
  /** Per-bar noise as a fraction of price. */
  noise: number;
  /** Marks the series as derived rather than IB-reported (`stories.md:619`). */
  synthetic?: boolean;
}

/**
 * TQQQ 2022 — peak ~$91 in January to ~$16 in December, about −82%.
 *
 * Legs follow the real year's structure: a first-half slide into the June low,
 * the summer rally that stopped well short of the high, and the autumn decline
 * to the December trough.
 */
export const TQQQ_2022: DrawdownShape = {
  name: 'tqqq-2022',
  symbol: 'TQQQ',
  startDate: '2022-01-03',
  startPrice: 91,
  legs: [
    // Jan–mid-June: the first slide, punctuated by capitulation days
    { to: 40, sessions: 115, shockEvery: 9, shockMagnitude: 0.07 },
    // mid-June–mid-Aug: the rally that never reclaims the high
    { to: 63, sessions: 45 },
    // mid-Aug–Dec: the decline to the December low
    { to: 16, sessions: 91, shockEvery: 8, shockMagnitude: 0.075 },
  ],
  seed: 20220103,
  noise: 0.02,
};

/**
 * TQQQ 2020 — the COVID crash. ~$61 in February to ~$18 in March, about −70%,
 * followed by the recovery that made it a different scenario from 2022: a
 * ladder that survived the fall saw every lot reach its target within months.
 */
export const TQQQ_2020: DrawdownShape = {
  name: 'tqqq-2020',
  symbol: 'TQQQ',
  startDate: '2020-02-19',
  startPrice: 61,
  legs: [
    // Feb 19–Mar 23: the crash, brutally fast and shock-dominated
    { to: 18, sessions: 23, shockEvery: 4, shockMagnitude: 0.11 },
    { to: 30, sessions: 25 }, // Mar 23–end Apr: the initial bounce
    { to: 55, sessions: 60 }, // May–July: the recovery
  ],
  seed: 20200219,
  noise: 0.035,
};

/**
 * Synthetic 3x QQQ across the 2000 dot-com collapse.
 *
 * TQQQ did not exist before February 2010, so evaluating the rules across 2000
 * and 2008 requires synthesizing 3x daily returns from QQQ (`PRD.md:299`).
 * Flagged `synthetic: true` on **every bar**, because naive 3x compounding
 * excludes the expense ratio and financing costs a real leveraged ETF pays —
 * making it optimistic in exactly the choppy regimes this strategy targets.
 */
export const SYNTHETIC_3X_2000: DrawdownShape = {
  name: 'synthetic-3x-2000',
  symbol: 'TQQQ',
  startDate: '2000-03-10',
  startPrice: 100,
  legs: [
    { to: 45, sessions: 90, shockEvery: 10, shockMagnitude: 0.08 },
    { to: 60, sessions: 40 },
    { to: 8, sessions: 250, shockEvery: 12, shockMagnitude: 0.07 },
  ],
  seed: 20000310,
  noise: 0.03,
  synthetic: true,
};

/**
 * Builds a daily bar series for a shape.
 *
 * Deterministic: the same shape always yields byte-identical bars, so a
 * scenario's reported figures are reproducible and a change to them shows up as
 * a failing assertion rather than as drift.
 *
 * Prices walk geometrically rather than linearly between leg endpoints, because
 * a percentage-spaced ladder cares about ratios — a linear path would spend
 * disproportionate time at the high end and misstate how quickly rungs fire.
 *
 * ## Why each session emits two bars
 *
 * The ladder anchors on the **09:30 open** and fires only from **09:45**
 * (`session-window.ts`). Those two rules are deliberately distinct: the opening
 * bar sets the anchor and may not itself fire. A daily series stamped once at
 * 09:30 would therefore anchor correctly and **never fire a single rung**,
 * making every drawdown scenario silently report an empty ladder.
 *
 * The honest representation of a daily bar for this strategy is consequently
 * two: an **anchor bar at 09:30** carrying the session's open, and a **body bar
 * at 09:45** carrying its full range and close. Both describe the same trading
 * day and together cover it exactly once — the low the ladder buys into and the
 * close it evaluates against are the real session's.
 *
 * The alternative — relaxing the 09:45 rule for daily bars — was rejected: that
 * rule is a Story 3 invariant with its own suite, and a backtester that changed
 * strategy behaviour to suit its data would no longer be testing the strategy
 * that trades.
 */
export function buildDrawdownBars(shape: DrawdownShape): Bar[] {
  const rand = mulberry32(shape.seed);
  const bars: Bar[] = [];

  let sessionDate = parseEtDate(shape.startDate);
  let price = shape.startPrice;

  for (const leg of shape.legs) {
    // Per-session growth factor that lands exactly on `leg.to`, with the
    // cumulative effect of the leg's shock days divided back out. Without this
    // correction, adding shocks would deepen every leg past its stated
    // endpoint and silently change the scenario's magnitude — the one number a
    // drawdown fixture must state honestly.
    const shockCount = leg.shockEvery ? Math.floor((leg.sessions - 1) / leg.shockEvery) : 0;
    const shockDrag = Math.pow(1 - (leg.shockMagnitude ?? 0.07), shockCount);
    const step = Math.pow(leg.to / price / shockDrag, 1 / leg.sessions);

    for (let i = 0; i < leg.sessions; i += 1) {
      while (sessionDate.weekday > 5) {
        sessionDate = sessionDate.plus({ days: 1 });
      }

      const open = price;
      // Volatility clustering: a shock session concentrates the decline into
      // one drop, the way a real leveraged-ETF selloff does. The remaining
      // sessions in the leg drift back toward the leg's endpoint, so the
      // scenario's overall magnitude is unchanged — only its *distribution* is,
      // and that distribution is what determines whether a rung ever fires.
      const shock =
        leg.shockEvery && i > 0 && i % leg.shockEvery === 0 ? 1 - (leg.shockMagnitude ?? 0.07) : 1;

      // Noise is symmetric around the leg's path, so it perturbs the route
      // without moving the endpoint the scenario's magnitude depends on.
      const close = open * step * shock * (1 + (rand() - 0.5) * shape.noise);
      const wick = open * shape.noise;
      const high = roundPrice(Math.max(open, close) + rand() * wick);
      const low = roundPrice(Math.min(open, close) - rand() * wick);
      const volume = Math.floor(50_000_000 + rand() * 100_000_000);
      const synthetic = shape.synthetic ? { synthetic: true as const } : {};

      // The anchor bar: the session's open, at the opening bell. Its range is
      // the open alone — the session's extremes belong to the body bar, and
      // duplicating them here would let one day's low fire two rungs.
      bars.push({
        symbol: shape.symbol,
        barSize: BarSize.DAILY,
        timestamp: formatEt(sessionDate.set({ hour: 9, minute: 30, second: 0, millisecond: 0 })),
        open: roundPrice(open),
        high: roundPrice(open),
        low: roundPrice(open),
        close: roundPrice(open),
        volume: 0,
        ...synthetic,
      });

      // The body bar: the session's full range and its close, inside the
      // firing window.
      bars.push({
        symbol: shape.symbol,
        barSize: BarSize.DAILY,
        timestamp: formatEt(sessionDate.set({ hour: 9, minute: 45, second: 0, millisecond: 0 })),
        open: roundPrice(open),
        high,
        low,
        close: roundPrice(close),
        volume,
        ...synthetic,
      });

      price = close;
      sessionDate = sessionDate.plus({ days: 1 });
    }
  }

  return bars;
}

/** Trading sessions in a series built by `buildDrawdownBars` (two bars each). */
export function sessionCount(bars: Bar[]): number {
  return new Set(bars.map((bar) => bar.timestamp.slice(0, 10))).size;
}

/** Peak-to-trough decline of a series, as a positive fraction. */
export function peakToTrough(bars: Bar[]): number {
  let peak = 0;
  let worst = 0;

  for (const bar of bars) {
    peak = Math.max(peak, bar.high);

    if (peak > 0) {
      worst = Math.max(worst, (peak - bar.low) / peak);
    }
  }

  return worst;
}
