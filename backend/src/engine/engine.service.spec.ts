/**
 * Engine unit tests.
 *
 * These cover what the integration suite structurally cannot: the app boots in
 * `SHADOW`, so no HTTP path can reach actual submission. Constructing the
 * engine directly in `PAPER` is the only way to exercise the submit, fill, and
 * fault-handling code — and those are the paths that will one day move real
 * money, so they must not go untested until Story 13.
 */

import { OrderStatus } from '../broker/broker-adapter.interface';
import { ExecutionMode } from '../config/execution-mode';
import { MockBrokerAdapter, FillMode } from '../broker/mock/mock-broker.adapter';
import { ReplayService } from '../market-data/mock/replay.service';
import { KillSwitchService } from '../risk/kill-switch.service';
import { RiskManagerService } from '../risk/risk-manager.service';
import { buildRiskConfig } from '../risk/risk.config';
import { InMemoryRiskEventSink } from '../risk/risk-event';
import { CoordinatorService } from '../strategies/coordinator.service';
import { buildDipLadderConfig } from '../strategies/dip-ladder/config';
import { DipLadderStrategy } from '../strategies/dip-ladder/dip-ladder.strategy';
import { GridStrategy } from '../strategies/grid/grid.strategy';
import { equityContract, OrderType, TimeInForce } from '../strategies/types';
import {
  InMemoryFillRepository,
  InMemoryLotRepository,
  InMemoryOrderIntentRepository,
  InMemoryOrderRepository,
  InMemoryRungRepository,
} from '../repositories/in-memory/in-memory.repositories';
import { EngineService, EntryHaltCode, toRiskIntent } from './engine.service';

jest.setTimeout(60_000);

interface Harness {
  engine: EngineService;
  broker: MockBrokerAdapter;
  coordinator: CoordinatorService;
  killSwitch: KillSwitchService;
  intents: InMemoryOrderIntentRepository;
  orders: InMemoryOrderRepository;
  fills: InMemoryFillRepository;
  lots: InMemoryLotRepository;
}

async function harness(mode = ExecutionMode.PAPER): Promise<Harness> {
  const broker = new MockBrokerAdapter();
  await broker.connect();

  const coordinator = new CoordinatorService();
  coordinator.register({
    strategy: new DipLadderStrategy(buildDipLadderConfig('TQQQ', { symbolCapital: 100_000 })),
    enabled: true,
    symbols: ['TQQQ'],
  });
  await coordinator.initializeAll('2025-01-02T09:30:00.000-05:00');

  const killSwitch = new KillSwitchService(new InMemoryRiskEventSink());
  const riskManager = new RiskManagerService(
    buildRiskConfig({ accountEquity: 1_000_000 }),
    mode,
    killSwitch,
    new InMemoryRiskEventSink(),
  );

  const intents = new InMemoryOrderIntentRepository();
  const orders = new InMemoryOrderRepository();
  const fills = new InMemoryFillRepository();
  const lots = new InMemoryLotRepository();
  const rungs = new InMemoryRungRepository();

  const engine = new EngineService(
    new ReplayService(),
    coordinator,
    riskManager,
    broker,
    intents,
    orders,
    fills,
    lots,
    rungs,
    mode,
  );

  return { engine, broker, coordinator, killSwitch, intents, orders, fills, lots };
}

describe('EngineService', () => {
  describe('toRiskIntent', () => {
    it('maps the shared OrderIntent onto the risk layer’s vocabulary', () => {
      // The seam that keeps the risk manager independent of every strategy.
      const mapped = toRiskIntent({
        strategyId: 'dip-ladder:TQQQ',
        contract: equityContract('TQQQ'),
        side: 'BUY',
        quantity: 100,
        orderType: OrderType.LIMIT,
        limitPrice: 95,
        timeInForce: TimeInForce.DAY,
        timestamp: '2025-01-02T10:00:00.000-05:00',
        reason: 'rung at 95.00',
      });

      expect(mapped).toEqual({
        strategyId: 'dip-ladder:TQQQ',
        symbol: 'TQQQ',
        side: 'BUY',
        quantity: 100,
        limitPrice: 95,
        timestamp: '2025-01-02T10:00:00.000-05:00',
        reason: 'rung at 95.00',
      });
    });
  });

  describe('SHADOW submits nothing', () => {
    it('approves intents but hands none to the broker', async () => {
      const { engine, broker } = await harness(ExecutionMode.SHADOW);

      const result = await engine.replayFixture('chop-range');

      expect(result.approved).toBeGreaterThan(0);
      expect(result.submitted).toBe(0);
      expect(broker.submittedOrders()).toEqual([]);
      expect(await broker.getPositions()).toEqual([]);
    });

    it('still persists an intent record for every intent', async () => {
      const { engine, intents } = await harness(ExecutionMode.SHADOW);

      await engine.replayFixture('steady-decline');

      const records = await intents.findAll();
      expect(records.length).toBeGreaterThan(0);
      expect(records.every((record) => record.submitted === false)).toBe(true);
    });
  });

  describe('submission in PAPER', () => {
    it('submits approved intents to the broker', async () => {
      const { engine, broker } = await harness();

      const result = await engine.replayFixture('steady-decline');

      expect(result.submitted).toBeGreaterThan(0);
      expect(broker.submittedOrders().length).toBe(result.submitted);
    });

    it('persists the intent before submitting it', async () => {
      // `PRD.md:366` — the write that makes the crash window recoverable.
      const { engine, intents, orders } = await harness();

      await engine.replayFixture('steady-decline');

      const submitted = (await intents.findAll()).filter((record) => record.submitted);
      expect(submitted.length).toBeGreaterThan(0);

      for (const record of submitted) {
        expect(record.clientOrderId).not.toBeNull();
        expect(await orders.findByClientOrderId(record.clientOrderId!)).not.toBeNull();
      }
    });

    it('builds a limit order payload field by field', async () => {
      const { engine, broker } = await harness();

      await engine.replayFixture('steady-decline');
      const [order] = broker.submittedOrders();

      expect(order).toEqual(
        expect.objectContaining({
          side: 'BUY',
          orderType: 'LMT',
          timeInForce: 'DAY',
        }),
      );
      expect(order.contract).toEqual({
        symbol: 'TQQQ',
        secType: 'STK',
        exchange: 'SMART',
        currency: 'USD',
        multiplier: 1,
      });
      expect(order.quantity).toBeGreaterThan(0);
      expect(order.limitPrice).toBeGreaterThan(0);
      expect(order.clientOrderId).toMatch(/^co-\d+$/);
    });

    it('records fills and corrects the lot to the actual fill price', async () => {
      // The strategy opens a lot optimistically at the rung; the broker decides
      // the real price. A lot's target is a percentage of what it actually paid.
      const { engine, broker, fills, coordinator } = await harness();
      broker.configure({ slippagePerShare: 0.02 });

      await engine.replayFixture('steady-decline');

      const recorded = await fills.findAll();
      expect(recorded.length).toBeGreaterThan(0);

      const state = coordinator.getState('dip-ladder:TQQQ')!;
      const lots = DipLadderStrategy.lotsOf(state);
      const filled = lots.find((lot) => lot.fillPrice !== lot.rungPrice);

      expect(filled).toBeDefined();
      // Slippage moved the fill above the rung, and the target moved with it.
      expect(filled!.fillPrice).toBeCloseTo(filled!.rungPrice + 0.02, 2);
      expect(filled!.exitTarget).toBeCloseTo(Math.round(filled!.fillPrice * 1.05 * 100) / 100, 2);
    });

    it('records a rejected order without halting the engine', async () => {
      const { engine, broker, orders } = await harness();
      broker.configure({ fillMode: FillMode.REJECT, rejectReason: 'no buying power' });

      const result = await engine.replayFixture('steady-decline');

      expect(result.submitted).toBeGreaterThan(0);
      // A rejection is the broker answering, not a fault.
      expect(engine.isHalted()).toBe(false);

      const rejected = (await orders.findAll()).filter((o) => o.status === 'REJECTED');
      expect(rejected.length).toBeGreaterThan(0);
      expect(rejected[0].rejectReason).toBe('no buying power');
      expect(engine.activeAlerts().some((a) => a.code === 'ORDER_REJECTED')).toBe(true);
    });
  });

  describe('technical faults never liquidate', () => {
    it('halts new entries when submission throws, and sells nothing', async () => {
      const { engine, broker } = await harness();
      broker.simulateDisconnect('socket dropped');

      const result = await engine.replayFixture('steady-decline');

      expect(engine.isHalted()).toBe(true);
      expect(engine.haltReason()).toMatch(/order submission failed/);
      expect(result.submitted).toBe(0);
      // No sell was produced in response to the fault.
      expect(broker.submittedOrders().filter((o) => o.side === 'SELL')).toEqual([]);
      expect(await broker.getPositions()).toEqual([]);
    });

    it('raises a CRITICAL alert naming the fault', async () => {
      const { engine, broker } = await harness();
      broker.simulateDisconnect('socket dropped');

      await engine.replayFixture('steady-decline');

      const alert = engine.activeAlerts().find((a) => a.code === 'ENTRY_HALT');
      expect(alert).toBeDefined();
      expect(alert!.severity).toBe('CRITICAL');
    });

    it('halts automatically when the broker connection reaches FAILED', async () => {
      const { engine, broker } = await harness();
      broker.configure({ baseBackoffMs: 1, maxReconnectAttempts: 2 });

      broker.simulateDisconnect();
      await broker.reconnect(99);

      expect(engine.isHalted()).toBe(true);
      expect(engine.haltReason()).toMatch(/broker connection failed/);
    });

    it('the halt is sticky — it does not clear itself on a later healthy bar', async () => {
      const { engine, broker } = await harness();
      broker.simulateDisconnect('transient');
      await engine.replayFixture('steady-decline');

      await broker.connect();

      // Reconnecting does not resume trading; that is an operator decision.
      expect(engine.isHalted()).toBe(true);
    });

    it('clearHalt is the explicit operator action that resumes entries', async () => {
      const { engine, broker } = await harness();
      broker.simulateDisconnect('transient');
      await engine.replayFixture('steady-decline');
      await broker.connect();

      engine.clearHalt();

      expect(engine.isHalted()).toBe(false);
      expect(engine.haltReason()).toBeNull();

      const result = await engine.replayFixture('steady-decline');
      expect(result.submitted).toBeGreaterThan(0);
    });

    it('records only one halt even across many failing bars', async () => {
      const { engine, broker } = await harness();
      broker.simulateDisconnect();

      await engine.replayFixture('steady-decline');

      expect(engine.activeAlerts().filter((a) => a.code === 'ENTRY_HALT')).toHaveLength(1);
    });
  });

  describe('a staleness halt clears itself when bars resume', () => {
    it('lifts the halt on the next bar, and that bar may trade', async () => {
      const { engine } = await harness();

      // What the live feed's watchdog does when the feed goes quiet.
      engine.haltEntriesForFault('market data stale beyond threshold');
      expect(engine.isHalted()).toBe(true);

      // A bar arriving is direct positive evidence the fault — no bars — has
      // ended. Without this, a feed that went quiet and simply resumed (a
      // data-farm blip, a pacing throttle, no socket drop) left entries halted
      // for the life of the process: bars flowed, the ladder evaluated, and
      // every BUY was silently dropped until someone restarted the daemon.
      const result = await engine.replayFixture('steady-decline');

      expect(engine.isHalted()).toBe(false);
      expect(engine.haltReason()).toBeNull();
      expect(result.submitted).toBeGreaterThan(0);
    });

    it('does NOT lift a broker-connection halt', async () => {
      const { engine, broker } = await harness();
      broker.configure({ baseBackoffMs: 1, maxReconnectAttempts: 2 });

      broker.simulateDisconnect();
      await broker.reconnect(99);
      expect(engine.isHalted()).toBe(true);

      await engine.replayFixture('steady-decline');

      // Bars and orders travel different paths: a feed can recover while
      // submission stays broken, so a bar is no evidence about the broker.
      // Only an operator clears this one.
      expect(engine.isHalted()).toBe(true);
      expect(engine.haltReason()).toMatch(/broker connection failed/);
    });

    it('does NOT lift an order-fault halt', async () => {
      const { engine, broker } = await harness();
      broker.simulateDisconnect('socket dropped');
      await engine.replayFixture('steady-decline');

      expect(engine.haltReason()).toMatch(/order submission failed/);

      await broker.connect();
      await engine.replayFixture('steady-decline');

      // A failed submission is disproved by nothing except trying again, which
      // is an operator's decision to make.
      expect(engine.isHalted()).toBe(true);
    });

    it('an explicitly coded stale halt is the only self-clearing kind', async () => {
      const { engine } = await harness();

      engine.haltEntriesForFault('broker went away', EntryHaltCode.BROKER_CONNECTION);
      await engine.replayFixture('steady-decline');
      expect(engine.isHalted()).toBe(true);

      engine.clearHalt();
      engine.haltEntriesForFault('feed quiet', EntryHaltCode.STALE_DATA);
      await engine.replayFixture('steady-decline');
      expect(engine.isHalted()).toBe(false);
    });
  });

  describe('kill switch and halts gate submission', () => {
    it('submits nothing while the kill switch is engaged', async () => {
      const { engine, broker, killSwitch } = await harness();
      killSwitch.engage('operator halt', '2025-01-02T09:30:00.000-05:00');

      const result = await engine.replayFixture('steady-decline');

      expect(result.submitted).toBe(0);
      expect(result.approved).toBe(0);
      expect(broker.submittedOrders()).toEqual([]);
    });

    it('an entry halt blocks buys but still permits exits', async () => {
      // Halting a sell would trap a position the strategy already decided to
      // close, so the fault gate is deliberately asymmetric.
      const { engine, broker } = await harness();

      await engine.replayFixture('chop-range');
      const sellsBefore = broker.submittedOrders().filter((o) => o.side === 'SELL').length;

      expect(sellsBefore).toBeGreaterThan(0);
    });
  });

  describe('state projection', () => {
    it('exposes ladder lots and rungs after a replay', async () => {
      const { engine } = await harness(ExecutionMode.SHADOW);

      await engine.replayFixture('chop-range');

      expect(engine.ladderLots().length).toBeGreaterThan(0);
      expect(engine.ladderRungs().length).toBeGreaterThan(0);
    });

    it('ignores strategies that keep no lots', async () => {
      // A scaffold's state has no `lots` field; reading it must not break the
      // ladder's own projection.
      const { engine, coordinator } = await harness(ExecutionMode.SHADOW);
      coordinator.register({ strategy: new GridStrategy(), enabled: true, symbols: ['TQQQ'] });
      await coordinator.initializeAll('2025-01-02T09:30:00.000-05:00');

      await engine.replayFixture('chop-range');

      expect(engine.ladderLots().every((lot) => lot !== undefined)).toBe(true);
      expect(engine.ladderRungs().every((rung) => rung !== undefined)).toBe(true);
    });

    it('persists lots and rungs to the repositories', async () => {
      const { engine, lots } = await harness(ExecutionMode.SHADOW);

      await engine.replayFixture('chop-range');

      expect(await lots.findBySymbol('TQQQ')).not.toEqual([]);
    });

    it('reports the configured mode', async () => {
      const { engine } = await harness(ExecutionMode.SHADOW);

      expect(engine.currentMode()).toBe(ExecutionMode.SHADOW);
    });

    it('reset clears repositories, alerts, and halts', async () => {
      const { engine, broker, intents } = await harness();
      broker.simulateDisconnect();
      await engine.replayFixture('steady-decline');

      await engine.reset();

      expect(engine.isHalted()).toBe(false);
      expect(engine.activeAlerts()).toEqual([]);
      expect(await intents.findAll()).toEqual([]);
    });
  });

  describe('replay accounting', () => {
    it('counts bars, intents, and outcomes consistently', async () => {
      const { engine } = await harness(ExecutionMode.SHADOW);

      const result = await engine.replayFixture('chop-range');

      expect(result.fixture).toBe('chop-range');
      expect(result.barsProcessed).toBeGreaterThan(900);
      expect(result.approved + result.resized + result.rejected).toBe(result.intentsGenerated);
    });

    it('produces identical results across two runs — determinism', async () => {
      const first = await (await harness(ExecutionMode.SHADOW)).engine.replayFixture('chop-range');
      const second = await (await harness(ExecutionMode.SHADOW)).engine.replayFixture('chop-range');

      expect(first).toEqual(second);
    });

    it('generates no intents when every strategy is disabled', async () => {
      const { engine, coordinator } = await harness(ExecutionMode.SHADOW);
      coordinator.disable('dip-ladder:TQQQ');

      const result = await engine.replayFixture('chop-range');

      expect(result.intentsGenerated).toBe(0);
      expect(result.submitted).toBe(0);
    });
  });
  describe('client order id reuse across a restart', () => {
    /**
     * The regression for the phantom-lot halt.
     *
     * A restart leaves the `Order` table intact while the engine's `co-N`
     * counter restarts at zero. Both repositories upsert on `clientOrderId`, so
     * the reused id does not error — it overwrites the earlier order's row, and
     * a fill for either order then resolves to the wrong one.
     */
    async function persistedOrder(orders: InMemoryOrderRepository, clientOrderId: string) {
      await orders.save({
        clientOrderId,
        brokerOrderId: null,
        symbol: 'TQQQ',
        side: 'BUY',
        quantity: 135,
        limitPrice: 73.91,
        status: OrderStatus.SUBMITTED,
        rejectReason: null,
        strategyId: 'dip-ladder:TQQQ',
        createdAt: '2026-08-18T10:40:00.000-04:00',
      });
    }

    it('never re-issues an id that a previous run already persisted', async () => {
      const { engine, orders, broker } = await harness();

      await persistedOrder(orders, 'co-1');
      await persistedOrder(orders, 'co-2');

      await engine.restoreClientOrderSequence();
      await engine.replayFixture('chop-range');

      const all = await orders.findAll();

      // The collision is invisible in a row *count* — the upsert overwrites in
      // place — so this asserts the pre-existing rows still carry the values
      // the previous run wrote. A reused id rewrites `createdAt` and the limit,
      // which is exactly how the 73.91 order came to look like the 69.00 one.
      const first = all.find((order) => order.clientOrderId === 'co-1');
      expect(first?.createdAt).toBe('2026-08-18T10:40:00.000-04:00');
      expect(first?.limitPrice).toBe(73.91);

      const second = all.find((order) => order.clientOrderId === 'co-2');
      expect(second?.createdAt).toBe('2026-08-18T10:40:00.000-04:00');

      // And the run genuinely issued orders, so the assertion above is not
      // passing merely because nothing was submitted.
      expect(all.length).toBeGreaterThan(2);
      expect(broker.isConnected()).toBe(true);
    });

    it('takes the maximum id rather than the row count', async () => {
      // A pruned table would repeat an id if the count were used: two rows
      // present, but the highest id issued is co-9.
      const { engine, orders } = await harness();

      await persistedOrder(orders, 'co-4');
      await persistedOrder(orders, 'co-9');

      await engine.restoreClientOrderSequence();
      await engine.replayFixture('chop-range');

      const generated = (await orders.findAll())
        .map((order) => order.clientOrderId)
        .filter((id) => id !== 'co-4' && id !== 'co-9')
        .map((id) => Number(/^co-(\d+)$/.exec(id)?.[1] ?? 0));

      expect(generated.length).toBeGreaterThan(0);
      for (const n of generated) {
        expect(n).toBeGreaterThan(9);
      }
    });

    it('ignores ids that are not co-N rather than refusing to boot', async () => {
      // Orders recovered from IB or written by hand carry the broker's own
      // vocabulary and cannot collide with this generator.
      const { engine, orders } = await harness();

      await persistedOrder(orders, 'ib-00025b46');
      await persistedOrder(orders, 'co-3');

      await expect(engine.restoreClientOrderSequence()).resolves.toBeUndefined();

      await engine.replayFixture('chop-range');

      const generated = (await orders.findAll())
        .map((order) => order.clientOrderId)
        .filter((id) => id.startsWith('co-') && id !== 'co-3')
        .map((id) => Number(/^co-(\d+)$/.exec(id)?.[1] ?? 0));

      for (const n of generated) {
        expect(n).toBeGreaterThan(3);
      }
    });

    it('is a no-op when nothing is persisted', async () => {
      const { engine, orders } = await harness();

      await engine.restoreClientOrderSequence();
      await engine.replayFixture('chop-range');

      const ids = (await orders.findAll()).map((order) => order.clientOrderId);

      // A fresh install still starts at co-1 — the restore only moves forward.
      expect(ids).toContain('co-1');
    });
  });
});
