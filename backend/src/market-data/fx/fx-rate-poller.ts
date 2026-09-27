/**
 * Keeps the risk manager's `USD.CAD` rate fresh (Story 15).
 *
 * The rate is market data with its own staleness: this polls the broker and
 * writes each reading into the `FxRateBook` the risk manager reads. It never
 * decides anything itself — whether a rate is fresh enough to size an order is
 * the book's question, answered at evaluation time, so a poller that silently
 * stops is caught the same way as one that keeps failing: the quote ages out
 * and new entries block.
 *
 * A snapshot poll rather than a streaming subscription, for the reason
 * `LiveFeedService` had to learn the hard way: an IB subscription does not
 * survive the socket it was made on, and the daily Gateway logout would end it
 * silently. A fresh request per poll has no subscription to lose.
 *
 * Started for **every** broker, unlike the live feed. The mock answers with a
 * constant, which keeps the zero-dependency replay path trading exactly as
 * before; gating this on IB would block every replayed BUY on a rate that can
 * never arrive.
 */

import { Logger } from '@nestjs/common';
import { FxQuoteReading } from '../../broker/broker-adapter.interface';
import { FxRateBook } from '../../risk/fx-rate';

/** The one broker capability this needs. */
export interface FxQuoteSource {
  getFxQuote?(base: string, quote: string): Promise<FxQuoteReading>;
}

/** A third of `FX_MAX_AGE_MS`, so two consecutive failed polls are survivable. */
export const FX_POLL_INTERVAL_MS = 60_000;

export class FxRatePoller {
  private readonly logger = new Logger(FxRatePoller.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Logged on transitions only; a minute-by-minute repeat trains an operator to ignore it. */
  private failing = false;

  constructor(
    private readonly source: FxQuoteSource,
    private readonly book: FxRateBook,
    private readonly intervalMs: number = FX_POLL_INTERVAL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Idempotent. Polls once immediately so the first BUY need not wait a full interval. */
  start(): void {
    if (this.timer) {
      return;
    }

    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);

    // A scheduled job should never be the reason the daemon cannot exit.
    this.timer.unref?.();
  }

  /**
   * One poll. **Errors are caught, never rethrown** — an unhandled rejection in
   * a timer callback takes the daemon down, and a failed rate read must degrade
   * to "entries blocked", not to an outage.
   */
  async poll(): Promise<void> {
    const { base, quote, pair } = this.book;

    try {
      if (!this.source.getFxQuote) {
        throw new Error(`broker cannot quote ${pair}`);
      }

      const reading = await this.source.getFxQuote(base, quote);

      // Stamped on arrival by this process's clock — the only clock the
      // staleness check can compare against honestly.
      this.book.record({
        base: reading.base,
        quote: reading.quote,
        rate: reading.ask,
        receivedAt: this.now(),
      });

      if (this.failing) {
        this.failing = false;
        this.logger.log(`${pair} rate recovered at ${reading.ask}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.book.recordFailure(message);

      if (!this.failing) {
        this.failing = true;
        this.logger.warn(
          `${pair} rate unavailable: ${message}. New entries block once the last rate is ` +
            'stale; exits are unaffected.',
        );
      }
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
