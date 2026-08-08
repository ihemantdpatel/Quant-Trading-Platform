/**
 * Bounded reconnect with exponential backoff, and IB Gateway's periodic forced
 * re-authentication (`PRD.md:312`, `stories.md:596`).
 *
 * ## The two events this distinguishes
 *
 * IB Gateway logs itself out on a schedule — daily, by design, not as a fault.
 * A system that treated that like a socket failure would raise a critical alert
 * every day at the same time, and an operator who learns to ignore a daily
 * alert will ignore the real one. So:
 *
 * | Event | Severity | Halts entries? |
 * |---|---|---|
 * | Scheduled re-authentication | routine — logged, not alerted | no |
 * | Unexpected socket drop | warning, retried with backoff | not while retrying |
 * | Retries exhausted | **critical** | **yes** |
 *
 * The distinction is only meaningful if it is drawn from something observable
 * rather than guessed, so the caller tells us which happened —
 * `reconnectAfterReauth` versus `reconnect`. IB's own disconnect reason codes
 * are the discriminator at the socket layer.
 *
 * ## What exhaustion does, and does not do
 *
 * Reaching `FAILED` halts **new entries** and raises a critical alert. It does
 * not sell anything, and there is deliberately no code path here that could:
 * "a network blip must not become a realized loss" (`PRD.md:317`). Positions
 * are left exactly as they are until a human decides otherwise.
 *
 * ## Why this is separate from `MockBrokerAdapter.reconnect`
 *
 * The mock grew its own backoff at Story 6 so the engine's fault handling could
 * be exercised early (`mock-broker.adapter.ts:20`). This is the production
 * implementation of the same shape, extracted because the IB adapter needs the
 * re-auth branch the mock has no concept of — and because a retry policy that
 * governs a live trading connection deserves its own tests.
 */

import { Logger } from '@nestjs/common';

export interface ReconnectConfig {
  /** Attempts before the connection is declared FAILED. */
  maxAttempts: number;
  /** First backoff delay in ms. Doubles each attempt. */
  baseDelayMs: number;
  /**
   * Ceiling on a single backoff delay.
   *
   * Without a cap, attempt 10 would wait over eight minutes on a 1s base —
   * long enough that a Gateway which came back early stays unused for most of
   * a session.
   */
  maxDelayMs: number;
}

export const DEFAULT_RECONNECT_CONFIG: ReconnectConfig = {
  maxAttempts: 6,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
};

export enum ReconnectOutcome {
  /** The socket came back. */
  RECONNECTED = 'RECONNECTED',
  /** Attempts exhausted — the fail-safe state. Halts entries. */
  EXHAUSTED = 'EXHAUSTED',
}

export interface ReconnectResult {
  outcome: ReconnectOutcome;
  attempts: number;
  /** The delays actually waited, so a test can assert the doubling directly. */
  delays: number[];
  /** Why the last attempt failed. Null on success. */
  lastError: string | null;
  /** True when this was IB's scheduled re-auth rather than a fault. */
  scheduled: boolean;
}

type Sleeper = (ms: number) => Promise<void>;

/**
 * The delay before a given attempt: `base * 2^(n-1)`, capped.
 *
 * Exported because it is the part worth asserting directly — a test that only
 * observed elapsed time would pass on a linear backoff too.
 */
export function backoffDelay(attempt: number, config: ReconnectConfig): number {
  const exponential = config.baseDelayMs * Math.pow(2, attempt - 1);

  return Math.min(exponential, config.maxDelayMs);
}

export class ReconnectPolicy {
  private readonly logger = new Logger(ReconnectPolicy.name);
  private readonly config: ReconnectConfig;
  private readonly sleep: Sleeper;

  constructor(
    config: Partial<ReconnectConfig> = {},
    sleeper: Sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.config = { ...DEFAULT_RECONNECT_CONFIG, ...config };
    this.sleep = sleeper;
  }

  /**
   * Retries `attempt` with exponential backoff until it succeeds or the budget
   * is spent.
   *
   * `attempt` should resolve on a working connection and throw otherwise. Each
   * throw is caught and retried; only exhaustion is terminal.
   */
  async reconnect(attempt: () => Promise<void>): Promise<ReconnectResult> {
    return this.run(attempt, false);
  }

  /**
   * Reconnects after IB Gateway's **scheduled** re-authentication.
   *
   * Same retry mechanics, different reporting: this is an expected daily event
   * (`stories.md:596`), so it logs at info and the result carries
   * `scheduled: true` so the caller can avoid raising a critical alert for
   * something that happens every day.
   *
   * Exhaustion is still exhaustion. A re-auth that never comes back is a real
   * outage regardless of having started routinely.
   */
  async reconnectAfterReauth(attempt: () => Promise<void>): Promise<ReconnectResult> {
    this.logger.log(
      'IB Gateway re-authentication detected — routine daily event, reconnecting without alerting',
    );

    return this.run(attempt, true);
  }

  private async run(attempt: () => Promise<void>, scheduled: boolean): Promise<ReconnectResult> {
    const delays: number[] = [];
    let lastError: string | null = null;

    for (let n = 1; n <= this.config.maxAttempts; n += 1) {
      const delay = backoffDelay(n, this.config);
      delays.push(delay);
      await this.sleep(delay);

      try {
        await attempt();

        const message = `reconnected on attempt ${n}${scheduled ? ' after scheduled re-authentication' : ''}`;
        this.logger.log(message);

        return {
          outcome: ReconnectOutcome.RECONNECTED,
          attempts: n,
          delays,
          lastError: null,
          scheduled,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        this.logger.warn(`reconnect attempt ${n}/${this.config.maxAttempts} failed: ${lastError}`);
      }
    }

    // The fail-safe state. New entries stop; **nothing is sold**.
    this.logger.error(
      `reconnect exhausted after ${this.config.maxAttempts} attempts (${lastError}) — ` +
        'halting new entries. Existing positions are untouched and will NOT be liquidated.',
    );

    return {
      outcome: ReconnectOutcome.EXHAUSTED,
      attempts: this.config.maxAttempts,
      delays,
      lastError,
      scheduled,
    };
  }
}

/**
 * Whether market data has gone stale (`PRD.md:314`).
 *
 * A connected socket that has stopped delivering bars is more dangerous than a
 * dropped one, because nothing looks wrong: the ladder evaluates against the
 * last price it saw and keeps firing rungs against a market that has moved.
 * Treated as its own fail-safe trigger for that reason.
 *
 * Pure so it can be asserted at the boundary without a clock — the threshold is
 * a judgement call and its exact behaviour should be visible in a test.
 *
 * `dataExpectedSinceMs` closes the hole that a null `lastBarAtMs` would
 * otherwise leave open. A reconnect clears the last-bar timestamp so a healthy
 * new session is not reported stale on its first moments — but that made "never
 * delivered a bar" indistinguishable from "starting up", so a socket that
 * reconnected and then stayed silent could never trip this check. Passing the
 * moment data began being expected lets the two be told apart: still null past
 * the threshold is a feed that never arrived, which is exactly the silent
 * failure this function exists to catch.
 */
export function isStale(
  lastBarAtMs: number | null,
  nowMs: number,
  thresholdMs: number,
  dataExpectedSinceMs: number | null = null,
): boolean {
  if (lastBarAtMs === null) {
    // Startup with no reference point: nothing was expected yet, so silence is
    // not evidence of a fault. The caller decides when to start counting.
    if (dataExpectedSinceMs === null) {
      return false;
    }

    // Data *was* expected from a known moment and none has arrived since.
    return nowMs - dataExpectedSinceMs > thresholdMs;
  }

  return nowMs - lastBarAtMs > thresholdMs;
}

/**
 * Default staleness threshold: three missed 5-minute bars.
 *
 * One missed bar is normal — a thin symbol may simply not print. Three in a row
 * during a session means the feed is gone, not that the market is quiet.
 */
export const DEFAULT_STALE_THRESHOLD_MS = 15 * 60 * 1000;
