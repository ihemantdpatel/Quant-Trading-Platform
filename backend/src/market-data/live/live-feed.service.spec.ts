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
  private connectionHandler: ((connected: boolean) => void) | null = null;
  unsubscribed = 0;
  /** How many times a bar subscription has been established. */
  subscribeCount = 0;

  subscribeBars(_contract: unknown, _barSize: BarSize, handler: (bar: Bar) => void): () => void {
    this.handler = handler;
    this.subscribeCount += 1;

    return () => {
      this.unsubscribed += 1;
      this.handler = null;
    };
  }

  isDataStale(): boolean {
    return this.stale;
  }

  /** Market-data errors IB has reported, newest state per symbol. */
  private errors: Array<{ symbol: string; code: number | null; message: string }> = [];
  /** Set to make `dataErrors` throw, modelling a source that fails mid-fault. */
  failDataErrors = false;

  dataErrors(): Array<{ symbol: string; code: number | null; message: string }> {
    if (this.failDataErrors) {
      throw new Error('adapter blew up while listing data errors');
    }

    return this.errors;
  }

  reportDataError(symbol: string, code: number | null, message: string): void {
    this.errors.push({ symbol, code, message });
  }

  onConnectionChange(handler: (connected: boolean) => void): () => void {
    this.connectionHandler = handler;

    return () => {
      this.connectionHandler = null;
    };
  }

  /**
   * Models IB's daily logout: the socket drops and the subscription dies with
   * it, silently — IB reports only a one-line subscription error.
   */
  dropConnection(): void {
    this.handler = null;
    this.connectionHandler?.(false);
  }

  reconnect(): void {
    this.connectionHandler?.(true);
  }

  watchesConnection(): boolean {
    return this.connectionHandler !== null;
  }

  goStale(): void {
    this.stale = true;
  }

  /** The feed recovers — data flows again with no socket event in between. */
  goLive(): void {
    this.stale = false;
  }

  goFresh(): void {
    this.stale = false;
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

  /** Bar timestamps as of each `persistState` call. */
  readonly persistedAfter: string[] = [];
  /** Set to make `persistState` reject once. */
  failPersistNext: string | null = null;

  async persistState(): Promise<void> {
    if (this.failPersistNext) {
      const message = this.failPersistNext;
      this.failPersistNext = null;
      throw new Error(message);
    }

    this.persistedAfter.push(this.seen[this.seen.length - 1]?.timestamp ?? 'none');
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

  describe('ladder state is persisted per bar', () => {
    it('persists after every bar, not once at the end', async () => {
      const source = new FakeSource();
      const consumer = new RecordingConsumer();
      const feed = new LiveFeedService(source, consumer);

      feed.start(TQQQ);
      source.emit(bar('2025-01-02T09:45:00.000-05:00', 40));
      source.emit(bar('2025-01-02T09:50:00.000-05:00', 39));
      source.emit(bar('2025-01-02T09:55:00.000-05:00', 38));
      await feed.drain();

      // A live session is interrupted rather than finished, so there is no end
      // to persist at. Without a write per bar a live-only session leaves the
      // ladder tables empty and every daily report skips its rung check.
      expect(consumer.persistedAfter).toEqual([
        '2025-01-02T09:45:00.000-05:00',
        '2025-01-02T09:50:00.000-05:00',
        '2025-01-02T09:55:00.000-05:00',
      ]);
    });

    it('persists even when the bar failed to process', async () => {
      const source = new FakeSource();
      const consumer = new RecordingConsumer();
      const feed = new LiveFeedService(source, consumer);

      feed.start(TQQQ);
      consumer.failNext = 'transient';
      source.emit(bar('2025-01-02T09:45:00.000-05:00', 40));
      await feed.drain();

      // The ladder may have opened a lot before throwing. Skipping the write
      // would leave the database disagreeing with a position the broker
      // already holds — the divergence reconciliation exists to prevent.
      expect(consumer.seen).toHaveLength(0);
      expect(consumer.persistedAfter).toHaveLength(1);
    });

    it('keeps processing bars after a failed write', async () => {
      const source = new FakeSource();
      const consumer = new RecordingConsumer();
      const feed = new LiveFeedService(source, consumer);

      feed.start(TQQQ);
      consumer.failPersistNext = 'database unreachable';
      source.emit(bar('2025-01-02T09:45:00.000-05:00', 40));
      source.emit(bar('2025-01-02T09:50:00.000-05:00', 39));
      await feed.drain();

      // A write failure must not stall the queue behind it: the engine runs on
      // in-memory state, and reconciliation catches a real divergence at the
      // next restart. Losing the feed instead would be strictly worse.
      expect(consumer.seen.map((b) => b.close)).toEqual([40, 39]);
    });

    it('works with a consumer that does not persist at all', async () => {
      const source = new FakeSource();
      // `persistState` is optional on the port — a fixture-driven consumer has
      // no persistence and must not be broken by this.
      const consumer: BarConsumer = {
        seen: [] as Bar[],
        processBar(b: Bar): Promise<void> {
          (this.seen as Bar[]).push(b);
          return Promise.resolve();
        },
        haltEntriesForFault: () => undefined,
      } as BarConsumer & { seen: Bar[] };
      const feed = new LiveFeedService(source, consumer);

      feed.start(TQQQ);
      source.emit(bar('2025-01-02T09:45:00.000-05:00', 40));
      await expect(feed.drain()).resolves.toBeUndefined();
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

    it('names the reported market-data error in the halt reason', () => {
      const source = new FakeSource();
      const consumer = new RecordingConsumer();
      const feed = new LiveFeedService(source, consumer);

      feed.start(TQQQ);
      // The observed production fault: IB refuses the subscription and then
      // delivers nothing, so the silence and the error are one fault.
      source.reportDataError(
        'TQQQ',
        162,
        'Historical Market Data Service error message:Trading TWS session is connected from a different IP address',
      );
      source.goStale();
      feed.checkStale();

      expect(consumer.halts[0]).toContain('stale');
      expect(consumer.halts[0]).toContain('[162]');
      expect(consumer.halts[0]).toContain('different IP address');
      // The safety clause survives the addition.
      expect(consumer.halts[0]).toContain('NOT liquidated');
    });

    it('reports the silence alone when no data error was reported', () => {
      const source = new FakeSource();
      const consumer = new RecordingConsumer();
      const feed = new LiveFeedService(source, consumer);

      feed.start(TQQQ);
      source.goStale();
      feed.checkStale();

      // No cause is honest where there is none — a feed can go quiet with IB
      // reporting nothing at all.
      expect(consumer.halts[0]).not.toContain('Reported market-data error');
    });

    it('omits the code when IB supplied none', () => {
      const source = new FakeSource();
      const consumer = new RecordingConsumer();
      const feed = new LiveFeedService(source, consumer);

      feed.start(TQQQ);
      source.reportDataError('TQQQ', null, 'no code from IB');
      source.goStale();
      feed.checkStale();

      expect(consumer.halts[0]).toContain('no code from IB');
      expect(consumer.halts[0]).not.toContain('[null]');
    });

    it('still halts when the source throws while listing data errors', () => {
      const source = new FakeSource();
      const consumer = new RecordingConsumer();
      const feed = new LiveFeedService(source, consumer);

      feed.start(TQQQ);
      source.failDataErrors = true;
      source.goStale();

      // The diagnostic must never replace the halt it only describes.
      expect(() => feed.checkStale()).not.toThrow();
      expect(consumer.halts).toHaveLength(1);
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

    it('re-arms once a bar arrives, so a second outage is still reported', () => {
      const source = new FakeSource();
      const consumer = new RecordingConsumer();
      const feed = new LiveFeedService(source, consumer);

      feed.start(TQQQ);
      source.goStale();
      feed.checkStale();
      expect(consumer.halts).toHaveLength(1);

      // The feed recovers on its own — a data-farm blip or a pacing throttle,
      // with no socket drop anywhere. Only `resubscribe` used to unlatch this
      // flag, so a recovery without a connection event left the detector
      // permanently spent and the *next* silence went unreported.
      source.goLive();
      source.emit(bar('2025-01-02T10:00:00.000-05:00'));

      source.goStale();
      feed.checkStale();

      expect(consumer.halts).toHaveLength(2);
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

  /**
   * The regression for a live PAPER incident: IB Gateway performed its daily
   * scheduled logout, the adapter restored the socket, and the *bar
   * subscription* was never re-established. The result was a broker reporting
   * CONNECTED that delivered no bars for eleven hours — the failure mode that
   * looks healthy from every angle except the data itself.
   */
  describe('resubscribing after a reconnect', () => {
    it('re-establishes the bar subscription when the broker reconnects', async () => {
      const source = new FakeSource();
      const consumer = new RecordingConsumer();
      const feed = new LiveFeedService(source, consumer);

      feed.start(TQQQ);
      expect(source.subscribeCount).toBe(1);

      // IB's 04:00 logout: the subscription dies with the socket.
      source.dropConnection();
      expect(source.hasSubscriber()).toBe(false);

      source.reconnect();

      expect(source.subscribeCount).toBe(2);
      expect(source.hasSubscriber()).toBe(true);

      // The feed is genuinely working again, not merely re-registered.
      source.emit(bar('2026-08-11T10:00:00.000-04:00'));
      await feed.drain();

      expect(consumer.seen).toHaveLength(1);
    });

    it('keeps delivering across repeated logout cycles', async () => {
      const source = new FakeSource();
      const consumer = new RecordingConsumer();
      const feed = new LiveFeedService(source, consumer);

      feed.start(TQQQ);

      // One cycle per trading day. A fix that only survives the first is not a
      // fix — the daemon is meant to run for weeks.
      for (let day = 0; day < 5; day += 1) {
        source.dropConnection();
        source.reconnect();
        source.emit(bar(`2026-08-1${day}T10:00:00.000-04:00`));
      }

      await feed.drain();

      expect(consumer.seen).toHaveLength(5);
      expect(source.subscribeCount).toBe(6);
    });

    it('ignores a repeated CONNECTED without dropping in between', () => {
      const source = new FakeSource();
      const feed = new LiveFeedService(source, new RecordingConsumer());

      feed.start(TQQQ);

      // A reconnect that succeeds on a later attempt reports CONNECTED more
      // than once. Re-subscribing per event would cost an IB request and
      // another backfill window each time.
      source.reconnect();
      source.reconnect();

      expect(source.subscribeCount).toBe(1);
    });

    it('re-arms the staleness halt so a second outage is still reported', () => {
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

        // Recovery: bars flow again.
        source.dropConnection();
        source.reconnect();
        source.goFresh();
        jest.advanceTimersByTime(1_000);

        // A second, genuinely new outage must raise its own halt. A latched
        // flag would leave this one silent.
        source.goStale();
        jest.advanceTimersByTime(1_000);

        expect(consumer.halts).toHaveLength(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('stops watching the connection once stopped', () => {
      const source = new FakeSource();
      const feed = new LiveFeedService(source, new RecordingConsumer());

      feed.start(TQQQ);
      expect(source.watchesConnection()).toBe(true);

      feed.stop();
      expect(source.watchesConnection()).toBe(false);

      // A connection event arriving after teardown must not revive the feed.
      source.reconnect();
      expect(source.subscribeCount).toBe(1);
    });

    it('works with a source that has no connection notion', () => {
      // Fixture replay and older test doubles do not implement the optional
      // hook; they must keep working exactly as before.
      const minimal: LiveBarSource = {
        subscribeBars: () => () => undefined,
        isDataStale: () => false,
      };

      const feed = new LiveFeedService(minimal, new RecordingConsumer());

      expect(() => {
        feed.start(TQQQ);
        feed.stop();
      }).not.toThrow();
    });
  });
});
