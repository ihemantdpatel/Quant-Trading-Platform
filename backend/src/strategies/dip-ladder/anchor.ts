import { DipLadderConfig } from './config';
import { HeldLot } from './types';

/**
 * Anchor computation — the price the next rung is measured down from.
 *
 * Two regimes (`PRD.md:63`):
 *
 * - **Bootstrap** (flat): `max(previous session close, today's open)`, except
 *   on a gap down beyond `gapRebasePercent`, which re-bases to the open.
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
 * Bootstrap anchor: normally the higher of the previous session close and
 * today's open.
 *
 * Taking the *maximum* is what handles both ordinary gap cases with one rule:
 *
 * - Gap down that persists — the open is lower, so the previous close wins and
 *   the first rung sits a full spacing unit below *it*. The system waits rather
 *   than treating the gap as "almost there" (`PRD.md:67`).
 * - Gap down that recovers — price trades back above the previous close, and
 *   because the anchor never sat below it, no stale anchor is stranded below
 *   the market (`PRD.md:72`).
 *
 * `previousClose` is null on the very first session ever seen, where the open
 * is the only information available.
 *
 * **`gapRebasePercent` is the deliberate exception to the max rule**, and it
 * exists because "wait rather than chase" degrades into "never trade" once the
 * gap is large relative to the rung spacing. Anchoring at the previous close
 * puts the first rung a spacing unit below a level price has already left
 * behind: under RESTING placement that rung is above the market, so
 * `isRestable` refuses it and the ladder places **nothing at all** until price
 * climbs back. At the live fixed-dollar geometry that is acute — $1 rungs
 * against a 3% TQQQ gap of roughly $2 means the ladder sits idle for as long as
 * the gap holds, which is precisely the drawdown it exists to work.
 *
 * So beyond a configured threshold the anchor re-bases to the gapped-down open,
 * putting rungs at levels the market can actually reach. This is a change of
 * *where the levels sit*, not of how they are ordered: entries remain resting
 * limit orders below the market, and no path here produces a market order or
 * chases price upward.
 *
 * Deliberately **one-directional**. A gap *up* re-bases already, because the
 * open is the higher of the two and the max rule selects it — no threshold is
 * involved and none is wanted. This clause fires only on a gap down, where the
 * max rule is what strands the anchor.
 */
export function bootstrapAnchor(
  previousClose: number | null,
  todayOpen: number,
  config?: Pick<DipLadderConfig, 'gapRebasePercent'>,
): number {
  if (previousClose === null) {
    return todayOpen;
  }

  if (isRebasableGap(previousClose, todayOpen, config)) {
    return todayOpen;
  }

  return Math.max(previousClose, todayOpen);
}

/**
 * True when the session opened far enough below the previous close to re-base
 * the anchor onto the open.
 *
 * Separate from `bootstrapAnchor` so the condition can be asserted directly and
 * reported on: "the anchor re-based because the session gapped 3.2% down" is a
 * fact an operator reading a soak report needs, and it is not recoverable from
 * the resulting price alone.
 *
 * Returns false when `gapRebasePercent` is null — the default — so every
 * committed fixture keeps the max rule its expected rung prices were computed
 * under. Guards a non-positive `previousClose` because the gap is a ratio
 * against it, and a division by zero would silently read as "no gap".
 */
export function isRebasableGap(
  previousClose: number | null,
  todayOpen: number,
  config?: Pick<DipLadderConfig, 'gapRebasePercent'>,
): boolean {
  const threshold = config?.gapRebasePercent ?? null;

  if (threshold === null || previousClose === null || previousClose <= 0) {
    return false;
  }

  // Negative for a gap down, which is the only direction this rule acts on.
  const gap = (todayOpen - previousClose) / previousClose;

  return gap <= -threshold;
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
 *
 * **Gap re-basing is therefore a bootstrap-only rule**, and that follows from
 * the same reasoning rather than being a separate decision: a ladder holding
 * lots through a gap-down open must keep extending below its existing exposure.
 * Re-basing onto the open there would place the next rung above lots already
 * held, breaking the invariant that the ladder descends.
 */
export function resolveAnchor(
  heldLots: HeldLot[],
  previousClose: number | null,
  todayOpen: number,
  config?: Pick<DipLadderConfig, 'gapRebasePercent'>,
): AnchorResult {
  const lowestHeld = lowestHeldLotPrice(heldLots);

  if (lowestHeld !== null) {
    return { price: lowestHeld, basis: AnchorBasis.PROGRESSION };
  }

  return {
    price: bootstrapAnchor(previousClose, todayOpen, config),
    basis: AnchorBasis.BOOTSTRAP,
  };
}
