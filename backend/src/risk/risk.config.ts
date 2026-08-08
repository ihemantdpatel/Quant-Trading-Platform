/**
 * Risk parameters.
 *
 * Two values here are `null` **on purpose** and Story 5 is explicitly forbidden
 * from setting them (`stories.md:343`, `PRD.md:500`): the per-symbol capital
 * allocation and the daily loss threshold. Story 13 sets them, once a backtest
 * exists to inform the decision. A numeric default would be precisely the
 * silent default the PRD forbids — it would look configured, boot into `PAPER`,
 * and size real orders off a figure nobody chose.
 *
 * `startup-assertions.ts` is the enforcement: unset is fine in `SHADOW` and
 * fatal in `PAPER`/`LIVE`.
 */

/**
 * The global cap, as a fraction of account equity (`PRD.md:243`).
 *
 * This is the one control a per-symbol limit cannot provide. Five rungs on one
 * symbol is fine; five rungs on eight symbols is what actually happens in a
 * broad selloff, because that is when everything dips together — correlation
 * goes to 1 in a crisis. Not configurable to a higher value by accident: it is
 * a named constant rather than an env var default.
 */
export const GLOBAL_CAPITAL_CAP_FRACTION = 0.6;

export enum LossBasis {
  /**
   * Realized losses only. Never trips on the scenario that actually matters —
   * a ladder deep in unrealized drawdown has realized nothing.
   */
  REALIZED = 'REALIZED',
  /**
   * Realized + unrealized, which is what `PRD.md:246` describes. Trips during
   * normal operation if set tightly, because a dip-buying ladder is *designed*
   * to sit in unrealized loss.
   */
  REALIZED_AND_UNREALIZED = 'REALIZED_AND_UNREALIZED',
}

export interface RiskConfig {
  /**
   * Account equity the global cap is measured against.
   *
   * Supplied by the broker at Story 6+; configured here so the arithmetic is
   * testable and so SHADOW replay has a figure to reason about.
   */
  accountEquity: number;

  /**
   * Per-symbol notional ceiling, keyed by symbol. A symbol absent from the map
   * is unconstrained by *this* control — the global cap still binds.
   *
   * Deliberately empty by default. This is the `PRD.md:503` open item.
   */
  perSymbolLimits: Record<string, number>;

  /** Per-strategy notional ceiling, keyed by strategy id. Same semantics. */
  perStrategyLimits: Record<string, number>;

  /**
   * Currency loss at which the breaker halts all strategies, as a positive
   * number. **Deliberately unset** (`PRD.md:505`).
   */
  dailyLossThreshold: number | null;

  /**
   * Which P&L the threshold is measured against. Recorded as config so the
   * Story 13 decision is a value change rather than a code change; the
   * `PRD.md:246` tension is resolved there, not here.
   */
  dailyLossBasis: LossBasis;

  /**
   * The explicit flag `LIVE` requires (`PRD.md:259`). False is the only safe
   * default and is never overridden implicitly.
   */
  allowLiveTrading: boolean;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  accountEquity: 0,
  perSymbolLimits: {},
  perStrategyLimits: {},
  dailyLossThreshold: null,
  dailyLossBasis: LossBasis.REALIZED_AND_UNREALIZED,
  allowLiveTrading: false,
};

/**
 * Builds a risk config from partial overrides, validating eagerly.
 *
 * Throws rather than clamping. A negative equity or a negative loss threshold
 * is a configuration mistake, and silently coercing it would produce a cap that
 * looks enforced and is not.
 */
export function buildRiskConfig(overrides: Partial<RiskConfig> = {}): RiskConfig {
  const config: RiskConfig = { ...DEFAULT_RISK_CONFIG, ...overrides };

  if (config.accountEquity < 0) {
    throw new Error(`accountEquity must not be negative, got ${config.accountEquity}`);
  }

  if (config.dailyLossThreshold !== null && config.dailyLossThreshold <= 0) {
    throw new Error(
      `dailyLossThreshold is a positive loss magnitude when set, got ${config.dailyLossThreshold}`,
    );
  }

  for (const [symbol, limit] of Object.entries(config.perSymbolLimits)) {
    if (limit <= 0) {
      throw new Error(`perSymbolLimits.${symbol} must be positive, got ${limit}`);
    }
  }

  for (const [strategyId, limit] of Object.entries(config.perStrategyLimits)) {
    if (limit <= 0) {
      throw new Error(`perStrategyLimits.${strategyId} must be positive, got ${limit}`);
    }
  }

  return config;
}

/** The absolute notional ceiling across all strategies: 60% of equity. */
export function globalCapitalCap(config: RiskConfig): number {
  return Math.round(config.accountEquity * GLOBAL_CAPITAL_CAP_FRACTION * 100) / 100;
}
