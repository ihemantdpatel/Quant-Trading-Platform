import { evaluateLossBreaker, measuredPnl, FLAT_PNL } from './loss-breaker';
import { buildRiskConfig, LossBasis } from './risk.config';

describe('measuredPnl', () => {
  const pnl = { realized: -100, unrealized: -900 };

  it('counts realized only under the REALIZED basis', () => {
    expect(measuredPnl(pnl, LossBasis.REALIZED)).toBe(-100);
  });

  it('sums both under the REALIZED_AND_UNREALIZED basis', () => {
    expect(measuredPnl(pnl, LossBasis.REALIZED_AND_UNREALIZED)).toBe(-1_000);
  });
});

describe('daily loss breaker', () => {
  const config = buildRiskConfig({ accountEquity: 100_000, dailyLossThreshold: 2_000 });

  it('does not halt while the loss is inside the threshold', () => {
    const verdict = evaluateLossBreaker({ realized: -500, unrealized: -1_000 }, config);

    expect(verdict.halted).toBe(false);
    expect(verdict.measured).toBe(-1_500);
  });

  it('halts on breach and reports the figures', () => {
    const verdict = evaluateLossBreaker({ realized: -500, unrealized: -2_000 }, config);

    expect(verdict.halted).toBe(true);
    expect(verdict.detail).toContain('2500.00');
    expect(verdict.detail).toContain('holding all positions');
  });

  it('halts when the loss lands exactly on the threshold', () => {
    // At the limit is the limit reached — rounding permissively would make the
    // threshold approximate.
    const verdict = evaluateLossBreaker({ realized: -2_000, unrealized: 0 }, config);

    expect(verdict.halted).toBe(true);
  });

  it('never halts on a profitable day', () => {
    const verdict = evaluateLossBreaker({ realized: 5_000, unrealized: 3_000 }, config);

    expect(verdict.halted).toBe(false);
    expect(verdict.measured).toBe(8_000);
  });

  it('ignores unrealized drawdown under the REALIZED basis', () => {
    // The ladder is designed to sit in unrealized loss; on this basis that
    // alone must not trip the breaker.
    const realizedOnly = buildRiskConfig({
      dailyLossThreshold: 2_000,
      dailyLossBasis: LossBasis.REALIZED,
    });

    const verdict = evaluateLossBreaker({ realized: 0, unrealized: -50_000 }, realizedOnly);

    expect(verdict.halted).toBe(false);
  });
});

/**
 * `null` means "not yet decided" (`PRD.md:505`), not "zero tolerance".
 * Permissive is safe here only because the startup assertion refuses to reach
 * PAPER/LIVE while it stays unset — see `startup-assertions.spec.ts`.
 */
describe('unset threshold', () => {
  const unset = buildRiskConfig({ accountEquity: 100_000 });

  it('never halts, however large the loss', () => {
    const verdict = evaluateLossBreaker({ realized: -1_000_000, unrealized: -1_000_000 }, unset);

    expect(verdict.halted).toBe(false);
    expect(verdict.detail).toContain('unset');
  });

  it('reports the measured figure even while inactive', () => {
    expect(evaluateLossBreaker(FLAT_PNL, unset).measured).toBe(0);
  });
});

/**
 * The breaker halts new submission and **does not liquidate** (`PRD.md:251`).
 * This is structural: `BreakerVerdict` has no field that could express a sell.
 */
describe('the breaker never liquidates', () => {
  it('produces no intent of any kind on breach', () => {
    const config = buildRiskConfig({ dailyLossThreshold: 100 });
    const verdict = evaluateLossBreaker({ realized: -5_000, unrealized: 0 }, config);

    expect(verdict.halted).toBe(true);
    expect(Object.keys(verdict).sort()).toEqual(['detail', 'halted', 'measured']);
    expect(JSON.stringify(verdict)).not.toMatch(/sell|liquidat/i);
  });
});
