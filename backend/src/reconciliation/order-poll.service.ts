/**
 * Periodic mid-session order-only reconciliation.
 *
 * **The gap this closes.** Nothing else re-asks the broker what an open order
 * looks like during a session. `processBar` never calls `getOpenOrders()` — a
 * bar only evaluates the strategy and submits or cancels what it decides on —
 * and everything this engine otherwise learns about an order arrives through
 * `onFill`, an event only a *fill* produces. An order that is edited or
 * cancelled in TWS without filling (a resized resting order, a manual
 * cancel) is invisible until the next explicit `getOpenOrders()` call, which
 * before this service happened only at boot, on operator-triggered
 * `POST /reconcile`, and once nightly via `PostCloseReconcileService` — up to
 * a full session's worth of drift between what the engine's in-memory
 * working-order registry believes and what is actually resting.
 *
 * The concrete failure this closes: `EngineService.routeFill` decides whether
 * a fill is partial by comparing it against the in-memory `working.quantity`,
 * which is only ever refreshed by `adoptWorkingOrders` — itself only called
 * from `reconcileOpenOrders`. A resting BUY resized upward in TWS (say 50 to
 * 100 shares) that then fills partially (e.g. 70 of the true 100) would be
 * misread as a *full* fill against the stale 50, skip cancelling the
 * remainder, and leave shares resting at the broker with no rung tracking
 * them.
 *
 * **Order-only, like the post-close job, and for the same reason.**
 * `reconcileAll` can halt a symbol on the lot-sum assertion; a halt raised by
 * an unattended background poll — say, on a broker blip at 11:03am — is the
 * exact failure mode a scheduled job must not have. `reconcileOrders` never
 * halts: an unreachable broker leaves the ledger exactly as persisted, and a
 * reachable one only releases stale working-order marks and adopts orphans,
 * neither of which touches a lot.
 *
 * **A fixed interval, not a one-shot re-arming timer.** Unlike
 * `PostCloseReconcileService`, this has no single instant it is pinned to —
 * it exists to keep bounded the staleness window described above, so a
 * simple `setInterval` is the right tool and DST/weekend arithmetic does not
 * apply. Running outside market hours is harmless for the same reason the
 * post-close job does not skip holidays: `reconcileOrders` asks the broker
 * read-only questions and finds nothing to change when nothing is resting.
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service';

export interface OrderPollConfig {
  /** How often to re-ask the broker for its open orders during a session. */
  intervalMs: number;
}

export const DEFAULT_ORDER_POLL_CONFIG: OrderPollConfig = {
  intervalMs: 5 * 60_000,
};

@Injectable()
export class OrderPollService implements OnModuleDestroy {
  private readonly logger = new Logger(OrderPollService.name);
  private readonly config: OrderPollConfig;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly reconciliation: ReconciliationService,
    config: Partial<OrderPollConfig> = {},
  ) {
    this.config = { ...DEFAULT_ORDER_POLL_CONFIG, ...config };
  }

  /** Idempotent — a second call while a timer is already running does nothing. */
  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => void this.poll(), this.config.intervalMs);

    // A scheduled job should never be the reason the daemon cannot exit.
    this.timer.unref?.();

    this.logger.log(
      `periodic order reconciliation started — every ${this.config.intervalMs / 60_000} minute(s)`,
    );
  }

  /**
   * One reconciliation pass.
   *
   * Public so a poll is directly assertable without waiting on a timer,
   * matching `PostCloseReconcileService.runNow` and
   * `LiveFeedService.checkStale`.
   *
   * **Errors are caught, never rethrown.** An unhandled rejection inside a
   * timer callback takes the daemon down — turning a failed maintenance read
   * into an outage is a worse failure than the drift this exists to bound.
   * The next tick, five minutes later, tries again.
   */
  async poll(now: string = new Date().toISOString()): Promise<void> {
    try {
      const report = await this.reconciliation.reconcileOrders(now);

      if (!report.brokerReachable) {
        this.logger.warn(
          'periodic order reconciliation could not reach the broker — the order ledger is ' +
            'unchanged; the next scheduled poll will retry',
        );
        return;
      }

      if (report.ordersUpdated > 0) {
        this.logger.log(
          `periodic order reconciliation corrected ${report.ordersUpdated} stale order row(s) ` +
            `across ${report.symbols.length} symbol(s)`,
        );
      }
    } catch (error) {
      this.logger.error(
        `periodic order reconciliation failed: ${
          error instanceof Error ? error.message : String(error)
        }. The ledger is unchanged; the next scheduled poll will retry.`,
      );
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  onModuleDestroy(): void {
    this.stop();
  }
}
