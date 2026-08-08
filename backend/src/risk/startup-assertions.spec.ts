import { ExecutionMode } from '../config/execution-mode';
import { buildRiskConfig } from './risk.config';
import {
  assertStartupSafe,
  evaluateStartupAssertions,
  StartupAssertionError,
} from './startup-assertions';

/** A config with both open PRD items resolved — the Story 13 end state. */
const configured = buildRiskConfig({
  accountEquity: 100_000,
  dailyLossThreshold: 2_000,
});

const CAPITAL_SET = { TQQQ: 40_000 };
const CAPITAL_UNSET = { TQQQ: null };

describe('SHADOW boots with both open items unresolved', () => {
  it('permits SHADOW with capital and loss threshold unset', () => {
    // This is what lets Stories 0–12 proceed before either decision is made.
    const result = evaluateStartupAssertions(
      ExecutionMode.SHADOW,
      buildRiskConfig(),
      CAPITAL_UNSET,
    );

    expect(result.permitted).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('permits SHADOW with no symbols configured at all', () => {
    expect(evaluateStartupAssertions(ExecutionMode.SHADOW, buildRiskConfig(), {}).permitted).toBe(
      true,
    );
  });

  it('defaults symbolCapital to empty when the argument is omitted', () => {
    expect(evaluateStartupAssertions(ExecutionMode.SHADOW, buildRiskConfig()).permitted).toBe(true);
    // The same omission is a refusal in PAPER — an empty map is itself a failure.
    expect(evaluateStartupAssertions(ExecutionMode.PAPER, buildRiskConfig()).permitted).toBe(false);
  });
});

describe('PAPER is refused while the open PRD items are unset', () => {
  it('refuses PAPER while per-symbol capital is unset', () => {
    const result = evaluateStartupAssertions(ExecutionMode.PAPER, configured, CAPITAL_UNSET);

    expect(result.permitted).toBe(false);
    expect(result.failures.join('\n')).toContain('per-symbol capital allocation');
    expect(result.failures.join('\n')).toContain('TQQQ');
  });

  it('refuses PAPER while the daily loss threshold is unset', () => {
    const noThreshold = buildRiskConfig({ accountEquity: 100_000 });
    const result = evaluateStartupAssertions(ExecutionMode.PAPER, noThreshold, CAPITAL_SET);

    expect(result.permitted).toBe(false);
    expect(result.failures.join('\n')).toContain('daily loss threshold');
  });

  it('refuses PAPER when no symbol is configured', () => {
    const result = evaluateStartupAssertions(ExecutionMode.PAPER, configured, {});

    expect(result.permitted).toBe(false);
    expect(result.failures.join('\n')).toContain('at least one symbol');
  });

  it('refuses PAPER with a non-positive account equity', () => {
    const noEquity = buildRiskConfig({ dailyLossThreshold: 2_000 });
    const result = evaluateStartupAssertions(ExecutionMode.PAPER, noEquity, CAPITAL_SET);

    expect(result.failures.join('\n')).toContain('account equity');
  });

  it('reports every failure at once rather than stopping at the first', () => {
    // An operator enabling PAPER should learn about both unset values in one
    // run, not fix one and rediscover the other after a restart.
    const result = evaluateStartupAssertions(ExecutionMode.PAPER, buildRiskConfig(), CAPITAL_UNSET);

    expect(result.failures.length).toBeGreaterThanOrEqual(3);
  });

  it('permits PAPER once both values are set', () => {
    const result = evaluateStartupAssertions(ExecutionMode.PAPER, configured, CAPITAL_SET);

    expect(result.permitted).toBe(true);
    expect(result.failures).toEqual([]);
  });
});

describe('LIVE additionally requires the explicit flag', () => {
  it('refuses LIVE without the flag even when every value is set', () => {
    const result = evaluateStartupAssertions(ExecutionMode.LIVE, configured, CAPITAL_SET);

    expect(result.permitted).toBe(false);
    expect(result.failures.join('\n')).toContain('allowLiveTrading');
  });

  it('permits LIVE with the flag and both values set', () => {
    const live = buildRiskConfig({
      accountEquity: 100_000,
      dailyLossThreshold: 2_000,
      allowLiveTrading: true,
    });

    expect(evaluateStartupAssertions(ExecutionMode.LIVE, live, CAPITAL_SET).permitted).toBe(true);
  });

  it('refuses LIVE for the flag even in SHADOW-clean configs', () => {
    // The guard runs before the parameter checks, so an absent flag is a
    // refusal regardless of what else happens to be configured.
    const result = evaluateStartupAssertions(ExecutionMode.LIVE, buildRiskConfig(), {});

    expect(result.failures[0]).toContain('allowLiveTrading');
  });
});

describe('assertStartupSafe', () => {
  it('throws StartupAssertionError listing every failure', () => {
    expect(() => assertStartupSafe(ExecutionMode.PAPER, buildRiskConfig(), CAPITAL_UNSET)).toThrow(
      StartupAssertionError,
    );

    try {
      assertStartupSafe(ExecutionMode.PAPER, buildRiskConfig(), CAPITAL_UNSET);
      fail('expected StartupAssertionError');
    } catch (error) {
      const assertion = error as StartupAssertionError;
      expect(assertion.name).toBe('StartupAssertionError');
      expect(assertion.failures.length).toBeGreaterThanOrEqual(3);
      expect(assertion.message).toContain('Refusing to start');
    }
  });

  it('does not throw in SHADOW with nothing configured', () => {
    expect(() => assertStartupSafe(ExecutionMode.SHADOW, buildRiskConfig())).not.toThrow();
  });

  it('does not throw once PAPER is properly configured', () => {
    expect(() => assertStartupSafe(ExecutionMode.PAPER, configured, CAPITAL_SET)).not.toThrow();
  });
});
