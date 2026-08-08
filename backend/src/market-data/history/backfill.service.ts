/**
 * One-time paced backfill, incremental gap-fill thereafter (`PRD.md:307`).
 *
 * Two jobs that look alike and are not:
 *
 * - **Backfill** runs once at setup. Daily bars to instrument inception (TQQQ
 *   from February 2010), 5-minute bars to IB's ~6-month cap. It is long, it is
 *   the only operation that comes near the pacing limits, and it must survive
 *   being interrupted.
 * - **Incremental fill** runs routinely. It asks for what has arrived since the
 *   newest cached bar, which is almost always a single short request.
 *
 * ## Chunking is what keeps this inside IB's limits
 *
 * IB caps the duration a single historical request may cover, and the cap
 * varies by bar size. So a fifteen-year daily backfill is not one request — it
 * is a sequence of bounded ones, each routed through `PacingQueue` by the
 * adapter beneath. Chunk size is chosen well under IB's documented maximum:
 * the penalty for asking too much is not a clean rejection but a silent
 * throttle, so there is no feedback telling us we were close.
 *
 * ## Resumability, and why it falls out of the design
 *
 * Every chunk is written to the cache as it arrives, and the next run starts
 * from what is already cached. An interrupted backfill therefore resumes rather
 * than restarting — which matters because restarting would re-request months of
 * data already held and burn the pacing budget for no gain.
 *
 * A chunk that fails does not abort the run. It is left as a gap, the backfill
 * continues, and the gap is picked up next time — one unavailable segment must
 * not cost the other fourteen years.
 */

import { Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { Contract, equityContract } from '../../domain/contract';
import { BarRepository } from '../../repositories/repository.interfaces';
import { formatEt } from '../session';
import { Bar, BarSize, ET_ZONE } from '../types';
import { HistoricalSource } from './cache.service';
import { TQQQ_INCEPTION, beforeInception, synthesizeLeveragedSeries } from './synthetic-3x';

export interface BackfillConfig {
  /**
   * Days of daily bars per request.
   *
   * IB serves up to a year of daily bars in one call; 180 days leaves room for
   * the pacing headroom the queue already reserves, and makes a failed chunk
   * cheap to re-request.
   */
  dailyChunkDays: number;
  /**
   * Days of 5-minute bars per request.
   *
   * IB restricts intraday durations far more tightly than daily. A week per
   * request is comfortably inside what it serves for 5-minute bars.
   */
  intradayChunkDays: number;
  /** IB's practical cap on 5-minute history (`PRD.md:305`). */
  intradayHistoryDays: number;
}

export const DEFAULT_BACKFILL_CONFIG: BackfillConfig = {
  dailyChunkDays: 180,
  intradayChunkDays: 7,
  intradayHistoryDays: 180,
};

export interface BackfillResult {
  symbol: string;
  barSize: BarSize;
  /** Requests actually issued — the figure pacing is judged against. */
  requests: number;
  barsIngested: number;
  /** Chunks that failed and were left as gaps for a later run. */
  failedChunks: number;
  from: string;
  to: string;
}

@Injectable()
export class BackfillService {
  private readonly logger = new Logger(BackfillService.name);
  private readonly config: BackfillConfig;

  constructor(
    private readonly bars: BarRepository,
    private readonly source: HistoricalSource,
    config: Partial<BackfillConfig> = {},
  ) {
    this.config = { ...DEFAULT_BACKFILL_CONFIG, ...config };
  }

  /**
   * Daily bars from `from` to `to`, in paced chunks.
   *
   * **Resumes rather than restarting**: chunks already fully cached are skipped,
   * so an interrupted run costs only the chunks it had not reached.
   */
  async backfillDaily(contract: Contract, from: string, to: string): Promise<BackfillResult> {
    return this.run(contract, BarSize.DAILY, from, to, this.config.dailyChunkDays);
  }

  /**
   * 5-minute bars back to IB's cap.
   *
   * The window is anchored to `asOf` rather than to a fixed date because the
   * cap is relative — IB serves roughly the last six months, and what that
   * means moves every day.
   */
  async backfillIntraday(contract: Contract, asOf: Date = new Date()): Promise<BackfillResult> {
    const end = DateTime.fromJSDate(asOf).setZone(ET_ZONE);
    const start = end.minus({ days: this.config.intradayHistoryDays });

    return this.run(
      contract,
      BarSize.FIVE_MIN,
      formatEt(start),
      formatEt(end),
      this.config.intradayChunkDays,
    );
  }

  /**
   * Fetches everything since the newest cached bar.
   *
   * The routine path after setup. Falls back to a bounded lookback when nothing
   * is cached, rather than silently backfilling from inception — a full
   * backfill is an explicit operation, not something an incremental call should
   * trigger by surprise.
   */
  async fillIncremental(
    contract: Contract,
    barSize: BarSize,
    asOf: Date = new Date(),
    fallbackDays = 5,
  ): Promise<BackfillResult> {
    const end = DateTime.fromJSDate(asOf).setZone(ET_ZONE);
    const latest = await this.bars.findLatest(contract.symbol, barSize);
    const start = latest
      ? DateTime.fromISO(latest.timestamp, { setZone: true }).setZone(ET_ZONE)
      : end.minus({ days: fallbackDays });

    const chunkDays =
      barSize === BarSize.DAILY ? this.config.dailyChunkDays : this.config.intradayChunkDays;

    // **`skipCached` is off here, unlike a backfill.** This range deliberately
    // *starts* at the newest cached bar, so it always contains one — the resume
    // check would match every time and the incremental fill would never fetch
    // anything, silently freezing the cache at the last backfilled bar.
    return this.run(contract, barSize, formatEt(start), formatEt(end), chunkDays, false);
  }

  /**
   * Synthesizes pre-inception TQQQ history from QQQ daily bars.
   *
   * Backfills QQQ to 1999 first, then derives the leveraged series from it. The
   * output is written with `synthetic: true` and is excluded from ordinary
   * reads — see `synthetic-3x.ts` for why that label is not optional.
   */
  async backfillSynthetic(
    targetSymbol = 'TQQQ',
    sourceSymbol = 'QQQ',
    from = '1999-03-10T00:00:00.000-05:00',
  ): Promise<BackfillResult> {
    const sourceContract = equityContract(sourceSymbol);
    const to = `${TQQQ_INCEPTION}T00:00:00.000-05:00`;

    const sourceResult = await this.backfillDaily(sourceContract, from, to);
    const sourceBars = await this.bars.findRange(sourceSymbol, BarSize.DAILY, from, to);

    const synthetic = synthesizeLeveragedSeries(beforeInception(sourceBars), {
      targetSymbol,
    });

    await this.bars.saveAll(synthetic);

    this.logger.log(
      `synthesized ${synthetic.length} SYNTHETIC ${targetSymbol} bars from ${sourceSymbol} ` +
        '— excludes expense ratio and financing costs; not real history',
    );

    return {
      symbol: targetSymbol,
      barSize: BarSize.DAILY,
      requests: sourceResult.requests,
      barsIngested: synthetic.length,
      failedChunks: sourceResult.failedChunks,
      from,
      to,
    };
  }

  /**
   * `skipCached` distinguishes the two callers.
   *
   * A **backfill** skips chunks that already hold bars — that is what makes an
   * interrupted run resume instead of re-requesting years of held data. An
   * **incremental fill** must not, because its range starts at the newest
   * cached bar by construction and would skip itself forever.
   */
  private async run(
    contract: Contract,
    barSize: BarSize,
    from: string,
    to: string,
    chunkDays: number,
    skipCached = true,
  ): Promise<BackfillResult> {
    const result: BackfillResult = {
      symbol: contract.symbol,
      barSize,
      requests: 0,
      barsIngested: 0,
      failedChunks: 0,
      from,
      to,
    };

    for (const chunk of chunkRanges(from, to, chunkDays)) {
      // Skip what is already held. This is what makes an interrupted backfill
      // resume: a re-run costs only the chunks it never reached.
      if (skipCached) {
        const cached = await this.bars.countInRange(contract.symbol, barSize, chunk.from, chunk.to);

        if (cached > 0) {
          continue;
        }
      }

      result.requests += 1;

      try {
        const fetched = await this.source.getHistoricalBars({
          contract,
          barSize,
          from: chunk.from,
          to: chunk.to,
        });

        if (fetched.length > 0) {
          await this.bars.saveAll(fetched);
          result.barsIngested += fetched.length;
        }
      } catch (error) {
        // Left as a gap for a later run. Aborting here would cost every
        // remaining chunk over one unavailable segment.
        result.failedChunks += 1;
        this.logger.warn(
          `backfill chunk ${chunk.from}→${chunk.to} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    this.logger.log(
      `backfill ${contract.symbol} ${barSize}: ${result.barsIngested} bars in ` +
        `${result.requests} request(s), ${result.failedChunks} failed chunk(s)`,
    );

    return result;
  }
}

/**
 * Splits a span into chunks of at most `chunkDays`.
 *
 * Exported for direct assertion: the count and boundaries of these chunks are
 * what determine whether a backfill stays inside IB's pacing limits, and that
 * is worth testing without a socket in the picture.
 */
export function chunkRanges(
  from: string,
  to: string,
  chunkDays: number,
): Array<{ from: string; to: string }> {
  const start = DateTime.fromISO(from, { setZone: true }).setZone(ET_ZONE);
  const end = DateTime.fromISO(to, { setZone: true }).setZone(ET_ZONE);

  if (!start.isValid || !end.isValid || start >= end) {
    return [];
  }

  const ranges: Array<{ from: string; to: string }> = [];
  let cursor = start;

  while (cursor < end) {
    const next = DateTime.min(cursor.plus({ days: chunkDays }), end);

    ranges.push({ from: formatEt(cursor), to: formatEt(next) });

    // The next chunk starts where this one ended. Overlapping by a boundary is
    // deliberate — the repository upserts, so a re-delivered edge bar is free,
    // while a one-bar hole would be re-requested on every subsequent run.
    cursor = next;
  }

  return ranges;
}

/** Re-exported so callers need not reach into the synthetic module for it. */
export type { Bar };
