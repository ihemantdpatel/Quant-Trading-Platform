import { Lot, heldLots, oldestHeldLotAtRung } from './lot';

/**
 * Per-lot take-profit evaluation.
 *
 * Three rules, all load-bearing (`PRD.md:127`):
 *
 * 1. Each lot exits when **that lot** reaches **its own** stored target,
 *    measured from its own fill price — never from the blended average.
 * 2. When a rung's target is hit, the **oldest** lot at that rung is the one
 *    sold (FIFO).
 * 3. **Lots only ever exit in profit.** There is no per-lot stop and no
 *    loss-booking exit. A lot below its target simply continues to be held.
 *
 * Rule 3 is structural here, not a convention: the only condition that produces
 * an exit is `close >= lot.exitTarget`, and the target is always above the fill
 * price. There is no branch that can emit an exit below the fill, which is what
 * makes "no code path books a loss to adjust basis" checkable rather than
 * merely documented.
 */

/** Sell side. Exits are the only place the ladder emits a sell. */
export type ExitSide = 'SELL';

export interface ExitIntent {
  symbol: string;
  side: ExitSide;
  quantity: number;
  /** Limit at the lot's own target. */
  limitPrice: number;
  /** The lot being disposed. */
  lotId: string;
  /** The rung that will re-arm once this fills. */
  rungPrice: number;
  /** Bar OPEN timestamp of the bar whose close triggered the exit. */
  timestamp: string;
  reason: string;
}

/** True when a held lot has reached its own stored target. */
export function hasReachedTarget(lot: Lot, close: number): boolean {
  return close >= lot.exitTarget;
}

/**
 * Realized profit for a completed lot cycle, in currency.
 *
 * Always positive by construction, because a lot can only exit at or above its
 * target and the target sits above the fill.
 */
export function realizedPnl(lot: Lot, exitPrice: number): number {
  return roundToCents((exitPrice - lot.fillPrice) * lot.quantity);
}

function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Selects the single lot to dispose on this bar, or null.
 *
 * At most one exit per bar, mirroring the one-entry-per-bar firing rule, so
 * each rung makes at most one decision per evaluation and the resulting
 * intents map one-to-one onto orders.
 *
 * When several rungs are simultaneously at target — a fast recovery lifts price
 * through every level at once — the **highest-priced** rung is disposed first.
 * Two reasons:
 *
 * - `PRD.md:131` states the intent directly: "Lower lots keep running when
 *   higher lots exit." Disposing the deepest lot first would invert that.
 * - The upper rung is the one that re-arms into the range and cycles again. In
 *   chop, that is where the repeated realized gains come from, while the lower
 *   lots are meant to ride the drawdown to their own targets.
 *
 * Within a rung the choice is strictly FIFO — the oldest lot at that rung is
 * sold (`PRD.md:134`) — which is what `oldestHeldLotAtRung` enforces.
 */
export function selectExit(
  lots: Lot[],
  close: number,
  barTimestamp: string,
  symbol: string,
): ExitIntent | null {
  const rungPrices = [...new Set(heldLots(lots).map((lot) => lot.rungPrice))].sort((a, b) => b - a);

  for (const rungPrice of rungPrices) {
    // FIFO: only the oldest lot at this rung is a disposal candidate. A newer
    // lot that happens to be in profit does not jump the queue.
    const candidate = oldestHeldLotAtRung(lots, rungPrice);

    if (candidate && hasReachedTarget(candidate, close)) {
      return {
        symbol,
        side: 'SELL',
        quantity: candidate.quantity,
        limitPrice: candidate.exitTarget,
        lotId: candidate.id,
        rungPrice: candidate.rungPrice,
        timestamp: barTimestamp,
        reason:
          `lot ${candidate.id} at rung ${candidate.rungPrice.toFixed(2)} reached its target ` +
          `${candidate.exitTarget.toFixed(2)} from fill ${candidate.fillPrice.toFixed(2)} ` +
          `(close ${close.toFixed(2)})`,
      };
    }
  }

  return null;
}
