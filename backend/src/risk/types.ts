/**
 * The risk layer's vocabulary.
 *
 * `RiskIntent` is deliberately declared here rather than imported from the dip
 * ladder. The risk manager sits *above* every strategy and must not depend on
 * any one of them — importing `dip-ladder/types.ts` would invert the dependency
 * and make the chokepoint ladder-specific. Story 2's shared `OrderIntent`
 * supersedes this type; the field names match what `EntryIntent` and
 * `ExitIntent` already carry (symbol, side, quantity, limitPrice, timestamp,
 * reason) so that mapping is mechanical, exactly as the ladder types planned.
 *
 * Every type here is plain and serializable — `RiskEvent` becomes a persisted
 * row at Story 8.
 */

/**
 * Both sides, unlike the ladder's entry path.
 *
 * The risk manager sees exits too, because it is the *only* path to the broker
 * (`PRD.md:237`) and a sell that bypassed it would be a bypass of the
 * chokepoint. The controls treat the sides asymmetrically — see `capital-cap.ts`.
 */
export type RiskSide = 'BUY' | 'SELL';

/** An intent as the risk manager receives it, from any strategy. */
export interface RiskIntent {
  /**
   * Which strategy emitted this. Required, because per-strategy allocation
   * limits cannot be enforced without it and the global cap has to attribute
   * deployed capital somewhere.
   */
  strategyId: string;
  symbol: string;
  side: RiskSide;
  /** Whole shares. Fractional quantities are not submittable to IB. */
  quantity: number;
  limitPrice: number;
  /** ISO-8601 ET, the bar timestamp that produced this intent. */
  timestamp: string;
  /** The strategy's own reason, carried through to the risk log. */
  reason: string;
}

export enum RiskOutcome {
  APPROVED = 'APPROVED',
  RESIZED = 'RESIZED',
  REJECTED = 'REJECTED',
}

/**
 * Why an intent was resized or rejected.
 *
 * Every outcome carries one of these (`stories.md:328` — "with a reason on
 * every outcome"), so no rejection is ever silent and the dashboard can explain
 * itself without re-deriving the decision.
 */
export enum RiskReason {
  /** Passed every control unchanged. */
  WITHIN_LIMITS = 'WITHIN_LIMITS',
  /** Exits are never capped — see `capital-cap.ts`. */
  EXIT_EXEMPT = 'EXIT_EXEMPT',
  /** Total deployed capital across all strategies would exceed 60% of equity. */
  GLOBAL_CAPITAL_CAP = 'GLOBAL_CAPITAL_CAP',
  PER_SYMBOL_LIMIT = 'PER_SYMBOL_LIMIT',
  PER_STRATEGY_LIMIT = 'PER_STRATEGY_LIMIT',
  /** Daily loss circuit breaker has halted all strategies. */
  DAILY_LOSS_HALT = 'DAILY_LOSS_HALT',
  /** Kill switch is engaged. */
  KILL_SWITCH = 'KILL_SWITCH',
  /** Quantity floored to zero — nothing left to submit after resizing. */
  ZERO_QUANTITY = 'ZERO_QUANTITY',
  /** Malformed intent: non-positive quantity or price. */
  INVALID_INTENT = 'INVALID_INTENT',
}

/**
 * The decision. `Resized` carries `approvedQuantity` strictly between zero and
 * the requested quantity — a resize to zero is a rejection and is reported as
 * one, so no caller has to defend against a zero-share order.
 */
export interface RiskDecision {
  outcome: RiskOutcome;
  reason: RiskReason;
  /** Human-readable detail naming the numbers that produced this outcome. */
  detail: string;
  /** The intent as submitted, unchanged. */
  intent: RiskIntent;
  /**
   * Shares actually permitted: equal to `intent.quantity` when approved,
   * strictly less when resized, zero when rejected.
   */
  approvedQuantity: number;
}

export function isApproved(decision: RiskDecision): boolean {
  return decision.outcome === RiskOutcome.APPROVED;
}

/** True when any shares at all may be submitted. */
export function isSubmittable(decision: RiskDecision): boolean {
  return decision.approvedQuantity > 0;
}

/**
 * Notional capital an intent commits: shares × limit price.
 *
 * The limit price is the right figure rather than the last trade, because a
 * limit order can never fill above it — this is the worst case, and a capital
 * cap has to be enforced against the worst case.
 */
export function intentNotional(intent: Pick<RiskIntent, 'quantity' | 'limitPrice'>): number {
  return roundToCents(intent.quantity * intent.limitPrice);
}

export function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}
