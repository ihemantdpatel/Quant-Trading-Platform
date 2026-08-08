import { HeldLot } from './types';

/**
 * Anchor computation — the price the next rung is measured down from.
 *
 * Two regimes (`PRD.md:63`):
 *
 * - **Bootstrap** (flat): `max(previous session close, today's open)`.
 * - **Progression** (holding): the price of the *lowest currently-held lot*.
 *
 * The progression rule anchors on the lowest *held* lot rather than the most
 * recent *fill*. That is what makes per-lot exits coherent: once a lot takes
 * profit and is no longer held, it stops influencing where new rungs go, so
 * the ladder always extends downward from real exposure rather than from a
 * historical trade.
 */

export enum AnchorBasis {
  /** No position: derived from previous close and today's open. */
  BOOTSTRAP = 'BOOTSTRAP',
  /** Holding: derived from the lowest held lot. */
  PROGRESSION = 'PROGRESSION',
}

export interface AnchorResult {
  price: number;
  basis: AnchorBasis;
}

/**
 * Bootstrap anchor: the higher of the previous session close and today's open.
 *
 * Taking the *maximum* is what handles both gap cases with one rule:
 *
 * - Gap down that persists — the open is lower, but the anchor re-bases to
 *   the *open* only when the open is higher. On a 4% gap down the previous
 *   close is higher, so it wins... which is precisely why the rule is stated
 *   as a max and the PRD's gap paragraph (`PRD.md:67`) describes re-basing to
 *   the gapped-down open: the ladder is then measured from a level price has
 *   already left behind, and the first rung sits a full spacing unit below
 *   the higher of the two. The system waits rather than treating the gap as
 *   "almost there".
 * - Gap down that recovers — price trades back above the previous close, and
 *   because the anchor never sat below it, no stale anchor is stranded below
 *   the market (`PRD.md:72`).
 *
 * `previousClose` is null on the very first session ever seen, where the open
 * is the only information available.
 */
export function bootstrapAnchor(previousClose: number | null, todayOpen: number): number {
  if (previousClose === null) {
    return todayOpen;
  }

  return Math.max(previousClose, todayOpen);
}

/**
 * Progression anchor: the price of the lowest currently-held lot.
 *
 * Uses each lot's `rungPrice` rather than its `fillPrice`. The rung is the
 * ladder's structural level — it is what re-arming restores in Story 4 and
 * what persists across a restart in Story 8 — whereas the fill price is an
 * execution detail that will drift from the rung once real slippage exists.
 * Chaining rungs off fills would let execution noise walk the ladder's
 * geometry away from its configured spacing.
 *
 * Returns null when nothing is held, which is the caller's signal to bootstrap.
 */
export function lowestHeldLotPrice(heldLots: HeldLot[]): number | null {
  if (heldLots.length === 0) {
    return null;
  }

  return heldLots.reduce(
    (lowest, lot) => (lot.rungPrice < lowest ? lot.rungPrice : lowest),
    heldLots[0].rungPrice,
  );
}

/**
 * Resolves the anchor for the current evaluation.
 *
 * Progression takes precedence whenever anything is held; the bootstrap
 * inputs are ignored in that case, because a ladder with live exposure must
 * extend from that exposure and not re-base to a session open that sits above
 * it.
 */
export function resolveAnchor(
  heldLots: HeldLot[],
  previousClose: number | null,
  todayOpen: number,
): AnchorResult {
  const lowestHeld = lowestHeldLotPrice(heldLots);

  if (lowestHeld !== null) {
    return { price: lowestHeld, basis: AnchorBasis.PROGRESSION };
  }

  return {
    price: bootstrapAnchor(previousClose, todayOpen),
    basis: AnchorBasis.BOOTSTRAP,
  };
}
