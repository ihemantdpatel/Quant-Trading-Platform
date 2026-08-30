/**
 * `Lot` — the durable unit of the dip ladder.
 *
 * The accepted cost of per-lot exits (`PRD.md:145`) is that a position is no
 * longer a single object with one cost basis: it is a *set* of lots, each with
 * independent state. This file owns that entity and the FIFO ordering rule.
 *
 * Every field is plain and serializable. Story 8 persists lots individually and
 * Story 9 reconciles their *sum* against IB's net position — IB reports a net
 * figure and knows nothing about lot composition, so these records are the only
 * authoritative source for which lot is which.
 */

export enum LotStatus {
  HELD = 'HELD',
  CLOSED = 'CLOSED',
}

export interface Lot {
  /**
   * Stable identity, unique within a ladder. Needed because two lots can share
   * a rung price across cycles, so price is not an identifier.
   */
  id: string;
  /** The price level of the rung this lot occupies — its re-arm price. */
  rungPrice: number;
  /** What this lot actually paid. The *only* basis for its exit target. */
  fillPrice: number;
  quantity: number;
  /** ISO-8601 ET. The FIFO sort key. */
  openedAt: string;
  /**
   * The price this lot exits at, frozen at open from the parameters in force
   * at that moment.
   *
   * Stored rather than recomputed. Story 7 requires a parameter edit to leave
   * every held lot's target untouched (`PRD.md:386`) — a stored target makes
   * that true by construction, whereas recomputing from current config would
   * silently move a live position into or out of an exit condition.
   */
  exitTarget: number;
  status: LotStatus;
  /** ISO-8601 ET, set when the lot closes. Null while held. */
  closedAt: string | null;
  /** Actual exit price. Null while held. */
  exitPrice: number | null;
  /**
   * The resting SELL placed against this lot, or null when none is working.
   *
   * The durable counterpart to `Rung.workingOrderId`, and load-bearing for the
   * same reason: it is what stops `selectExit` choosing this lot again on the
   * next bar and stacking a second sell against shares one order already
   * covers. The engine's in-memory `workingOrders` map is a cache of the same
   * fact and is rebuilt from here during reconciliation.
   */
  workingOrderId: string | null;
}

/**
 * The exit target for a lot: its own fill price plus the take-profit fraction.
 *
 * Measured from **this lot's fill price**, never from the blended average
 * (`PRD.md:129`). That is the whole point of per-lot exits — in a choppy range
 * upper rungs cycle repeatedly while lower rungs keep holding, which an
 * average-cost exit would forfeit by closing everything at once.
 */
export function exitTargetFor(
  fillPrice: number,
  takeProfitPercent: number,
  takeProfitDollars: number | null = null,
): number {
  // An absolute target supersedes the percentage when set. It is a third
  // parameter defaulting to null rather than a replacement, so every existing
  // caller keeps the percentage rule its expected values were computed under.
  if (takeProfitDollars !== null) {
    return roundToCents(fillPrice + takeProfitDollars);
  }

  return roundToCents(fillPrice * (1 + takeProfitPercent));
}

/** Local copy to avoid a circular import with `spacing.ts`. */
function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface OpenLotParams {
  id: string;
  rungPrice: number;
  fillPrice: number;
  quantity: number;
  openedAt: string;
  takeProfitPercent: number;
  /** Absolute take-profit; supersedes the percentage when set. */
  takeProfitDollars?: number | null;
}

/** Creates a held lot with its exit target frozen at the current parameters. */
export function openLot(params: OpenLotParams): Lot {
  return {
    id: params.id,
    rungPrice: params.rungPrice,
    fillPrice: params.fillPrice,
    quantity: params.quantity,
    openedAt: params.openedAt,
    exitTarget: exitTargetFor(
      params.fillPrice,
      params.takeProfitPercent,
      params.takeProfitDollars ?? null,
    ),
    status: LotStatus.HELD,
    closedAt: null,
    exitPrice: null,
    workingOrderId: null,
  };
}

/**
 * Returns a closed copy of a lot. Does not mutate the input.
 *
 * Non-mutating so the caller controls when state changes, which keeps the
 * evaluation path a pure function and makes the Story 8 persistence boundary a
 * straightforward write of the returned value.
 */
export function closeLot(lot: Lot, exitPrice: number, closedAt: string): Lot {
  // The working order is cleared, not preserved: a closed lot has no resting
  // sell, and leaving the id set would make reconciliation try to adopt an
  // order for a lot that no longer holds anything.
  return { ...lot, status: LotStatus.CLOSED, exitPrice, closedAt, workingOrderId: null };
}

/**
 * Splits a partially-sold lot into the portion that filled and the portion
 * still held.
 *
 * A resting sell that fills 40 of 100 leaves a lot this type cannot otherwise
 * describe — partly realized, partly held. Shrinking the lot in place was
 * rejected: it changes a lot's composition after open, which `PRD.md:386`
 * forbids for the frozen target, and `realizedPnl` multiplies by a lot's whole
 * quantity so there is nowhere to record profit already taken.
 *
 * Splitting produces two *structurally ordinary* lots instead, so every
 * downstream consumer sees something it already understands. The invariant that
 * matters is preserved exactly: `sold.quantity + remainder.quantity ==
 * lot.quantity`, so held quantities still sum to the broker's net position and
 * the lot-sum assertion (`PRD.md:343`) is unaffected.
 *
 * **The remainder keeps the original `openedAt`.** It holds its place in the
 * FIFO queue rather than jumping to the back — `fifoQueueAtRung` breaks ties by
 * `id`, so a fresh id is safe where a fresh timestamp would silently reorder
 * disposals. It also keeps `fillPrice` and `exitTarget`: the shares are the same
 * shares, bought at the same price, and their target was frozen at open.
 *
 * The remainder carries **no working order** — its order filled partially and
 * the rest is cancelled by the caller — so it becomes eligible for a fresh
 * resting sell on the next bar without any further bookkeeping.
 */
export function splitLot(
  lot: Lot,
  filledQuantity: number,
  exitPrice: number,
  closedAt: string,
  remainderId: string,
): { sold: Lot; remainder: Lot } {
  return {
    sold: closeLot({ ...lot, quantity: filledQuantity }, exitPrice, closedAt),
    remainder: {
      ...lot,
      id: remainderId,
      quantity: lot.quantity - filledQuantity,
      workingOrderId: null,
    },
  };
}

export function isHeld(lot: Lot): boolean {
  return lot.status === LotStatus.HELD;
}

/**
 * Held lots at a rung, oldest first — the FIFO disposal order.
 *
 * Ties on `openedAt` break by `id` so the ordering is total and stable. Two
 * lots can share a timestamp when a bar fills more than one rung, and an
 * unstable sort there would make which-lot-sold depend on array order, which
 * is exactly the kind of nondeterminism that cannot be reconciled after a
 * restart.
 */
export function fifoQueueAtRung(lots: Lot[], rungPrice: number): Lot[] {
  const target = roundToCents(rungPrice);

  return lots
    .filter((lot) => isHeld(lot) && roundToCents(lot.rungPrice) === target)
    .sort((a, b) =>
      a.openedAt === b.openedAt ? compare(a.id, b.id) : compare(a.openedAt, b.openedAt),
    );
}

function compare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * The oldest held lot at a rung — the one FIFO disposes when that rung's
 * target is hit (`PRD.md:134`).
 */
export function oldestHeldLotAtRung(lots: Lot[], rungPrice: number): Lot | null {
  return fifoQueueAtRung(lots, rungPrice)[0] ?? null;
}

export function heldLots(lots: Lot[]): Lot[] {
  return lots.filter(isHeld);
}
