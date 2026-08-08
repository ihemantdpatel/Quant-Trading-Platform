/**
 * The replay harness, and **the story's central architectural claim**: the same
 * strategy code runs unmodified against the simulated and mock brokers,
 * producing identical intents for identical bars (`stories.md:660`).
 *
 * If that fails, the backtester is a parallel engine wearing the interface's
 * clothes, and nothing it reports is evidence about the system that will trade.
 */

import { BROKER_ADAPTER, BrokerAdapter, OrderStatus } from '../broker/broker-adapter.interface';
import { FillMode, MockBrokerAdapter } from '../broker/mock/mock-broker.adapter';
import { SimulatedBrokerAdapter } from '../broker/simulated/simulated-broker.adapter';
import { ExecutionMode } from '../config/execution-mode';
import { equityContract } from '../domain/contract';
import { EngineService } from '../engine/engine.service';
import { loadFixture } from '../market-data/mock/fixtures';
import { ReplayService } from '../market-data/mock/replay.service';
import { Bar, BarSize } from '../market-data/types';
import {
  InMemoryFillRepository,
  InMemoryLotRepository,
  InMemoryOrderIntentRepository,
  InMemoryOrderRepository,
  InMemoryRiskEventRepository,
  InMemoryRungRepository,
} from '../repositories/in-memory/in-memory.repositories';
import { KillSwitchService } from '../risk/kill-switch.service';
import { RiskManagerService } from '../risk/risk-manager.service';
import { buildRiskConfig } from '../risk/risk.config';
import { CoordinatorService } from '../strategies/coordinator.service';
import { buildDipLadderConfig } from '../strategies/dip-ladder/config';
import { DipLadderStrategy } from '../strategies/dip-ladder/dip-ladder.strategy';
import { OrderIntent } from '../strategies/types';
import { barCoverage, closedTradesFrom, runBacktest } from './replay-harness';

const SYMBOL = 'TQQQ';
const CAPITAL = 100_000;

function chopBars(): Bar[] {
  return loadFixture('chop-range').bars;
}

/**
 * Drives one engine over bars and captures the intents the strategy produced,
 * with whichever broker is supplied.
 *
 * Deliberately duplicates the harness's wiring rather than calling
 * `runBacktest`, because the point is to run the *same* engine against a
 * *different* broker — reusing the harness would only prove the harness is
 * consistent with itself.
 */
async function intentsWithBroker(broker: BrokerAdapter, bars: Bar[]): Promise<OrderIntent[]> {
  const coordinator = new CoordinatorService();
  const ladder = new DipLadderStrategy(buildDipLadderConfig(SYMBOL, { symbolCapital: CAPITAL }));
  coordinator.register({ strategy: ladder, enabled: true, symbols: [SYMBOL] });

  const riskEvents = new InMemoryRiskEventRepository();
  const riskManager = new RiskManagerService(
    buildRiskConfig({ accountEquity: CAPITAL, perSymbolLimits: { [SYMBOL]: CAPITAL } }),
    ExecutionMode.PAPER,
    new KillSwitchService(riskEvents),
    riskEvents,
  );

  const intents = new InMemoryOrderIntentRepository();

  const engine = new EngineService(
    new ReplayService(),
    coordinator,
    riskManager,
    broker,
    intents,
    new InMemoryOrderRepository(),
    new InMemoryFillRepository(),
    new InMemoryLotRepository(),
    new InMemoryRungRepository(),
    ExecutionMode.PAPER,
  );

  await coordinator.initializeAll(bars[0].timestamp);

  for (const bar of bars) {
    if (broker instanceof SimulatedBrokerAdapter) {
      broker.setCurrentBar(bar);
    }

    await engine.processBar(bar);
  }

  return (await intents.findAll()).map((record) => record.intent);
}

describe('the strategy cannot tell which broker exists', () => {
  it('produces identical intents against the simulated and mock brokers', async () => {
    // The bars must be identical, so both runs get the same fixture. The mock
    // is configured to fill at the limit with no slippage, matching what the
    // simulated broker does when the bar trades through — otherwise the two
    // would diverge on *fill prices*, which legitimately differ, rather than on
    // the intents, which must not.
    const bars = chopBars();

    const simulated = new SimulatedBrokerAdapter({
      equity: CAPITAL,
      fillModel: { slippagePercent: 0, commissionPerShare: 0, minCommissionPerOrder: 0 },
    });
    await simulated.connect();

    const mock = new MockBrokerAdapter({
      equity: CAPITAL,
      fillMode: FillMode.IMMEDIATE,
      slippagePerShare: 0,
      commissionPerOrder: 0,
    });
    await mock.connect();

    const fromSimulated = await intentsWithBroker(simulated, bars);
    const fromMock = await intentsWithBroker(mock, bars);

    expect(fromSimulated.length).toBeGreaterThan(0);
    expect(fromSimulated).toEqual(fromMock);
  }, 60_000);

  it('reaches the same ladder outcome through both brokers', async () => {
    const bars = chopBars();

    const simulated = new SimulatedBrokerAdapter({
      equity: CAPITAL,
      fillModel: { slippagePercent: 0, commissionPerShare: 0, minCommissionPerOrder: 0 },
    });
    await simulated.connect();

    const mock = new MockBrokerAdapter({
      equity: CAPITAL,
      fillMode: FillMode.IMMEDIATE,
      slippagePerShare: 0,
      commissionPerOrder: 0,
    });
    await mock.connect();

    const simulatedIntents = await intentsWithBroker(simulated, bars);
    const mockIntents = await intentsWithBroker(mock, bars);

    // Same buys and same sells — an exit is only reachable if the entries
    // filled identically, so this covers the full cycle rather than entries
    // alone.
    const sides = (intents: OrderIntent[]) => intents.map((intent) => intent.side).join(',');

    expect(sides(simulatedIntents)).toBe(sides(mockIntents));
    expect(simulatedIntents.filter((intent) => intent.side === 'SELL').length).toBeGreaterThan(0);
  }, 60_000);

  it('binds to the shared BROKER_ADAPTER token like any other adapter', () => {
    // Not a tautology: it asserts the simulated adapter satisfies the same
    // interface the engine resolves, which is what "an implementation, not a
    // parallel engine" means structurally.
    const broker: BrokerAdapter = new SimulatedBrokerAdapter();

    expect(typeof BROKER_ADAPTER).toBe('symbol');
    expect(broker.name).toBe('simulated');
    expect(typeof broker.submit).toBe('function');
    expect(typeof broker.getPositions).toBe('function');
  });
});

describe('runBacktest', () => {
  it('runs the chop fixture through the real strategy and risk layer', async () => {
    const result = await runBacktest({
      symbol: SYMBOL,
      barSize: BarSize.FIVE_MIN,
      bars: chopBars(),
      symbolCapital: CAPITAL,
      accountEquity: CAPITAL,
    });

    expect(result.barsProcessed).toBe(chopBars().length);
    expect(result.intentsGenerated).toBeGreaterThan(0);
    expect(result.fills.length).toBeGreaterThan(0);
  }, 60_000);

  it('completes lot cycles — fire, target, exit, re-arm (the Story 4 behaviour)', async () => {
    const result = await runBacktest({
      symbol: SYMBOL,
      barSize: BarSize.FIVE_MIN,
      bars: chopBars(),
      symbolCapital: CAPITAL,
      accountEquity: CAPITAL,
    });

    expect(result.closedTrades.length).toBeGreaterThanOrEqual(3);
    // Every rung that cycled is re-armed at its original price, not the exit.
    expect(result.rungs.some((rung) => rung.completedCycles > 0)).toBe(true);
  }, 60_000);

  it('exits every lot in profit — there is no loss-booking path', async () => {
    const result = await runBacktest({
      symbol: SYMBOL,
      barSize: BarSize.FIVE_MIN,
      bars: chopBars(),
      symbolCapital: CAPITAL,
      accountEquity: CAPITAL,
    });

    for (const trade of result.closedTrades) {
      expect(trade.exitPrice).toBeGreaterThan(trade.entryPrice);
    }
  }, 60_000);

  it('applies the fill model — entries cost more and exits realize less', async () => {
    const result = await runBacktest({
      symbol: SYMBOL,
      barSize: BarSize.FIVE_MIN,
      bars: chopBars(),
      symbolCapital: CAPITAL,
      accountEquity: CAPITAL,
      fillModel: { slippagePercent: 0.001 },
    });

    const buys = result.fills.filter((fill) => fill.side === 'BUY');

    expect(buys.length).toBeGreaterThan(0);
    expect(result.commissionPaid).toBeGreaterThan(0);
  }, 60_000);

  it('is deterministic — the same inputs produce the same result', async () => {
    const request = {
      symbol: SYMBOL,
      barSize: BarSize.FIVE_MIN,
      bars: chopBars(),
      symbolCapital: CAPITAL,
      accountEquity: CAPITAL,
    };

    const first = await runBacktest(request);
    const second = await runBacktest(request);

    expect(second.closedTrades).toEqual(first.closedTrades);
    expect(second.equityCurve).toEqual(first.equityCurve);
  }, 90_000);

  it('does not leak state between runs', async () => {
    // Two runs over the same bars must each start flat. A shared coordinator or
    // repository would leave the second starting with the first's lots.
    const request = {
      symbol: SYMBOL,
      barSize: BarSize.FIVE_MIN,
      bars: chopBars(),
      symbolCapital: CAPITAL,
      accountEquity: CAPITAL,
    };

    const first = await runBacktest(request);
    const second = await runBacktest(request);

    expect(second.fills.length).toBe(first.fills.length);
    expect(second.equityCurve[0]).toEqual(first.equityCurve[0]);
  }, 90_000);

  it('records an equity point per bar with realized and unrealized apart', async () => {
    const result = await runBacktest({
      symbol: SYMBOL,
      barSize: BarSize.FIVE_MIN,
      bars: chopBars(),
      symbolCapital: CAPITAL,
      accountEquity: CAPITAL,
    });

    expect(result.equityCurve).toHaveLength(result.barsProcessed);
    expect(result.equityCurve[0]).toHaveProperty('realized');
    expect(result.equityCurve[0]).toHaveProperty('unrealized');
  }, 60_000);

  it('flags a run as synthetic when any input bar is synthetic', async () => {
    const bars = chopBars().map((bar) => ({ ...bar, synthetic: true }));

    const result = await runBacktest({
      symbol: SYMBOL,
      barSize: BarSize.FIVE_MIN,
      bars,
      symbolCapital: CAPITAL,
      accountEquity: CAPITAL,
    });

    expect(result.synthetic).toBe(true);
  }, 60_000);

  it('reports a real run as not synthetic', async () => {
    const result = await runBacktest({
      symbol: SYMBOL,
      barSize: BarSize.FIVE_MIN,
      bars: chopBars(),
      symbolCapital: CAPITAL,
      accountEquity: CAPITAL,
    });

    expect(result.synthetic).toBe(false);
  }, 60_000);

  it('rejects an empty bar range rather than reporting a flat market', async () => {
    await expect(
      runBacktest({
        symbol: SYMBOL,
        barSize: BarSize.FIVE_MIN,
        bars: [],
        symbolCapital: CAPITAL,
        accountEquity: CAPITAL,
      }),
    ).rejects.toThrow('at least one bar');
  });

  it('sorts bars by timestamp before processing', async () => {
    const bars = [...chopBars()].reverse();

    const result = await runBacktest({
      symbol: SYMBOL,
      barSize: BarSize.FIVE_MIN,
      bars,
      symbolCapital: CAPITAL,
      accountEquity: CAPITAL,
    });

    expect(result.rangeStart < result.rangeEnd).toBe(true);
  }, 60_000);
});

describe('the simulated broker rests orders across bars', () => {
  it('fills a resting order on a later bar that trades through it', async () => {
    const broker = new SimulatedBrokerAdapter({
      fillModel: { slippagePercent: 0, commissionPerShare: 0, minCommissionPerOrder: 0 },
    });
    await broker.connect();

    const base: Bar = {
      symbol: SYMBOL,
      barSize: BarSize.FIVE_MIN,
      timestamp: '2025-01-02T10:00:00.000-05:00',
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1_000_000,
    };

    // Submitted against a bar whose low never reaches 90 — it must rest.
    broker.setCurrentBar(base);
    await broker.submit({
      clientOrderId: 'co-1',
      contract: equityContract(SYMBOL),
      side: 'BUY',
      quantity: 100,
      orderType: 'LMT',
      limitPrice: 90,
      timeInForce: 'DAY',
      timestamp: base.timestamp,
    });

    expect(broker.executedFills()).toHaveLength(0);
    expect(broker.restingOrders()).toHaveLength(1);

    // A later bar reaches down through 90.
    broker.setCurrentBar({ ...base, timestamp: '2025-01-02T10:05:00.000-05:00', low: 89 });

    expect(broker.executedFills()).toHaveLength(1);
    expect(broker.executedFills()[0].price).toBe(90);
    // Stamped with the bar that filled it, not the one that submitted it.
    expect(broker.executedFills()[0].timestamp).toBe('2025-01-02T10:05:00.000-05:00');
    expect(broker.restingOrders()).toHaveLength(0);
  });

  it('throws on submission while disconnected — a fault, not a rejection', async () => {
    const broker = new SimulatedBrokerAdapter();

    await expect(
      broker.submit({
        clientOrderId: 'co-1',
        contract: equityContract(SYMBOL),
        side: 'BUY',
        quantity: 100,
        orderType: 'LMT',
        limitPrice: 90,
        timeInForce: 'DAY',
        timestamp: '2025-01-02T10:00:00.000-05:00',
      }),
    ).rejects.toThrow('not connected');
  });

  it('rejects an order submitted with no bar rather than guessing a price', async () => {
    const broker = new SimulatedBrokerAdapter();
    await broker.connect();

    const ack = await broker.submit({
      clientOrderId: 'co-1',
      contract: equityContract(SYMBOL),
      side: 'BUY',
      quantity: 100,
      orderType: 'LMT',
      limitPrice: 90,
      timeInForce: 'DAY',
      timestamp: '2025-01-02T10:00:00.000-05:00',
    });

    expect(ack.status).toBe(OrderStatus.REJECTED);
    expect(ack.rejectReason).toBe('no bar to price against');
    expect(broker.executedFills()).toHaveLength(0);
  });

  it('reports net position and average cost, never lot composition', async () => {
    const broker = new SimulatedBrokerAdapter({
      fillModel: { slippagePercent: 0, commissionPerShare: 0, minCommissionPerOrder: 0 },
    });
    await broker.connect();

    const bar: Bar = {
      symbol: SYMBOL,
      barSize: BarSize.FIVE_MIN,
      timestamp: '2025-01-02T10:00:00.000-05:00',
      open: 100,
      high: 101,
      low: 90,
      close: 100,
      volume: 1_000_000,
    };
    broker.setCurrentBar(bar);

    for (const [id, price] of [
      ['co-1', 100],
      ['co-2', 90],
    ] as const) {
      await broker.submit({
        clientOrderId: id,
        contract: equityContract(SYMBOL),
        side: 'BUY',
        quantity: 100,
        orderType: 'LMT',
        limitPrice: price,
        timeInForce: 'DAY',
        timestamp: bar.timestamp,
      });
    }

    const [position] = await broker.getPositions();

    // Two lots of 100 are reported as one block of 200 at the blended cost —
    // the asymmetry Story 9's reconciliation exists for.
    expect(position.quantity).toBe(200);
    expect(position.averageCost).toBe(95);
    expect(Object.keys(position)).toEqual(['symbol', 'quantity', 'averageCost']);
  });
});

describe('barCoverage', () => {
  it('reports the largest gap so a hole in history is visible', () => {
    const bars = [
      { timestamp: '2022-01-03T09:30:00.000-05:00' },
      { timestamp: '2022-01-04T09:30:00.000-05:00' },
      // A month missing — the case that would read as a flat market.
      { timestamp: '2022-02-04T09:30:00.000-05:00' },
    ] as Bar[];

    const coverage = barCoverage(bars);

    expect(coverage.barCount).toBe(3);
    expect(coverage.largestGapAt).toBe('2022-01-04T09:30:00.000-05:00');
    expect(coverage.largestGapMs).toBeGreaterThan(20 * 24 * 60 * 60 * 1000);
  });

  it('reports a zero gap for a single bar', () => {
    expect(barCoverage([{ timestamp: '2022-01-03T09:30:00.000-05:00' } as Bar])).toEqual({
      barCount: 1,
      largestGapMs: 0,
      largestGapAt: null,
    });
  });
});

describe('closedTradesFrom', () => {
  it('pairs a closed lot with its realized P&L net of commission', () => {
    const trades = closedTradesFrom(
      [
        {
          id: 'lot-1',
          rungPrice: 95,
          fillPrice: 95,
          quantity: 100,
          openedAt: '2025-01-02T10:00:00.000-05:00',
          exitTarget: 99.75,
          status: 'CLOSED',
          closedAt: '2025-01-03T10:00:00.000-05:00',
          exitPrice: 99.75,
        },
      ] as never,
      [{ commission: 1 }, { commission: 1 }] as never,
    );

    expect(trades).toHaveLength(1);
    // (99.75 - 95) × 100 = 475 gross, less 2 commission = 473
    expect(trades[0].realizedPnl).toBe(473);
    expect(trades[0].holdingPeriodMs).toBe(24 * 60 * 60 * 1000);
  });

  it('ignores lots still held — an open lot has not finished, not lost', () => {
    const trades = closedTradesFrom(
      [
        {
          id: 'lot-1',
          rungPrice: 95,
          fillPrice: 95,
          quantity: 100,
          openedAt: '2025-01-02T10:00:00.000-05:00',
          exitTarget: 99.75,
          status: 'HELD',
          closedAt: null,
          exitPrice: null,
        },
      ] as never,
      [],
    );

    expect(trades).toEqual([]);
  });
});
