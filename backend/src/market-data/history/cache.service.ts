/**
 * Cache-first historical bars — **a correctness requirement, not a speed-up**
 * (`PRD.md:293`).
 *
 * "All historical bars are cached in MySQL and served from there. IB is called
 * only to fill gaps, through a rate-limited request queue." The reason is not
 * latency: exceeding IB's pacing limits does not fail cleanly, it silently
 * throttles or drops the connection, and a system that re-requested history it
 * already had would breach those limits routinely while appearing to work.
 *
 * ## The problem this file actually solves
 *
 * A gap in the cache is easy to state and hard to detect, because **an absent
 * bar has two possible causes**:
 *
 * 1. the market was closed — a weekend, a holiday, an hour outside the session
 * 2. we never fetched it
 *
 * Only the second is a gap. Confusing them is expensive in both directions: a
 * system that treats every quiet stretch as a gap re-requests Christmas Day
 * forever and burns its pacing budget on data that does not exist, while one
 * that treats a real gap as a holiday leaves a permanent hole in the history a
 * backtest then reads as a flat market.
 *
 * The resolution here is deliberately **coverage-based rather than
 * completeness-based**: a range is considered cached when it contains bars at
 * the edges and no interior span longer than `maxGapMs` is empty. Session
 * boundaries and holidays produce predictable, bounded quiet stretches; a
 * genuine gap does not.
 *
 * ## What this does not do
 *
 * It does not decide *how far back* history should reach — that is the
 * backfill's job, which chunks a long span into requests IB will accept. This
 * service answers one question at a time: "for this range, what is missing?"
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Contract } from '../../domain/contract';
import { BAR_REPOSITORY, BarRepository } from '../../repositories/repository.interfaces';
import { Bar, BarSize } from '../types';

/**
 * The historical source the cache falls back to.
 *
 * Narrow on purpose: the cache needs exactly one capability from a broker, and
 * depending on the whole `BrokerAdapter` would make it untestable without one —
 * and would let a future edit reach `submit()` from a data-loading path. Story
 * 11's backtester can satisfy this from a file just as well as IB does from a
 * socket.
 */
export interface HistoricalSource {
  getHistoricalBars(request: {
    contract: Contract;
    barSize: BarSize;
    from: string;
    to: string;
  }): Promise<Bar[]>;
}

/** DI token for the source, so the cache never names the IB adapter. */
export const HISTORICAL_SOURCE = Symbol('HISTORICAL_SOURCE');

export interface CacheConfig {
  /**
   * The longest empty interior span treated as normal rather than a gap.
   *
   * Four days by default for daily bars: a Friday→Monday weekend is three, and
   * a holiday-extended weekend four. Anything longer is missing data, not a
   * closed market.
   */
  maxGapMsDaily: number;
  /**
   * The same for 5-minute bars, sized to span an overnight plus a weekend —
   * the largest legitimate quiet stretch inside a 5-minute series.
   */
  maxGapMsIntraday: number;
}

export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  maxGapMsDaily: 4 * 24 * 60 * 60 * 1000,
  maxGapMsIntraday: 4 * 24 * 60 * 60 * 1000,
};

export interface CacheRange {
  from: string;
  to: string;
}

export interface CacheReadResult {
  bars: Bar[];
  /** Ranges that had to be fetched from the source. Empty on a cache hit. */
  fetched: CacheRange[];
  /** How many requests reached the source. **Zero for a fully-cached range.** */
  sourceRequests: number;
}

@Injectable()
export class HistoryCacheService {
  private readonly logger = new Logger(HistoryCacheService.name);
  private readonly config: CacheConfig;

  constructor(
    @Inject(BAR_REPOSITORY) private readonly bars: BarRepository,
    @Inject(HISTORICAL_SOURCE) private readonly source: HistoricalSource,
    config: Partial<CacheConfig> = {},
  ) {
    this.config = { ...DEFAULT_CACHE_CONFIG, ...config };
  }

  /**
   * Bars for a range, served from cache and topped up from the source.
   *
   * **A fully-cached range issues zero source requests** (`stories.md:613`).
   * That is the property the whole design exists for, and it is asserted
   * directly rather than inferred from timing.
   */
  async getBars(
    contract: Contract,
    barSize: BarSize,
    from: string,
    to: string,
  ): Promise<CacheReadResult> {
    const cached = await this.bars.findRange(contract.symbol, barSize, from, to);
    const gaps = this.findGaps(cached, from, to, barSize);

    if (gaps.length === 0) {
      return { bars: cached, fetched: [], sourceRequests: 0 };
    }

    for (const gap of gaps) {
      await this.fill(contract, barSize, gap);
    }

    // Re-read rather than merging in memory: the repository is the authority on
    // what is stored, and a merge would have to re-implement its de-duplication
    // to avoid returning a bar twice when a gap-fill overlapped a cached edge.
    const merged = await this.bars.findRange(contract.symbol, barSize, from, to);

    return { bars: merged, fetched: gaps, sourceRequests: gaps.length };
  }

  /**
   * Fetches one range from the source and caches it.
   *
   * Failures are logged and swallowed rather than thrown: a gap that cannot be
   * filled right now leaves the cache exactly as it was, and the caller still
   * receives whatever *is* cached. Propagating would turn one unavailable
   * segment of a long backfill into a total failure, and the range will be
   * re-attempted on the next pass because it is still a gap.
   */
  private async fill(contract: Contract, barSize: BarSize, range: CacheRange): Promise<number> {
    try {
      const fetched = await this.source.getHistoricalBars({
        contract,
        barSize,
        from: range.from,
        to: range.to,
      });

      if (fetched.length === 0) {
        return 0;
      }

      await this.bars.saveAll(fetched);

      return fetched.length;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `gap fill failed for ${contract.symbol} ${barSize} ${range.from}→${range.to}: ${detail}`,
      );

      return 0;
    }
  }

  /**
   * The sub-ranges of `[from, to]` not covered by `cached`.
   *
   * Three kinds of gap, and all three matter:
   * - **leading** — cache starts after `from`
   * - **interior** — an empty span longer than the tolerance
   * - **trailing** — cache ends before `to`, the ordinary incremental case
   *
   * Exported behaviour via `getBars`; kept private because the tolerance is a
   * judgement call and callers should not be able to reason about it
   * independently.
   */
  private findGaps(cached: Bar[], from: string, to: string, barSize: BarSize): CacheRange[] {
    if (from > to) {
      return [];
    }

    if (cached.length === 0) {
      return [{ from, to }];
    }

    const tolerance =
      barSize === BarSize.DAILY ? this.config.maxGapMsDaily : this.config.maxGapMsIntraday;
    const gaps: CacheRange[] = [];

    if (millisBetween(from, cached[0].timestamp) > tolerance) {
      gaps.push({ from, to: cached[0].timestamp });
    }

    for (let i = 1; i < cached.length; i += 1) {
      if (millisBetween(cached[i - 1].timestamp, cached[i].timestamp) > tolerance) {
        gaps.push({ from: cached[i - 1].timestamp, to: cached[i].timestamp });
      }
    }

    const last = cached[cached.length - 1].timestamp;

    if (millisBetween(last, to) > tolerance) {
      gaps.push({ from: last, to });
    }

    return gaps;
  }

  /** The newest cached bar, or null. Drives incremental gap-filling. */
  async latestCached(symbol: string, barSize: BarSize): Promise<Bar | null> {
    return this.bars.findLatest(symbol, barSize);
  }

  /** The oldest cached bar, so a backfill knows how far back it already reaches. */
  async earliestCached(symbol: string, barSize: BarSize): Promise<Bar | null> {
    return this.bars.findEarliest(symbol, barSize);
  }
}

function millisBetween(a: string, b: string): number {
  return new Date(b).getTime() - new Date(a).getTime();
}
