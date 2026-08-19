/**
 * The post-close order reconciliation job.
 *
 * **What it is for.** DAY orders expire at the close, and an order cancelled in
 * TWS during the session leaves this engine believing a rung is still working.
 * Both are discrepancies the engine cannot always learn about on its own: a
 * terminal status is attributed through an in-memory map populated at
 * submission, so an order placed before a restart produces a status this
 * process cannot match to a rung and silently drops. Running the order
 * reconciliation shortly after the close means the next session opens against a
 * ledger that agrees with the broker, rather than one carrying yesterday's
 * expired orders as permanently blocked levels.
 *
 * **It reconciles orders only, never positions.** `reconcileAll` can halt a
 * symbol, and a halt raised while nobody is watching is the failure mode this
 * job must not have — a broker briefly unreachable at 16:10 would otherwise
 * leave every symbol halted until an operator noticed the next morning. The
 * order half degrades to "changed nothing" instead: an unreachable broker
 * leaves the ledger exactly as persisted.
 *
 * ## Why the delay after the close is not zero
 *
 * IB does not mark DAY orders expired at exactly 16:00:00. Asking too early
 * returns them as still open, and the job would report a clean run over
 * precisely the orders it exists to clean up. The default lag gives the Gateway
 * time to settle the session before it is asked.
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { DateTime } from 'luxon';
import { ET_ZONE } from '../market-data/types';
import { SESSION_CLOSE } from '../market-data/session';
import { ReconciliationService } from './reconciliation.service';

export interface PostCloseReconcileConfig {
  /**
   * Minutes after the 16:00 ET close to run.
   *
   * Long enough that IB has finished expiring DAY orders, short enough that the
   * result is available the same evening.
   */
  delayMinutesAfterClose: number;
}

export const DEFAULT_POST_CLOSE_CONFIG: PostCloseReconcileConfig = {
  delayMinutesAfterClose: 15,
};

@Injectable()
export class PostCloseReconcileService implements OnModuleDestroy {
  private readonly logger = new Logger(PostCloseReconcileService.name);
  private readonly config: PostCloseReconcileConfig;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastRunDate: string | null = null;

  constructor(
    private readonly reconciliation: ReconciliationService,
    config: Partial<PostCloseReconcileConfig> = {},
  ) {
    this.config = { ...DEFAULT_POST_CLOSE_CONFIG, ...config };
  }

  /**
   * Schedules the next run.
   *
   * **A one-shot timer that re-arms, not a 24-hour interval.** A fixed interval
   * drifts across DST — the run would land an hour early or late for half the
   * year — and it anchors to process start rather than to the market close, so
   * a daemon restarted at 11:00 would reconcile at 11:00 forever. Recomputing
   * the next close in ET each time keeps the job pinned to the session.
   */
  start(now: DateTime = DateTime.now().setZone(ET_ZONE)): void {
    if (this.timer) {
      return;
    }

    this.arm(now);
  }

  private arm(now: DateTime): void {
    const next = this.nextRunAt(now);
    const delayMs = next.diff(now).toMillis();

    this.timer = setTimeout(() => {
      this.timer = null;

      void this.runNow().finally(() => {
        // Re-armed from the wake-up time rather than the original schedule, so
        // a long-running reconciliation cannot compound into drift.
        this.arm(DateTime.now().setZone(ET_ZONE));
      });
    }, delayMs);

    // A scheduled job should never be the reason the daemon cannot exit.
    this.timer.unref?.();

    this.logger.log(`post-close order reconciliation scheduled for ${next.toISO()}`);
  }

  /**
   * The next run instant: the first weekday close + delay strictly after `now`.
   *
   * Weekends are skipped because there is no close to follow. Market holidays
   * are **not** skipped, deliberately: this codebase has no holiday calendar,
   * and a run on a closed day asks the broker two harmless read-only questions
   * and finds nothing to change. Inventing a calendar to avoid a no-op would be
   * a source of wrong answers rather than a saving.
   */
  nextRunAt(now: DateTime): DateTime {
    const et = now.setZone(ET_ZONE);

    let candidate = et.set({
      hour: SESSION_CLOSE.hour,
      minute: SESSION_CLOSE.minute,
      second: 0,
      millisecond: 0,
    });

    candidate = candidate.plus({ minutes: this.config.delayMinutesAfterClose });

    // Strictly after: a run that lands exactly on the boundary must schedule
    // the *next* one, not re-arm on the instant it just fired.
    if (candidate <= et) {
      candidate = candidate.plus({ days: 1 });
    }

    while (candidate.weekday > 5) {
      candidate = candidate.plus({ days: 1 });
    }

    return candidate;
  }

  /**
   * Runs the reconciliation once.
   *
   * Public so the job's actual work is directly assertable without waiting on a
   * timer, matching `LiveFeedService.checkStale`.
   *
   * **Errors are caught, never rethrown.** An unhandled rejection inside a
   * timer callback takes the daemon down, which would turn a failed read into
   * an outage — the opposite of what a maintenance job should risk. The next
   * evening's run tries again.
   */
  async runNow(now: DateTime = DateTime.now().setZone(ET_ZONE)): Promise<void> {
    const sessionDate = now.toFormat('yyyy-MM-dd');

    // Guards a double-run on the same session: `start` being called twice, or a
    // timer firing early enough that the re-arm lands on the same evening.
    // Harmless if it happened — the reconciliation is idempotent — but a second
    // entry in the log would misreport how often this ran.
    if (this.lastRunDate === sessionDate) {
      return;
    }

    this.lastRunDate = sessionDate;

    try {
      const report = await this.reconciliation.reconcileOrders(now.toISO()!);

      if (!report.brokerReachable) {
        this.logger.warn(
          'post-close reconciliation could not reach the broker — the order ledger is ' +
            'unchanged and may still carry orders that expired at the close',
        );
        return;
      }

      this.logger.log(
        `post-close reconciliation done — ${report.ordersUpdated} stale order row(s) corrected ` +
          `across ${report.symbols.length} symbol(s)`,
      );
    } catch (error) {
      this.logger.error(
        `post-close reconciliation failed: ${
          error instanceof Error ? error.message : String(error)
        }. The ledger is unchanged; the next scheduled run will retry.`,
      );
    }
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  onModuleDestroy(): void {
    this.stop();
  }
}
