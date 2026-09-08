/**
 * Automatic resolution of a lot-sum/state-version mismatch — the guess
 * `lot-sum-assertion.ts` and `recover-lots.ts` both document as forbidden on
 * the reconciliation path, made anyway, deliberately, and only under the
 * conditions recorded in `docs/decisions/auto-lot-rebuild.md`.
 *
 * **This service does not decide whether to run.** `ReconciliationService`
 * decides that (gated to `PAPER`, per the decision doc) and calls `attempt`
 * only once `assertLotSum` has already found a disagreement. Everything here
 * is pure computation over the lots/rungs it is handed, plus one read
 * (`OrderRepository`) for the higher-fidelity reconstruction — persistence and
 * the halt/release/audit sequencing all stay in `ReconciliationService`.
 *
 * ## The two directions
 *
 * `delta = brokerQuantity - sumHeldQuantity(persistedLots)`:
 *
 * - **`delta > 0`** — the broker reports more shares than our lots explain
 *   (`UNTRACKED_AT_BROKER`, or `QUANTITY_MISMATCH` with the broker higher).
 *   Existing correct `HELD` lots are left untouched; only the *difference* is
 *   unexplained, and is reconstructed or synthesized to cover it. See
 *   `addLots`.
 * - **`delta < 0`** — our lots claim more shares than the broker reports
 *   (`MISSING_AT_BROKER`, or `QUANTITY_MISMATCH` with the broker lower).
 *   There is no fill evidence for whatever happened to the difference, so
 *   nothing here can know what price it left at — the excess is written off
 *   at its own fill price, not sold at a guessed one, so realized P&L is
 *   always exactly zero. See `writeOff`.
 *
 * Both directions bring the lot sum to exactly `brokerQuantity` or refuse
 * entirely — there is no partial application. A caller that receives
 * `applied: false` must treat the mismatch exactly as before this service
 * existed: halted, unresolved, operator-only.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  FILL_REPOSITORY,
  FillRepository,
  ORDER_REPOSITORY,
  OrderRepository,
} from '../repositories/repository.interfaces';
import {
  closeLot,
  exitTargetFor,
  fifoQueue,
  heldLots,
  Lot,
  LotStatus,
  splitLot,
} from '../strategies/dip-ladder/lot';
import {
  findRung,
  markHeld,
  releaseWithoutCycle,
  Rung,
  RungStatus,
} from '../strategies/dip-ladder/rung';
import { buildRecoveryPlan, ProposedLot, refuseReason } from './lot-recovery-plan';
import { assertLotSum, LotSumVerdict, sumHeldQuantity } from './lot-sum-assertion';

export enum RebuildAction {
  /** Exact reconstruction from this system's own Order/Rung records. */
  ADD_TIER1_RECONSTRUCTED = 'ADD_TIER1_RECONSTRUCTED',
  /** A single lot at the broker's blended average cost — the lossy fallback. */
  ADD_TIER2_SYNTHETIC = 'ADD_TIER2_SYNTHETIC',
  /** Excess DB lot quantity closed at its own fill price — zero realized P&L. */
  WRITE_OFF = 'WRITE_OFF',
}

export interface RebuildAttemptParams {
  symbol: string;
  persistedLots: Lot[];
  persistedRungs: Rung[];
  brokerQuantity: number;
  brokerAverageCost: number;
  takeProfitPercent: number;
  /** Supersedes `takeProfitPercent` when set — the live engine's FIXED_DOLLAR geometry. */
  takeProfitDollars: number | null;
  now: string;
}

export interface RebuildOutcome {
  applied: boolean;
  action: RebuildAction | null;
  lots: Lot[];
  rungs: Rung[];
  verdict: LotSumVerdict;
  detail: string;
}

function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

@Injectable()
export class LotRebuildService {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(FILL_REPOSITORY) private readonly fills: FillRepository,
  ) {}

  async attempt(params: RebuildAttemptParams): Promise<RebuildOutcome> {
    const { symbol, persistedLots, brokerQuantity } = params;
    const heldQuantity = sumHeldQuantity(persistedLots);
    const delta = brokerQuantity - heldQuantity;

    if (delta === 0) {
      // Should not be reached — the caller only invokes this on a mismatch —
      // but returning "nothing to do" is the safe response if it ever is.
      return {
        applied: false,
        action: null,
        lots: params.persistedLots,
        rungs: params.persistedRungs,
        verdict: assertLotSum(symbol, persistedLots, brokerQuantity),
        detail: 'delta is zero — no rebuild needed',
      };
    }

    return delta > 0 ? this.addLots(params, delta) : this.writeOff(params, -delta);
  }

  /**
   * True when a `Fill` is recorded for `workingOrderId` that `recoverExitFills`
   * (`reconciliation.service.ts`) did not already resolve — i.e. a fill exists
   * but does not exactly cover the lot, so it is evidence of a real (partial)
   * sale rather than nothing at all.
   *
   * `writeOff` must refuse when this is true rather than book the gap at zero
   * P&L: `recoverExitFills` runs first and already applies every fill that
   * *exactly* matches, so any fill still on record here is inexact by
   * construction — proof that money changed hands at a real price, which a
   * cost-basis write-off would silently discard.
   */
  private async hasUnresolvedFillEvidence(lot: Lot): Promise<boolean> {
    if (!lot.workingOrderId) {
      return false;
    }

    const evidence = await this.fills.findByClientOrderId(lot.workingOrderId);
    return evidence.length > 0;
  }

  /**
   * Covers `UNTRACKED_AT_BROKER` and `QUANTITY_MISMATCH` with the broker
   * higher. Tries an exact reconstruction from this ladder's own order
   * records first; only synthesizes a blended-cost lot when that can't
   * explain the gap exactly.
   */
  private async addLots(params: RebuildAttemptParams, delta: number): Promise<RebuildOutcome> {
    const { symbol, persistedLots, persistedRungs, brokerQuantity, brokerAverageCost } = params;

    const workingRungs = persistedRungs.filter(
      (rung) => rung.status === RungStatus.WORKING && rung.workingOrderId !== null,
    );
    const rungByOrder = new Map(workingRungs.map((rung) => [rung.workingOrderId as string, rung]));

    const allOrders = await this.orders.findAll();
    const stranded = allOrders
      .filter(
        (order) =>
          order.symbol === symbol && order.side === 'BUY' && rungByOrder.has(order.clientOrderId),
      )
      .map((order) => ({
        clientOrderId: order.clientOrderId,
        quantity: order.quantity,
        limitPrice: order.limitPrice,
        createdAt: order.createdAt,
      }));

    const plan = buildRecoveryPlan(
      symbol,
      stranded,
      (id) => rungByOrder.get(id)!.price,
      params.takeProfitPercent,
      params.takeProfitDollars,
    );

    const existingHeld = heldLots(persistedLots);
    const existingNotional = existingHeld.reduce(
      (sum, lot) => sum + lot.fillPrice * lot.quantity,
      0,
    );
    const combinedQuantity =
      existingHeld.reduce((sum, lot) => sum + lot.quantity, 0) + plan.recoveredQuantity;
    const combinedNotional =
      existingNotional + plan.lots.reduce((sum, lot) => sum + lot.fillPrice * lot.quantity, 0);
    const combinedWeighted = combinedQuantity === 0 ? 0 : combinedNotional / combinedQuantity;

    // Reuse the CLI's own refusal arithmetic against the *combined* set — the
    // same exact-sum and above-average-cost requirements, just measured over
    // "existing correct lots plus this reconstruction" rather than an empty
    // ledger.
    const tier1Refusal =
      plan.recoveredQuantity !== delta
        ? refuseReason(plan, delta, null) // surfaces the "nothing found"/quantity-mismatch reason
        : combinedWeighted < brokerAverageCost - 0.005
          ? `weighted reconstruction ${combinedWeighted.toFixed(4)} is below the broker's average ` +
            `cost ${brokerAverageCost.toFixed(4)} — the orders on file do not explain this position`
          : null;

    if (tier1Refusal === null) {
      return this.applyTier1(params, plan, brokerQuantity);
    }

    return this.applyTier2(params, delta, tier1Refusal);
  }

  private applyTier1(
    params: RebuildAttemptParams,
    plan: { lots: ProposedLot[] },
    brokerQuantity: number,
  ): RebuildOutcome {
    const { symbol, persistedLots, persistedRungs } = params;

    const recoveredLots: Lot[] = plan.lots.map((proposed) => ({
      id: `${symbol}-lot-recovered-${proposed.clientOrderId}`,
      rungPrice: proposed.rungPrice,
      fillPrice: proposed.fillPrice,
      quantity: proposed.quantity,
      openedAt: proposed.openedAt,
      // Already computed by `buildRecoveryPlan` under the config's actual
      // take-profit rule (percent or dollars) — not recomputed here, which
      // would silently drop the FIXED_DOLLAR supersession.
      exitTarget: proposed.exitTarget,
      status: LotStatus.HELD,
      closedAt: null,
      exitPrice: null,
      workingOrderId: null,
    }));

    const clientOrderIdByLotId = new Map(
      plan.lots.map((proposed, index) => [recoveredLots[index].id, proposed.clientOrderId]),
    );

    const rungs = persistedRungs.map((rung) => {
      if (rung.workingOrderId === null) {
        return rung;
      }

      const recovered = recoveredLots.find(
        (lot) => clientOrderIdByLotId.get(lot.id) === rung.workingOrderId,
      );

      return recovered ? markHeld(rung, recovered.id) : rung;
    });

    const lots = [...persistedLots, ...recoveredLots];
    const verdict = assertLotSum(symbol, lots, brokerQuantity);

    return {
      applied: verdict.reconciled,
      action: verdict.reconciled ? RebuildAction.ADD_TIER1_RECONSTRUCTED : null,
      lots: verdict.reconciled ? lots : persistedLots,
      rungs: verdict.reconciled ? rungs : persistedRungs,
      verdict,
      detail: verdict.reconciled
        ? `reconstructed ${recoveredLots.length} lot(s) totalling ` +
          `${recoveredLots.reduce((sum, lot) => sum + lot.quantity, 0)} share(s) from this ` +
          "ladder's own order records — exact match against the broker"
        : `Tier 1 reconstruction produced ${verdict.lotQuantity} share(s), still not ` +
          `${brokerQuantity} — refusing rather than guessing further`,
    };
  }

  private applyTier2(
    params: RebuildAttemptParams,
    delta: number,
    tier1Refusal: string,
  ): RebuildOutcome {
    const {
      symbol,
      persistedLots,
      persistedRungs,
      brokerAverageCost,
      takeProfitPercent,
      takeProfitDollars,
      now,
    } = params;

    const candidatePrice = roundToCents(brokerAverageCost);
    const collidesWithWorkingOrder =
      findRung(persistedRungs, candidatePrice)?.status === RungStatus.WORKING;
    // A rung already `WORKING` at exactly this price has a real resting order
    // at the broker — hosting the synthetic lot there would overwrite
    // `workingOrderId` and strand that order untracked. Astronomically rare
    // (the broker's average cost would have to land on the cent at a level
    // this ladder happens to have an order resting on), but nudged aside
    // rather than risking it: a rung a cent off its usual grid spacing is
    // harmless, an orphaned resting order is not.
    const rungPrice = collidesWithWorkingOrder
      ? roundToCents(candidatePrice + 0.01)
      : candidatePrice;

    const syntheticLot: Lot = {
      id: `${symbol}-lot-synthetic-${now}`,
      rungPrice,
      fillPrice: brokerAverageCost,
      quantity: delta,
      openedAt: now,
      exitTarget: exitTargetFor(brokerAverageCost, takeProfitPercent, takeProfitDollars),
      status: LotStatus.HELD,
      closedAt: null,
      exitPrice: null,
      workingOrderId: null,
    };

    const existingRung = findRung(persistedRungs, rungPrice);
    const hostRung: Rung = existingRung
      ? markHeld(existingRung, syntheticLot.id)
      : {
          price: rungPrice,
          status: RungStatus.HELD,
          lotId: syntheticLot.id,
          workingOrderId: null,
          completedCycles: 0,
          lastExitAt: null,
        };

    const rungs = existingRung
      ? persistedRungs.map((rung) => (rung.price === existingRung.price ? hostRung : rung))
      : [...persistedRungs, hostRung];

    const lots = [...persistedLots, syntheticLot];
    const verdict = assertLotSum(symbol, lots, params.brokerQuantity);

    return {
      applied: verdict.reconciled,
      action: verdict.reconciled ? RebuildAction.ADD_TIER2_SYNTHETIC : null,
      lots: verdict.reconciled ? lots : persistedLots,
      rungs: verdict.reconciled ? rungs : persistedRungs,
      verdict,
      detail: verdict.reconciled
        ? `Tier 1 refused (${tier1Refusal}); synthesized one lot of ${delta} share(s) at the ` +
          `broker's average cost ${brokerAverageCost.toFixed(2)} — per-lot exit targets for this ` +
          'gap are now collapsed to one blended target'
        : `synthetic lot still did not reconcile: ${verdict.reason}`,
    };
  }

  /**
   * Covers `MISSING_AT_BROKER` and `QUANTITY_MISMATCH` with the broker lower.
   * Writes off `quantity` shares of held exposure, oldest lot first, at each
   * lot's own `fillPrice` — never a market price, since nothing here observed
   * a real sale. `realizedPnl` is therefore always exactly zero: this is a
   * reconciliation write-off, not a fabricated trade.
   *
   * Refuses entirely — no partial application, same as every other outcome
   * here — the moment any lot it would touch has unresolved fill evidence.
   * See `hasUnresolvedFillEvidence`.
   */
  private async writeOff(params: RebuildAttemptParams, quantity: number): Promise<RebuildOutcome> {
    const { symbol, persistedLots, persistedRungs, brokerQuantity, now } = params;
    const queue = fifoQueue(heldLots(persistedLots));

    let remaining = quantity;
    let lots = [...persistedLots];
    let rungs = [...persistedRungs];
    let writtenOff = 0;

    for (const lot of queue) {
      if (remaining <= 0) {
        break;
      }

      if (await this.hasUnresolvedFillEvidence(lot)) {
        return {
          applied: false,
          action: null,
          lots: persistedLots,
          rungs: persistedRungs,
          verdict: assertLotSum(symbol, persistedLots, brokerQuantity),
          detail:
            `refusing to write off ${lot.id} — a Fill is recorded for its exit order ` +
            `${lot.workingOrderId ?? ''} that does not exactly cover the lot, so the gap may ` +
            'reflect a real partial sale rather than an unexplained difference',
        };
      }

      const rungIndex = rungs.findIndex((rung) => rung.lotId === lot.id);

      if (lot.quantity <= remaining) {
        const closed = closeLot(lot, lot.fillPrice, now);
        lots = lots.map((candidate) => (candidate.id === lot.id ? closed : candidate));

        if (rungIndex !== -1) {
          rungs = rungs.map((rung, index) =>
            index === rungIndex ? releaseWithoutCycle(rung) : rung,
          );
        }

        remaining -= lot.quantity;
        writtenOff += lot.quantity;
      } else {
        const { sold, remainder } = splitLot(
          lot,
          remaining,
          lot.fillPrice,
          now,
          `${lot.id}-writeoff-remainder`,
        );

        lots = lots.flatMap((candidate) =>
          candidate.id === lot.id ? [sold, remainder] : [candidate],
        );

        // The rung stays HELD — the remainder is still exposure — but must
        // point at the remainder's fresh id, or `rung.lotId` names a lot that
        // no longer exists.
        if (rungIndex !== -1) {
          rungs = rungs.map((rung, index) =>
            index === rungIndex ? { ...rung, lotId: remainder.id } : rung,
          );
        }

        writtenOff += remaining;
        remaining = 0;
      }
    }

    const verdict = assertLotSum(symbol, lots, brokerQuantity);

    if (!verdict.reconciled || remaining > 0) {
      // Structurally shouldn't happen — held quantity is always >= the
      // write-off amount by construction — but refuse rather than guess if it
      // ever does.
      return {
        applied: false,
        action: null,
        lots: persistedLots,
        rungs: persistedRungs,
        verdict: assertLotSum(symbol, persistedLots, brokerQuantity),
        detail: `write-off left ${remaining} share(s) unaccounted for — refusing`,
      };
    }

    return {
      applied: true,
      action: RebuildAction.WRITE_OFF,
      lots,
      rungs,
      verdict,
      detail:
        `wrote off ${writtenOff} share(s) of held exposure, oldest lot first, at each lot's own ` +
        'fill price (realized P&L exactly zero) to match a broker position lower than this ' +
        `ladder's records — mismatch was ${verdict.status}`,
    };
  }
}
