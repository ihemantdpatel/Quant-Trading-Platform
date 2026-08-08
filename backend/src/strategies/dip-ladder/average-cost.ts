import { Lot, heldLots } from './lot';

/**
 * Blended average cost — **display only** (`PRD.md:157`).
 *
 * The dashboard labels this "reference only" (`PRD.md:378`) and no exit
 * decision reads it. It is computed here, in its own module, precisely so that
 * the separation is visible: nothing in `exits.ts` imports this file, so the
 * default exit path cannot consult the blend even by accident.
 *
 * **On "selling to bring the average down"** (`PRD.md:149`): the intuition is
 * common and the mechanic does not work as expected. Selling a lot at a loss
 * *raises* the average cost of what remains — buy at 100 and 90 (average 95),
 * sell the 100-lot at 92, and the remaining 90-lot leaves the average at 90.
 * It dropped only because the expensive lot was disposed of at a realized loss,
 * with less exposure remaining. What lowers the average while *keeping*
 * exposure is buying lower, which the ladder already does. No function in this
 * file books a loss to adjust basis, and none exists elsewhere.
 */

/**
 * Quantity-weighted average fill price across held lots. Null when flat.
 *
 * Weighted by quantity rather than a plain mean of fill prices: rungs deeper in
 * the ladder buy more shares for the same allocation, so an unweighted mean
 * would misstate the basis whenever rung sizes differ.
 */
export function blendedAverageCost(lots: Lot[]): number | null {
  const held = heldLots(lots);

  if (held.length === 0) {
    return null;
  }

  const totalQuantity = held.reduce((sum, lot) => sum + lot.quantity, 0);

  if (totalQuantity === 0) {
    return null;
  }

  const totalCost = held.reduce((sum, lot) => sum + lot.fillPrice * lot.quantity, 0);

  return roundToCents(totalCost / totalQuantity);
}

function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Total shares held across all lots. */
export function totalHeldQuantity(lots: Lot[]): number {
  return heldLots(lots).reduce((sum, lot) => sum + lot.quantity, 0);
}

/** Total capital currently deployed at cost. */
export function totalDeployedCost(lots: Lot[]): number {
  return roundToCents(heldLots(lots).reduce((sum, lot) => sum + lot.fillPrice * lot.quantity, 0));
}

/**
 * Unrealized P&L at a mark price. Display only.
 *
 * A dip-buying ladder is expected to sit in unrealized loss by design
 * (`PRD.md:252`), so this figure is informational and is never an exit trigger.
 */
export function unrealizedPnl(lots: Lot[], markPrice: number): number {
  return roundToCents(
    heldLots(lots).reduce((sum, lot) => sum + (markPrice - lot.fillPrice) * lot.quantity, 0),
  );
}

/**
 * The average-cost exit level, available as a config option but **not the
 * default** (`PRD.md:159`).
 *
 * Provided for completeness so switching is configuration rather than a
 * rewrite. It closes the entire position at one level, which is exactly what
 * per-lot exits exist to avoid: in a choppy range it forfeits the repeated
 * upper-rung cycling that generates realized gains while lower rungs hold.
 *
 * Returns null when flat.
 */
export function averageCostExitLevel(lots: Lot[], takeProfitPercent: number): number | null {
  const average = blendedAverageCost(lots);

  if (average === null) {
    return null;
  }

  return roundToCents(average * (1 + takeProfitPercent));
}
