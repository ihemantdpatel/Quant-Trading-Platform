/**
 * Backfill (`stories.md:620`).
 *
 * The load-bearing assertion is the **request count**: a full backfill must
 * complete without tripping pacing, and pacing is a function of how many
 * requests are issued. Everything else here protects that property — resuming
 * rather than restarting, and not aborting a fifteen-year run over one bad
 * chunk.
 */

import { equityContract } from '../../domain/contract';
import { InMemoryBarRepository } from '../../repositories/in-memory/in-memory.repositories';
import { PacingQueue } from '../../broker/ib/pacing-queue';
import { Bar, BarSize } from '../types';
import { BackfillService, chunkRanges } from './backfill.service';
import { HistoricalSource } from './cache.service';

const TQQQ = equityContract('TQQQ');

function bar(timestamp: string, symbol = 'TQQQ', barSize = BarSize.DAILY): Bar {
  return {
    symbol,
    barSize,
    timestamp,
    open: 40,
    high: 41,
    low: 39,
    close: 40.5,
    volume: 1_000_000,
  };
}

/** A source that returns one bar per requested chunk and counts calls. */
class CountingSource implements HistoricalSource {
  calls = 0;
  failOn: number | null = null;
  private emptyAfter = Infinity;

  async getHistoricalBars(request: {
    contract: { symbol: string };
    barSize: BarSize;
    from: string;
    to: string;
  }): Promise<Bar[]> {
    this.calls += 1;

    if (this.failOn === this.calls) {
      throw new Error('pacing violation');
    }

    if (this.calls > this.emptyAfter) {
      return [];
    }

    return [bar(request.from, request.contract.symbol, request.barSize)];
  }

  returnEmptyAfter(n: number): void {
    this.emptyAfter = n;
  }
}

describe('chunkRanges', () => {
  it('splits a span into bounded chunks', () => {
    const ranges = chunkRanges(
      '2025-01-01T00:00:00.000-05:00',
      '2025-01-31T00:00:00.000-05:00',
      10,
    );

    expect(ranges).toHaveLength(3);
    expect(ranges[0].from.startsWith('2025-01-01')).toBe(true);
    expect(ranges[2].to.startsWith('2025-01-31')).toBe(true);
  });

  it('makes each chunk start where the previous ended, leaving no hole', () => {
    const ranges = chunkRanges(
      '2025-01-01T00:00:00.000-05:00',
      '2025-01-31T00:00:00.000-05:00',
      10,
    );

    for (let i = 1; i < ranges.length; i += 1) {
      // A one-bar hole here would be re-requested on every future run.
      expect(ranges[i].from).toBe(ranges[i - 1].to);
    }
  });

  it('returns one chunk when the span is shorter than the chunk size', () => {
    const ranges = chunkRanges(
      '2025-01-01T00:00:00.000-05:00',
      '2025-01-05T00:00:00.000-05:00',
      180,
    );

    expect(ranges).toHaveLength(1);
  });

  it('returns nothing for an empty or inverted span', () => {
    expect(
      chunkRanges('2025-01-31T00:00:00.000-05:00', '2025-01-01T00:00:00.000-05:00', 10),
    ).toEqual([]);
    expect(
      chunkRanges('2025-01-01T00:00:00.000-05:00', '2025-01-01T00:00:00.000-05:00', 10),
    ).toEqual([]);
  });
});

describe('BackfillService', () => {
  describe('full backfill completes without tripping pacing (stories.md:620)', () => {
    it('stays within the pacing budget for a 15-year daily backfill', async () => {
      const repo = new InMemoryBarRepository();
      const source = new CountingSource();
      const backfill = new BackfillService(repo, source, { dailyChunkDays: 180 });

      const result = await backfill.backfillDaily(
        TQQQ,
        '2010-02-11T00:00:00.000-05:00',
        '2025-02-11T00:00:00.000-05:00',
      );

      // ~15 years in 180-day chunks ≈ 31 requests — comfortably inside the
      // 55-per-10-minute budget the queue enforces, so the whole backfill
      // proceeds without a single pacing wait.
      expect(result.requests).toBeLessThan(55);
      expect(result.barsIngested).toBe(result.requests);
      expect(result.failedChunks).toBe(0);
    });

    it('dispatches every chunk through the pacing queue without exceeding the window', async () => {
      const repo = new InMemoryBarRepository();
      const source = new CountingSource();
      const queue = new PacingQueue(
        { maxRequestsPerWindow: 55 },
        () => 0,
        async () => undefined,
      );

      // The real composition: a backfill whose source is paced, as the IB
      // adapter wires it in production.
      const paced: HistoricalSource = {
        getHistoricalBars: (request) =>
          queue.enqueue(`${request.contract.symbol}|${request.from}|${request.to}`, () =>
            source.getHistoricalBars(request),
          ),
      };

      const backfill = new BackfillService(repo, paced, { dailyChunkDays: 180 });

      await backfill.backfillDaily(
        TQQQ,
        '2010-02-11T00:00:00.000-05:00',
        '2025-02-11T00:00:00.000-05:00',
      );

      expect(queue.stats().inWindow).toBeLessThanOrEqual(55);
      expect(queue.stats().rateLimitWaits).toBe(0);
    });

    it('caps 5-minute history at IB’s ~6-month window', async () => {
      const repo = new InMemoryBarRepository();
      const source = new CountingSource();
      const backfill = new BackfillService(repo, source, {
        intradayChunkDays: 7,
        intradayHistoryDays: 180,
      });

      const result = await backfill.backfillIntraday(TQQQ, new Date('2025-06-30T12:00:00Z'));

      expect(result.barSize).toBe(BarSize.FIVE_MIN);
      // 180 days in 7-day chunks ≈ 26 requests.
      expect(result.requests).toBeLessThan(55);
    });
  });

  describe('resumability', () => {
    it('skips chunks already cached, so an interrupted run resumes', async () => {
      const repo = new InMemoryBarRepository();
      const source = new CountingSource();
      const backfill = new BackfillService(repo, source, { dailyChunkDays: 180 });

      const from = '2020-01-01T00:00:00.000-05:00';
      const to = '2022-01-01T00:00:00.000-05:00';

      const first = await backfill.backfillDaily(TQQQ, from, to);
      const second = await backfill.backfillDaily(TQQQ, from, to);

      expect(first.requests).toBeGreaterThan(0);
      // Nothing re-requested: re-running a completed backfill must be free,
      // or the pacing budget is spent on data already held.
      expect(second.requests).toBe(0);
      expect(source.calls).toBe(first.requests);
    });
  });

  describe('failure handling', () => {
    it('continues past a failed chunk and records it as a gap', async () => {
      const repo = new InMemoryBarRepository();
      const source = new CountingSource();
      source.failOn = 2;
      const backfill = new BackfillService(repo, source, { dailyChunkDays: 180 });

      const result = await backfill.backfillDaily(
        TQQQ,
        '2020-01-01T00:00:00.000-05:00',
        '2022-01-01T00:00:00.000-05:00',
      );

      // One unavailable segment must not cost the rest of the run.
      expect(result.failedChunks).toBe(1);
      expect(result.barsIngested).toBeGreaterThan(0);
    });
  });

  describe('incremental fill', () => {
    it('requests only what has arrived since the newest cached bar', async () => {
      const repo = new InMemoryBarRepository();
      const source = new CountingSource();
      const backfill = new BackfillService(repo, source, { dailyChunkDays: 180 });

      await repo.saveAll([bar('2025-06-27T00:00:00.000-04:00')]);

      const result = await backfill.fillIncremental(
        TQQQ,
        BarSize.DAILY,
        new Date('2025-06-30T12:00:00Z'),
      );

      // A few days, not a decade — the routine path after setup.
      expect(result.requests).toBe(1);
      expect(result.from.startsWith('2025-06-27')).toBe(true);
    });

    it('uses a bounded lookback rather than backfilling from inception when nothing is cached', async () => {
      const repo = new InMemoryBarRepository();
      const source = new CountingSource();
      const backfill = new BackfillService(repo, source);

      const result = await backfill.fillIncremental(
        TQQQ,
        BarSize.DAILY,
        new Date('2025-06-30T12:00:00Z'),
        5,
      );

      // A full backfill is an explicit operation; an incremental call must not
      // trigger one by surprise.
      expect(result.requests).toBe(1);
      expect(result.from.startsWith('2025-06-25')).toBe(true);
    });
  });

  describe('synthetic backfill', () => {
    it('writes synthetic bars flagged and excluded from ordinary reads', async () => {
      const repo = new InMemoryBarRepository();
      const source = new CountingSource();
      const backfill = new BackfillService(repo, source, { dailyChunkDays: 3650 });

      const result = await backfill.backfillSynthetic('TQQQ', 'QQQ');

      expect(result.barsIngested).toBeGreaterThan(0);

      const real = await repo.findRange(
        'TQQQ',
        BarSize.DAILY,
        '1999-01-01T00:00:00.000-05:00',
        '2010-01-01T00:00:00.000-05:00',
      );
      const withSynthetic = await repo.findRange(
        'TQQQ',
        BarSize.DAILY,
        '1999-01-01T00:00:00.000-05:00',
        '2010-01-01T00:00:00.000-05:00',
        true,
      );

      // Present, but only when asked for — the whole point of the label.
      expect(real).toHaveLength(0);
      expect(withSynthetic.length).toBeGreaterThan(0);
      expect(withSynthetic.every((b) => b.synthetic === true)).toBe(true);
    });
  });
});
