/**
 * Pure lot-reconstruction arithmetic, shared by the manual `recover-lots` CLI
 * (`src/cli/recover-lots.ts`) and the automatic `LotRebuildService`
 * (`lot-rebuild.service.ts`).
 *
 * Kept in one place deliberately: the CLI and the automatic path must reason
 * about a stranded position identically, or the two "recover a position from
 * its own orders" code paths would silently drift apart over time.
 *
 * See `lot-sum-assertion.ts` for why a repair can only ever be an exact
 * reconstruction (or, for `LotRebuildService`, a synthetic single lot) —
 * never a guess that doesn't sum exactly to the broker's reported position.
 */

import { exitTargetFor } from '../strategies/dip-ladder/lot';

/** One lot the reconstruction proposes to write. */
export interface ProposedLot {
  id: string;
  symbol: string;
  rungPrice: number;
  fillPrice: number;
  quantity: number;
  openedAt: string;
  exitTarget: number;
  clientOrderId: string;
}

export interface RecoveryPlan {
  lots: ProposedLot[];
  recoveredQuantity: number;
  weightedFillPrice: number;
  /** The lowest fill price — where the ladder's anchor will sit. */
  firstEntryPrice: number;
}

/**
 * Builds the lots implied by a set of stranded orders.
 *
 * Pure, so the arithmetic that decides a live position's exit targets is
 * testable without a database.
 *
 * Orders are taken **oldest first** so `openedAt` and the generated ids follow
 * the sequence the ladder would itself have produced — FIFO disposal depends on
 * that ordering, and a reconstruction that shuffles it would sell lots in an
 * order the ladder never chose.
 */
export function buildRecoveryPlan(
  symbol: string,
  orders: { clientOrderId: string; quantity: number; limitPrice: number; createdAt: string }[],
  rungPriceOf: (clientOrderId: string) => number,
  takeProfitPercent: number,
  // Supersedes the percentage when set, mirroring `exitTargetFor` itself —
  // the live engine runs `FIXED_DOLLAR` geometry (`strategies.module.ts`), so
  // a reconstruction that only knew percentage would freeze every recovered
  // lot's target on a rule the position was never actually opened under.
  takeProfitDollars: number | null = null,
): RecoveryPlan {
  const ordered = [...orders].sort((a, b) =>
    a.createdAt === b.createdAt
      ? a.clientOrderId.localeCompare(b.clientOrderId)
      : a.createdAt.localeCompare(b.createdAt),
  );

  const lots = ordered.map((order, index) => {
    // The limit price is the fill price's upper bound, so the target errs high.
    const fillPrice = order.limitPrice;

    return {
      // Matches the ladder's own `${symbol}-lot-${n}` convention, continuing
      // from an empty ledger — the precondition this script enforces.
      id: `${symbol}-lot-${index + 1}`,
      symbol,
      rungPrice: rungPriceOf(order.clientOrderId),
      fillPrice,
      quantity: order.quantity,
      openedAt: order.createdAt,
      exitTarget: exitTargetFor(fillPrice, takeProfitPercent, takeProfitDollars),
      clientOrderId: order.clientOrderId,
    };
  });

  const recoveredQuantity = lots.reduce((sum, lot) => sum + lot.quantity, 0);
  const notional = lots.reduce((sum, lot) => sum + lot.fillPrice * lot.quantity, 0);

  return {
    lots,
    recoveredQuantity,
    weightedFillPrice: recoveredQuantity === 0 ? 0 : notional / recoveredQuantity,
    // The hard floor is measured from the first entry (`invalidation.ts:50`), so
    // this must be populated or the -25% stop-adding rule silently disappears.
    firstEntryPrice: lots.length === 0 ? 0 : Math.max(...lots.map((lot) => lot.fillPrice)),
  };
}

/** Why a recovery was refused, or null when it may proceed. */
export function refuseReason(
  plan: RecoveryPlan,
  brokerQuantity: number,
  averageCost: number | null,
): string | null {
  if (plan.lots.length === 0) {
    return 'no stranded BUY orders with a WORKING rung were found — nothing to recover';
  }

  if (plan.recoveredQuantity !== brokerQuantity) {
    return (
      `recovered orders sum to ${plan.recoveredQuantity} share(s) but the broker reports ` +
      `${brokerQuantity} — ${Math.abs(brokerQuantity - plan.recoveredQuantity)} share(s) ` +
      'cannot be attributed to any order, so lot composition is genuinely unknown'
    );
  }

  if (averageCost !== null && plan.weightedFillPrice < averageCost - 0.005) {
    return (
      `weighted reconstruction ${plan.weightedFillPrice.toFixed(4)} is below the broker's ` +
      `average cost ${averageCost.toFixed(4)} — a buy limit fills at or below its limit, so ` +
      'this is impossible and the orders do not explain the position'
    );
  }

  return null;
}
