/**
 * `GridLot` — the durable unit of the grid strategy.
 *
 * Deliberately **not** imported from `dip-ladder/lot.ts`, even though the
 * shapes are similar. Keeping this independent is what lets the grid
 * strategy be added, tested, and eventually enabled without any change to
 * the dip ladder's own lot type or the code that depends on it.
 *
 * There is no `rungPrice` field here — unlike the ladder, a grid lot is not
 * tied to a persisted price-level ledger. Its only durable facts are what it
 * paid, how many shares, when, and the sell target frozen at that moment.
 */

export enum GridLotStatus {
  HELD = 'HELD',
  CLOSED = 'CLOSED',
}

export interface GridLot {
  /** Stable identity, unique within this grid instance. */
  id: string;
  /** What this lot actually paid. The only basis for its sell target. */
  fillPrice: number;
  quantity: number;
  /** ISO-8601 ET. The FIFO sort key. */
  openedAt: string;
  /**
   * The price this lot sells at, frozen at open from the `gap` in force at
   * that moment.
   *
   * Stored rather than recomputed, mirroring `Lot.exitTarget` in the dip
   * ladder: a later runtime edit to `gap` must leave every held lot's target
   * untouched, and freezing it here makes that true by construction rather
   * than by a guard that could be bypassed.
   */
  sellTarget: number;
  status: GridLotStatus;
  /** ISO-8601 ET, set when the lot closes. Null while held. */
  closedAt: string | null;
  /** Actual exit price. Null while held. */
  exitPrice: number | null;
  /**
   * The resting SELL placed against this lot, or null when none is working.
   *
   * The grid-strategy counterpart to `Lot.workingOrderId` — what stops the
   * recompute placing a second sell against shares one order already covers.
   */
  workingOrderId: string | null;
}

function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A lot's sell target: its own fill price plus the fixed-dollar gap. */
export function sellTargetFor(fillPrice: number, gap: number): number {
  return roundToCents(fillPrice + gap);
}

export interface OpenGridLotParams {
  id: string;
  fillPrice: number;
  quantity: number;
  openedAt: string;
  gap: number;
}

/** Creates a held lot with its sell target frozen at the current gap. */
export function openGridLot(params: OpenGridLotParams): GridLot {
  return {
    id: params.id,
    fillPrice: params.fillPrice,
    quantity: params.quantity,
    openedAt: params.openedAt,
    sellTarget: sellTargetFor(params.fillPrice, params.gap),
    status: GridLotStatus.HELD,
    closedAt: null,
    exitPrice: null,
    workingOrderId: null,
  };
}

/**
 * Returns a closed copy of a lot. Does not mutate the input — the caller
 * controls when state changes, keeping the evaluation path pure.
 */
export function closeGridLot(lot: GridLot, exitPrice: number, closedAt: string): GridLot {
  return { ...lot, status: GridLotStatus.CLOSED, exitPrice, closedAt, workingOrderId: null };
}

/**
 * Splits a partially-sold lot into the portion that filled and the portion
 * still held — the same reasoning as `splitLot` in the dip ladder: shrinking
 * in place would change a lot's composition after open and leave nowhere to
 * record profit already taken. `sold.quantity + remainder.quantity ==
 * lot.quantity` always holds, so held quantities still sum to the broker's
 * net position.
 */
export function splitGridLot(
  lot: GridLot,
  filledQuantity: number,
  exitPrice: number,
  closedAt: string,
  remainderId: string,
): { sold: GridLot; remainder: GridLot } {
  return {
    sold: closeGridLot({ ...lot, quantity: filledQuantity }, exitPrice, closedAt),
    remainder: {
      ...lot,
      id: remainderId,
      quantity: lot.quantity - filledQuantity,
      workingOrderId: null,
    },
  };
}

export function isHeld(lot: GridLot): boolean {
  return lot.status === GridLotStatus.HELD;
}

/**
 * Any lots, oldest first — the FIFO ordering rule. Ties on `openedAt` break
 * by `id` so the ordering is total and stable, matching `fifoQueue` in the
 * dip ladder for the same reason: two lots can share a timestamp when a bar
 * fills more than one level.
 */
export function fifoQueue(lots: GridLot[]): GridLot[] {
  return [...lots].sort((a, b) =>
    a.openedAt === b.openedAt ? compare(a.id, b.id) : compare(a.openedAt, b.openedAt),
  );
}

function compare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function heldGridLots(lots: GridLot[]): GridLot[] {
  return lots.filter(isHeld);
}
