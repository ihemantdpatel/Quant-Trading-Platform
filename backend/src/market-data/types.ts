/**
 * Market data domain types.
 *
 * Timestamps are stored as ISO-8601 strings carrying an explicit UTC offset
 * (e.g. `2025-01-02T09:30:00.000-05:00`). Two reasons: fixtures stay
 * human-readable and diffable as committed JSON, and the offset makes the
 * EST/EDT distinction visible in the data rather than implied by a separate
 * timezone field that could drift out of sync with the instant.
 */

export const ET_ZONE = 'America/New_York';

export enum BarSize {
  FIVE_MIN = '5min',
  DAILY = '1day',
}

/**
 * Number of minutes in each bar size. Used to validate that a bar's timestamp
 * falls on a legitimate boundary for its size.
 */
export const BAR_SIZE_MINUTES: Record<BarSize, number> = {
  [BarSize.FIVE_MIN]: 5,
  [BarSize.DAILY]: 24 * 60,
};

/**
 * A single OHLCV candle.
 *
 * `timestamp` is the bar's OPEN time, matching IB's convention — a 5-minute
 * bar stamped 09:30 covers 09:30:00–09:34:59. Story 3 fires on bar *close*,
 * so it must add the bar duration rather than reading this field as a close
 * time.
 */
export interface Bar {
  symbol: string;
  barSize: BarSize;
  /** ISO-8601 with explicit ET offset. Bar OPEN time. */
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /**
   * True for a **derived** series rather than one IB reported (Story 10).
   *
   * Only pre-2010 TQQQ, synthesized from QQQ daily returns so the rules can be
   * evaluated across 2000 and 2008 — TQQQ did not exist then (`PRD.md:299`).
   * Such a series is *approximate and optimistic*: naive 3x compounding
   * excludes the expense ratio and financing costs that make real leveraged
   * ETFs decay faster, so a backtest that silently mixed it with real bars
   * would report a return the instrument could not have produced.
   *
   * Optional, and absent means real. Every bar IB or a fixture supplies is real,
   * so requiring the field would add `synthetic: false` to thousands of
   * committed fixture bars to state the default.
   */
  synthetic?: boolean;
}

/**
 * A single trade/quote print. Declared now so the `onTick` lifecycle hook
 * (`PRD.md` §2) has a real type from day one; the mock pipeline is bar-driven,
 * and ticks arrive with the IB adapter at Story 10.
 */
export interface Tick {
  symbol: string;
  /** ISO-8601 with explicit ET offset. */
  timestamp: string;
  price: number;
  size: number;
}

/**
 * A named scenario: bars plus the outcome the fixture exists to demonstrate.
 *
 * `expectation` is prose for a human reading the file. `invariants` are the
 * machine-checked assertions — every fixture must state at least one, so a
 * fixture can never be silently edited into meaninglessness.
 */
export interface Fixture {
  name: string;
  symbol: string;
  barSize: BarSize;
  /** Human-readable statement of what this scenario demonstrates. */
  expectation: string;
  invariants: FixtureInvariant[];
  bars: Bar[];
}

/**
 * Declarative, strategy-agnostic assertions. Deliberately expressed in terms of
 * price and time only — a fixture that knew about rungs or anchors would couple
 * the data to the strategy it is meant to test independently.
 */
export type FixtureInvariant =
  | { kind: 'minBarCount'; value: number }
  | { kind: 'closesBelowFirstBarByPct'; value: number }
  | { kind: 'gapDownFromPreviousClosePct'; value: number }
  | { kind: 'recoversToPreviousClose' }
  | { kind: 'bandCrossings'; low: number; high: number; minCrossings: number }
  | { kind: 'containsSessionTime'; time: string }
  | { kind: 'containsPreMarketBars' }
  | { kind: 'containsPostMarketBars' };
