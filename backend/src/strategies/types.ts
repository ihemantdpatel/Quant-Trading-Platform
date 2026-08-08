/**
 * The shared plugin vocabulary every strategy speaks.
 *
 * Four types, and each exists to make one rule enforceable rather than merely
 * documented:
 *
 * - `Contract` (re-exported from `src/domain/`) models options from day one
 *   (`PRD.md:224`), so retrofitting the Wheel and LEAPs later is not a rewrite.
 * - `OrderIntent` is what a strategy returns and the *only* thing it returns.
 *   It carries no broker handle, no order id, and no submission method — a
 *   strategy that wanted to submit could not express it in this type.
 * - `StrategyState` is the durable recovery unit (`PRD.md:222`) and is
 *   therefore constrained to JSON-serializable shapes. The contract suite
 *   asserts a round trip; the type makes violations hard to write in the first
 *   place.
 * - `StrategyContext` is immutable and deliberately *narrow*. What it omits is
 *   the point: no broker, no repository, no clock.
 */

import { Bar, Tick } from '../market-data/types';
import { Contract } from '../domain/contract';

/**
 * `Contract` and its constructors live in `src/domain/` so the broker layer can
 * use them without importing from `strategies/` (`architecture.spec.ts`).
 * Re-exported here because strategies are their primary producer and this
 * remains the natural import site for plugin authors.
 */
export {
  type Contract,
  type OptionContractParams,
  SecurityType,
  OptionRight,
  equityContract,
  optionContract,
  isOptionContract,
} from '../domain/contract';

/**
 * JSON-representable values. `StrategyState` is constrained to these so a
 * `Date`, a `Map`, or a class instance is a compile error rather than a
 * surprise at the Story 8 persistence boundary or, worse, a silently corrupted
 * recovery after a restart.
 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type IntentSide = 'BUY' | 'SELL';

/**
 * Limit orders only, for now.
 *
 * Declared as an enum rather than assumed, because the ladder's rung prices are
 * meaningless without a limit — a market order at a rung price would fill
 * wherever the book happened to be.
 */
export enum OrderType {
  LIMIT = 'LMT',
  MARKET = 'MKT',
}

export enum TimeInForce {
  DAY = 'DAY',
  GOOD_TIL_CANCELLED = 'GTC',
}

/**
 * What a strategy returns. The complete extent of its authority.
 *
 * This is a *request*, not an order. The risk manager decides whether it
 * becomes one, and may resize or refuse it (`PRD.md:237`). Nothing here can be
 * submitted by the strategy that produced it.
 */
export interface OrderIntent {
  /** Which strategy emitted this — required for per-strategy risk limits. */
  strategyId: string;
  contract: Contract;
  side: IntentSide;
  /** Whole shares/contracts. Fractional quantities are not submittable to IB. */
  quantity: number;
  orderType: OrderType;
  /** Required for `LIMIT`. The rung price, for the dip ladder. */
  limitPrice: number;
  timeInForce: TimeInForce;
  /** ISO-8601 ET — the bar timestamp that produced this, never a clock read. */
  timestamp: string;
  /** The strategy's own reasoning, carried to the risk log and the dashboard. */
  reason: string;
  /**
   * Strategy-specific correlation data — the dip ladder puts its lot id here so
   * a fill can be matched back to the lot it closes.
   *
   * Constrained to JSON values for the same reason `StrategyState` is: this
   * field is persisted at Story 8 and must survive the round trip.
   */
  metadata?: Record<string, JsonValue>;
}

/**
 * A strategy's durable state — the unit that survives a restart
 * (`PRD.md:222`).
 *
 * `data` is deliberately opaque to the coordinator. Each plugin owns its own
 * shape, and the coordinator persists and restores it without interpreting it,
 * so adding a strategy never requires a coordinator change.
 */
export interface StrategyState {
  strategyId: string;
  /**
   * Schema version for `data`. Story 8 persists snapshots and needs to reject
   * or migrate an older shape rather than silently loading a state whose fields
   * have moved (`stories.md:495`).
   */
  version: number;
  /** Symbols this instance is responsible for. */
  symbols: string[];
  data: Record<string, JsonValue>;
}

/**
 * The immutable context a strategy is given.
 *
 * **What this type omits is its entire purpose.** There is no broker, no
 * repository, no clock, no logger with side effects. A strategy cannot perform
 * I/O because it is handed nothing capable of it (`PRD.md:204`).
 *
 * `now` is a value passed *in* rather than a function a strategy calls, so
 * replay, backtest, and live all produce identical decisions for identical
 * bars — the property `stories.md:660` relies on to prove the strategy cannot
 * tell which broker exists.
 */
export interface StrategyContext {
  readonly strategyId: string;
  readonly symbols: readonly string[];
  /** ISO-8601 ET, supplied by the caller. Strategies never read a clock. */
  readonly now: string;
  /** Strategy-specific parameters, frozen for the life of the context. */
  readonly parameters: Readonly<Record<string, JsonValue>>;
  /**
   * Recent bars, oldest first — enough history for indicator calculation (the
   * ladder's ATR-14 spacing, for instance) without a strategy having to fetch
   * anything.
   */
  readonly history: readonly Bar[];
}

/** Convenience alias making `onTick`'s unused-in-Phase-1 status explicit. */
export type { Bar, Tick };
