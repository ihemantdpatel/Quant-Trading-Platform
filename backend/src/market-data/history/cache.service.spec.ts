/**
 * Cache-first reads and gap detection (`stories.md:613`).
 *
 * The headline assertion is the count of source requests, not the bars
 * returned: "IB is called only to fill gaps" is only meaningful if something
 * counts the calls, and a cache that quietly re-requested everything would
 * still return correct bars while breaching the pacing limits that make the
 * connection unusable.
 */

import { equityContract } from '../../domain/contract';
import { InMemoryBarRepository } from '../../repositories/in-memory/in-memory.repositories';
import { Bar, BarSize } from '../types';
import { HistoricalSource, HistoryCacheService } from './cache.service';

const TQQQ = equityContract('TQQQ');

function dailyBar(date: string, close = 40): Bar {
  return {
    symbol: 'TQQQ',
    barSize: BarSize.DAILY,
    timestamp: `${date}T00:00:00.000-05:00`,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1_000_000,
  };
}

/** A source that records every call and serves from a seeded set. */
class RecordingSource implements HistoricalSource {
  readonly calls: Array<{ from: string; to: string }> = [];
  private available: Bar[] = [];
  private failWith: string | null = null;

  seed(bars: Bar[]): void {
    this.available = bars;
  }

  failNext(message: string): void {
    this.failWith = message;
  }

  async getHistoricalBars(request: { barSize: BarSize; from: string; to: string }): Promise<Bar[]> {
    this.calls.push({ from: request.from, to: request.to });

    if (this.failWith) {
      const message = this.failWith;
      this.failWith = null;
      throw new Error(message);
    }

    return this.available.filter(
      (bar) => bar.timestamp >= request.from && bar.timestamp <= request.to,
    );
  }
}

function build(): {
  cache: HistoryCacheService;
  repo: InMemoryBarRepository;
  source: RecordingSource;
} {
  const repo = new InMemoryBarRepository();
  const source = new RecordingSource();

  return { cache: new HistoryCacheService(repo, source), repo, source };
}

describe('HistoryCacheService', () => {
  describe('cache-first (stories.md:613)', () => {
    it('issues ZERO source requests for a fully-cached range', async () => {
      const { cache, repo, source } = build();

      await repo.saveAll([dailyBar('2025-01-02'), dailyBar('2025-01-03'), dailyBar('2025-01-06')]);

      const result = await cache.getBars(
        TQQQ,
        BarSize.DAILY,
        '2025-01-02T00:00:00.000-05:00',
        '2025-01-06T00:00:00.000-05:00',
      );

      // **The requirement.** Not "few requests" — none.
      expect(result.sourceRequests).toBe(0);
      expect(source.calls).toHaveLength(0);
      expect(result.bars).toHaveLength(3);
    });

    it('does not treat a weekend as a gap', async () => {
      const { cache, repo, source } = build();

      // Friday 2025-01-03 → Monday 2025-01-06. The market was closed, not
      // missing — re-requesting this every read would waste the pacing budget
      // forever on data that does not exist.
      await repo.saveAll([dailyBar('2025-01-03'), dailyBar('2025-01-06')]);

      const result = await cache.getBars(
        TQQQ,
        BarSize.DAILY,
        '2025-01-03T00:00:00.000-05:00',
        '2025-01-06T00:00:00.000-05:00',
      );

      expect(result.sourceRequests).toBe(0);
      expect(source.calls).toHaveLength(0);
    });
  });

  describe('partial cache issues requests for gaps only (stories.md:614)', () => {
    it('requests an interior gap and leaves cached spans alone', async () => {
      const { cache, repo, source } = build();

      await repo.saveAll([dailyBar('2025-01-02'), dailyBar('2025-01-20')]);
      source.seed([dailyBar('2025-01-08'), dailyBar('2025-01-13')]);

      const result = await cache.getBars(
        TQQQ,
        BarSize.DAILY,
        '2025-01-02T00:00:00.000-05:00',
        '2025-01-20T00:00:00.000-05:00',
      );

      // One request, bounded by the cached bars on either side of the hole.
      expect(result.sourceRequests).toBe(1);
      expect(source.calls[0]).toEqual({
        from: '2025-01-02T00:00:00.000-05:00',
        to: '2025-01-20T00:00:00.000-05:00',
      });
      expect(result.bars.map((bar) => bar.timestamp)).toEqual([
        '2025-01-02T00:00:00.000-05:00',
        '2025-01-08T00:00:00.000-05:00',
        '2025-01-13T00:00:00.000-05:00',
        '2025-01-20T00:00:00.000-05:00',
      ]);
    });

    it('requests only the trailing span when the cache stops short', async () => {
      const { cache, repo, source } = build();

      await repo.saveAll([dailyBar('2025-01-02'), dailyBar('2025-01-03')]);
      source.seed([dailyBar('2025-01-20'), dailyBar('2025-01-21')]);

      const result = await cache.getBars(
        TQQQ,
        BarSize.DAILY,
        '2025-01-02T00:00:00.000-05:00',
        '2025-01-21T00:00:00.000-05:00',
      );

      // The ordinary incremental case: yesterday's bars are cached, today's
      // are not.
      expect(result.sourceRequests).toBe(1);
      expect(result.fetched[0].to).toBe('2025-01-21T00:00:00.000-05:00');
      expect(result.bars).toHaveLength(4);
    });

    it('requests the leading span when the cache starts late', async () => {
      const { cache, repo, source } = build();

      await repo.saveAll([dailyBar('2025-01-20')]);
      source.seed([dailyBar('2025-01-02')]);

      const result = await cache.getBars(
        TQQQ,
        BarSize.DAILY,
        '2025-01-02T00:00:00.000-05:00',
        '2025-01-20T00:00:00.000-05:00',
      );

      expect(result.sourceRequests).toBe(1);
      expect(result.bars).toHaveLength(2);
    });

    it('requests the whole range when nothing is cached', async () => {
      const { cache, source } = build();

      source.seed([dailyBar('2025-01-02'), dailyBar('2025-01-03')]);

      const result = await cache.getBars(
        TQQQ,
        BarSize.DAILY,
        '2025-01-02T00:00:00.000-05:00',
        '2025-01-03T00:00:00.000-05:00',
      );

      expect(result.sourceRequests).toBe(1);
      expect(result.bars).toHaveLength(2);
    });

    it('caches what it fetched, so the next identical read issues no request', async () => {
      const { cache, source } = build();

      source.seed([dailyBar('2025-01-02'), dailyBar('2025-01-03')]);
      const from = '2025-01-02T00:00:00.000-05:00';
      const to = '2025-01-03T00:00:00.000-05:00';

      await cache.getBars(TQQQ, BarSize.DAILY, from, to);
      const second = await cache.getBars(TQQQ, BarSize.DAILY, from, to);

      // The whole point of a cache, and the property the 15-second
      // identical-request rule would otherwise punish.
      expect(second.sourceRequests).toBe(0);
      expect(source.calls).toHaveLength(1);
    });
  });

  describe('failure handling', () => {
    it('returns cached bars when a gap fill fails, rather than throwing', async () => {
      const { cache, repo, source } = build();

      await repo.saveAll([dailyBar('2025-01-02')]);
      source.failNext('pacing violation');

      const result = await cache.getBars(
        TQQQ,
        BarSize.DAILY,
        '2025-01-02T00:00:00.000-05:00',
        '2025-01-31T00:00:00.000-05:00',
      );

      // One unavailable segment must not fail a whole backfill; the range is
      // still a gap and will be retried on the next pass.
      expect(result.bars).toHaveLength(1);
      expect(result.sourceRequests).toBe(1);
    });

    it('tolerates a source that returns nothing for a gap', async () => {
      const { cache, source } = build();

      source.seed([]);

      const result = await cache.getBars(
        TQQQ,
        BarSize.DAILY,
        '2025-01-02T00:00:00.000-05:00',
        '2025-01-31T00:00:00.000-05:00',
      );

      expect(result.bars).toHaveLength(0);
    });

    it('returns nothing for an inverted range without calling the source', async () => {
      const { cache, source } = build();

      const result = await cache.getBars(
        TQQQ,
        BarSize.DAILY,
        '2025-01-31T00:00:00.000-05:00',
        '2025-01-02T00:00:00.000-05:00',
      );

      expect(result.bars).toHaveLength(0);
      expect(source.calls).toHaveLength(0);
    });
  });

  describe('synthetic bars stay out of cached reads', () => {
    it('does not serve a synthetic bar as if it were real', async () => {
      const { cache, repo } = build();

      await repo.saveAll([dailyBar('2025-01-02'), { ...dailyBar('2025-01-03'), synthetic: true }]);

      const result = await cache.getBars(
        TQQQ,
        BarSize.DAILY,
        '2025-01-02T00:00:00.000-05:00',
        '2025-01-03T00:00:00.000-05:00',
      );

      // A synthetic series excludes costs a real leveraged ETF pays; mixing it
      // into an ordinary read would overstate returns invisibly.
      expect(result.bars.every((bar) => bar.synthetic !== true)).toBe(true);
    });
  });

  describe('cache extents', () => {
    it('reports the earliest and latest cached bar', async () => {
      const { cache, repo } = build();

      await repo.saveAll([dailyBar('2025-01-02'), dailyBar('2025-01-06')]);

      expect((await cache.earliestCached('TQQQ', BarSize.DAILY))!.timestamp).toBe(
        '2025-01-02T00:00:00.000-05:00',
      );
      expect((await cache.latestCached('TQQQ', BarSize.DAILY))!.timestamp).toBe(
        '2025-01-06T00:00:00.000-05:00',
      );
    });
  });
});
