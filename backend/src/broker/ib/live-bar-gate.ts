/**
 * The gate between IB's bar subscription and the engine.
 *
 * `getHistoricalDataUpdates` is a **backfill-then-stream** subscription, not a
 * pure live feed. On subscribe IB replays a window of historical bars, and only
 * then begins emitting live updates — and it re-emits the in-progress bar
 * repeatedly as it forms. Treating every emission as a new closed bar walked a
 * live ladder down five rungs in sixteen seconds against stale prices, which in
 * `PAPER` went straight at the submission path.
 *
 * This module is the decision "is this emission a new closed bar?", separated
 * from the socket so it is directly testable. `stoqey-ib-socket.ts` is
 * Gateway-dependent and excluded from coverage; the rule that protects the
 * ladder must not be. Same split as `ib-wire.ts`, for the same reason.
 *
 * ## Why a quiet period
 *
 * IB provides no marker between the last historical bar and the first live one.
 * A gap in emissions is the only signal available: historical bars arrive
 * back-to-back in a burst, whereas the smallest live cadence this system
 * subscribes to is 5 minutes. So the window is "drained" once nothing has
 * arrived for `settleMs`.
 *
 * Erring long is the safe direction — the cost is skipping one early bar,
 * against the cost of replaying an entire historical window into a ladder that
 * can submit orders.
 */

import { Bar } from '../../market-data/types';

/**
 * Quiet period marking the end of the historical backfill.
 *
 * Three seconds sits far above the gap between burst emissions and far below
 * the 5-minute live cadence.
 */
export const BACKFILL_SETTLE_MS = 3_000;

export interface LiveBarGateOptions {
  settleMs?: number;
  /** Injectable clock, so tests need no timers. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Decides which subscription emissions are new closed bars.
 *
 * Stateful by nature — the decision depends on everything seen before — but
 * pure with respect to I/O: it holds no socket, no logger, and no timer. The
 * caller supplies elapsed time via `now`, which is what makes the settle
 * behaviour assertable without waiting.
 */
export class LiveBarGate {
  private readonly settleMs: number;
  private readonly now: () => number;

  private newestSeen: string | null = null;
  private lastEmissionAt: number;
  private draining = true;

  constructor(options: LiveBarGateOptions = {}) {
    this.settleMs = options.settleMs ?? BACKFILL_SETTLE_MS;
    this.now = options.now ?? (() => Date.now());

    // The clock starts at construction rather than at the first emission: a
    // subscription that returns no history at all — a symbol IB has no bars
    // for, or a market long closed — would otherwise stay draining forever and
    // silently drop every live bar that followed.
    this.lastEmissionAt = this.now();
  }

  /**
   * Returns the bar when it should reach the engine, or `null` to suppress it.
   *
   * Suppressed emissions still advance the watermark: a backfill bar is not
   * forwarded, but a later bar must be *newer than it* to count as live.
   */
  accept(bar: Bar): Bar | null {
    const at = this.now();

    if (this.draining && at - this.lastEmissionAt >= this.settleMs) {
      this.draining = false;
    }

    this.lastEmissionAt = at;

    // ISO-8601 with a fixed offset compares correctly lexicographically, and
    // `parseIbTime` normalizes every bar to the same ET offset form. `<=`
    // rather than `<` is what suppresses the repeated emissions of the
    // in-progress bar as it forms.
    if (this.newestSeen !== null && bar.timestamp <= this.newestSeen) {
      return null;
    }

    this.newestSeen = bar.timestamp;

    if (this.draining) {
      return null;
    }

    return bar;
  }

  /** True while the historical window is still being absorbed. Diagnostics. */
  isDraining(): boolean {
    return this.draining;
  }

  /** The newest bar timestamp seen, forwarded or not. Diagnostics. */
  watermark(): string | null {
    return this.newestSeen;
  }
}
