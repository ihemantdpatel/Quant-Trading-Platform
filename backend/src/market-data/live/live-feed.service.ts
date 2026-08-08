/**
 * The live bar feed — what makes `SHADOW` stream real bars (`stories.md:624`).
 *
 * Story 6 built `EngineService.processBar` as "the unit Story 10 will call from
 * a live bar subscription instead of from a fixture loop"
 * (`engine.service.ts:180`). This is that caller. Nothing downstream changes:
 * the same bar shape reaches the same coordinator, the same risk chokepoint,
 * and the same broker, which is why the fixture suites remain evidence about
 * live behaviour.
 *
 * ## Bars are processed one at a time, in order
 *
 * `processBar` mutates ladder state as a side effect of deciding — it opens
 * lots and re-arms rungs. Two bars in flight concurrently would interleave
 * those mutations and make the ladder's behaviour depend on delivery timing,
 * which is precisely what the deterministic replay suites assume cannot happen.
 * So bars queue behind one another here, exactly as `replayFixture` sequences
 * them.
 *
 * ## Staleness is watched here, not in the engine
 *
 * A connected socket that stops delivering bars is more dangerous than one that
 * drops, because nothing looks wrong: the ladder keeps evaluating against the
 * last price it saw while the market moves away from it (`PRD.md:314`). The
 * engine cannot notice this on its own — it only ever sees bars that *did*
 * arrive. So the watchdog lives with the subscription that owns the feed, and
 * it **halts new entries only**: positions are held, never liquidated, because
 * a quiet feed is a technical fault and "a network blip must not become a
 * realized loss" (`PRD.md:317`).
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Contract } from '../../domain/contract';
import { Bar, BarSize } from '../types';

/** The subset of the engine this service drives. */
export interface BarConsumer {
  processBar(bar: Bar): Promise<unknown>;
  /** Halts new entries on a technical fault. Never sells anything. */
  haltEntriesForFault(reason: string): void;
}

/** The subset of a broker this service needs — kept narrow so it stays fakeable. */
export interface LiveBarSource {
  subscribeBars(contract: Contract, barSize: BarSize, handler: (bar: Bar) => void): () => void;
  isDataStale(): boolean;
}

export interface LiveFeedConfig {
  /** How often the staleness watchdog checks. */
  watchdogIntervalMs: number;
}

export const DEFAULT_LIVE_FEED_CONFIG: LiveFeedConfig = {
  watchdogIntervalMs: 60_000,
};

@Injectable()
export class LiveFeedService implements OnModuleDestroy {
  private readonly logger = new Logger(LiveFeedService.name);
  private readonly config: LiveFeedConfig;

  private readonly unsubscribes: Array<() => void> = [];
  private watchdog: ReturnType<typeof setInterval> | null = null;

  /** Serializes bar processing — see the class comment. */
  private queue: Promise<unknown> = Promise.resolve();

  private processed = 0;
  private staleHaltRaised = false;

  constructor(
    private readonly source: LiveBarSource,
    private readonly consumer: BarConsumer,
    config: Partial<LiveFeedConfig> = {},
  ) {
    this.config = { ...DEFAULT_LIVE_FEED_CONFIG, ...config };
  }

  /**
   * Subscribes to a symbol and starts feeding the engine.
   *
   * 5-minute bars: the cadence the ladder evaluates on (`stories.md:226`).
   */
  start(contract: Contract, barSize: BarSize = BarSize.FIVE_MIN): void {
    const unsubscribe = this.source.subscribeBars(contract, barSize, (bar) => {
      this.enqueue(bar);
    });

    this.unsubscribes.push(unsubscribe);
    this.logger.log(`live feed started for ${contract.symbol} ${barSize}`);
  }

  /** Starts the staleness watchdog. Separate from `start` so tests can drive it. */
  startWatchdog(): void {
    if (this.watchdog) {
      return;
    }

    this.watchdog = setInterval(() => this.checkStale(), this.config.watchdogIntervalMs);

    // Node keeps the process alive for a pending interval; a watchdog should
    // not be the reason the daemon cannot exit.
    this.watchdog.unref?.();
  }

  /**
   * One staleness check.
   *
   * Public so the watchdog's decision is directly assertable rather than
   * dependent on a timer firing in a test.
   */
  checkStale(): void {
    if (!this.source.isDataStale()) {
      return;
    }

    if (this.staleHaltRaised) {
      // Sticky: re-raising every tick would flood the alert list with one fault.
      return;
    }

    this.staleHaltRaised = true;

    // Halts **new entries**. Nothing is sold — there is deliberately no path
    // from here to a liquidation (`PRD.md:317`).
    this.consumer.haltEntriesForFault(
      'market data stale beyond threshold — halting new entries. Positions are held, NOT liquidated.',
    );
    this.logger.error('market data stale beyond threshold — new entries halted');
  }

  /**
   * Queues a bar behind any still processing.
   *
   * Errors are caught per bar: one bar that fails to process must not stall
   * every subsequent bar behind it, which would silently stop the engine while
   * the socket still looked healthy.
   */
  private enqueue(bar: Bar): void {
    this.queue = this.queue
      .then(() => this.consumer.processBar(bar))
      .then(() => {
        this.processed += 1;
      })
      .catch((error: unknown) => {
        this.logger.error(
          `failed to process live bar ${bar.symbol} ${bar.timestamp}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }

  /** Resolves once every queued bar has been processed. */
  async drain(): Promise<void> {
    await this.queue;
  }

  barsProcessed(): number {
    return this.processed;
  }

  stop(): void {
    this.unsubscribes.forEach((unsubscribe) => unsubscribe());
    this.unsubscribes.length = 0;

    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  onModuleDestroy(): void {
    this.stop();
  }
}
