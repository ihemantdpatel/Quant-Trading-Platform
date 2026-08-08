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
}

export interface Rung {
  /** The level. Immutable for the life of the rung — this is what re-arming preserves. */
  price: number;
  status: RungStatus;
  /** Id of the lot currently held here, or null. */
  lotId: string | null;
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
    completedCycles: 0,
    lastExitAt: null,
  };
}

/** Local copy to avoid a circular import with `spacing.ts`. */
function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Marks a rung as holding a lot. Non-mutating. */
export function markHeld(rung: Rung, lotId: string): Rung {
  return { ...rung, status: RungStatus.HELD, lotId };
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
    completedCycles: rung.completedCycles + 1,
    lastExitAt: exitedAt,
  };
}

export function isHeldRung(rung: Rung): boolean {
  return rung.status === RungStatus.HELD;
}

/**
 * True when a rung is empty and therefore eligible to fire.
 *
 * Both `PENDING` and `RE_ARMED` qualify — a re-armed rung is exactly as
 * fireable as one that has never fired, which is what makes the ladder cycle.
 */
export function isFireable(rung: Rung): boolean {
  return !isHeldRung(rung);
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
  T extends { price: number; lotId: string | null; lastExitAt: string | null },
>(rungs: T[], close: number, barTimestamp: string): T | null {
  // Empty is `lotId === null`, which holds for both PENDING and RE_ARMED — a
  // re-armed rung is exactly as fireable as one that has never fired.
  const candidates = rungs.filter(
    (rung) => rung.lotId === null && close <= rung.price && rung.lastExitAt !== barTimestamp,
  );

  if (candidates.length === 0) {
    return null;
  }

  return candidates.reduce((highest, rung) => (rung.price > highest.price ? rung : highest));
}
