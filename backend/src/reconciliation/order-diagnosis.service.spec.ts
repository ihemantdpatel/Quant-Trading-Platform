/**
 * Order diagnosis, operator placement, and duplicate resolution.
 *
 * These three controls exist because the ladder and the broker can disagree in
 * ways nothing on the bar path repairs, and the suite is organised around what
 * each one must **refuse** rather than what it does on the happy path:
 *
 * - the diagnosis must not report an unreadable book as an empty one;
 * - placement must not act on an empty book, cross the spread, or bypass risk;
 * - duplicate resolution must not cancel a tracked order or guess at an
 *   ambiguous group.
 *
 * Those refusals are the safety properties. A test that only proved the happy
 * path would report confidence the code has not earned.
 */

import { ExecutionMode } from '../config/execution-mode';
import { OpenOrder } from '../broker/broker-adapter.interface';
import { FillMode, MockBrokerAdapter } from '../broker/mock/mock-broker.adapter';
import { EngineService } from '../engine/engine.service';
import { ReplayService } from '../market-data/mock/replay.service';
import {
  InMemoryFillRepository,
  InMemoryLotRepository,
  InMemoryOrderIntentRepository,
  InMemoryOrderRepository,
  InMemoryRungRepository,
  InMemoryStrategyStateSnapshotRepository,
} from '../repositories/in-memory/in-memory.repositories';
import { InMemoryRiskEventSink } from '../risk/risk-event';
import { KillSwitchService } from '../risk/kill-switch.service';
import { RiskManagerService } from '../risk/risk-manager.service';
import { buildRiskConfig } from '../risk/risk.config';
import { CoordinatorService } from '../strategies/coordinator.service';
import { buildDipLadderConfig, OrderPlacement } from '../strategies/dip-ladder/config';
import { DipLadderStrategy } from '../strategies/dip-ladder/dip-ladder.strategy';
import { Lot, LotStatus } from '../strategies/dip-ladder/lot';
import { Rung, RungStatus } from '../strategies/dip-ladder/rung';
import { DuplicateOrderService, OrderDiagnosisService } from './order-diagnosis.service';
import { SymbolHaltService } from './symbol-halt.service';

const NOW = '2025-01-20T10:00:00.000-05:00';
const STRATEGY_ID = 'dip-ladder:TQQQ';

function buildHarness(options: { symbolCapital?: number } = {}) {
  const broker = new MockBrokerAdapter({ fillMode: FillMode.MARKET_AWARE });
  const coordinator = new CoordinatorService();
  const lots = new InMemoryLotRepository();
  const rungs = new InMemoryRungRepository();
  const orders = new InMemoryOrderRepository();
  const snapshots = new InMemoryStrategyStateSnapshotRepository();

  coordinator.register({
    // RESTING, because the whole subject here is orders that sit at the broker
    // between placement and fill. Under IMMEDIATE there is no such window.
    strategy: new DipLadderStrategy(
      buildDipLadderConfig('TQQQ', {
        symbolCapital: options.symbolCapital ?? 100_000,
        orderPlacement: OrderPlacement.RESTING,
      }),
    ),
    enabled: true,
    symbols: ['TQQQ'],
  });

  const halts = new SymbolHaltService();
  jest.spyOn(halts['logger'], 'error').mockImplementation(() => undefined);
  jest.spyOn(halts['logger'], 'warn').mockImplementation(() => undefined);

  const diagnosis = new OrderDiagnosisService(coordinator, halts, broker);
  jest.spyOn(diagnosis['logger'], 'log').mockImplementation(() => undefined);

  const duplicates = new DuplicateOrderService(diagnosis, broker);
  jest.spyOn(duplicates['logger'], 'log').mockImplementation(() => undefined);

  const engine = new EngineService(
    new ReplayService(),
    coordinator,
    new RiskManagerService(
      buildRiskConfig({ accountEquity: 1_000_000 }),
      ExecutionMode.PAPER,
      new KillSwitchService(new InMemoryRiskEventSink()),
      new InMemoryRiskEventSink(),
    ),
    broker,
    new InMemoryOrderIntentRepository(),
    orders,
    new InMemoryFillRepository(),
    lots,
    rungs,
    ExecutionMode.PAPER,
    halts,
    snapshots,
  );
  jest.spyOn(engine['logger'], 'log').mockImplementation(() => undefined);
  jest.spyOn(engine['logger'], 'warn').mockImplementation(() => undefined);
  jest.spyOn(engine['logger'], 'error').mockImplementation(() => undefined);

  return { broker, coordinator, halts, diagnosis, duplicates, engine, lots, rungs };
}

afterEach(() => {
  jest.restoreAllMocks();
});

function heldLot(id: string, overrides: Partial<Lot> = {}): Lot {
  return {
    id,
    rungPrice: 95,
    fillPrice: 95,
    quantity: 100,
    openedAt: '2025-01-20T09:45:00.000-05:00',
    exitTarget: 99.75,
    status: LotStatus.HELD,
    closedAt: null,
    exitPrice: null,
    workingOrderId: null,
    ...overrides,
  };
}

function rung(price: number, overrides: Partial<Rung> = {}): Rung {
  return {
    price,
    status: RungStatus.PENDING,
    lotId: null,
    workingOrderId: null,
    completedCycles: 0,
    lastExitAt: null,
    ...overrides,
  };
}

/** Seeds ladder state directly, standing in for a session that already ran. */
function seedLadder(
  coordinator: CoordinatorService,
  { lots = [], rungs = [] }: { lots?: Lot[]; rungs?: Rung[] },
): void {
  const state = coordinator.getState(STRATEGY_ID) ?? {
    strategyId: STRATEGY_ID,
    data: {},
  };

  const data = state.data as Record<string, unknown>;
  data.lots = lots;
  data.rungs = rungs;
  coordinator.setState(STRATEGY_ID, state as never);
}

/** Makes the broker report a fixed set of open orders. */
function withOpenOrders(broker: MockBrokerAdapter, orders: Partial<OpenOrder>[]): void {
  jest.spyOn(broker, 'getOpenOrders').mockResolvedValue(
    orders.map((order, i) => ({
      clientOrderId: order.clientOrderId ?? `co-${i}`,
      brokerOrderId: order.brokerOrderId ?? `ib-${i}`,
      symbol: order.symbol ?? 'TQQQ',
      side: order.side ?? 'BUY',
      quantity: order.quantity ?? 100,
      filledQuantity: order.filledQuantity ?? 0,
      limitPrice: order.limitPrice ?? 95,
    })),
  );
}

describe('OrderDiagnosisService', () => {
  it('reports an unreadable book as unreachable, not as empty', async () => {
    // The distinction the whole design turns on. An operator reading "no orders
    // resting" during an outage would conclude the ladder is unprotected and
    // press "place missing" — placing duplicates on top of orders that are
    // still live at IB.
    const h = buildHarness();
    jest.spyOn(h.broker, 'getOpenOrders').mockRejectedValue(new Error('socket closed'));

    const report = await h.diagnosis.diagnose(NOW);

    expect(report.brokerReachable).toBe(false);
    expect(report.reason).toContain('socket closed');
    expect(report.missing).toEqual([]);
    expect(report.orphans).toEqual([]);
    expect(report.duplicates).toEqual([]);
  });

  it('matches a rung and a lot to the orders they claim', async () => {
    const h = buildHarness();
    seedLadder(h.coordinator, {
      lots: [heldLot('lot-1', { workingOrderId: 'sell-1' })],
      rungs: [rung(95, { status: RungStatus.WORKING, workingOrderId: 'buy-1' })],
    });
    withOpenOrders(h.broker, [
      { clientOrderId: 'buy-1', side: 'BUY', limitPrice: 95 },
      { clientOrderId: 'sell-1', side: 'SELL', limitPrice: 99.75 },
    ]);

    const report = await h.diagnosis.diagnose(NOW);

    expect(report.matched.map((m) => m.clientOrderId).sort()).toEqual(['buy-1', 'sell-1']);
    expect(report.unbacked).toEqual([]);
    expect(report.orphans).toEqual([]);
  });

  it('reports a WORKING rung whose order is gone as unbacked, not as missing', async () => {
    // A DAY order that expired overnight. Releasing the rung is
    // reconciliation's job — re-placing at a level still marked WORKING would
    // race that release and could double the order.
    const h = buildHarness();
    seedLadder(h.coordinator, {
      rungs: [rung(95, { status: RungStatus.WORKING, workingOrderId: 'expired-1' })],
    });
    withOpenOrders(h.broker, []);

    const report = await h.diagnosis.diagnose(NOW);

    expect(report.unbacked).toHaveLength(1);
    expect(report.unbacked[0].clientOrderId).toBe('expired-1');
    expect(report.missing).toEqual([]);
  });

  it('reports a held lot whose sell is gone as unbacked on the SELL side', async () => {
    // The exit-side counterpart. A lot believing it is protected by an order
    // that no longer exists is the more dangerous of the two directions: the
    // position is uncovered while the ladder thinks it is covered.
    const h = buildHarness();
    seedLadder(h.coordinator, {
      lots: [heldLot('lot-1', { workingOrderId: 'cancelled-sell' })],
    });
    withOpenOrders(h.broker, []);

    const report = await h.diagnosis.diagnose(NOW);

    expect(report.unbacked).toEqual([
      expect.objectContaining({ side: 'SELL', clientOrderId: 'cancelled-sell', lotId: 'lot-1' }),
    ]);
  });

  it('reports a non-Error failure without losing the reason', async () => {
    const h = buildHarness();
    jest.spyOn(h.broker, 'getOpenOrders').mockRejectedValue('connection reset');

    const report = await h.diagnosis.diagnose(NOW);

    expect(report.brokerReachable).toBe(false);
    expect(report.reason).toBe('connection reset');
  });

  it('does not treat a HELD rung as a placement candidate', async () => {
    // A rung holding a lot is not missing an order — its exposure is already
    // committed, and the exit side is what covers it.
    const h = buildHarness();
    seedLadder(h.coordinator, {
      lots: [heldLot('lot-1', { workingOrderId: 'sell-1' })],
      rungs: [rung(95, { status: RungStatus.HELD, lotId: 'lot-1' })],
    });
    withOpenOrders(h.broker, [{ clientOrderId: 'sell-1', side: 'SELL', limitPrice: 99.75 }]);

    const report = await h.diagnosis.diagnose(NOW);

    expect(report.missing).toEqual([]);
  });

  it('offers a re-armed rung with no order as a placement candidate', async () => {
    // The case placement exists for on the entry side: the rung is genuinely
    // fireable and nothing is resting at it.
    const h = buildHarness();
    seedLadder(h.coordinator, { rungs: [rung(95, { status: RungStatus.RE_ARMED })] });
    withOpenOrders(h.broker, []);

    const report = await h.diagnosis.diagnose(NOW);

    expect(report.missing).toEqual([
      expect.objectContaining({ side: 'BUY', limitPrice: 95, rungPrice: 95 }),
    ]);
  });

  it('reports an order for a symbol no ladder trades as neither orphan nor duplicate', async () => {
    // Reporting it would invite cancelling an order belonging to something this
    // engine deliberately is not reasoning about.
    const h = buildHarness();
    seedLadder(h.coordinator, { rungs: [rung(95)] });
    withOpenOrders(h.broker, [
      { clientOrderId: 'other-1', symbol: 'SPY', side: 'BUY', limitPrice: 500 },
      { clientOrderId: 'other-2', symbol: 'SPY', side: 'BUY', limitPrice: 500 },
    ]);

    const report = await h.diagnosis.diagnose(NOW);

    expect(report.orphans).toEqual([]);
    expect(report.duplicates).toEqual([]);
  });

  it('reports an order no rung or lot claims as an orphan', async () => {
    const h = buildHarness();
    seedLadder(h.coordinator, { rungs: [rung(95)] });
    withOpenOrders(h.broker, [{ clientOrderId: 'placed-by-hand', side: 'BUY', limitPrice: 88 }]);

    const report = await h.diagnosis.diagnose(NOW);

    expect(report.orphans).toHaveLength(1);
    expect(report.orphans[0].clientOrderId).toBe('placed-by-hand');
  });

  it('finds a held lot with no resting sell', async () => {
    // The gap with real money behind it: the ladder decided this lot's exit
    // target when it opened, and no order is carrying that decision.
    const h = buildHarness();
    seedLadder(h.coordinator, { lots: [heldLot('lot-1')] });
    withOpenOrders(h.broker, []);

    const report = await h.diagnosis.diagnose(NOW);

    expect(report.missing).toHaveLength(1);
    expect(report.missing[0]).toMatchObject({
      side: 'SELL',
      quantity: 100,
      limitPrice: 99.75,
      lotId: 'lot-1',
    });
  });

  it('does not report a lot as missing when a matching sell already rests', async () => {
    // The broker is the authority, not the absent in-memory mark: a sell at
    // this price and quantity already covers these shares whatever the lot
    // record says.
    const h = buildHarness();
    seedLadder(h.coordinator, { lots: [heldLot('lot-1', { workingOrderId: null })] });
    withOpenOrders(h.broker, [{ side: 'SELL', limitPrice: 99.75, quantity: 100 }]);

    const report = await h.diagnosis.diagnose(NOW);

    expect(report.missing).toEqual([]);
  });

  it('reports nothing missing for a flat ladder with no fireable rung', async () => {
    // An empty book is not evidence of a fault. This is the case that makes
    // "place if nothing is resting" wrong: the ladder is correctly resting
    // nothing, and placing here would open a position it never chose.
    const h = buildHarness();
    seedLadder(h.coordinator, { lots: [], rungs: [] });
    withOpenOrders(h.broker, []);

    const report = await h.diagnosis.diagnose(NOW);

    expect(report.missing).toEqual([]);
  });

  it('skips a halted symbol rather than reporting its whole ladder as divergent', async () => {
    // A halt leaves live strategy state empty by design, so every order would
    // read as an orphan and every rung as missing — findings that describe the
    // halt rather than the orders.
    const h = buildHarness();
    seedLadder(h.coordinator, { lots: [heldLot('lot-1')] });
    h.halts.halt('TQQQ', 'LOT_SUM_MISMATCH', 'test halt', NOW);
    withOpenOrders(h.broker, [{ clientOrderId: 'stray', side: 'BUY' }]);

    const report = await h.diagnosis.diagnose(NOW);

    expect(report.skippedSymbols).toEqual(['TQQQ']);
    expect(report.missing).toEqual([]);
    expect(report.orphans).toEqual([]);
  });

  it('groups two untracked orders at one price as an unresolvable duplicate', async () => {
    const h = buildHarness();
    seedLadder(h.coordinator, { rungs: [rung(95)] });
    withOpenOrders(h.broker, [
      { clientOrderId: 'a', side: 'BUY', limitPrice: 95 },
      { clientOrderId: 'b', side: 'BUY', limitPrice: 95 },
    ]);

    const report = await h.diagnosis.diagnose(NOW);

    expect(report.duplicates).toHaveLength(1);
    expect(report.duplicates[0].resolvable).toBe(false);
    expect(report.duplicates[0].tracked).toEqual([]);
  });

  it('marks a group resolvable when exactly one order is tracked', async () => {
    const h = buildHarness();
    seedLadder(h.coordinator, {
      rungs: [rung(95, { status: RungStatus.WORKING, workingOrderId: 'mine' })],
    });
    withOpenOrders(h.broker, [
      { clientOrderId: 'mine', side: 'BUY', limitPrice: 95 },
      { clientOrderId: 'extra', side: 'BUY', limitPrice: 95 },
    ]);

    const report = await h.diagnosis.diagnose(NOW);

    expect(report.duplicates[0]).toMatchObject({
      resolvable: true,
      tracked: ['mine'],
      untracked: ['extra'],
    });
  });

  it('excludes a partially filled order from a duplicate group', async () => {
    // It has already put shares on the books, so it is not interchangeable with
    // an untouched order at the same price, and cancelling it would strand the
    // remainder mid-fill.
    const h = buildHarness();
    seedLadder(h.coordinator, { rungs: [rung(95)] });
    withOpenOrders(h.broker, [
      { clientOrderId: 'partial', side: 'BUY', limitPrice: 95, filledQuantity: 40 },
      { clientOrderId: 'whole', side: 'BUY', limitPrice: 95 },
    ]);

    const report = await h.diagnosis.diagnose(NOW);

    expect(report.duplicates).toEqual([]);
  });

  it('does not group a buy and a sell at the same price', async () => {
    const h = buildHarness();
    seedLadder(h.coordinator, { rungs: [rung(95)] });
    withOpenOrders(h.broker, [
      { clientOrderId: 'buy', side: 'BUY', limitPrice: 95 },
      { clientOrderId: 'sell', side: 'SELL', limitPrice: 95 },
    ]);

    const report = await h.diagnosis.diagnose(NOW);

    expect(report.duplicates).toEqual([]);
  });
});

describe('DuplicateOrderService', () => {
  it('cancels the untracked extra and keeps the order the ladder depends on', async () => {
    const h = buildHarness();
    seedLadder(h.coordinator, {
      rungs: [rung(95, { status: RungStatus.WORKING, workingOrderId: 'mine' })],
    });
    withOpenOrders(h.broker, [
      { clientOrderId: 'mine', side: 'BUY', limitPrice: 95 },
      { clientOrderId: 'extra', side: 'BUY', limitPrice: 95 },
    ]);
    const cancel = jest
      .spyOn(h.broker, 'cancel')
      .mockResolvedValue({ clientOrderId: 'extra' } as never);

    const result = await h.duplicates.resolveDuplicates(NOW);

    expect(result.cancelled.map((c) => c.clientOrderId)).toEqual(['extra']);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith('extra');
  });

  it('refuses to cancel anything when no order in the group is tracked', async () => {
    // The standing rule survives here: the ladder depends on neither, so it
    // cannot say which an operator placed by hand.
    const h = buildHarness();
    seedLadder(h.coordinator, { rungs: [rung(95)] });
    withOpenOrders(h.broker, [
      { clientOrderId: 'a', side: 'BUY', limitPrice: 95 },
      { clientOrderId: 'b', side: 'BUY', limitPrice: 95 },
    ]);
    const cancel = jest.spyOn(h.broker, 'cancel');

    const result = await h.duplicates.resolveDuplicates(NOW);

    expect(cancel).not.toHaveBeenCalled();
    expect(result.cancelled).toEqual([]);
    expect(result.skipped[0].reason).toContain('no order in this group is tracked');
  });

  it('cancels nothing when the broker cannot be read', async () => {
    const h = buildHarness();
    jest.spyOn(h.broker, 'getOpenOrders').mockRejectedValue(new Error('socket closed'));
    const cancel = jest.spyOn(h.broker, 'cancel');

    const result = await h.duplicates.resolveDuplicates(NOW);

    expect(cancel).not.toHaveBeenCalled();
    expect(result.cancelled).toEqual([]);
    expect(result.skipped[0].reason).toContain('socket closed');
  });

  it('reports a failed cancellation rather than throwing', async () => {
    const h = buildHarness();
    seedLadder(h.coordinator, {
      rungs: [rung(95, { status: RungStatus.WORKING, workingOrderId: 'mine' })],
    });
    withOpenOrders(h.broker, [
      { clientOrderId: 'mine', side: 'BUY', limitPrice: 95 },
      { clientOrderId: 'extra', side: 'BUY', limitPrice: 95 },
    ]);
    jest.spyOn(h.broker, 'cancel').mockRejectedValue(new Error('rejected by IB'));

    const result = await h.duplicates.resolveDuplicates(NOW);

    expect(result.cancelled).toEqual([]);
    expect(result.failed[0]).toMatchObject({ clientOrderId: 'extra' });
    expect(result.failed[0].reason).toContain('rejected by IB');
  });
});

/**
 * Operator placement.
 *
 * This is the only path that creates an order from a click rather than from a
 * bar, so the assertions here are almost entirely about what it refuses. The
 * one thing it must do — place a genuinely missing exit — is proven last, so a
 * regression that broke every guard could not pass by simply refusing
 * everything.
 */
describe('EngineService.placeMissingOrders', () => {
  /** Gives the engine a reference price without running a whole fixture. */
  async function ready(h: ReturnType<typeof buildHarness>, close: number): Promise<void> {
    // The mock broker refuses to submit while disconnected, exactly as a real
    // one would. Connecting is setup, not part of what these tests assert.
    await h.broker.connect();
    setLastClose(h.engine, close);
  }

  function setLastClose(engine: EngineService, close: number, at = NOW): void {
    (engine as unknown as { lastBarClose: number; lastBarTimestamp: string }).lastBarClose = close;
    (engine as unknown as { lastBarClose: number; lastBarTimestamp: string }).lastBarTimestamp = at;
  }

  const candidate = {
    strategyId: STRATEGY_ID,
    symbol: 'TQQQ',
    side: 'SELL' as const,
    quantity: 100,
    limitPrice: 99.75,
    reason: 'lot-1 is held with no resting sell',
    lotId: 'lot-1',
  };

  it('refuses every candidate before any bar has been seen', async () => {
    // With no reference price there is nothing to prove the order would rest
    // rather than cross the spread, so refusing is the safe direction.
    const h = buildHarness();

    const result = await h.engine.placeMissingOrders([candidate]);

    expect(result.placed).toEqual([]);
    expect(result.declined[0].reason).toContain('no reference price');
  });

  it('places nothing when given no candidates', async () => {
    const h = buildHarness();
    setLastClose(h.engine, 96);
    const submit = jest.spyOn(h.broker, 'submit');

    const result = await h.engine.placeMissingOrders([]);

    expect(submit).not.toHaveBeenCalled();
    expect(result.placed).toEqual([]);
  });

  it('refuses a sell that would be marketable against the last close', async () => {
    // A marketable order into a 3x ETF book is a fill price the ladder must
    // then hold with no stop underneath it.
    const h = buildHarness();
    setLastClose(h.engine, 105);
    const submit = jest.spyOn(h.broker, 'submit');

    const result = await h.engine.placeMissingOrders([candidate]);

    expect(submit).not.toHaveBeenCalled();
    expect(result.declined[0].reason).toContain('marketable');
  });

  it('refuses a buy that would be marketable against the last close', async () => {
    const h = buildHarness();
    setLastClose(h.engine, 90);
    const submit = jest.spyOn(h.broker, 'submit');

    const result = await h.engine.placeMissingOrders([
      { ...candidate, side: 'BUY', limitPrice: 95, lotId: null },
    ]);

    expect(submit).not.toHaveBeenCalled();
    expect(result.declined[0].reason).toContain('marketable');
  });

  it('refuses everything while the kill switch is engaged', async () => {
    // The chokepoint is not bypassed by this path: `canSubmit` gates it exactly
    // as it gates the bar path.
    const h = buildHarness();
    setLastClose(h.engine, 96);
    h.engine['riskManager']['killSwitch'].engage('operator test', NOW);
    const submit = jest.spyOn(h.broker, 'submit');

    const result = await h.engine.placeMissingOrders([candidate]);

    expect(submit).not.toHaveBeenCalled();
    expect(result.placed).toEqual([]);
    expect(result.declined[0].reason).toContain('submission is blocked');
  });

  it('refuses a BUY while entries are halted but still places a SELL', async () => {
    // Matches `processBar`: halting a sell would trap a position the ladder has
    // already decided to close.
    const h = buildHarness();
    seedLadder(h.coordinator, { lots: [heldLot('lot-1')] });
    await ready(h, 96);
    h.engine['haltEntries']('test fault', 'BROKER_CONNECTION' as never, NOW);

    const result = await h.engine.placeMissingOrders([
      { ...candidate, side: 'BUY', limitPrice: 95, lotId: null },
      candidate,
    ]);

    expect(result.declined.some((d) => d.reason.includes('new entries are halted'))).toBe(true);
    expect(result.placed.map((p) => p.candidate.side)).toEqual(['SELL']);
  });

  it('refuses a candidate whose symbol no registered ladder trades', async () => {
    const h = buildHarness();
    setLastClose(h.engine, 96);

    const result = await h.engine.placeMissingOrders([
      { ...candidate, symbol: 'SOXL', strategyId: 'dip-ladder:SOXL' },
    ]);

    expect(result.placed).toEqual([]);
    expect(result.declined[0].reason).toContain('no contract is registered');
  });

  it('places a missing exit and records the working order against its lot', async () => {
    // The happy path, proven last: the guards above must not be passing simply
    // because everything is refused.
    const h = buildHarness();
    seedLadder(h.coordinator, { lots: [heldLot('lot-1')] });
    await ready(h, 96);

    const result = await h.engine.placeMissingOrders([candidate]);

    expect(result.declined).toEqual([]);
    expect(result.placed).toHaveLength(1);
    expect(result.placed[0]).toMatchObject({ quantity: 100, resized: false });

    // The durable record the exit path depends on — without it the next bar
    // would stack a second sell against shares this order already covers.
    const lots = DipLadderStrategy.lotsOf(h.coordinator.getState(STRATEGY_ID)!)!;
    expect(lots[0].workingOrderId).not.toBeNull();
  });

  it('reports a risk rejection rather than forcing the order through', async () => {
    // A tiny allocation makes the capital cap bind. The order is refused with
    // the risk manager's own reason, not resized to something it never
    // approved.
    const h = buildHarness();
    setLastClose(h.engine, 96);
    jest
      .spyOn(h.engine['riskManager'], 'evaluateBatch')
      .mockReturnValue([
        { outcome: 'REJECTED', approvedQuantity: 0, reason: 'global capital cap' } as never,
      ]);
    const submit = jest.spyOn(h.broker, 'submit');

    const result = await h.engine.placeMissingOrders([candidate]);

    expect(submit).not.toHaveBeenCalled();
    expect(result.declined[0].reason).toContain('global capital cap');
  });
});
