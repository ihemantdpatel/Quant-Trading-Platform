/**
 * IB historical-data pacing — **a correctness requirement, not an optimization**
 * (`PRD.md:289`).
 *
 * Exceeding IB's limits does not produce a clean error. IB silently throttles
 * or drops the connection, "a failure mode that reads as a bug in your own code
 * for days". So this queue is not a nicety layered over the adapter; it is the
 * only way a historical request is allowed to reach the socket.
 *
 * Two limits, enforced independently because they fail differently:
 *
 * | Limit | Value | What breaching it looks like |
 * |---|---|---|
 * | Request rate | ~60 per 10 minutes | silent throttling |
 * | Identical repeats | none within 15 seconds | the same, plus a pacing violation |
 *
 * ## Delay, never drop
 *
 * A request that would breach a limit **waits**; it is never discarded. Dropping
 * would silently leave a gap in the cached history, and a gap is indistinguishable
 * from "the market was closed" once it is in the table. The caller's promise
 * simply resolves later. `stories.md:612` states this explicitly for the
 * identical-request rule — "suppressed or delayed, never sent" — and the same
 * reasoning applies to the rate limit.
 *
 * ## Why the clock is injected
 *
 * Every limit here is a time window, so a test that used the real clock would
 * either sleep for ten minutes or assert nothing. `now()` and `sleep()` are
 * constructor parameters, which lets the suite drive a virtual clock and prove
 * the window arithmetic exactly — including the boundary, where an off-by-one
 * is the difference between 60 requests and 61.
 */

import { Logger } from '@nestjs/common';

export interface PacingConfig {
  /** Requests permitted in one rolling window. IB's practical limit is ~60. */
  maxRequestsPerWindow: number;
  /** Window length in ms. IB's is 10 minutes. */
  windowMs: number;
  /** Minimum gap between two *identical* requests. IB's is 15 seconds. */
  identicalRequestCooldownMs: number;
}

/**
 * Deliberately below IB's documented ceiling.
 *
 * IB's limit is approximate and the penalty for crossing it is a silent
 * throttle rather than a rejection, so there is no feedback signal telling us
 * we were too close. 55 leaves headroom for the requests IB counts that we do
 * not — reconnect handshakes, contract lookups — and costs only a little
 * throughput on a backfill that runs once.
 */
export const DEFAULT_PACING_CONFIG: PacingConfig = {
  maxRequestsPerWindow: 55,
  windowMs: 10 * 60 * 1000,
  identicalRequestCooldownMs: 15_000,
};

export interface PacingStats {
  /** Requests currently inside the rolling window. */
  inWindow: number;
  /** Requests that have completed since construction. */
  totalDispatched: number;
  /** How many had to wait for the rate limit. */
  rateLimitWaits: number;
  /** How many had to wait for the identical-request cooldown. */
  cooldownWaits: number;
  /** Requests waiting to be dispatched. */
  queued: number;
}

type Clock = () => number;
type Sleeper = (ms: number) => Promise<void>;

/**
 * Serializes historical requests within IB's pacing limits.
 *
 * One queue per connection. Requests are dispatched strictly in submission
 * order: reordering to fit a limit would make a backfill's request pattern
 * depend on timing, and an out-of-order gap-fill is far harder to reason about
 * when a range comes back short.
 */
export class PacingQueue {
  private readonly logger = new Logger(PacingQueue.name);
  private readonly config: PacingConfig;
  private readonly now: Clock;
  private readonly sleep: Sleeper;

  /** Dispatch timestamps inside the current window, oldest first. */
  private readonly dispatchTimes: number[] = [];
  /** Last dispatch time per request key, for the identical-request rule. */
  private readonly lastByKey = new Map<string, number>();

  private totalDispatched = 0;
  private rateLimitWaits = 0;
  private cooldownWaits = 0;
  private queued = 0;

  /**
   * Tail of the dispatch chain.
   *
   * Every enqueued request appends to this promise, which is what makes the
   * queue serial. Without it two concurrent callers would both read the window
   * as having room and both dispatch — the exact race that produces a pacing
   * violation under the burst load `stories.md:611` tests for.
   */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    config: Partial<PacingConfig> = {},
    clock: Clock = () => Date.now(),
    sleeper: Sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.config = { ...DEFAULT_PACING_CONFIG, ...config };
    this.now = clock;
    this.sleep = sleeper;
  }

  /**
   * Runs `request` once pacing allows it.
   *
   * `key` identifies the request for the identical-request rule — same symbol,
   * bar size, and range means the same key. Callers build it with
   * `historicalRequestKey`.
   *
   * The returned promise resolves with the request's result, so a caller never
   * needs to know it waited.
   */
  async enqueue<T>(key: string, request: () => Promise<T>): Promise<T> {
    this.queued += 1;

    // Append to the chain so requests dispatch one at a time and in order.
    // The `.catch` keeps one failed request from poisoning the chain for every
    // request behind it — a failed backfill segment must not stall the rest.
    const result = this.chain.then(
      () => this.dispatch(key, request),
      () => this.dispatch(key, request),
    );

    this.chain = result.catch(() => undefined);

    try {
      return await result;
    } finally {
      this.queued -= 1;
    }
  }

  private async dispatch<T>(key: string, request: () => Promise<T>): Promise<T> {
    await this.waitForCooldown(key);
    await this.waitForRateLimit();

    const at = this.now();
    this.dispatchTimes.push(at);
    this.lastByKey.set(key, at);
    this.totalDispatched += 1;

    return request();
  }

  /**
   * Honours the identical-request cooldown.
   *
   * Checked before the rate limit because it is keyed to one request rather
   * than to the connection: waiting out a cooldown may itself let the rate
   * window drain, whereas the reverse ordering could satisfy the rate limit and
   * then still stall on the cooldown, having spent a slot to learn it.
   */
  private async waitForCooldown(key: string): Promise<void> {
    const last = this.lastByKey.get(key);

    if (last === undefined) {
      return;
    }

    const elapsed = this.now() - last;
    const remaining = this.config.identicalRequestCooldownMs - elapsed;

    if (remaining > 0) {
      this.cooldownWaits += 1;
      this.logger.debug(`identical request "${key}" held for ${remaining}ms`);
      await this.sleep(remaining);
    }
  }

  private async waitForRateLimit(): Promise<void> {
    // Loops rather than sleeping once: the sleeper is injected, and a virtual
    // clock in a test may advance differently than requested. Re-checking after
    // waking is what makes the limit hold regardless of how the clock moved.
    for (;;) {
      this.evictExpired();

      if (this.dispatchTimes.length < this.config.maxRequestsPerWindow) {
        return;
      }

      // The window is full. The oldest request is the first to age out, so
      // that is exactly how long this one has to wait.
      const oldest = this.dispatchTimes[0];
      const waitMs = oldest + this.config.windowMs - this.now();

      this.rateLimitWaits += 1;
      this.logger.debug(
        `pacing window full (${this.dispatchTimes.length}/${this.config.maxRequestsPerWindow}) — waiting ${waitMs}ms`,
      );

      // A non-positive wait means the window has already drained; loop round
      // and let `evictExpired` see it rather than sleeping on a stale figure.
      await this.sleep(Math.max(waitMs, 0));
    }
  }

  private evictExpired(): void {
    const cutoff = this.now() - this.config.windowMs;

    while (this.dispatchTimes.length > 0 && this.dispatchTimes[0] <= cutoff) {
      this.dispatchTimes.shift();
    }
  }

  stats(): PacingStats {
    this.evictExpired();

    return {
      inWindow: this.dispatchTimes.length,
      totalDispatched: this.totalDispatched,
      rateLimitWaits: this.rateLimitWaits,
      cooldownWaits: this.cooldownWaits,
      queued: this.queued,
    };
  }

  /** Test and reconnect support: forgets all history. */
  reset(): void {
    this.dispatchTimes.length = 0;
    this.lastByKey.clear();
    this.totalDispatched = 0;
    this.rateLimitWaits = 0;
    this.cooldownWaits = 0;
  }
}

/**
 * The identity of a historical request, for the 15-second rule.
 *
 * IB considers a request identical by contract, bar size, duration, and end
 * time. Two gap-fills for different date ranges of the same symbol are *not*
 * identical and must not be collapsed — which is why the range is in the key
 * rather than just the symbol.
 */
export function historicalRequestKey(
  symbol: string,
  barSize: string,
  from: string,
  to: string,
): string {
  return `${symbol}|${barSize}|${from}|${to}`;
}
