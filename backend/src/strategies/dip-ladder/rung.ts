/**
 * Rung state and re-arming.
 *
 * **Rungs are price levels, not one-shot slots** (`PRD.md:76`). A rung is a
 * price at which at most one lot may be held; when that lot exits at its
 * take-profit the rung is **re-armed at its original price** and may fire
 * again. Repeated cycling in a range is the primary advantage of per-lot exits
 * over a single average-cost exit.
 *
 * This is why rungs are stored rather than recomputed. Story 3 could derive the
 * next rung from the anchor on every bar, because every rung held a lot. Once a
 * rung can be empty *and still exist at its original price*, there is nothing
 * to derive it from — the ledger is the only record of where that level was.
 */

export enum RungStatus {
  /** Holds a lot. May not fire.  */
  HELD = 'HELD',
  /** Fired and exited, restored at its original price. May fire again. */
  RE_ARMED = 'RE_ARMED',
  /** Created by ladder extension, never yet fired. */
  PENDING = 'PENDING',
  /**
   * A limit order is **resting at the broker** at this price, unfilled.
   *
   * The state that makes resting orders possible. Before it, "empty" and
   * "fireable" were the same question — `lotId === null` answered both. A rung
   * whose order is working is empty (no lot yet) but must **not** fire again,
   * or every bar would place another order at the same level.
   *
   * Distinct from `PENDING`, which means "no order exists anywhere". The
   * difference matters on restart: a `WORKING` rung has an order at IB that
   * reconciliation must find and adopt, and a `PENDING` one does not.
   */
  WORKING = 'WORKING',
}

export interface Rung {
  /** The level. Immutable for the life of the rung — this is what re-arming preserves. */
  price: number;
  status: RungStatus;
  /** Id of the lot currently held here, or null. */
  lotId: string | null;
  /**
   * `clientOrderId` of the limit order resting at this price, or null.
   *
   * Set while `WORKING`, cleared on fill, cancel, or expiry. This is the handle
   * the engine cancels by, and the key reconciliation matches IB's open orders
   * against on restart — without it a restart could not tell which rung an
   * existing broker order belongs to, and would place a duplicate.
   */
  workingOrderId: string | null;
  /** How many lots have completed a full cycle at this rung. Display + Story 11 stats. */
  completedCycles: number;
  /**
   * Bar timestamp of the most recent exit at this rung, or null.
   *
   * Guards the same-bar re-fire rule: a rung that exits on a bar may not fire
   * again until a later bar closes. A round trip inside one 5-minute bar is not
   * something real fills would reliably achieve, and allowing it would inflate
   * cycle counts in the chop suite with trades that never happened.
   */
  lastExitAt: string | null;
}

export function createRung(price: number): Rung {
  return {
    price: roundToCents(price),
    status: RungStatus.PENDING,
    lotId: null,
    workingOrderId: null,
    completedCycles: 0,
    lastExitAt: null,
  };
}

/**
 * Marks a rung as having a limit order resting at the broker.
 *
 * The rung is still empty — no lot exists until the order fills — but it is no
 * longer fireable, which is what stops the next bar placing a second order at
 * the same level.
 */
export function markWorking(rung: Rung, clientOrderId: string): Rung {
  return { ...rung, status: RungStatus.WORKING, workingOrderId: clientOrderId };
}

/**
 * Clears a resting order without opening a lot — a cancel, a rejection, or a
 * DAY order that expired at the close.
 *
 * Returns the rung to `RE_ARMED` rather than `PENDING` when it has cycled
 * before, preserving the distinction `completedCycles` records. Either way it
 * becomes fireable again, which is the point: an order that went away without
 * filling must not leave the level permanently blocked.
 */
export function clearWorking(rung: Rung): Rung {
  return {
    ...rung,
    status: rung.completedCycles > 0 ? RungStatus.RE_ARMED : RungStatus.PENDING,
    workingOrderId: null,
  };
}

/** Local copy to avoid a circular import with `spacing.ts`. */
function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Marks a rung as holding a lot. Non-mutating. */
export function markHeld(rung: Rung, lotId: string): Rung {
  // Clears any resting order id: the order that filled is no longer working,
  // and leaving a stale id here would let a later cancel target an order the
  // broker has already completed.
  return { ...rung, status: RungStatus.HELD, lotId, workingOrderId: null };
}

/**
 * Re-arms a rung after its lot exits — **at its original price**, not at the
 * exit price (`PRD.md:78`).
 *
 * `price` is deliberately untouched here. Re-arming at the exit price would
 * walk the ladder's levels upward every cycle, so a range that oscillates
 * around a fixed band would drift out of it and stop cycling.
 */
export function reArm(rung: Rung, exitedAt: string): Rung {
  return {
    ...rung,
    status: RungStatus.RE_ARMED,
    lotId: null,
    workingOrderId: null,
    completedCycles: rung.completedCycles + 1,
    lastExitAt: exitedAt,
  };
}

export function isHeldRung(rung: Rung): boolean {
  return rung.status === RungStatus.HELD;
}

/** True when a limit order is resting at this rung, unfilled. */
export function isWorkingRung(rung: Rung): boolean {
  return rung.status === RungStatus.WORKING;
}

/**
 * True when a rung is empty and therefore eligible to fire.
 *
 * Both `PENDING` and `RE_ARMED` qualify — a re-armed rung is exactly as
 * fireable as one that has never fired, which is what makes the ladder cycle.
 *
 * `WORKING` does **not**, even though it holds no lot. This is the distinction
 * resting orders introduce: the rung is empty but already has an order at the
 * broker, and firing again would place a second one at the same price every
 * bar until one filled.
 */
export function isFireable(rung: Rung): boolean {
  return !isHeldRung(rung) && !isWorkingRung(rung);
}

/**
 * Rungs currently holding a lot. **This is what the 5-concurrent limit counts**
 * (`PRD.md:163`) — re-armed empty rungs do not consume a slot.
 */
export function heldRungs(rungs: Rung[]): Rung[] {
  return rungs.filter(isHeldRung);
}

/** The lowest rung price in the ledger, or null when empty. */
export function lowestRungPrice(rungs: Rung[]): number | null {
  if (rungs.length === 0) {
    return null;
  }

  return rungs.reduce(
    (lowest, rung) => (rung.price < lowest ? rung.price : lowest),
    rungs[0].price,
  );
}

/**
 * Generic over the rung shape so the entry path can call it with the narrow
 * `LadderRung` view while the replay harness passes full `Rung` records.
 */
export function findRung<T extends { price: number }>(rungs: T[], price: number): T | null {
  const target = roundToCents(price);
  return rungs.find((rung) => roundToCents(rung.price) === target) ?? null;
}

/**
 * The highest empty rung with no order resting at it, regardless of where price
 * currently is.
 *
 * The resting-order counterpart to `selectFireableRung`. Price is deliberately
 * not a factor: a resting limit order is placed *above* the market and waits,
 * so requiring the bar to have reached the level first would defeat the point
 * and would strand a released rung whenever price sits above it.
 *
 * Highest, for the same reason `selectFireableRung` picks the highest: the
 * ladder descends one level at a time, so the shallowest unplaced rung is the
 * next commitment.
 */
export function highestFireableRung<
  T extends {
    price: number;
    lotId: string | null;
    workingOrderId?: string | null;
    lastExitAt: string | null;
  },
>(rungs: T[], barTimestamp: string): T | null {
  const candidates = rungs.filter(
    (rung) => rung.lotId === null && !rung.workingOrderId && rung.lastExitAt !== barTimestamp,
  );

  if (candidates.length === 0) {
    return null;
  }

  return candidates.reduce((highest, rung) => (rung.price > highest.price ? rung : highest));
}

/**
 * Selects the rung a bar should fire, or null.
 *
 * The **highest** fireable rung at or above the bar's close, so a bar that
 * gaps through several levels fills the shallowest one first and the ladder
 * descends one rung per bar rather than opening the whole ladder at once on a
 * single fast move. Depth should reflect sustained weakness, not one print.
 *
 * A rung that exited on this same bar is excluded — see `lastExitAt`.
 */
export function selectFireableRung<
  T extends {
    price: number;
    lotId: string | null;
    workingOrderId?: string | null;
    lastExitAt: string | null;
  },
>(rungs: T[], close: number, barTimestamp: string): T | null {
  // Empty is `lotId === null`, which holds for PENDING and RE_ARMED — a
  // re-armed rung is exactly as fireable as one that has never fired.
  //
  // `workingOrderId` must be null too: a rung with an order resting at the
  // broker holds no lot, so the `lotId` test alone would select it again on
  // every bar and stack duplicate orders at one price. Optional in the type
  // because the entry path passes a narrow `LadderRung` view; absent is treated
  // as "no resting order", which is correct for callers that never place them.
  const candidates = rungs.filter(
    (rung) =>
      rung.lotId === null &&
      !rung.workingOrderId &&
      close <= rung.price &&
      rung.lastExitAt !== barTimestamp,
  );

  if (candidates.length === 0) {
    return null;
  }

  return candidates.reduce((highest, rung) => (rung.price > highest.price ? rung : highest));
}
