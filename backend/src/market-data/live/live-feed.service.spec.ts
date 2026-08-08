/**
 * The live bar feed and its staleness watchdog (`stories.md:618`, `:624`).
 *
 * The assertion that matters most is negative: when the feed goes stale, new
 * entries halt and **nothing is sold**. That path is unreachable in a live test
 * and trivially reachable here, which is the whole reason the source is a port.
 */

import { equityContract } from '../../domain/contract';
import { Bar, BarSize } from '../types';
import { BarConsumer, LiveBarSource, LiveFeedService } from './live-feed.service';

const TQQQ = equityContract('TQQQ');

function bar(timestamp: string, close = 40): Bar {
  return {
    symbol: 'TQQQ',
    barSize: BarSize.FIVE_MIN,
    timestamp,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000,
  };
}

class FakeSource implements LiveBarSource {
  private handler: ((bar: Bar) => void) | null = null;
  private stale = false;
  unsubscribed = 0;

  subscribeBars(_contract: unknown, _barSize: BarSize, handler: (bar: Bar) => void): () => void {
    this.handler = handler;

    return () => {
      this.unsubscribed += 1;
      this.handler = null;
    };
  }

  isDataStale(): boolean {
    return this.stale;
  }

  goStale(): void {
    this.stale = true;
  }

  emit(b: Bar): void {
    this.handler?.(b);
  }

  hasSubscriber(): boolean {
    return this.handler !== null;
  }
}

class RecordingConsumer implements BarConsumer {
  readonly seen: Bar[] = [];
  readonly halts: string[] = [];
  /** Set to make `processBar` reject once. */
  failNext: string | null = null;
  /** Bars observed as "in flight" simultaneously — must never exceed 1. */
  maxConcurrent = 0;
  private inFlight = 0;

  async processBar(b: Bar): Promise<void> {
    this.inFlight += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);

    await new Promise((resolve) => setImmediate(resolve));

    this.inFlight -= 1;

    if (this.failNext) {
      const message = this.failNext;
      this.failNext = null;
      throw new Error(message);
    }

    this.seen.push(b);
  }

  haltEntriesForFault(reason: string): void {
    this.halts.push(reason);
  }
}

describe('LiveFeedService', () => {
  describe('feeding the engine', () => {
    it('passes live bars to the engine unchanged', async () => {
      const source = new FakeSource();
      const consumer = new RecordingConsumer();
      const feed = new LiveFeedService(source, consumer);

      feed.start(TQQQ);
      source.emit(bar('2025-01-02T09:45:00.000-05:00', 40));
      await feed.drain();

      expect(consumer.seen).toHaveLength(1);
      expect(consumer.seen[0].close).toBe(40);
      expect(feed.barsProcessed()).toBe(1);
    });

    it('processes bars strictly one at a time and in order', async () => {
      const source = new FakeSource();
      const consumer = new RecordingConsumer();
      const feed = new LiveFeedService(source, consumer);

      feed.start(TQQQ);
      source.emit(bar('2025-01-02T09:45:00.000-05:00', 40));
      source.emit(bar('2025-01-02T09:50:00.000-05:00', 39));
      source.emit(bar('2025-01-02T09:55:00.000-05:00', 38));
      await feed.drain();

      // `processBar` mutates ladder state as it decides; overlapping two bars
      // would make the ladder depend on delivery timing.
      expect(consumer.maxConcurrent).toBe(1);
      expect(consumer.seen.map((b) => b.close)).toEqual([40, 39, 38]);
    });

    it('keeps processing after one bar fails', async () => {
      const source = new FakeSource();
      const consumer = new RecordingConsumer();
      const feed = new LiveFeedService(source, consumer);

      feed.start(TQQQ);
      consumer.failNext = 'transient';
      source.emit(bar('2025-01-02T09:45:00.000-05:00', 40));
      source.emit(bar('2025-01-02T09:50:00.000-05:00', 39));
      await feed.drain();

      // A stalled queue would silently stop the engine while the socket still
      // looked healthy — the worst kind of failure here.
      expect(consumer.seen.map((b) => b.close)).toEqual([39]);
    });
  });

  describe('staleness watchdog (PRD.md:314)', () => {
    it('halts new entries when the feed goes stale — and sells nothing', () => {
      const source = new FakeSource();
      const consumer = new RecordingConsumer();
      const feed = new LiveFeedService(source, consumer);

      feed.start(TQQQ);
      source.goStale();
      feed.checkStale();

      expect(consumer.halts).toHaveLength(1);
      expect(consumer.halts[0]).toContain('stale');
      // **The rule.** A quiet feed is a technical fault, and a technical fault
      // must never become a realized loss.
      expect(consumer.halts[0]).toContain('NOT liquidated');
    });

    it('does not halt while data is flowing', () => {
      const source = new FakeSource();
      const consumer = new RecordingConsumer();
      const feed = new LiveFeedService(source, consumer);

      feed.start(TQQQ);
      feed.checkStale();

      expect(consumer.halts).toHaveLength(0);
    });

    it('raises the stale halt once rather than on every check', () => {
      const source = new FakeSource();
      const consumer = new RecordingConsumer();
      const feed = new LiveFeedService(source, consumer);

      feed.start(TQQQ);
      source.goStale();
      feed.checkStale();
      feed.checkStale();
      feed.checkStale();

      // One fault, one alert — a flood would bury the next real one.
      expect(consumer.halts).toHaveLength(1);
    });

    it('fires from the interval once started', async () => {
      jest.useFakeTimers();

      try {
        const source = new FakeSource();
        const consumer = new RecordingConsumer();
        const feed = new LiveFeedService(source, consumer, { watchdogIntervalMs: 1_000 });

        feed.start(TQQQ);
        feed.startWatchdog();
        source.goStale();

        jest.advanceTimersByTime(1_000);

        expect(consumer.halts).toHaveLength(1);
        feed.stop();
      } finally {
        jest.useRealTimers();
      }
    });

    it('starting the watchdog twice does not double it', () => {
      jest.useFakeTimers();

      try {
        const source = new FakeSource();
        const consumer = new RecordingConsumer();
        const feed = new LiveFeedService(source, consumer, { watchdogIntervalMs: 1_000 });

        feed.startWatchdog();
        feed.startWatchdog();
        source.goStale();
        jest.advanceTimersByTime(1_000);

        expect(consumer.halts).toHaveLength(1);
        feed.stop();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('lifecycle', () => {
    it('unsubscribes on stop', () => {
      const source = new FakeSource();
      const feed = new LiveFeedService(source, new RecordingConsumer());

      feed.start(TQQQ);
      expect(source.hasSubscriber()).toBe(true);

      feed.stop();

      expect(source.unsubscribed).toBe(1);
      expect(source.hasSubscriber()).toBe(false);
    });

    it('unsubscribes on module destroy', () => {
      const source = new FakeSource();
      const feed = new LiveFeedService(source, new RecordingConsumer());

      feed.start(TQQQ);
      feed.onModuleDestroy();

      expect(source.unsubscribed).toBe(1);
    });
  });
});
