/**
 * Story 13 — the capital decisions and the guard that depends on them.
 *
 * The point of these tests is **not** that PAPER now boots. It is that the
 * startup assertion still refuses to boot when either open item is removed. A
 * guard that passes because it was disabled looks identical to a guard that
 * passes because the values are set, and only one of those is safe.
 */

import { ExecutionMode } from './execution-mode';
import {
  PAPER_ACCOUNT_CURRENCY,
  PAPER_ACCOUNT_EQUITY,
  PAPER_DAILY_LOSS_BASIS,
  PAPER_DAILY_LOSS_THRESHOLD,
  PAPER_SYMBOL_CAPITAL,
} from './capital.config';
import { buildRiskConfig, globalCapitalCap, LossBasis, RiskConfig } from '../risk/risk.config';
import { evaluateStartupAssertions, SymbolCapital } from '../risk/startup-assertions';
import { DEFAULT_DIP_LADDER_CONFIG, buildDipLadderConfig } from '../strategies/dip-ladder/config';
import { rungQuantity } from '../strategies/dip-ladder/ladder';
import {
  DIP_LADDER_CURRENCY,
  DIP_LADDER_SYMBOL,
  ladderCapital,
} from '../strategies/strategies.module';

/** The PAPER risk config exactly as `risk.module.ts` builds it. */
function paperRiskConfig(overrides: Partial<RiskConfig> = {}): RiskConfig {
  return buildRiskConfig({
    accountEquity: PAPER_ACCOUNT_EQUITY,
    accountCurrency: PAPER_ACCOUNT_CURRENCY,
    dailyLossThreshold: PAPER_DAILY_LOSS_THRESHOLD,
    dailyLossBasis: PAPER_DAILY_LOSS_BASIS,
    perSymbolLimits: PAPER_SYMBOL_CAPITAL,
    ...overrides,
  });
}

const paperSymbolCapital: SymbolCapital = {
  [DIP_LADDER_SYMBOL]: PAPER_SYMBOL_CAPITAL[DIP_LADDER_SYMBOL],
};

describe('Story 13 capital configuration', () => {
  it('keys the allocation by the symbol the ladder actually trades', () => {
    // The literal key in capital.config.ts exists to break an import cycle.
    // This is what stops it drifting from DIP_LADDER_SYMBOL unnoticed.
    expect(PAPER_SYMBOL_CAPITAL[DIP_LADDER_SYMBOL]).toBeDefined();
    expect(PAPER_SYMBOL_CAPITAL[DIP_LADDER_SYMBOL]).toBeGreaterThan(0);
  });

  it('resolves the PRD.md:252 tension on the basis that can actually fire', () => {
    // REALIZED-only can never fire on this strategy: lots close solely in
    // profit. Pinning the basis makes a silent change to it a test failure.
    expect(PAPER_DAILY_LOSS_BASIS).toBe(LossBasis.REALIZED_AND_UNREALIZED);
  });

  it('sizes a fully-extended ladder to fit under the 60% global cap', () => {
    const allocation = PAPER_SYMBOL_CAPITAL[DIP_LADDER_SYMBOL];
    const { sizePerRung, escalationFactor, maxConcurrentRungs } = DEFAULT_DIP_LADDER_CONFIG;

    // Flat ladder: every rung is the same fraction. Sum the actual escalation
    // series rather than assuming flatness, so turning escalation on fails here
    // rather than at the first deep rung in a live drawdown.
    let deployedFraction = 0;
    for (let depth = 0; depth < maxConcurrentRungs; depth += 1) {
      deployedFraction += sizePerRung * Math.pow(escalationFactor, depth);
    }

    const peakDeployment = allocation * deployedFraction;

    expect(peakDeployment).toBeLessThanOrEqual(globalCapitalCap(paperRiskConfig()));
  });

  it('sets the loss threshold below the account equity it protects', () => {
    expect(PAPER_DAILY_LOSS_THRESHOLD).toBeGreaterThan(0);
    expect(PAPER_DAILY_LOSS_THRESHOLD).toBeLessThan(PAPER_ACCOUNT_EQUITY);
  });

  it('expresses the capital figures in the currency the instrument trades in', () => {
    // The cap compares position notional against equity directly, so these must
    // agree. They are both USD by an operator decision to hand-convert the CAD
    // balance rather than build FX conversion — see capital.config.ts.
    expect(PAPER_ACCOUNT_CURRENCY).toBe('USD');
    expect(PAPER_ACCOUNT_CURRENCY).toBe(DIP_LADDER_CURRENCY);
  });
});

describe('the account/instrument currency check', () => {
  it('permits PAPER because the configured currencies agree', () => {
    const result = evaluateStartupAssertions(
      ExecutionMode.PAPER,
      paperRiskConfig(),
      paperSymbolCapital,
      [DIP_LADDER_CURRENCY],
    );

    expect(result.failures).toEqual([]);
    expect(result.permitted).toBe(true);
  });

  it('refuses PAPER if the account is ever tagged with the real CAD base currency', () => {
    // The account genuinely reports CAD; this configuration states USD and
    // converts by hand. Should someone tag it honestly without adding FX
    // conversion, the cap becomes wrong by the exchange rate — so it must
    // refuse. This is the case that keeps the check load-bearing rather than
    // decorative now that the configured values agree.
    const result = evaluateStartupAssertions(
      ExecutionMode.PAPER,
      paperRiskConfig({ accountCurrency: 'CAD' }),
      paperSymbolCapital,
      [DIP_LADDER_CURRENCY],
    );

    expect(result.permitted).toBe(false);
    expect(result.failures.join('\n')).toContain('denominated in CAD');
  });

  it('refuses PAPER when a non-USD instrument joins the configuration', () => {
    const result = evaluateStartupAssertions(
      ExecutionMode.PAPER,
      paperRiskConfig(),
      paperSymbolCapital,
      [DIP_LADDER_CURRENCY, 'EUR'],
    );

    expect(result.permitted).toBe(false);
    expect(result.failures.join('\n')).toContain('EUR');
  });

  it('asserts nothing when no instrument currency is supplied', () => {
    // The default keeps every pre-existing caller's behaviour. Worth pinning:
    // if this ever started failing closed it would refuse boots that are fine.
    const result = evaluateStartupAssertions(
      ExecutionMode.PAPER,
      paperRiskConfig(),
      paperSymbolCapital,
    );

    expect(result.permitted).toBe(true);
  });

  it('refuses SHADOW outright, whatever its currency', () => {
    // SHADOW is retired (`execution-mode.ts`). It used to be exempt from every
    // check here because it submitted nothing; it is now refused, so the
    // exemption cannot be reached by setting the mode back.
    const result = evaluateStartupAssertions(
      ExecutionMode.SHADOW,
      buildRiskConfig({ accountEquity: 100_000, accountCurrency: 'USD' }),
      { [DIP_LADDER_SYMBOL]: null },
      [DIP_LADDER_CURRENCY],
    );

    expect(result.permitted).toBe(false);
    expect(result.failures.join('\n')).toContain('retired');
  });
});

describe('startup assertions with Story 13 values set', () => {
  it('permits PAPER', () => {
    const result = evaluateStartupAssertions(
      ExecutionMode.PAPER,
      paperRiskConfig(),
      paperSymbolCapital,
    );

    expect(result.failures).toEqual([]);
    expect(result.permitted).toBe(true);
  });

  it('still refuses PAPER when the capital allocation is removed', () => {
    const result = evaluateStartupAssertions(ExecutionMode.PAPER, paperRiskConfig(), {
      [DIP_LADDER_SYMBOL]: null,
    });

    expect(result.permitted).toBe(false);
    expect(result.failures.join('\n')).toContain('per-symbol capital allocation');
  });

  it('still refuses PAPER when the loss threshold is removed', () => {
    const result = evaluateStartupAssertions(
      ExecutionMode.PAPER,
      paperRiskConfig({ dailyLossThreshold: null }),
      paperSymbolCapital,
    );

    expect(result.permitted).toBe(false);
    expect(result.failures.join('\n')).toContain('daily loss threshold');
  });

  it('still refuses PAPER when account equity is zero', () => {
    const result = evaluateStartupAssertions(
      ExecutionMode.PAPER,
      paperRiskConfig({ accountEquity: 0 }),
      paperSymbolCapital,
    );

    expect(result.permitted).toBe(false);
    expect(result.failures.join('\n')).toContain('positive account equity');
  });

  it('still refuses LIVE, which needs the explicit flag beyond these values', () => {
    // Story 13 opens PAPER and must not open LIVE as a side effect.
    const result = evaluateStartupAssertions(
      ExecutionMode.LIVE,
      paperRiskConfig(),
      paperSymbolCapital,
    );

    expect(result.permitted).toBe(false);
  });
});

describe('ladder sizing per mode', () => {
  it('sizes rungs from the real allocation in PAPER', () => {
    const capital = ladderCapital(ExecutionMode.PAPER, DIP_LADDER_SYMBOL);
    expect(capital).toBe(PAPER_SYMBOL_CAPITAL[DIP_LADDER_SYMBOL]);

    const config = buildDipLadderConfig(DIP_LADDER_SYMBOL, { symbolCapital: capital });

    // A zero-quantity intent in a submitting mode is malformed, which is the
    // failure mode a null allocation would have produced.
    expect(rungQuantity(100, 0, config)).toBeGreaterThan(0);
  });

  it('reports null for a symbol with no configured allocation', () => {
    // Must not fall back to another symbol's figure — unset has to stay unset
    // so the assertion still fires.
    expect(ladderCapital(ExecutionMode.PAPER, 'NOT_CONFIGURED')).toBeNull();
  });

  it('sizes from the real allocation regardless of mode', () => {
    // The SHADOW display notional is gone with SHADOW. There is one allocation
    // now, so a rung is sized the same however the engine was started.
    expect(ladderCapital(ExecutionMode.SHADOW, DIP_LADDER_SYMBOL)).toBe(
      PAPER_SYMBOL_CAPITAL[DIP_LADDER_SYMBOL],
    );
    expect(ladderCapital(ExecutionMode.LIVE, DIP_LADDER_SYMBOL)).toBe(
      PAPER_SYMBOL_CAPITAL[DIP_LADDER_SYMBOL],
    );
  });
});
