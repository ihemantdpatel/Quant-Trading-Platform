/**
 * Dip-ladder domain types.
 *
 * These are deliberately local to the ladder and deliberately narrow. Story 2
 * owns the shared plugin vocabulary — `Strategy`, `StrategyContext`,
 * `StrategyState`, `OrderIntent`, `Contract` — and has not been built yet. The
 * types here cover exactly what the Story 3 rung mathematics needs and nothing
 * more, so that when Story 2 lands the retrofit is a mapping at the boundary
 * rather than a rewrite of the ladder internals.
 *
 * Two constraints are honoured now so they do not have to be retrofitted:
 * every type is a plain serializable object (no class instances, no `Date`),
 * because `StrategyState` is the durable recovery unit; and nothing here reads
 * a clock or performs I/O.
 */

/** Buy only. The ladder never emits a sell — see `invalidation.ts`. */
export type IntentSide = 'BUY';

/**
 * An intent to open a lot at a rung.
 *
 * Story 2's `OrderIntent` supersedes this. The field names are chosen to match
 * what that type will carry (symbol, side, quantity, limit price) so the
 * eventual mapping is mechanical.
 */
export interface EntryIntent {
  symbol: string;
  side: IntentSide;
  /** Whole shares. Fractional quantities are not submittable to IB. */
  quantity: number;
  /** The rung price. The intent is a limit at the rung, not a market order. */
  limitPrice: number;
  /** Bar OPEN timestamp of the bar whose close triggered this intent, ISO-8601 ET. */
  timestamp: string;
  /** Why this fired — carried through to the risk log and the dashboard. */
  reason: string;
}

/**
 * A lot the ladder currently holds, as the anchor and invalidation limits see
 * it.
 *
 * The full entity — exit target, FIFO ordering, open/closed status — lives in
 * `lot.ts`. This narrower view is what the *entry* path reads, and `Lot`
 * structurally satisfies it, so entry logic never has to know about exits.
 */
export interface HeldLot {
  /** The price level of the rung this lot occupies. */
  rungPrice: number;
  /** Actual fill price. May differ from `rungPrice` once real fills exist. */
  fillPrice: number;
  quantity: number;
  /** ISO-8601 ET. `lot.ts` uses this for FIFO disposal ordering. */
  openedAt: string;
}

/**
 * Everything the ladder needs to decide whether a bar fires a rung.
 *
 * Passed in whole on every evaluation rather than held as mutable internal
 * state, which is what keeps the firing decision a pure function of
 * (bar, position, config) and therefore trivially testable.
 */
export interface LadderPosition {
  /**
   * The rung ledger — every level this ladder has established, held or empty.
   *
   * Stored rather than derived. A re-armed rung is empty but must keep its
   * *original* price, so there is no held lot to recompute it from; the ledger
   * is the only record of where that level was. This is also what survives a
   * restart in Story 8, so re-arming is not lost on recovery.
   */
  rungs: LadderRung[];
  /** Lots currently held, in no guaranteed order. */
  heldLots: HeldLot[];
  /**
   * Fill price of the very first entry of the current ladder cycle, which is
   * what the 25% hard floor is measured from. `null` when flat — the floor
   * cannot bind before there is a first entry.
   *
   * Deliberately *not* derived from `heldLots`: the first entry may already
   * have exited, and the floor must still be measured from where the ladder
   * actually started, not from whatever remains held.
   */
  firstEntryPrice: number | null;
}

/**
 * The rung shape the entry path reads. `rung.ts` owns the full entity with its
 * status enum and cycle counters; `Rung` structurally satisfies this.
 *
 * `lotId` doubles as the held/empty flag — a rung holding a lot names it, and a
 * pending or re-armed rung is null. `lastExitAt` carries the same-bar re-fire
 * guard, so the entry path can enforce it without importing rung status.
 */
export interface LadderRung {
  price: number;
  lotId: string | null;
  /**
   * `clientOrderId` of an order resting at this level, or null.
   *
   * Optional so callers predating resting orders — the replay harness and the
   * ladder's own tests — satisfy this view unchanged; absent reads as "no
   * resting order". Where it *is* set, the entry path must treat the rung as
   * occupied even though `lotId` is still null, which is the one thing
   * `lotId`-as-held/empty-flag cannot express on its own.
   */
  workingOrderId?: string | null;
  /** Bar timestamp of the most recent exit here, or null if never exited. */
  lastExitAt: string | null;
}
