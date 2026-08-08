import { Logger } from '@nestjs/common';
import { ExecutionMode } from '../config/execution-mode';
import { loadFixture } from '../market-data/mock/fixtures';
import { buildDipLadderConfig } from '../strategies/dip-ladder/config';
import { replayLadder } from '../strategies/dip-ladder/replay-ladder';
import { KillSwitchService } from './kill-switch.service';
import { RiskManagerService } from './risk-manager.service';
import { InMemoryRiskEventSink, RiskEventType } from './risk-event';
import { buildRiskConfig } from './risk.config';
import { RiskIntent, RiskOutcome } from './types';

/**
 * The chokepoint, end to end: real ladder intents from a replayed fixture,
 * every one of them evaluated by the risk manager.
 *
 * The ladder is Story 3/4 code, unmodified. It emits `EntryIntent`/`ExitIntent`
 * and knows nothing about the risk layer — the mapping below is the boundary
 * Story 2's shared `OrderIntent` eventually replaces, and it is mechanical
 * precisely because both types were designed to line up.
 */

const STRATEGY_ID = 'dip-ladder';

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterAll(() => jest.restoreAllMocks());

/** Replays a fixture and maps every ladder intent onto the risk vocabulary. */
function ladderIntents(fixtureName: string): RiskIntent[] {
  const config = buildDipLadderConfig('TQQQ', { symbolCapital: 40_000 });
  const result = replayLadder(loadFixture(fixtureName).bars, config);

  const entries: RiskIntent[] = result.entries.map((entry) => ({
    strategyId: STRATEGY_ID,
    symbol: entry.symbol,
    side: 'BUY',
    quantity: entry.quantity,
    limitPrice: entry.limitPrice,
    timestamp: entry.timestamp,
    reason: entry.reason,
  }));

  const exits: RiskIntent[] = result.exits.map((exit) => ({
    strategyId: STRATEGY_ID,
    symbol: exit.symbol,
    side: 'SELL',
    quantity: exit.quantity,
    limitPrice: exit.limitPrice,
    timestamp: exit.timestamp,
    reason: exit.reason,
  }));

  return [...entries, ...exits];
}

function harness(equity: number, mode = ExecutionMode.SHADOW) {
  const sink = new InMemoryRiskEventSink();
  const killSwitch = new KillSwitchService(sink);
  const manager = new RiskManagerService(
    buildRiskConfig({ accountEquity: equity }),
    mode,
    killSwitch,
    sink,
  );

  return { manager, sink, killSwitch };
}

describe('ladder intents through the risk manager', () => {
  const intents = ladderIntents('chop-range');

  it('the fixture produces real intents to evaluate', () => {
    // Guards the whole suite against passing vacuously on an empty replay.
    expect(intents.length).toBeGreaterThan(0);
    expect(intents.some((intent) => intent.side === 'BUY')).toBe(true);
  });

  it('approves every intent when equity is ample', () => {
    const { manager, sink } = harness(1_000_000);
    const decisions = manager.evaluateBatch(intents);

    expect(decisions.every((decision) => decision.outcome === RiskOutcome.APPROVED)).toBe(true);
    expect(sink.all()).toEqual([]);
  });

  it('constrains the same intents under a small account', () => {
    // 20,000 equity → a 12,000 cap against a ladder sized for 40,000.
    const { manager } = harness(20_000);
    const decisions = manager.evaluateBatch(intents);

    expect(decisions.some((decision) => decision.outcome !== RiskOutcome.APPROVED)).toBe(true);

    const buyNotional = decisions
      .filter((decision) => decision.intent.side === 'BUY')
      .reduce((sum, d) => sum + d.approvedQuantity * d.intent.limitPrice, 0);

    expect(buyNotional).toBeLessThanOrEqual(12_000);
  });

  it('never blocks an exit, even with the cap fully consumed', () => {
    // A capital control that strands a lot at its target is a bug.
    const { manager } = harness(1);
    const exits = intents.filter((intent) => intent.side === 'SELL');

    expect(exits.length).toBeGreaterThan(0);
    for (const exit of exits) {
      expect(manager.evaluate(exit).outcome).toBe(RiskOutcome.APPROVED);
    }
  });

  it('halts every subsequent intent once the kill switch is engaged', () => {
    const { manager, killSwitch } = harness(1_000_000);

    manager.evaluate(intents[0]);
    killSwitch.engage('operator halt mid-replay', intents[0].timestamp);

    const after = intents.slice(1).map((intent) => manager.evaluate(intent));
    expect(after.every((decision) => decision.outcome === RiskOutcome.REJECTED)).toBe(true);
  });

  it('emits exactly one RiskEvent per non-approved intent', () => {
    const { manager, sink } = harness(20_000);
    const decisions = manager.evaluateBatch(intents);

    const nonApproved = decisions.filter((d) => d.outcome !== RiskOutcome.APPROVED).length;
    const decisionEvents = sink
      .all()
      .filter(
        (event) => event.type === RiskEventType.REJECTION || event.type === RiskEventType.RESIZE,
      );

    expect(decisionEvents).toHaveLength(nonApproved);
    expect(decisionEvents.every((event) => String(event.reason).length > 0)).toBe(true);
  });

  it('submits nothing in SHADOW however clean the intents are', () => {
    const { manager } = harness(1_000_000, ExecutionMode.SHADOW);
    const decisions = manager.evaluateBatch(intents);

    expect(decisions.every((decision) => decision.outcome === RiskOutcome.APPROVED)).toBe(true);
    // Approved is not submitted — SHADOW is the gate, not the decision.
    expect(manager.canSubmit()).toBe(false);
  });

  it('halts the ladder mid-replay when the loss breaker trips', () => {
    const sink = new InMemoryRiskEventSink();
    const manager = new RiskManagerService(
      buildRiskConfig({ accountEquity: 1_000_000, dailyLossThreshold: 1_000 }),
      ExecutionMode.SHADOW,
      new KillSwitchService(sink),
      sink,
    );

    const decisions = intents.map((intent, index) =>
      manager.evaluate(intent, {
        deployed: { total: 0, bySymbol: {}, byStrategy: {} },
        // The drawdown arrives partway through the replay.
        pnl: { realized: 0, unrealized: index < 2 ? 0 : -5_000 },
      }),
    );

    expect(decisions[0].outcome).toBe(RiskOutcome.APPROVED);
    expect(decisions[decisions.length - 1].outcome).toBe(RiskOutcome.REJECTED);
    expect(sink.ofType(RiskEventType.HALT)).toHaveLength(1);
    // Halted, not liquidated: no sell was generated by the breaker.
    expect(sink.ofType(RiskEventType.HALT)[0].intent).toBeNull();
  });
});
