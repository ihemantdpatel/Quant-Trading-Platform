import {
  applyCapitalCap,
  capitalHeadroom,
  DeployedCapital,
  NO_CAPITAL_DEPLOYED,
  withIntentDeployed,
} from './capital-cap';
import { buildRiskConfig, globalCapitalCap } from './risk.config';
import { RiskIntent, RiskReason } from './types';

function intent(overrides: Partial<RiskIntent> = {}): RiskIntent {
  return {
    strategyId: 'dip-ladder',
    symbol: 'TQQQ',
    side: 'BUY',
    quantity: 100,
    limitPrice: 50,
    timestamp: '2026-03-02T10:00:00-05:00',
    reason: 'rung fired',
    ...overrides,
  };
}

function deployed(overrides: Partial<DeployedCapital> = {}): DeployedCapital {
  return { ...NO_CAPITAL_DEPLOYED, ...overrides };
}

describe('global capital cap', () => {
  const config = buildRiskConfig({ accountEquity: 100_000 });

  it('caps at 60% of account equity', () => {
    expect(globalCapitalCap(config)).toBe(60_000);
  });

  it('approves an intent comfortably under the cap', () => {
    // 100 × 50 = 5,000 against 60,000 of headroom.
    const verdict = applyCapitalCap(intent(), config, NO_CAPITAL_DEPLOYED);

    expect(verdict.approvedQuantity).toBe(100);
    expect(verdict.reason).toBe(RiskReason.WITHIN_LIMITS);
  });

  it('approves an intent landing exactly on the cap', () => {
    // 55,000 already deployed leaves exactly 5,000 — the requested notional.
    const verdict = applyCapitalCap(intent(), config, deployed({ total: 55_000 }));

    expect(verdict.approvedQuantity).toBe(100);
    expect(verdict.reason).toBe(RiskReason.WITHIN_LIMITS);
  });

  it('resizes at the boundary rather than rejecting outright', () => {
    // 57,500 deployed leaves 2,500 → 50 shares at 50, not the requested 100.
    const verdict = applyCapitalCap(intent(), config, deployed({ total: 57_500 }));

    expect(verdict.approvedQuantity).toBe(50);
    expect(verdict.reason).toBe(RiskReason.GLOBAL_CAPITAL_CAP);
    expect(verdict.detail).toContain('resized 100 → 50');
  });

  it('floors a resize to whole shares, never rounding up past the cap', () => {
    // 2,530 of headroom at 50/share is 50.6 shares. Rounding up would deploy
    // 2,550 — past the cap the control exists to enforce.
    const verdict = applyCapitalCap(intent(), config, deployed({ total: 57_470 }));

    expect(verdict.approvedQuantity).toBe(50);
    expect(verdict.approvedQuantity * 50).toBeLessThanOrEqual(2_530);
  });

  it('rejects when the cap is fully consumed', () => {
    const verdict = applyCapitalCap(intent(), config, deployed({ total: 60_000 }));

    expect(verdict.approvedQuantity).toBe(0);
    expect(verdict.reason).toBe(RiskReason.GLOBAL_CAPITAL_CAP);
    expect(verdict.detail).toContain('exhausted');
  });

  it('rejects when deployed capital already exceeds the cap', () => {
    // Headroom floors at zero rather than going negative and wrapping into an
    // apparently-affordable share count.
    const verdict = applyCapitalCap(intent(), config, deployed({ total: 75_000 }));

    expect(verdict.approvedQuantity).toBe(0);
    expect(capitalHeadroom(intent(), config, deployed({ total: 75_000 })).headroom).toBe(0);
  });

  it('rejects when a single share does not fit in the headroom', () => {
    // 30 of headroom cannot buy one 50-share.
    const verdict = applyCapitalCap(intent(), config, deployed({ total: 59_970 }));

    expect(verdict.approvedQuantity).toBe(0);
  });
});

/**
 * The broad-selloff case at `PRD.md:243` — the reason the global cap exists and
 * the one thing a per-symbol limit provably cannot catch.
 */
describe('the broad-selloff case', () => {
  const config = buildRiskConfig({ accountEquity: 100_000 });

  it('approves five rungs on one symbol', () => {
    // Five rungs at 25% of a 40,000 symbol allocation = 10,000 each... sized
    // here directly as 5 × 2,000 = 10,000 total, well within 60,000.
    let running = NO_CAPITAL_DEPLOYED;
    const approvals: number[] = [];

    for (let rung = 0; rung < 5; rung += 1) {
      const candidate = intent({ quantity: 40, limitPrice: 50 });
      const verdict = applyCapitalCap(candidate, config, running);
      approvals.push(verdict.approvedQuantity);
      running = withIntentDeployed(running, candidate, verdict.approvedQuantity);
    }

    expect(approvals).toEqual([40, 40, 40, 40, 40]);
    expect(running.total).toBe(10_000);
  });

  it('rejects the same five rungs once they span eight symbols', () => {
    // Correlation goes to 1: every symbol dips together, each individually
    // reasonable, collectively far past 60% of equity.
    const symbols = ['TQQQ', 'SOXL', 'SPXL', 'TNA', 'UPRO', 'FAS', 'LABU', 'TECL'];
    let running = NO_CAPITAL_DEPLOYED;
    let rejected = 0;
    let resized = 0;

    for (const symbol of symbols) {
      for (let rung = 0; rung < 5; rung += 1) {
        // 5 rungs × 8 symbols × 2,000 = 80,000 requested against a 60,000 cap.
        const candidate = intent({ symbol, quantity: 40, limitPrice: 50 });
        const verdict = applyCapitalCap(candidate, config, running);

        if (verdict.approvedQuantity === 0) {
          rejected += 1;
        } else if (verdict.approvedQuantity < candidate.quantity) {
          resized += 1;
        }

        running = withIntentDeployed(running, candidate, verdict.approvedQuantity);
      }
    }

    expect(rejected).toBeGreaterThan(0);
    // The cap is the binding constraint, and it is never breached.
    expect(running.total).toBeLessThanOrEqual(60_000);
    expect(rejected + resized).toBe(10);
  });
});

describe('per-symbol and per-strategy limits', () => {
  it('rejects on the per-symbol limit independently of the global cap', () => {
    // Global headroom is ample; the symbol ceiling is what binds.
    const config = buildRiskConfig({
      accountEquity: 1_000_000,
      perSymbolLimits: { TQQQ: 5_000 },
    });

    const verdict = applyCapitalCap(
      intent(),
      config,
      deployed({ total: 0, bySymbol: { TQQQ: 5_000 } }),
    );

    expect(verdict.approvedQuantity).toBe(0);
    expect(verdict.reason).toBe(RiskReason.PER_SYMBOL_LIMIT);
  });

  it('rejects on the per-strategy limit independently of the global cap', () => {
    const config = buildRiskConfig({
      accountEquity: 1_000_000,
      perStrategyLimits: { 'dip-ladder': 4_000 },
    });

    const verdict = applyCapitalCap(
      intent(),
      config,
      deployed({ byStrategy: { 'dip-ladder': 4_000 } }),
    );

    expect(verdict.approvedQuantity).toBe(0);
    expect(verdict.reason).toBe(RiskReason.PER_STRATEGY_LIMIT);
  });

  it('leaves a symbol absent from the limits map constrained only by the global cap', () => {
    const config = buildRiskConfig({
      accountEquity: 100_000,
      perSymbolLimits: { SOXL: 1_000 },
    });

    const verdict = applyCapitalCap(intent({ symbol: 'TQQQ' }), config, NO_CAPITAL_DEPLOYED);

    expect(verdict.approvedQuantity).toBe(100);
  });

  it('reports the smallest binding ceiling when several apply', () => {
    const config = buildRiskConfig({
      accountEquity: 100_000,
      perSymbolLimits: { TQQQ: 3_000 },
      perStrategyLimits: { 'dip-ladder': 1_000 },
    });

    const { binding } = capitalHeadroom(intent(), config, NO_CAPITAL_DEPLOYED);

    expect(binding?.reason).toBe(RiskReason.PER_STRATEGY_LIMIT);
    expect(binding?.limit).toBe(1_000);
  });

  it('resizes to the tightest ceiling, not the global one', () => {
    const config = buildRiskConfig({
      accountEquity: 100_000,
      perSymbolLimits: { TQQQ: 1_500 },
    });

    const verdict = applyCapitalCap(intent(), config, NO_CAPITAL_DEPLOYED);

    expect(verdict.approvedQuantity).toBe(30);
    expect(verdict.reason).toBe(RiskReason.PER_SYMBOL_LIMIT);
  });
});

/**
 * A capital control that can block an exit is a bug — it would strand a lot
 * that reached its target and turn a risk limit into a reason to keep exposure.
 */
describe('exits are exempt from capital limits', () => {
  const config = buildRiskConfig({
    accountEquity: 100_000,
    perSymbolLimits: { TQQQ: 1 },
    perStrategyLimits: { 'dip-ladder': 1 },
  });

  it('approves a sell in full even with every ceiling exhausted', () => {
    const verdict = applyCapitalCap(
      intent({ side: 'SELL' }),
      config,
      deployed({
        total: 999_999,
        bySymbol: { TQQQ: 999_999 },
        byStrategy: { 'dip-ladder': 999_999 },
      }),
    );

    expect(verdict.approvedQuantity).toBe(100);
    expect(verdict.reason).toBe(RiskReason.EXIT_EXEMPT);
  });
});

describe('withIntentDeployed', () => {
  it('adds a buy to every bucket', () => {
    const result = withIntentDeployed(NO_CAPITAL_DEPLOYED, intent(), 100);

    expect(result.total).toBe(5_000);
    expect(result.bySymbol.TQQQ).toBe(5_000);
    expect(result.byStrategy['dip-ladder']).toBe(5_000);
  });

  it('releases capital on a sell', () => {
    const held = withIntentDeployed(NO_CAPITAL_DEPLOYED, intent(), 100);
    const result = withIntentDeployed(held, intent({ side: 'SELL' }), 100);

    expect(result.total).toBe(0);
    expect(result.bySymbol.TQQQ).toBe(0);
  });

  it('floors at zero rather than going negative on an oversized sell', () => {
    const result = withIntentDeployed(NO_CAPITAL_DEPLOYED, intent({ side: 'SELL' }), 100);

    expect(result.total).toBe(0);
    expect(result.bySymbol.TQQQ).toBe(0);
  });

  it('does not mutate the input snapshot', () => {
    const before = withIntentDeployed(NO_CAPITAL_DEPLOYED, intent(), 10);
    const beforeTotal = before.total;

    withIntentDeployed(before, intent(), 10);

    expect(before.total).toBe(beforeTotal);
  });

  it('keeps buckets separate across symbols and strategies', () => {
    let running = withIntentDeployed(NO_CAPITAL_DEPLOYED, intent(), 100);
    running = withIntentDeployed(
      running,
      intent({ symbol: 'SOXL', strategyId: 'grid', quantity: 20 }),
      20,
    );

    expect(running.total).toBe(6_000);
    expect(running.bySymbol.TQQQ).toBe(5_000);
    expect(running.bySymbol.SOXL).toBe(1_000);
    expect(running.byStrategy['dip-ladder']).toBe(5_000);
    expect(running.byStrategy.grid).toBe(1_000);
  });
});
