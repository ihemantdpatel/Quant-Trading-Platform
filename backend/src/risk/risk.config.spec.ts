import {
  buildRiskConfig,
  DEFAULT_RISK_CONFIG,
  GLOBAL_CAPITAL_CAP_FRACTION,
  globalCapitalCap,
  LossBasis,
} from './risk.config';

/**
 * The two open PRD items (`PRD.md:500`) must stay unset through Story 5. A
 * numeric default here would be the silent default the PRD forbids — it would
 * look configured and size real orders off a figure nobody chose.
 */
describe('the deliberately unset defaults', () => {
  it('leaves the daily loss threshold unset', () => {
    expect(DEFAULT_RISK_CONFIG.dailyLossThreshold).toBeNull();
    expect(buildRiskConfig().dailyLossThreshold).toBeNull();
  });

  it('leaves per-symbol and per-strategy limits empty', () => {
    expect(buildRiskConfig().perSymbolLimits).toEqual({});
    expect(buildRiskConfig().perStrategyLimits).toEqual({});
  });

  it('defaults live trading to off', () => {
    expect(buildRiskConfig().allowLiveTrading).toBe(false);
  });

  it('defaults the loss basis to realized + unrealized', () => {
    // The `PRD.md:246` tension is resolved at Story 13 by changing this value,
    // not by editing the breaker.
    expect(buildRiskConfig().dailyLossBasis).toBe(LossBasis.REALIZED_AND_UNREALIZED);
  });
});

describe('global cap', () => {
  it('is 60% of equity', () => {
    expect(GLOBAL_CAPITAL_CAP_FRACTION).toBe(0.6);
    expect(globalCapitalCap(buildRiskConfig({ accountEquity: 250_000 }))).toBe(150_000);
  });

  it('is zero when equity is zero', () => {
    expect(globalCapitalCap(buildRiskConfig())).toBe(0);
  });
});

describe('validation', () => {
  it('rejects negative account equity', () => {
    expect(() => buildRiskConfig({ accountEquity: -1 })).toThrow(/accountEquity/);
  });

  it('rejects a non-positive loss threshold — it is a loss magnitude', () => {
    expect(() => buildRiskConfig({ dailyLossThreshold: 0 })).toThrow(/dailyLossThreshold/);
    expect(() => buildRiskConfig({ dailyLossThreshold: -500 })).toThrow(/dailyLossThreshold/);
  });

  it('accepts a positive loss threshold', () => {
    expect(buildRiskConfig({ dailyLossThreshold: 2_000 }).dailyLossThreshold).toBe(2_000);
  });

  it('rejects a non-positive per-symbol limit, naming the symbol', () => {
    expect(() => buildRiskConfig({ perSymbolLimits: { TQQQ: 0 } })).toThrow(/perSymbolLimits.TQQQ/);
  });

  it('rejects a non-positive per-strategy limit, naming the strategy', () => {
    expect(() => buildRiskConfig({ perStrategyLimits: { grid: -1 } })).toThrow(
      /perStrategyLimits.grid/,
    );
  });

  it('accepts zero equity so SHADOW can run before an account is attached', () => {
    expect(() => buildRiskConfig({ accountEquity: 0 })).not.toThrow();
  });
});
