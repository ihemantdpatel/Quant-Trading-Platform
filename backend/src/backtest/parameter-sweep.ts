/**
 * Parameter sweeps — stage 4 of the backtester (`PRD.md:411`).
 *
 * A grid over spacing, rung count, and exit target: the three parameters that
 * define the ladder's shape. Each combination is **one independent run with its
 * own strategy instance, its own repositories, and its own broker**, because
 * `runBacktest` constructs and discards all of them. Sharing any of those would
 * let one combination's lots contaminate the next, and the resulting comparison
 * would attribute one parameter set's position to another's results.
 *
 * ## Why the grid is explicit rather than optimizing
 *
 * There is no search, no hill-climbing, no "best" flag. The output is the full
 * grid with each combination's statistics, ranked but not chosen.
 *
 * That is deliberate. **Story 11 is expressly forbidden from changing strategy
 * defaults based on results** (`stories.md:651`) — that decision belongs to
 * Story 13, informed by these numbers plus judgement this code does not have.
 * A sweep that reported a winner would invite adopting it, and on a strategy
 * with no stop-loss the parameter set with the best backtested return is
 * frequently the one that was luckiest about where the drawdown ended. Ranking
 * by return alone is exactly the wrong summary, which is why `rankBy` defaults
 * to a risk-aware measure and every combination's drawdown travels with it.
 *
 * ## Cost
 *
 * The grid is multiplicative: 3 spacings × 3 rung counts × 3 targets is 27 full
 * replays of the entire bar range. Runs are sequential rather than parallel —
 * they are CPU-bound and deterministic, and parallelism would buy little while
 * making a failure mid-sweep harder to attribute.
 */

import { Logger } from '@nestjs/common';
import { BarSize } from '../market-data/types';
import { BacktestRequest, BacktestRunResult, runBacktest } from './replay-harness';
import { BacktestStatistics, computeStatistics } from './statistics';
import { DEFAULT_DIP_LADDER_CONFIG } from '../strategies/dip-ladder/config';

/**
 * The swept dimensions.
 *
 * Each is a list of values to try. An empty or omitted list means "hold this
 * parameter at its shipped default", which keeps a one-dimensional sweep to one
 * axis rather than requiring the caller to restate the others.
 */
export interface SweepGrid {
  /** Fractional rung spacing. 0.05 = 5%. */
  spacingPercent?: number[];
  /** Concurrent rung limit. */
  maxConcurrentRungs?: number[];
  /** Fractional per-lot take-profit. 0.05 = +5%. */
  takeProfitPercent?: number[];
}

export interface SweepRequest extends Omit<BacktestRequest, 'ladder'> {
  grid: SweepGrid;
  /** Ladder parameters held constant across every combination. */
  baseLadder?: BacktestRequest['ladder'];
  /**
   * How the returned combinations are ordered.
   *
   * Defaults to `RETURN_PER_DRAWDOWN` rather than raw return — see the header.
   * Ordering is presentation only; nothing is selected or applied.
   */
  rankBy?: SweepRanking;
}

export enum SweepRanking {
  /** Total return divided by max drawdown. Risk-aware, and the default. */
  RETURN_PER_DRAWDOWN = 'RETURN_PER_DRAWDOWN',
  TOTAL_RETURN = 'TOTAL_RETURN',
  MAX_DRAWDOWN = 'MAX_DRAWDOWN',
  COMPLETED_CYCLES = 'COMPLETED_CYCLES',
}

/** The parameters one combination used — the run's identity. */
export interface SweepCombination {
  spacingPercent: number;
  maxConcurrentRungs: number;
  takeProfitPercent: number;
}

export interface SweepEntry {
  combination: SweepCombination;
  statistics: BacktestStatistics;
  result: BacktestRunResult;
}

export interface SweepReport {
  symbol: string;
  barSize: BarSize;
  rangeStart: string;
  rangeEnd: string;
  /** Every combination, ordered by `rankBy`. Nothing is selected. */
  entries: SweepEntry[];
  combinationsRun: number;
}

const logger = new Logger('ParameterSweep');

/**
 * Expands a grid into every combination, in a deterministic order.
 *
 * Sorted per axis so a sweep's output ordering does not depend on the order the
 * caller happened to list values in — two callers requesting the same grid must
 * get comparable reports.
 */
export function expandGrid(grid: SweepGrid): SweepCombination[] {
  const spacings = axis(grid.spacingPercent, DEFAULT_DIP_LADDER_CONFIG.spacingPercent);
  const rungCounts = axis(grid.maxConcurrentRungs, DEFAULT_DIP_LADDER_CONFIG.maxConcurrentRungs);
  const targets = axis(grid.takeProfitPercent, DEFAULT_DIP_LADDER_CONFIG.takeProfitPercent);

  const combinations: SweepCombination[] = [];

  for (const spacingPercent of spacings) {
    for (const maxConcurrentRungs of rungCounts) {
      for (const takeProfitPercent of targets) {
        combinations.push({ spacingPercent, maxConcurrentRungs, takeProfitPercent });
      }
    }
  }

  return combinations;
}

function axis(values: number[] | undefined, fallback: number): number[] {
  if (!values || values.length === 0) {
    return [fallback];
  }

  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * Runs every combination in the grid.
 *
 * **One `BacktestRun` per combination** (`stories.md:664`) — persisting them is
 * the caller's job (`BacktestService`), so this stays a pure computation that a
 * test can run without a database.
 */
export async function runParameterSweep(request: SweepRequest): Promise<SweepReport> {
  const combinations = expandGrid(request.grid);

  logger.log(
    `sweeping ${combinations.length} combination(s) over ${request.bars.length} bars of ${request.symbol}`,
  );

  const entries: SweepEntry[] = [];

  for (const combination of combinations) {
    const result = await runBacktest({
      ...request,
      ladder: {
        ...request.baseLadder,
        spacingPercent: combination.spacingPercent,
        maxConcurrentRungs: combination.maxConcurrentRungs,
        takeProfitPercent: combination.takeProfitPercent,
      },
    });

    entries.push({
      combination,
      result,
      statistics: computeStatistics({
        closedTrades: result.closedTrades,
        equityCurve: result.equityCurve,
        openLotsAtEnd: result.openLots.length,
        commissionPaid: result.commissionPaid,
        startingEquity: request.accountEquity,
        maxConcurrentRungs: combination.maxConcurrentRungs,
      }),
    });
  }

  const ranked = rank(entries, request.rankBy ?? SweepRanking.RETURN_PER_DRAWDOWN);

  return {
    symbol: request.symbol,
    barSize: request.barSize,
    rangeStart: entries[0]?.result.rangeStart ?? '',
    rangeEnd: entries[0]?.result.rangeEnd ?? '',
    entries: ranked,
    combinationsRun: ranked.length,
  };
}

/**
 * Orders entries for presentation. Does not select or mark a winner.
 *
 * `MAX_DRAWDOWN` sorts ascending (shallowest first) since a smaller drawdown is
 * the better outcome; the rest sort descending.
 */
export function rank(entries: SweepEntry[], ranking: SweepRanking): SweepEntry[] {
  const scored = entries.map((entry) => ({ entry, score: score(entry, ranking) }));

  scored.sort((a, b) =>
    ranking === SweepRanking.MAX_DRAWDOWN ? a.score - b.score : b.score - a.score,
  );

  return scored.map((item) => item.entry);
}

function score(entry: SweepEntry, ranking: SweepRanking): number {
  const stats = entry.statistics;

  switch (ranking) {
    case SweepRanking.TOTAL_RETURN:
      return stats.totalReturnPercent;
    case SweepRanking.MAX_DRAWDOWN:
      return stats.maxDrawdownPercent;
    case SweepRanking.COMPLETED_CYCLES:
      return stats.completedCycles;
    case SweepRanking.RETURN_PER_DRAWDOWN:
    default:
      // A run that never drew down has no risk to divide by; ranking it by
      // return alone is the honest reading rather than an infinite score.
      return stats.maxDrawdownPercent === 0
        ? stats.totalReturnPercent
        : stats.totalReturnPercent / stats.maxDrawdownPercent;
  }
}
