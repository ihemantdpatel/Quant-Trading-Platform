/**
 * Automatic protective-sell placement for a disabled strategy's real lots.
 *
 * ## The gap this closes
 *
 * A disabled strategy (the dip ladder today, potentially the grid strategy
 * tomorrow if the operator swaps which one trades) can still hold real
 * broker shares from before it was switched off — nothing here can liquidate
 * them, but nothing was placing sells to protect them either, until an
 * operator noticed and pressed `POST /orders/place-missing` by hand
 * (`OrderDiagnosisService`'s "diagnosed from the database" section covers why
 * that button could even see them). That one-time placement is not durable:
 * every order this system places is DAY time-in-force, so whatever it placed
 * expires at the close exactly like an enabled strategy's own orders do — the
 * difference is that an *enabled* strategy re-evaluates and re-rests its own
 * missing orders every session for free, while a disabled one has nothing
 * doing that on its behalf. Left alone, the position would silently lose its
 * protection every single evening.
 *
 * This service is the automation an operator would otherwise have to
 * perform by hand each morning: diagnose, and place whatever is missing for
 * a strategy nothing is running.
 *
 * ## Why this needs its own service rather than reusing `PostCloseReconcileService`
 *
 * That job's entire design is "read-only-ish" — its own header states it
 * "reconciles orders only, never positions" and "places and cancels no
 * order" is the very first line of `OrderDiagnosisService`'s. Repurposing it
 * to submit real orders would be a silent, undocumented widening of a class
 * whose safety story depends on that restriction. This service says plainly,
 * in its own name, that it writes.
 *
 * ## Ordering: reconcile first, then diagnose, then place
 *
 * A lot's `workingOrderId` goes stale the moment its DAY sell expires at the
 * close, and a *stale* mark reads as `UNBACKED`, not `missing`
 * (`OrderDiagnosisService`'s own doc comment) — `UNBACKED`'s repair is
 * release, not placement, so a stale mark must be cleared before this can
 * see anything to act on. `ReconciliationService.releaseStaleDisabledSells`/
 * `GridReconciliationService`'s own version do that release, but only for a
 * *disabled* strategy's persisted rows — the live-state release path an
 * enabled strategy uses doesn't apply here at all. Both reconcilers' own
 * `reconcileOrders` already runs on a shorter cycle via `OrderPollService`
 * and nightly via `PostCloseReconcileService`, so by the time this fires the
 * mark is very likely already clear — but calling `reconcileOrders` again
 * here first makes this job self-sufficient rather than dependent on exact
 * timing relative to the other two schedulers.
 *
 * ## Scope: SELL-side, disabled strategies only
 *
 * Never proposes a BUY — a disabled strategy must never open a new position,
 * and `OrderDiagnosisService`'s database fallback never produces one for
 * exactly that reason, so there is nothing to filter out on that side. Only
 * a strategy currently reporting `enabled: false` is considered: an enabled
 * one already re-rests its own missing orders through the normal bar path,
 * and placing for it here too would be redundant at best.
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { DateTime } from 'luxon';
import { ET_ZONE } from '../market-data/types';
import { SESSION_CLOSE } from '../market-data/session';
import { CoordinatorService } from '../strategies/coordinator.service';
import { OrderOnlyReconciler } from './order-reconciler';
import { OrderDiagnosisService } from './order-diagnosis.service';

/** The engine surface this service needs — narrower than the full `EngineService`. */
export interface MissingOrderPlacer {
  placeMissingOrders(candidates: MissingOrderCandidateLike[]): Promise<{
    placed: { candidate: MissingOrderCandidateLike; quantity: number; resized: boolean }[];
    declined: { candidate: MissingOrderCandidateLike; reason: string }[];
  }>;
}

export interface MissingOrderCandidateLike {
  strategyId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  limitPrice: number;
  reason: string;
  lotId: string | null;
}

export interface DisabledStrategyProtectionConfig {
  /** Minutes after the 16:00 ET close to run — after both order-only reconcilers' own pass. */
  delayMinutesAfterClose: number;
}

export const DEFAULT_DISABLED_STRATEGY_PROTECTION_CONFIG: DisabledStrategyProtectionConfig = {
  delayMinutesAfterClose: 30,
};

@Injectable()
export class DisabledStrategyProtectionService implements OnModuleDestroy {
  private readonly logger = new Logger(DisabledStrategyProtectionService.name);
  private readonly config: DisabledStrategyProtectionConfig;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastRunDate: string | null = null;

  constructor(
    private readonly ladderReconciliation: OrderOnlyReconciler,
    private readonly gridReconciliation: OrderOnlyReconciler,
    private readonly diagnosis: OrderDiagnosisService,
    private readonly coordinator: CoordinatorService,
    private readonly engine: MissingOrderPlacer,
    config: Partial<DisabledStrategyProtectionConfig> = {},
  ) {
    this.config = { ...DEFAULT_DISABLED_STRATEGY_PROTECTION_CONFIG, ...config };
  }

  /** Same one-shot-timer-that-re-arms shape as `PostCloseReconcileService`, and for the same reason. */
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
        this.arm(DateTime.now().setZone(ET_ZONE));
      });
    }, delayMs);

    this.timer.unref?.();

    this.logger.log(`disabled-strategy protection scheduled for ${next.toISO()}`);
  }

  /** Identical computation to `PostCloseReconcileService.nextRunAt`, at this job's own delay. */
  nextRunAt(now: DateTime): DateTime {
    const et = now.setZone(ET_ZONE);

    let candidate = et.set({
      hour: SESSION_CLOSE.hour,
      minute: SESSION_CLOSE.minute,
      second: 0,
      millisecond: 0,
    });

    candidate = candidate.plus({ minutes: this.config.delayMinutesAfterClose });

    if (candidate <= et) {
      candidate = candidate.plus({ days: 1 });
    }

    while (candidate.weekday > 5) {
      candidate = candidate.plus({ days: 1 });
    }

    return candidate;
  }

  /**
   * Runs the protection pass once. Public so it is directly assertable
   * without waiting on a timer, matching `PostCloseReconcileService.runNow`.
   *
   * **Errors are caught, never rethrown** — the same reasoning as every
   * other scheduled job here: an unhandled rejection inside a timer callback
   * would take the daemon down, turning a missed protective sell into a full
   * outage. The next scheduled run retries.
   */
  async runNow(now: DateTime = DateTime.now().setZone(ET_ZONE)): Promise<void> {
    const sessionDate = now.toFormat('yyyy-MM-dd');

    if (this.lastRunDate === sessionDate) {
      return;
    }

    this.lastRunDate = sessionDate;

    try {
      const nowIso = now.toISO()!;

      // Freshens stale working-order marks first — see this file's own
      // "ordering" section for why a diagnosis run before this would still
      // see yesterday's expired sells as `UNBACKED` rather than `missing`.
      await this.ladderReconciliation.reconcileOrders(nowIso);
      await this.gridReconciliation.reconcileOrders(nowIso);

      const diagnosis = await this.diagnosis.diagnose(nowIso);

      if (!diagnosis.brokerReachable) {
        this.logger.warn(
          'disabled-strategy protection skipped — broker unreachable; the next scheduled run ' +
            'will retry',
        );
        return;
      }

      const disabledStrategyIds = new Set(
        this.coordinator
          .snapshots()
          .filter((snapshot) => !snapshot.enabled)
          .map((snapshot) => snapshot.id),
      );

      // SELL-side only, and only for a strategy currently disabled — see
      // this file's own header for both restrictions.
      const candidates = diagnosis.missing.filter(
        (missing) => missing.side === 'SELL' && disabledStrategyIds.has(missing.strategyId),
      );

      if (candidates.length === 0) {
        this.logger.log('disabled-strategy protection: nothing missing');
        return;
      }

      const result = await this.engine.placeMissingOrders(
        candidates.map((candidate) => ({
          strategyId: candidate.strategyId,
          symbol: candidate.symbol,
          side: candidate.side,
          quantity: candidate.quantity,
          limitPrice: candidate.limitPrice,
          reason: candidate.reason,
          lotId: candidate.lotId,
        })),
      );

      this.logger.log(
        `disabled-strategy protection: placed ${result.placed.length} sell(s), declined ` +
          `${result.declined.length}` +
          (result.declined.length > 0
            ? ` (${result.declined.map((d) => d.reason).join('; ')})`
            : ''),
      );
    } catch (error) {
      this.logger.error(
        `disabled-strategy protection failed: ${
          error instanceof Error ? error.message : String(error)
        }. The next scheduled run will retry.`,
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
