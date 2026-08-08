import { Logger } from '@nestjs/common';
import { ExecutionMode } from '../config/execution-mode';
import { NO_CAPITAL_DEPLOYED } from './capital-cap';
import { KillSwitchService } from './kill-switch.service';
import { AccountSnapshot, RiskManagerService } from './risk-manager.service';
import { InMemoryRiskEventSink, RiskEventType } from './risk-event';
import { buildRiskConfig, RiskConfig } from './risk.config';
import { RiskIntent, RiskOutcome, RiskReason } from './types';

const AT = '2026-03-02T10:00:00-05:00';

function intent(overrides: Partial<RiskIntent> = {}): RiskIntent {
  return {
    strategyId: 'dip-ladder',
    symbol: 'TQQQ',
    side: 'BUY',
    quantity: 100,
    limitPrice: 50,
    timestamp: AT,
    reason: 'rung fired',
    ...overrides,
  };
}

function account(overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    deployed: NO_CAPITAL_DEPLOYED,
    pnl: { realized: 0, unrealized: 0 },
    ...overrides,
  };
}

interface Harness {
  manager: RiskManagerService;
  sink: InMemoryRiskEventSink;
  killSwitch: KillSwitchService;
}

function harness(config?: Partial<RiskConfig>, mode = ExecutionMode.SHADOW): Harness {
  const sink = new InMemoryRiskEventSink();
  const killSwitch = new KillSwitchService(sink);
  const riskConfig = buildRiskConfig({ accountEquity: 100_000, ...config });

  return {
    manager: new RiskManagerService(riskConfig, mode, killSwitch, sink),
    sink,
    killSwitch,
  };
}

// The manager logs every decision; silence it so the suite output stays readable.
beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterAll(() => jest.restoreAllMocks());

describe('approval path', () => {
  it('approves an intent within every limit', () => {
    const { manager } = harness();
    const decision = manager.evaluate(intent(), account());

    expect(decision.outcome).toBe(RiskOutcome.APPROVED);
    expect(decision.approvedQuantity).toBe(100);
    expect(decision.reason).toBe(RiskReason.WITHIN_LIMITS);
  });

  it('emits no RiskEvent for a clean approval', () => {
    // The order log records what was approved; an event per approval would bury
    // the rejections an operator actually needs to see.
    const { manager, sink } = harness();
    manager.evaluate(intent(), account());

    expect(sink.all()).toEqual([]);
  });

  it('carries a reason on every outcome', () => {
    const { manager } = harness();

    expect(manager.evaluate(intent(), account()).detail).not.toHaveLength(0);
  });
});

describe('intent validation', () => {
  const { manager } = harness();

  it.each([
    ['zero quantity', { quantity: 0 }],
    ['negative quantity', { quantity: -5 }],
    ['NaN quantity', { quantity: Number.NaN }],
    ['zero price', { limitPrice: 0 }],
    ['negative price', { limitPrice: -1 }],
    ['infinite price', { limitPrice: Number.POSITIVE_INFINITY }],
  ])('rejects %s', (_label, overrides) => {
    const decision = manager.evaluate(intent(overrides), account());

    expect(decision.outcome).toBe(RiskOutcome.REJECTED);
    expect(decision.reason).toBe(RiskReason.INVALID_INTENT);
  });
});

describe('kill switch', () => {
  it('halts submission within one evaluation cycle', () => {
    const { manager, killSwitch } = harness();

    expect(manager.evaluate(intent(), account()).outcome).toBe(RiskOutcome.APPROVED);

    killSwitch.engage('operator', AT);

    // The very next intent is already blocked — no queue to drain.
    const after = manager.evaluate(intent(), account());
    expect(after.outcome).toBe(RiskOutcome.REJECTED);
    expect(after.reason).toBe(RiskReason.KILL_SWITCH);
  });

  it('blocks sells too — halting is reversible, an unintended sell is not', () => {
    const { manager, killSwitch } = harness();
    killSwitch.engage('operator', AT);

    expect(manager.evaluate(intent({ side: 'SELL' }), account()).reason).toBe(
      RiskReason.KILL_SWITCH,
    );
  });

  it('outranks a capital rejection in the reported reason', () => {
    const { manager, killSwitch } = harness();
    killSwitch.engage('operator', AT);

    const decision = manager.evaluate(
      intent(),
      account({ deployed: { total: 999_999, bySymbol: {}, byStrategy: {} } }),
    );

    expect(decision.reason).toBe(RiskReason.KILL_SWITCH);
  });

  it('permits submission again after release', () => {
    const { manager, killSwitch } = harness();
    killSwitch.engage('operator', AT);
    killSwitch.release('resolved', AT);

    expect(manager.evaluate(intent(), account()).outcome).toBe(RiskOutcome.APPROVED);
  });

  it('falls back gracefully when the switch reports no recorded reason', () => {
    // A switch restored from persisted state (Story 8) can be engaged with a
    // null reason. The rejection detail must still be readable.
    const sink = new InMemoryRiskEventSink();
    const stub = {
      isEngaged: () => true,
      snapshot: () => ({ engaged: true, reason: null, changedAt: null }),
    } as unknown as KillSwitchService;

    const manager = new RiskManagerService(
      buildRiskConfig({ accountEquity: 100_000 }),
      ExecutionMode.SHADOW,
      stub,
      sink,
    );

    expect(manager.evaluate(intent(), account()).detail).toContain('no reason recorded');
  });

  it('reports canSubmit false while engaged, in a submitting mode', () => {
    const { manager, killSwitch } = harness({}, ExecutionMode.PAPER);

    expect(manager.canSubmit()).toBe(true);
    killSwitch.engage('operator', AT);
    expect(manager.canSubmit()).toBe(false);
  });
});

describe('daily loss breaker', () => {
  const breached = account({ pnl: { realized: -1_000, unrealized: -1_500 } });

  it('halts on breach and emits a HALT RiskEvent', () => {
    const { manager, sink } = harness({ dailyLossThreshold: 2_000 });
    const decision = manager.evaluate(intent(), breached);

    expect(decision.outcome).toBe(RiskOutcome.REJECTED);
    expect(decision.reason).toBe(RiskReason.DAILY_LOSS_HALT);
    expect(sink.ofType(RiskEventType.HALT)).toHaveLength(1);
    expect(manager.isHalted()).toBe(true);
  });

  it('emits the HALT event once, not once per subsequent intent', () => {
    const { manager, sink } = harness({ dailyLossThreshold: 2_000 });

    manager.evaluate(intent(), breached);
    manager.evaluate(intent(), breached);
    manager.evaluate(intent(), breached);

    expect(sink.ofType(RiskEventType.HALT)).toHaveLength(1);
    // Each blocked intent still gets its own rejection event.
    expect(sink.ofType(RiskEventType.REJECTION)).toHaveLength(3);
  });

  it('stays halted after the mark recovers — no flapping', () => {
    const { manager } = harness({ dailyLossThreshold: 2_000 });
    manager.evaluate(intent(), breached);

    const recovered = manager.evaluate(intent(), account());
    expect(recovered.reason).toBe(RiskReason.DAILY_LOSS_HALT);
  });

  it('halts new submission only — no liquidation intent is ever produced', () => {
    const { manager, sink } = harness({ dailyLossThreshold: 2_000 });
    manager.evaluate(intent(), breached);

    // Nothing the breaker produces can express a sell, and the blocked buy is
    // simply refused. Existing positions are held.
    const decisions = sink.all().map((event) => JSON.stringify(event));
    expect(decisions.join(' ')).not.toMatch(/"side":"SELL"/);
    expect(sink.ofType(RiskEventType.HALT)[0].detail.toLowerCase()).toContain(
      'holding all positions',
    );
  });

  it('blocks a sell during a halt without generating one', () => {
    const { manager } = harness({ dailyLossThreshold: 2_000 });
    manager.evaluate(intent(), breached);

    expect(manager.evaluate(intent({ side: 'SELL' }), breached).outcome).toBe(RiskOutcome.REJECTED);
  });

  it('never halts while the threshold is unset', () => {
    const { manager } = harness();
    const catastrophic = account({ pnl: { realized: -500_000, unrealized: -500_000 } });

    expect(manager.evaluate(intent(), catastrophic).outcome).toBe(RiskOutcome.APPROVED);
    expect(manager.isHalted()).toBe(false);
  });

  it('resets only on an explicit operator action, recorded as an event', () => {
    const { manager, sink } = harness({ dailyLossThreshold: 2_000 });
    manager.evaluate(intent(), breached);

    manager.resetBreaker('reviewed by operator', AT);

    expect(manager.isHalted()).toBe(false);
    expect(manager.evaluate(intent(), account()).outcome).toBe(RiskOutcome.APPROVED);
    expect(sink.ofType(RiskEventType.HALT).map((e) => e.reason)).toContain('BREAKER_RESET');
  });
});

describe('capital caps through the manager', () => {
  it('resizes and reports the resize with a reason', () => {
    const { manager } = harness();
    const decision = manager.evaluate(
      intent(),
      account({ deployed: { total: 57_500, bySymbol: {}, byStrategy: {} } }),
    );

    expect(decision.outcome).toBe(RiskOutcome.RESIZED);
    expect(decision.approvedQuantity).toBe(50);
    expect(decision.reason).toBe(RiskReason.GLOBAL_CAPITAL_CAP);
  });

  it('approves sells regardless of deployed capital', () => {
    const { manager } = harness();
    const decision = manager.evaluate(
      intent({ side: 'SELL' }),
      account({ deployed: { total: 999_999, bySymbol: {}, byStrategy: {} } }),
    );

    expect(decision.outcome).toBe(RiskOutcome.APPROVED);
    expect(decision.reason).toBe(RiskReason.EXIT_EXEMPT);
  });
});

describe('evaluateBatch', () => {
  it('measures each intent against a running total, not a stale snapshot', () => {
    // Evaluating independently is exactly how eight symbols each pass a check
    // they collectively fail.
    const { manager } = harness();
    const intents = Array.from({ length: 8 }, (_unused, index) =>
      intent({ symbol: `SYM${index}`, quantity: 200, limitPrice: 50 }),
    );

    const decisions = manager.evaluateBatch(intents, account());
    const approvedNotional = decisions.reduce(
      (sum, decision) => sum + decision.approvedQuantity * decision.intent.limitPrice,
      0,
    );

    // 8 × 200 × 50 = 80,000 requested against a 60,000 cap.
    expect(approvedNotional).toBeLessThanOrEqual(60_000);
    expect(decisions.some((d) => d.outcome !== RiskOutcome.APPROVED)).toBe(true);
  });

  it('returns one decision per intent, in order', () => {
    const { manager } = harness();
    const decisions = manager.evaluateBatch([intent(), intent({ symbol: 'SOXL' })], account());

    expect(decisions).toHaveLength(2);
    expect(decisions[0].intent.symbol).toBe('TQQQ');
    expect(decisions[1].intent.symbol).toBe('SOXL');
  });

  it('does not advance the running total for a rejected intent', () => {
    const { manager } = harness();
    const decisions = manager.evaluateBatch(
      [intent({ quantity: 0 }), intent({ quantity: 100 })],
      account(),
    );

    expect(decisions[0].outcome).toBe(RiskOutcome.REJECTED);
    expect(decisions[1].outcome).toBe(RiskOutcome.APPROVED);
  });
});

/**
 * `PRD.md:268` — in SHADOW, intents are logged with full order payloads and
 * nothing is submitted.
 */
describe('SHADOW mode', () => {
  it('logs the full order payload for an approved intent', () => {
    const logged: string[] = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logged.push(String(message));
    });

    const { manager } = harness({}, ExecutionMode.SHADOW);
    manager.evaluate(intent(), account());

    const line = logged.find((entry) => entry.includes('SHADOW'));
    expect(line).toBeDefined();
    // Field-by-field: every value a broker order needs is present.
    expect(line).toContain('"symbol":"TQQQ"');
    expect(line).toContain('"side":"BUY"');
    expect(line).toContain('"quantity":100');
    expect(line).toContain('"orderType":"LMT"');
    expect(line).toContain('"limitPrice":50');
    expect(line).toContain('"timeInForce":"DAY"');
    expect(line).toContain('"notional":5000');
    expect(line).toContain('"strategyId":"dip-ladder"');
    expect(line).toContain('not submitted');
  });

  it('reports canSubmit false in SHADOW even with everything clear', () => {
    const { manager } = harness({}, ExecutionMode.SHADOW);

    expect(manager.evaluate(intent(), account()).outcome).toBe(RiskOutcome.APPROVED);
    // Approved is not submitted. SHADOW submits nothing, by definition.
    expect(manager.canSubmit()).toBe(false);
  });

  it('reports canSubmit true in PAPER with no halts', () => {
    const { manager } = harness({}, ExecutionMode.PAPER);

    expect(manager.canSubmit()).toBe(true);
  });

  it('labels the log line with the live mode rather than the SHADOW notice', () => {
    const logged: string[] = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logged.push(String(message));
    });

    const { manager } = harness({}, ExecutionMode.PAPER);
    manager.evaluate(intent(), account());

    expect(logged.some((line) => line.startsWith('PAPER APPROVED'))).toBe(true);
    expect(logged.join(' ')).not.toContain('not submitted');
  });
});

/**
 * `stories.md:369` — every rejection, resize, and halt produces exactly one
 * `RiskEvent` carrying a reason.
 */
describe('RiskEvent emission', () => {
  it('emits exactly one event per rejection, with a reason', () => {
    const { manager, sink } = harness();
    manager.evaluate(intent({ quantity: -1 }), account());

    expect(sink.all()).toHaveLength(1);
    expect(sink.all()[0].type).toBe(RiskEventType.REJECTION);
    expect(sink.all()[0].reason).toBe(RiskReason.INVALID_INTENT);
    expect(sink.all()[0].detail).not.toHaveLength(0);
  });

  it('emits exactly one event per resize, carrying the approved quantity', () => {
    const { manager, sink } = harness();
    manager.evaluate(
      intent(),
      account({ deployed: { total: 57_500, bySymbol: {}, byStrategy: {} } }),
    );

    expect(sink.ofType(RiskEventType.RESIZE)).toHaveLength(1);
    expect(sink.ofType(RiskEventType.RESIZE)[0].approvedQuantity).toBe(50);
  });

  it('records the intent on the event so the audit trail is self-contained', () => {
    const { manager, sink } = harness();
    manager.evaluate(intent({ quantity: 0 }), account());

    expect(sink.all()[0].intent?.symbol).toBe('TQQQ');
    expect(sink.all()[0].timestamp).toBe(AT);
  });

  it('emits one event per intent across a batch of rejections', () => {
    const { manager, sink } = harness();
    manager.evaluateBatch([intent({ quantity: 0 }), intent({ limitPrice: 0 })], account());

    expect(sink.ofType(RiskEventType.REJECTION)).toHaveLength(2);
  });
});

describe('defaults', () => {
  it('constructs with its own kill switch and sink when none are supplied', () => {
    const manager = new RiskManagerService(
      buildRiskConfig({ accountEquity: 100_000 }),
      ExecutionMode.SHADOW,
    );

    expect(manager.evaluate(intent()).outcome).toBe(RiskOutcome.APPROVED);
  });
});
