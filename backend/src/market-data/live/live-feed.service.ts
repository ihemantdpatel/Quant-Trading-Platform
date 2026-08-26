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
  /**
   * Writes ladder state after a bar has been processed.
   *
   * `replayFixture` persists once at the end of a replay, which is right for a
   * batch that either completes or is re-run. A live session has no end to
   * persist at: it is interrupted, not finished, and the soak deliberately
   * includes mid-session restarts. Without a write per bar the `Lot`, `Rung`,
   * and `StrategyStateSnapshot` tables stay empty for a live-only session, so
   * a restart restores nothing and `DailyReportService` skips its rung check
   * every day — and a skip is not a pass.
   *
   * Optional so a consumer with no persistence (the fixture-driven tests, any
   * future non-engine consumer) is unaffected.
   */
  persistState?(): Promise<void>;
}

/** The subset of a broker this service needs — kept narrow so it stays fakeable. */
export interface LiveBarSource {
  subscribeBars(contract: Contract, barSize: BarSize, handler: (bar: Bar) => void): () => void;
  isDataStale(): boolean;
  /**
   * Notifies when the broker's connection state changes, so the feed can
   * re-subscribe after a reconnect. See `LiveFeedService.start`.
   *
   * Optional: a source with no notion of connection health (a fixture, a test
   * double that only emits bars) simply never resubscribes, which is the
   * behaviour those callers already had.
   */
  onConnectionChange?(handler: (connected: boolean) => void): () => void;
  /**
   * The most recent market-data error per symbol, if the source tracks any.
   *
   * Read only when a stale halt is being raised, to name the *cause* alongside
   * the effect. IB answers an unentitled or refused subscription here and then
   * delivers nothing, so the error and the silence are the same fault seen from
   * two sides — but the halt message previously reported only the silence, and
   * an operator had to go find `broker.dataErrors` to learn why.
   *
   * Optional, like `onConnectionChange`: a source with no notion of data errors
   * (a fixture, a test double) simply contributes no cause, and the halt reads
   * exactly as it did before.
   */
  dataErrors?(): Array<{ symbol: string; code: number | null; message: string }>;
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

  /** True while a bar subscription is believed live. Gates re-subscribing. */
  private subscribed = false;
  private unwatchConnection: (() => void) | null = null;

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
   *
   * ## The subscription is re-established on every reconnect
   *
   * **A bar subscription does not survive the socket it was made on.** IB
   * Gateway logs itself out daily (`TWS_COLD_RESTART`), and on the way back the
   * adapter's reconnect policy restores the *socket* — but the subscription
   * made against the old one is gone, and IB reports it only as a one-line
   * `Failed to request live updates (disconnected)`.
   *
   * Without re-subscribing, the first logout permanently ends the feed for the
   * life of the process: connected broker, no bars, indefinitely. The staleness
   * watchdog catches it — that is what it is for — but a halt that can only be
   * cleared by restarting the daemon every morning is not a working feed.
   *
   * Re-subscribing is safe because the socket's `LiveBarGate` is per
   * subscription: the fresh backfill IB replays is absorbed rather than
   * forwarded, so a reconnect cannot walk the ladder down a stale window.
   */
  start(contract: Contract, barSize: BarSize = BarSize.FIVE_MIN): void {
    this.subscribe(contract, barSize);

    // A source with no connection notion never resubscribes — see the port.
    const unwatch = this.source.onConnectionChange?.((connected) => {
      if (connected) {
        this.resubscribe(contract, barSize);
        return;
      }

      // The subscription died with the socket, whether or not IB said so.
      // Marking it dead here is what lets the next CONNECTED re-subscribe;
      // without it the guard in `resubscribe` would suppress the recovery.
      this.subscribed = false;
    });

    if (unwatch) {
      this.unwatchConnection = unwatch;
    }

    this.logger.log(`live feed started for ${contract.symbol} ${barSize}`);
  }

  /**
   * Tears down the stale subscription and makes a fresh one.
   *
   * Ignored while a subscription is already live for this contract: the adapter
   * can report `CONNECTED` more than once for a single recovery (a reconnect
   * that succeeds on attempt 2 emits per attempt), and each redundant
   * re-subscribe would cost an IB request and another backfill window.
   */
  private resubscribe(contract: Contract, barSize: BarSize): void {
    if (this.subscribed) {
      return;
    }

    this.logger.log(
      `broker reconnected — re-subscribing ${contract.symbol} ${barSize}; ` +
        'the bar subscription did not survive the previous socket',
    );

    this.subscribe(contract, barSize);

    // The feed is live again, so a stale halt may legitimately be raised anew
    // if it goes quiet a second time. Without this the watchdog stays latched
    // and the *next* outage would pass unreported.
    this.staleHaltRaised = false;
  }

  private subscribe(contract: Contract, barSize: BarSize): void {
    const unsubscribe = this.source.subscribeBars(contract, barSize, (bar) => {
      this.enqueue(bar);
    });

    this.unsubscribes.push(unsubscribe);
    this.subscribed = true;
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

    // Names the cause next to the effect. IB refuses a subscription on the
    // error channel and then delivers nothing, so "no bars" and "code 162" are
    // one fault; reporting only the silence sent an operator hunting through
    // `broker.dataErrors` for the half that says what to actually fix.
    const cause = this.staleCause();

    // Halts **new entries**. Nothing is sold — there is deliberately no path
    // from here to a liquidation (`PRD.md:317`).
    this.consumer.haltEntriesForFault(
      `market data stale beyond threshold — halting new entries. Positions are held, NOT liquidated.${cause}`,
    );
    this.logger.error(`market data stale beyond threshold — new entries halted${cause}`);
  }

  /**
   * The reported market-data errors, as a clause to append to the halt reason.
   *
   * Empty string when there is nothing to add, so the message is unchanged for
   * a source that tracks no errors or a feed that simply went quiet with no
   * error reported — silence with no stated cause is still the honest report,
   * and inventing one would be worse than none.
   *
   * Defensive around the source: this runs while a fault is already being
   * reported, and a throw here would replace a halt an operator needs with an
   * unhandled error from the diagnostic that was only meant to describe it.
   */
  private staleCause(): string {
    let errors: Array<{ symbol: string; code: number | null; message: string }>;

    try {
      errors = this.source.dataErrors?.() ?? [];
    } catch {
      return '';
    }

    if (errors.length === 0) {
      return '';
    }

    const detail = errors
      .map(
        (error) =>
          `${error.symbol}: ${error.code === null ? '' : `[${error.code}] `}${error.message}`,
      )
      .join('; ');

    return ` Reported market-data error(s) — ${detail}`;
  }

  /**
   * Queues a bar behind any still processing.
   *
   * Errors are caught per bar: one bar that fails to process must not stall
   * every subsequent bar behind it, which would silently stop the engine while
   * the socket still looked healthy.
   */
  private enqueue(bar: Bar): void {
    // A bar arrived, so the feed is not stale any more. Unlatching here is what
    // lets a *second* outage be reported: the flag is sticky so one fault does
    // not flood the alert list, but leaving it latched after recovery meant the
    // next silence passed unnoticed. Paired with the engine's own auto-clear of
    // a staleness halt — this side re-arms the detector, that side lifts the
    // halt, and both are driven by the same evidence.
    //
    // Set before the bar is processed rather than after: it describes the
    // arrival, not the outcome, and a bar that throws in `processBar` still
    // proves data is flowing.
    this.staleHaltRaised = false;

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
      })
      // Persistence runs *after* the catch above, so state is written even for
      // a bar whose processing failed: the ladder may have opened a lot before
      // throwing, and losing that write would leave the database disagreeing
      // with a position the broker already holds.
      //
      // Its own catch, because a failed write must not be reported as a failed
      // bar — and must not stall the queue behind it. The engine keeps running
      // on in-memory state; reconciliation is what catches a persistent
      // divergence on the next restart.
      .then(() => this.consumer.persistState?.())
      .catch((error: unknown) => {
        this.logger.error(
          `failed to persist ladder state after ${bar.symbol} ${bar.timestamp}: ${
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
    // Before the unsubscribes: a connection event arriving mid-teardown would
    // otherwise re-subscribe a feed that is being shut down.
    this.unwatchConnection?.();
    this.unwatchConnection = null;

    this.unsubscribes.forEach((unsubscribe) => unsubscribe());
    this.unsubscribes.length = 0;
    this.subscribed = false;

    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  onModuleDestroy(): void {
    this.stop();
  }
}
