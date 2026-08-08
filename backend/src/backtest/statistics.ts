/**
 * Statistics — stage 3 of the backtester (`PRD.md:409`).
 *
 * Pure functions over a `BacktestRunResult`. No I/O, no clock, no randomness,
 * so every figure here is verifiable against a hand-worked fixture — which
 * `statistics.spec.ts` does for each one individually. That matters more than
 * usual: these numbers are the evidence Story 13 uses to set the per-symbol
 * capital and the daily loss threshold, and a quietly wrong drawdown figure
 * would inform a decision about real money.
 *
 * ## Two measurement choices that are easy to get wrong
 *
 * **Drawdown is measured on total equity, not on realized P&L.** A ladder that
 * never sells at a loss has, by construction, a realized curve that only ever
 * goes up — so a realized-only drawdown on this strategy is always ~0% and
 * reports nothing. The drawdown that matters is the mark-to-market one the
 * operator actually lives through, which is why `EquityPoint` carries
 * unrealized separately and why this measures the sum.
 *
 * **Win rate counts completed cycles, not lots.** A lot still held at the end
 * of the run has not lost — it has not finished. Counting open lots as losses
 * would make every backtest ending mid-drawdown look catastrophic; excluding
 * them entirely, without reporting them, would hide a ladder that ended with
 * five rungs underwater. So open lots are reported as their own figure
 * (`openLotsAtEnd`) rather than folded into the win rate.
 *
 * Since the ladder has **no stop-loss and lots only ever exit in profit**
 * (`PRD.md:141`), a win rate near 100% is the expected result and is *not* a
 * sign the strategy works. `losingTrades` exists to prove the metric is live
 * rather than hardcoded, and the number that carries the actual risk is
 * `maxDrawdownPercent` alongside `timeAtHardFloorPercent`.
 */

import { ClosedTrade, EquityPoint } from './replay-harness';

export interface BacktestStatistics {
  /** Net realized P&L across completed cycles, commissions deducted. */
  totalRealizedPnl: number;
  /** Mark-to-market on lots still held at the final bar. */
  finalUnrealizedPnl: number;
  totalCommission: number;
  /** Return on starting equity, fractional. 0.1 = +10%. */
  totalReturnPercent: number;
  /**
   * Total return annualized by the run's calendar span.
   *
   * Null for a span under a day: annualizing a few hours compounds noise into
   * a meaningless number, and reporting one would invite comparing it to a
   * multi-year run.
   */
  annualizedReturnPercent: number | null;
  /** Largest peak-to-trough fall in total equity, fractional and positive. */
  maxDrawdownPercent: number;
  /** ISO timestamp of the drawdown trough. */
  maxDrawdownAt: string | null;
  /** Peak equity preceding the max drawdown. */
  maxDrawdownPeak: number;
  maxDrawdownTrough: number;
  completedCycles: number;
  winningTrades: number;
  losingTrades: number;
  /** Fraction of completed cycles that were profitable. Null when none closed. */
  winRate: number | null;
  /** Mean holding period of a completed cycle, in milliseconds. */
  averageHoldingPeriodMs: number | null;
  /** Fraction of bars on which at least one lot was held. */
  timeInPositionPercent: number;
  /** Fraction of bars on which the ladder was fully extended to its rung limit. */
  timeAtHardFloorPercent: number;
  /** Deepest simultaneous rung count reached. */
  maxConcurrentLots: number;
  /** Lots never closed — an unfinished ladder is a real, reportable outcome. */
  openLotsAtEnd: number;
  /** Completed cycles per rung price, keyed by price as a string. */
  rungDistribution: Record<string, number>;
}

export interface StatisticsInput {
  closedTrades: ClosedTrade[];
  equityCurve: EquityPoint[];
  openLotsAtEnd: number;
  commissionPaid: number;
  startingEquity: number;
  /**
   * Lots held simultaneously at which the ladder is considered fully extended.
   *
   * `maxConcurrentRungs` from the ladder config. Passed in rather than imported
   * so this module stays free of strategy config — a statistic should not know
   * how the strategy is configured, only what it was told to measure against.
   */
  maxConcurrentRungs: number;
}

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function computeStatistics(input: StatisticsInput): BacktestStatistics {
  const { closedTrades, equityCurve, startingEquity } = input;

  const totalRealizedPnl = round(closedTrades.reduce((sum, trade) => sum + trade.realizedPnl, 0));
  const finalUnrealizedPnl = equityCurve.length
    ? equityCurve[equityCurve.length - 1].unrealized
    : 0;

  const drawdown = maxDrawdown(equityCurve);
  const winning = closedTrades.filter((trade) => trade.realizedPnl > 0).length;
  const losing = closedTrades.filter((trade) => trade.realizedPnl <= 0).length;

  return {
    totalRealizedPnl,
    finalUnrealizedPnl,
    totalCommission: round(input.commissionPaid),
    totalReturnPercent: totalReturn(totalRealizedPnl, finalUnrealizedPnl, startingEquity),
    annualizedReturnPercent: annualizedReturn(
      totalReturn(totalRealizedPnl, finalUnrealizedPnl, startingEquity),
      equityCurve,
    ),
    maxDrawdownPercent: drawdown.percent,
    maxDrawdownAt: drawdown.at,
    maxDrawdownPeak: drawdown.peak,
    maxDrawdownTrough: drawdown.trough,
    completedCycles: closedTrades.length,
    winningTrades: winning,
    losingTrades: losing,
    winRate: closedTrades.length === 0 ? null : round4(winning / closedTrades.length),
    averageHoldingPeriodMs: averageHoldingPeriod(closedTrades),
    timeInPositionPercent: fractionOfBars(equityCurve, (point) => point.heldLots > 0),
    timeAtHardFloorPercent: fractionOfBars(
      equityCurve,
      (point) => point.heldLots >= input.maxConcurrentRungs,
    ),
    maxConcurrentLots: equityCurve.reduce((max, point) => Math.max(max, point.heldLots), 0),
    openLotsAtEnd: input.openLotsAtEnd,
    rungDistribution: rungDistribution(closedTrades),
  };
}

/**
 * Total return on starting equity.
 *
 * Includes unrealized, because a ladder holding five underwater lots has not
 * "returned 0%" — it is down, and reporting only realized would describe a
 * losing run as flat.
 */
export function totalReturn(realized: number, unrealized: number, startingEquity: number): number {
  if (startingEquity <= 0) {
    return 0;
  }

  return round4((realized + unrealized) / startingEquity);
}

/**
 * Annualizes a total return over the curve's calendar span.
 *
 * Compounded, not scaled linearly: `(1 + r)^(year/span) - 1`. A linear
 * annualization of a 3-month run would overstate a compounding strategy by
 * roughly its own volatility.
 *
 * Returns null for spans under a day, and for a total loss (where the
 * compounding base is non-positive and the root is undefined).
 */
export function annualizedReturn(total: number, equityCurve: EquityPoint[]): number | null {
  if (equityCurve.length < 2) {
    return null;
  }

  const spanMs =
    Date.parse(equityCurve[equityCurve.length - 1].timestamp) -
    Date.parse(equityCurve[0].timestamp);

  if (spanMs < MS_PER_DAY) {
    return null;
  }

  const growth = 1 + total;

  if (growth <= 0) {
    return null;
  }

  return round4(Math.pow(growth, MS_PER_YEAR / spanMs) - 1);
}

export interface DrawdownResult {
  /** Positive fraction. 0.8 = an 80% fall from peak. */
  percent: number;
  at: string | null;
  peak: number;
  trough: number;
}

/**
 * Largest peak-to-trough decline in total equity.
 *
 * The running peak only ever rises, so a later, deeper trough measured against
 * an earlier peak is correctly reported as the larger drawdown — which is the
 * behaviour 2022 requires, where the fall is long and interrupted by rallies
 * that never reclaim the high.
 */
export function maxDrawdown(equityCurve: EquityPoint[]): DrawdownResult {
  let peak = equityCurve.length ? equityCurve[0].equity : 0;
  let worst: DrawdownResult = { percent: 0, at: null, peak, trough: peak };

  for (const point of equityCurve) {
    if (point.equity > peak) {
      peak = point.equity;
    }

    if (peak <= 0) {
      continue;
    }

    const decline = (peak - point.equity) / peak;

    if (decline > worst.percent) {
      worst = { percent: round4(decline), at: point.timestamp, peak, trough: point.equity };
    }
  }

  return worst;
}

export function averageHoldingPeriod(trades: ClosedTrade[]): number | null {
  if (trades.length === 0) {
    return null;
  }

  return Math.round(trades.reduce((sum, trade) => sum + trade.holdingPeriodMs, 0) / trades.length);
}

/**
 * Completed cycles per rung price.
 *
 * Keyed by price rather than by rung index because a rung's identity *is* its
 * price — that is what re-arming preserves (`rung.ts:36`), and an index would
 * shift as the ladder extends.
 */
export function rungDistribution(trades: ClosedTrade[]): Record<string, number> {
  const distribution: Record<string, number> = {};

  for (const trade of trades) {
    const key = trade.rungPrice.toFixed(2);
    distribution[key] = (distribution[key] ?? 0) + 1;
  }

  return distribution;
}

function fractionOfBars(
  equityCurve: EquityPoint[],
  predicate: (point: EquityPoint) => boolean,
): number {
  if (equityCurve.length === 0) {
    return 0;
  }

  return round4(equityCurve.filter(predicate).length / equityCurve.length);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Fractions carry four places — 0.0001 is a basis point, the useful floor. */
function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
