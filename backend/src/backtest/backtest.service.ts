/**
 * `BacktestService` — the composition point.
 *
 * Loads bars from the cache, runs the harness, computes statistics, persists
 * the run. Every piece it calls is independently testable without a database or
 * a broker; this layer exists to wire them and to own the two decisions that
 * need a single home: **where bars come from** and **what gets persisted**.
 *
 * ## Bars come from the cache, never from IB directly
 *
 * `BarRepository.findRange` only — a backtest must not be able to trigger a
 * historical request. Story 10 made pacing a correctness requirement
 * (`PRD.md:289`): a sweep of 27 combinations that each fetched its own history
 * would issue hundreds of identical requests and be silently throttled or
 * dropped. Reading from the cache also means every combination in a sweep sees
 * **byte-identical bars**, which is what makes their comparison valid at all.
 *
 * The consequence is that a backtest over a range the cache has not been
 * backfilled with returns no bars rather than fetching them, and this service
 * says so explicitly rather than reporting an empty result as a flat market.
 *
 * ## Synthetic bars must be asked for twice
 *
 * `findRange` excludes synthetic bars unless told otherwise, and this service
 * only passes `includeSynthetic` when the request sets it. A run that used them
 * is flagged `synthetic: true` on the persisted record and in the returned
 * report, because naive 3x compounding excludes the expense ratio and financing
 * costs real leveraged ETFs pay — optimistic in exactly the choppy regimes this
 * strategy targets (`stories.md:619`).
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { BarSize } from '../market-data/types';
import {
  BACKTEST_REPOSITORY,
  BacktestRepository,
  BacktestResultRecord,
  BacktestRunRecord,
  BAR_REPOSITORY,
  BarRepository,
} from '../repositories/repository.interfaces';
import { DIP_LADDER_ID_PREFIX } from '../strategies/dip-ladder/dip-ladder.strategy';
import { BacktestRequest, BacktestRunResult, runBacktest } from './replay-harness';
import { BacktestStatistics, computeStatistics } from './statistics';
import { runParameterSweep, SweepGrid, SweepRanking, SweepReport } from './parameter-sweep';
import { DEFAULT_DIP_LADDER_CONFIG } from '../strategies/dip-ladder/config';

/** A backtest as the HTTP layer asks for it — a range, not a bar array. */
export interface BacktestCommand {
  symbol: string;
  barSize: BarSize;
  from: string;
  to: string;
  /** Per-run, never read from global config. See `BacktestRequest.symbolCapital`. */
  symbolCapital?: number;
  accountEquity?: number;
  /** Opt-in, and flagged on the result when true. */
  includeSynthetic?: boolean;
  ladder?: BacktestRequest['ladder'];
  fillModel?: BacktestRequest['fillModel'];
  /** Present for a sweep; absent runs a single backtest. */
  grid?: SweepGrid;
  rankBy?: SweepRanking;
  /** Free-form label stored with the run, so an operator can find it later. */
  label?: string;
}

export interface BacktestReport {
  runId: string;
  symbol: string;
  barSize: BarSize;
  rangeStart: string;
  rangeEnd: string;
  barsProcessed: number;
  synthetic: boolean;
  statistics: BacktestStatistics;
  result: BacktestRunResult;
}

export interface SweepPersistedReport extends Omit<SweepReport, 'entries'> {
  /** One persisted run id per combination (`stories.md:664`). */
  entries: Array<{ runId: string; combination: unknown; statistics: BacktestStatistics }>;
}

/**
 * Defaults for a backtest's capital figures.
 *
 * **Not** the Story 13 allocation and must not be mistaken for it. A backtest
 * needs *some* figure to size rungs against, and the real per-symbol allocation
 * is deliberately unset (`PRD.md:503`) — these backtests are the evidence meant
 * to inform it. A stated nominal here keeps the run interpretable (results
 * scale linearly with it) without writing anything into the config the startup
 * assertion guards.
 */
export const BACKTEST_NOMINAL_CAPITAL = 100_000;
export const BACKTEST_NOMINAL_EQUITY = 100_000;

@Injectable()
export class BacktestService {
  private readonly logger = new Logger(BacktestService.name);

  constructor(
    @Inject(BAR_REPOSITORY) private readonly bars: BarRepository,
    @Inject(BACKTEST_REPOSITORY) private readonly runs: BacktestRepository,
  ) {}

  /** Runs one backtest over a cached range and persists it. */
  async run(command: BacktestCommand): Promise<BacktestReport> {
    const bars = await this.loadBars(command);

    const symbolCapital = command.symbolCapital ?? BACKTEST_NOMINAL_CAPITAL;
    const accountEquity = command.accountEquity ?? BACKTEST_NOMINAL_EQUITY;

    const result = await runBacktest({
      symbol: command.symbol,
      barSize: command.barSize,
      bars,
      symbolCapital,
      accountEquity,
      ladder: command.ladder,
      fillModel: command.fillModel,
    });

    const statistics = computeStatistics({
      closedTrades: result.closedTrades,
      equityCurve: result.equityCurve,
      openLotsAtEnd: result.openLots.length,
      commissionPaid: result.commissionPaid,
      startingEquity: accountEquity,
      maxConcurrentRungs:
        command.ladder?.maxConcurrentRungs ?? DEFAULT_DIP_LADDER_CONFIG.maxConcurrentRungs,
    });

    const runId = await this.persist(command, result, statistics, symbolCapital, accountEquity);

    return {
      runId,
      symbol: result.symbol,
      barSize: result.barSize,
      rangeStart: result.rangeStart,
      rangeEnd: result.rangeEnd,
      barsProcessed: result.barsProcessed,
      synthetic: result.synthetic,
      statistics,
      result,
    };
  }

  /**
   * Runs a grid sweep, persisting **one `BacktestRun` per combination**.
   *
   * Each is a full run record carrying its own parameter set, so two results
   * remain comparable after the fact without depending on what the config says
   * at read time.
   */
  async sweep(command: BacktestCommand): Promise<SweepPersistedReport> {
    if (!command.grid) {
      throw new Error('sweep requires a grid');
    }

    const bars = await this.loadBars(command);
    const symbolCapital = command.symbolCapital ?? BACKTEST_NOMINAL_CAPITAL;
    const accountEquity = command.accountEquity ?? BACKTEST_NOMINAL_EQUITY;

    const report = await runParameterSweep({
      symbol: command.symbol,
      barSize: command.barSize,
      bars,
      symbolCapital,
      accountEquity,
      baseLadder: command.ladder,
      fillModel: command.fillModel,
      grid: command.grid,
      rankBy: command.rankBy,
    });

    const entries = [];

    for (const entry of report.entries) {
      const runId = await this.persist(
        { ...command, ladder: { ...command.ladder, ...entry.combination } },
        entry.result,
        entry.statistics,
        symbolCapital,
        accountEquity,
      );

      entries.push({ runId, combination: entry.combination, statistics: entry.statistics });
    }

    return { ...report, entries };
  }

  async findRun(id: string): Promise<{
    run: BacktestRunRecord;
    results: BacktestResultRecord[];
  } | null> {
    const run = await this.runs.findRun(id);

    if (run === null) {
      return null;
    }

    return { run, results: await this.runs.findResults(id) };
  }

  async listRuns(): Promise<BacktestRunRecord[]> {
    return this.runs.findAllRuns();
  }

  /**
   * Bars for the requested range, from the cache only.
   *
   * Throws on an empty range rather than returning a zero-bar result. A
   * backtest reporting "0% return, no drawdown" over an un-backfilled range
   * looks like a finding; it is an absence of data, and the two must not be
   * confusable when the output informs a capital decision.
   */
  private async loadBars(command: BacktestCommand) {
    const bars = await this.bars.findRange(
      command.symbol,
      command.barSize,
      command.from,
      command.to,
      command.includeSynthetic ?? false,
    );

    if (bars.length === 0) {
      throw new Error(
        `no cached ${command.barSize} bars for ${command.symbol} in ${command.from}..${command.to}. ` +
          'Run a backfill first — a backtest never fetches history itself, because a sweep ' +
          "would breach IB's pacing limits.",
      );
    }

    this.logger.log(
      `loaded ${bars.length} cached bars for ${command.symbol} ${command.barSize} ${command.from}..${command.to}`,
    );

    return bars;
  }

  /**
   * Persists a run and its metrics.
   *
   * `parameters` stores the **effective** set — defaults merged with overrides
   * — rather than only what the caller passed, so a result read back a year
   * from now is interpretable without knowing what the defaults were then.
   */
  private async persist(
    command: BacktestCommand,
    result: BacktestRunResult,
    statistics: BacktestStatistics,
    symbolCapital: number,
    accountEquity: number,
  ): Promise<string> {
    const runId = `bt-${result.symbol}-${result.barSize}-${result.rangeStart}-${result.rangeEnd}-${hash(
      JSON.stringify({ ...command.ladder, symbolCapital, label: command.label }),
    )}`;

    await this.runs.saveRun({
      id: runId,
      strategyId: `${DIP_LADDER_ID_PREFIX}${result.symbol}`,
      symbol: result.symbol,
      barSize: result.barSize,
      rangeStart: result.rangeStart,
      rangeEnd: result.rangeEnd,
      parameters: {
        ...DEFAULT_DIP_LADDER_CONFIG,
        ...command.ladder,
        symbolCapital,
        accountEquity,
        fillModel: command.fillModel ?? null,
        label: command.label ?? null,
      },
      synthetic: result.synthetic,
      // Derived from the data's own range, not from a wall clock: a backtest
      // over fixed bars with fixed parameters must produce an identical record
      // every time it is run, or two runs of the same thing would not compare.
      createdAt: result.rangeEnd,
    });

    await this.runs.saveResults(metricRows(runId, statistics, result));

    return runId;
  }
}

/**
 * Flattens statistics into `(metric, value, detail)` rows.
 *
 * Null-valued statistics (win rate with no completed cycles) are **omitted**
 * rather than stored as zero. A zero win rate and an absent one mean opposite
 * things, and a column that cannot distinguish them would misreport a run that
 * simply never closed a lot.
 */
export function metricRows(
  runId: string,
  statistics: BacktestStatistics,
  result: BacktestRunResult,
): BacktestResultRecord[] {
  const rows: BacktestResultRecord[] = [
    { runId, metric: 'totalRealizedPnl', value: statistics.totalRealizedPnl },
    { runId, metric: 'finalUnrealizedPnl', value: statistics.finalUnrealizedPnl },
    { runId, metric: 'totalCommission', value: statistics.totalCommission },
    { runId, metric: 'totalReturnPercent', value: statistics.totalReturnPercent },
    {
      runId,
      metric: 'maxDrawdownPercent',
      value: statistics.maxDrawdownPercent,
      detail: {
        at: statistics.maxDrawdownAt,
        peak: statistics.maxDrawdownPeak,
        trough: statistics.maxDrawdownTrough,
      },
    },
    { runId, metric: 'completedCycles', value: statistics.completedCycles },
    { runId, metric: 'winningTrades', value: statistics.winningTrades },
    { runId, metric: 'losingTrades', value: statistics.losingTrades },
    { runId, metric: 'timeInPositionPercent', value: statistics.timeInPositionPercent },
    { runId, metric: 'timeAtHardFloorPercent', value: statistics.timeAtHardFloorPercent },
    { runId, metric: 'maxConcurrentLots', value: statistics.maxConcurrentLots },
    { runId, metric: 'openLotsAtEnd', value: statistics.openLotsAtEnd },
    { runId, metric: 'barsProcessed', value: result.barsProcessed },
    {
      runId,
      metric: 'rungDistribution',
      value: Object.keys(statistics.rungDistribution).length,
      detail: statistics.rungDistribution,
    },
    {
      runId,
      metric: 'barCoverage',
      value: result.coverage.largestGapMs,
      detail: {
        barCount: result.coverage.barCount,
        largestGapAt: result.coverage.largestGapAt,
      },
    },
  ];

  if (statistics.annualizedReturnPercent !== null) {
    rows.push({
      runId,
      metric: 'annualizedReturnPercent',
      value: statistics.annualizedReturnPercent,
    });
  }

  if (statistics.winRate !== null) {
    rows.push({ runId, metric: 'winRate', value: statistics.winRate });
  }

  if (statistics.averageHoldingPeriodMs !== null) {
    rows.push({
      runId,
      metric: 'averageHoldingPeriodMs',
      value: statistics.averageHoldingPeriodMs,
    });
  }

  return rows;
}

/**
 * A short, stable hash of a run's parameters, used in its id.
 *
 * Deterministic so re-running the same backtest **upserts** the same row rather
 * than accumulating near-duplicates that differ only by when they were run.
 * FNV-1a: not cryptographic, and does not need to be — it disambiguates
 * parameter sets within one symbol and range.
 */
function hash(value: string): string {
  let h = 0x811c9dc5;

  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }

  return h.toString(16).padStart(8, '0');
}
