/**
 * Capital limits: the global 60% cap plus per-symbol and per-strategy ceilings.
 *
 * **The global cap is the control that matters most** (`PRD.md:243`). Five rungs
 * on one symbol is fine; five rungs on eight symbols simultaneously is what
 * actually happens in a broad selloff, because that is when everything dips
 * together. Per-symbol limits give a false sense of bounded risk precisely
 * because correlation goes to 1 in a crisis — every per-symbol limit can be
 * satisfied while the account is fully committed.
 *
 * **Sells are never capped.** A capital control that can block an exit is a
 * bug, not a safeguard: it would strand a lot that reached its target and turn
 * a risk limit into a reason to hold losing exposure. Every function here
 * short-circuits on `SELL`.
 *
 * The three limits are independent. An intent must satisfy all of them, and the
 * binding one is the smallest — reported by name so a log line says which
 * ceiling was hit.
 */

import { globalCapitalCap, RiskConfig } from './risk.config';
import { intentNotional, RiskIntent, RiskReason, roundToCents } from './types';

/**
 * Capital currently committed, as the cap sees it.
 *
 * Supplied by the caller rather than computed here so this module stays pure:
 * Story 6 sources it from the position repository, the tests supply it
 * directly. Notional at cost, not at market — the cap governs how much capital
 * was *deployed*, and marking to market would loosen the cap in a rally and
 * tighten it in a selloff, which is exactly backwards.
 */
export interface DeployedCapital {
  /** Total across every strategy and symbol. */
  total: number;
  /** Committed per symbol. Absent key means zero. */
  bySymbol: Record<string, number>;
  /** Committed per strategy. Absent key means zero. */
  byStrategy: Record<string, number>;
}

export const NO_CAPITAL_DEPLOYED: DeployedCapital = {
  total: 0,
  bySymbol: {},
  byStrategy: {},
};

/** One ceiling and how much of it is already consumed. */
interface Ceiling {
  reason: RiskReason;
  limit: number;
  used: number;
  label: string;
}

/**
 * The headroom check for one intent against all applicable ceilings.
 *
 * `headroom` is the smallest remaining capacity across every ceiling, floored
 * at zero. `binding` names which ceiling produced it — null when nothing
 * constrains the intent.
 */
export interface CapitalHeadroom {
  headroom: number;
  binding: Ceiling | null;
}

function ceilingsFor(intent: RiskIntent, config: RiskConfig, deployed: DeployedCapital): Ceiling[] {
  const ceilings: Ceiling[] = [
    {
      reason: RiskReason.GLOBAL_CAPITAL_CAP,
      limit: globalCapitalCap(config),
      used: deployed.total,
      label: `global cap 60% of equity ${config.accountEquity.toFixed(2)}`,
    },
  ];

  const symbolLimit = config.perSymbolLimits[intent.symbol];

  if (symbolLimit !== undefined) {
    ceilings.push({
      reason: RiskReason.PER_SYMBOL_LIMIT,
      limit: symbolLimit,
      used: deployed.bySymbol[intent.symbol] ?? 0,
      label: `per-symbol limit for ${intent.symbol}`,
    });
  }

  const strategyLimit = config.perStrategyLimits[intent.strategyId];

  if (strategyLimit !== undefined) {
    ceilings.push({
      reason: RiskReason.PER_STRATEGY_LIMIT,
      limit: strategyLimit,
      used: deployed.byStrategy[intent.strategyId] ?? 0,
      label: `per-strategy limit for ${intent.strategyId}`,
    });
  }

  return ceilings;
}

/**
 * Remaining capacity for this intent, and which ceiling binds.
 *
 * Ties go to the ceiling checked first — global, then symbol, then strategy —
 * so the most important control is the one named in the log when several bind
 * at once.
 */
export function capitalHeadroom(
  intent: RiskIntent,
  config: RiskConfig,
  deployed: DeployedCapital,
): CapitalHeadroom {
  let headroom = Number.POSITIVE_INFINITY;
  let binding: Ceiling | null = null;

  for (const ceiling of ceilingsFor(intent, config, deployed)) {
    const remaining = roundToCents(Math.max(0, ceiling.limit - ceiling.used));

    if (remaining < headroom) {
      headroom = remaining;
      binding = ceiling;
    }
  }

  return { headroom, binding };
}

export interface CapitalVerdict {
  /**
   * Shares permitted: the full request when it fits, a floored smaller figure
   * when it partly fits, zero when nothing fits.
   */
  approvedQuantity: number;
  reason: RiskReason;
  detail: string;
}

/**
 * Applies the capital ceilings to one intent.
 *
 * Resizing floors to whole shares rather than rounding, for the same reason
 * `rungQuantity` does: rounding up would commit more capital than the ceiling
 * permits, and at the boundary that is the exact case the cap exists to
 * prevent. A request that floors to zero is a rejection — there is no
 * zero-share order to submit.
 */
export function applyCapitalCap(
  intent: RiskIntent,
  config: RiskConfig,
  deployed: DeployedCapital,
): CapitalVerdict {
  // Exits are exempt. See the file comment — blocking a sell would strand a lot
  // that reached its target.
  if (intent.side === 'SELL') {
    return {
      approvedQuantity: intent.quantity,
      reason: RiskReason.EXIT_EXEMPT,
      detail: 'sell intents are not subject to capital limits',
    };
  }

  const requested = intentNotional(intent);
  const { headroom, binding } = capitalHeadroom(intent, config, deployed);

  if (requested <= headroom) {
    return {
      approvedQuantity: intent.quantity,
      reason: RiskReason.WITHIN_LIMITS,
      detail:
        `notional ${requested.toFixed(2)} within remaining headroom ` + `${headroom.toFixed(2)}`,
    };
  }

  // `binding` is non-null whenever headroom is finite, and headroom is always
  // finite here: the global ceiling is unconditional, so there is always at
  // least one.
  const ceiling = binding!;
  const affordable = Math.floor(headroom / intent.limitPrice);

  if (affordable <= 0) {
    return {
      approvedQuantity: 0,
      reason: ceiling.reason,
      detail:
        `${ceiling.label} exhausted: ${ceiling.used.toFixed(2)} of ` +
        `${ceiling.limit.toFixed(2)} deployed, no capacity for ` +
        `${intent.quantity} shares at ${intent.limitPrice.toFixed(2)}`,
    };
  }

  return {
    approvedQuantity: affordable,
    reason: ceiling.reason,
    detail:
      `${ceiling.label} binds: resized ${intent.quantity} → ${affordable} shares ` +
      `at ${intent.limitPrice.toFixed(2)} to fit remaining headroom ${headroom.toFixed(2)} ` +
      `(${ceiling.used.toFixed(2)} of ${ceiling.limit.toFixed(2)} deployed)`,
  };
}

/**
 * Folds an approved intent into a `DeployedCapital` snapshot.
 *
 * Non-mutating. Lets a caller evaluate a batch of intents against a running
 * total — five rungs firing on one bar must not each be measured against the
 * same starting headroom, which is how eight symbols would each pass a check
 * that they collectively fail.
 */
export function withIntentDeployed(
  deployed: DeployedCapital,
  intent: RiskIntent,
  quantity: number,
): DeployedCapital {
  const notional = roundToCents(quantity * intent.limitPrice);
  // A sell releases capital; a buy commits it.
  const delta = intent.side === 'SELL' ? -notional : notional;

  return {
    total: roundToCents(Math.max(0, deployed.total + delta)),
    bySymbol: {
      ...deployed.bySymbol,
      [intent.symbol]: roundToCents(Math.max(0, (deployed.bySymbol[intent.symbol] ?? 0) + delta)),
    },
    byStrategy: {
      ...deployed.byStrategy,
      [intent.strategyId]: roundToCents(
        Math.max(0, (deployed.byStrategy[intent.strategyId] ?? 0) + delta),
      ),
    },
  };
}
