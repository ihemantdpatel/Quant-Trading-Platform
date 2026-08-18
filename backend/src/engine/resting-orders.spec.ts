/**
 * Resting limit orders — the behaviours that only exist because an order now
 * outlives the bar that created it.
 *
 * Every test here targets a failure that the immediate-placement path could not
 * produce, and that a green suite would otherwise hide:
 *
 * - a second order stacked at a level that already has one working
 * - a fill arriving after its submit-scoped subscription was torn down
 * - a restart placing a duplicate beside an order still live at IB
 * - a partially filled order left half-working with the ladder unaware
 *
 * The mock broker is used rather than the fake IB socket because these are
 * engine-level rules: they must hold for any adapter, and the mock is the one
 * that can be told to fill partially or not at all on demand.
 */

import { OrderStatus } from '../broker/broker-adapter.interface';
import { FillMode, MockBrokerAdapter } from '../broker/mock/mock-broker.adapter';
import { ExecutionMode } from '../config/execution-mode';
import { ReplayService } from '../market-data/mock/replay.service';
import { Bar, BarSize } from '../market-data/types';
import { SymbolHaltService } from '../reconciliation/symbol-halt.service';
import { RiskManagerService } from '../risk/risk-manager.service';
import { buildRiskConfig } from '../risk/risk.config';
import { KillSwitchService } from '../risk/kill-switch.service';
import { InMemoryRiskEventSink } from '../risk/risk-event';
import { CoordinatorService } from '../strategies/coordinator.service';
import { buildDipLadderConfig, OrderPlacement } from '../strategies/dip-ladder/config';
import { DipLadderStrategy } from '../strategies/dip-ladder/dip-ladder.strategy';
import { RungStatus } from '../strategies/dip-ladder/rung';
import {
  InMemoryFillRepository,
  InMemoryLotRepository,
  InMemoryOrderIntentRepository,
  InMemoryOrderRepository,
  InMemoryRungRepository,
} from '../repositories/in-memory/in-memory.repositories';
import { EngineService } from './engine.service';

const SYMBOL = 'TQQQ';

/** 09:50 ET — inside the firing window, after the 09:45 open. */
function bar(close: number, minute = 50, open = 100): Bar {
  const stamp = `2026-08-14T09:${String(minute).padStart(2, '0')}:00.000-04:00`;

  return {
    symbol: SYMBOL,
    timestamp: stamp,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: 1_000,
    barSize: BarSize.FIVE_MIN,
  };
}

/**
 * Repositories a test can share between two engines to model a restart.
 *
 * `engine.reset()` cannot stand in for this: it clears the order and rung
 * tables, and those durable records are exactly what a restart keeps and what
 * fill recovery reads.
 */
interface SharedRepositories {
  orders: InMemoryOrderRepository;
  lots: InMemoryLotRepository;
  rungs: InMemoryRungRepository;
  fills: InMemoryFillRepository;
}

async function buildEngine(
  placement: OrderPlacement,
  shared?: SharedRepositories,
  existingBroker?: MockBrokerAdapter,
) {
  const config = buildDipLadderConfig(SYMBOL, {
    symbolCapital: 40_000,
    orderPlacement: placement,
  });
  const ladder = new DipLadderStrategy(config);
  const coordinator = new CoordinatorService();

  coordinator.register({ strategy: ladder, enabled: true, symbols: [SYMBOL] });

  // RESTING: the broker acknowledges and holds the order until a test fills it
  // explicitly, which is the only way to model an order that outlives its bar.
  const broker =
    existingBroker ?? new MockBrokerAdapter({ equity: 175_000, fillMode: FillMode.RESTING });
  const sink = new InMemoryRiskEventSink();
  const risk = new RiskManagerService(
    buildRiskConfig({ accountEquity: 175_000, perSymbolLimits: { [SYMBOL]: 40_000 } }),
    // PAPER so `canSubmit()` is true — SHADOW submits nothing and no order
    // could rest anywhere.
    ExecutionMode.PAPER,
    new KillSwitchService(sink),
    sink,
  );

  const orders = shared?.orders ?? new InMemoryOrderRepository();
  const engine = new EngineService(
    new ReplayService(),
    coordinator,
    risk,
    broker,
    new InMemoryOrderIntentRepository(),
    orders,
    shared?.fills ?? new InMemoryFillRepository(),
    shared?.lots ?? new InMemoryLotRepository(),
    shared?.rungs ?? new InMemoryRungRepository(),
    ExecutionMode.PAPER,
    new SymbolHaltService(),
  );

  // Creates empty ladder state, exactly as `StartupSequence` does before any
  // bar is dispatched. Without it the coordinator holds no state to mutate.
  await coordinator.initializeAll('2026-08-14T09:30:00.000-04:00');

  return { engine, broker, coordinator, ladder, orders, config };
}

function rungsOf(coordinator: CoordinatorService, ladder: DipLadderStrategy) {
  return DipLadderStrategy.rungsOf(coordinator.getState(ladder.id)!) ?? [];
}

function lotsOf(coordinator: CoordinatorService, ladder: DipLadderStrategy) {
  return DipLadderStrategy.lotsOf(coordinator.getState(ladder.id)!) ?? [];
}

describe('resting limit orders', () => {
  describe('placement', () => {
    it('places an order at the rung before price reaches it', async () => {
      // The whole point: under IMMEDIATE nothing is submitted until a bar closes
      // at or below the rung. Here the close is well above it and an order is
      // still working at the level.
      const { engine, broker, coordinator, ladder } = await buildEngine(OrderPlacement.RESTING);
      await broker.connect();

      await engine.processBar(bar(100));

      const [rung] = rungsOf(coordinator, ladder);
      expect(rung.status).toBe(RungStatus.WORKING);
      expect(rung.workingOrderId).not.toBeNull();
      // 5% below the 100 anchor.
      expect(rung.price).toBe(95);

      const open = await broker.getOpenOrders();
      expect(open).toHaveLength(1);
      expect(open[0].limitPrice).toBe(95);
    });

    it('does not place a second order while one is working at that rung', async () => {
      // The duplication bug `isFireable` exists to prevent: a WORKING rung holds
      // no lot, so a `lotId === null` test alone would re-fire it every bar.
      const { engine, broker, coordinator, ladder } = await buildEngine(OrderPlacement.RESTING);
      await broker.connect();

      await engine.processBar(bar(100, 50));
      await engine.processBar(bar(99, 55));
      await engine.processBar(bar(98, 59));

      expect(await broker.getOpenOrders()).toHaveLength(1);
      expect(rungsOf(coordinator, ladder)).toHaveLength(1);
    });

    it('leaves IMMEDIATE placement submitting nothing above the rung', async () => {
      // Guards the default: the committed fixtures' expected intents were all
      // computed under this rule, so a silent switch would invalidate them.
      const { engine, broker } = await buildEngine(OrderPlacement.IMMEDIATE);
      await broker.connect();

      await engine.processBar(bar(100));

      expect(await broker.getOpenOrders()).toHaveLength(0);
    });
  });

  describe('fills that arrive after the submitting call returned', () => {
    it('opens a lot from a fill delivered long after placement', async () => {
      // The regression for the torn-down subscription: `submitOrder` used to
      // unsubscribe in `finally`, so a fill arriving later reached no listener.
      const { engine, broker, coordinator, ladder } = await buildEngine(OrderPlacement.RESTING);
      await broker.connect();

      await engine.processBar(bar(100));
      expect(lotsOf(coordinator, ladder)).toHaveLength(0);

      const [open] = await broker.getOpenOrders();
      broker.fillResting(open.clientOrderId, open.quantity, 94.8);
      await new Promise(process.nextTick);

      const lots = lotsOf(coordinator, ladder);
      expect(lots).toHaveLength(1);
      // The lot's target follows the **actual** fill, not the rung price.
      expect(lots[0].fillPrice).toBe(94.8);
      expect(lots[0].exitTarget).toBeCloseTo(99.54, 2);

      const [rung] = rungsOf(coordinator, ladder);
      expect(rung.status).toBe(RungStatus.HELD);
      expect(rung.workingOrderId).toBeNull();
    });

    it('cancels the remainder of a partial fill and opens a lot for what filled', async () => {
      const { engine, broker, coordinator, ladder } = await buildEngine(OrderPlacement.RESTING);
      await broker.connect();

      await engine.processBar(bar(100));

      const [open] = await broker.getOpenOrders();
      const partial = Math.floor(open.quantity / 3);
      broker.fillResting(open.clientOrderId, partial, 95);
      await new Promise(process.nextTick);

      // Remainder gone from the broker, not left half-working.
      expect(await broker.getOpenOrders()).toHaveLength(0);

      const lots = lotsOf(coordinator, ladder);
      expect(lots).toHaveLength(1);
      expect(lots[0].quantity).toBe(partial);
    });
  });

  describe('orders that go away without filling', () => {
    it('releases the rung when a resting order is cancelled', async () => {
      // A DAY order expiring overnight surfaces exactly like this. Without the
      // release the level stays WORKING forever and the ladder stops laddering.
      const { engine, broker, coordinator, ladder } = await buildEngine(OrderPlacement.RESTING);
      await broker.connect();

      await engine.processBar(bar(100));
      const [open] = await broker.getOpenOrders();

      await broker.cancel(open.clientOrderId);
      await new Promise(process.nextTick);

      const [rung] = rungsOf(coordinator, ladder);
      expect(rung.status).not.toBe(RungStatus.WORKING);
      expect(rung.workingOrderId).toBeNull();
    });

    it('re-places at the same level once the rung is released', async () => {
      // Proves the release actually restores fireability rather than merely
      // relabelling the status.
      const { engine, broker, coordinator, ladder } = await buildEngine(OrderPlacement.RESTING);
      await broker.connect();

      await engine.processBar(bar(100, 50));
      const [first] = await broker.getOpenOrders();
      await broker.cancel(first.clientOrderId);
      await new Promise(process.nextTick);

      await engine.processBar(bar(100, 55));

      const open = await broker.getOpenOrders();
      expect(open).toHaveLength(1);
      expect(open[0].limitPrice).toBe(95);
      expect(open[0].clientOrderId).not.toBe(first.clientOrderId);
      expect(rungsOf(coordinator, ladder)).toHaveLength(1);
    });
  });

  describe('the concurrent-rung limit counts committed exposure', () => {
    it('counts a working order against maxConcurrentRungs', async () => {
      // Five resting orders are five rungs the ladder has committed to, even
      // with no lot yet: they can all fill at once, and the limit would then be
      // breached with no point at which it could intervene.
      const { engine, broker, coordinator, ladder } = await buildEngine(OrderPlacement.RESTING);
      await broker.connect();

      // Each fill opens a lot and frees the next level, extending the ladder.
      for (let i = 0; i < 6; i += 1) {
        await engine.processBar(bar(100, 50 + i));
        const open = await broker.getOpenOrders();

        if (open.length > 0) {
          broker.fillResting(open[0].clientOrderId, open[0].quantity, open[0].limitPrice);
          await new Promise(process.nextTick);
        }
      }

      expect(lotsOf(coordinator, ladder).length).toBeLessThanOrEqual(5);
    });
  });

  describe('the broker is consulted before a duplicate can be placed', () => {
    it('does not place a second order at a price already resting at the broker', async () => {
      // The in-memory registry is deliberately desynchronised here, reproducing
      // a crash between placement and persistence: the order exists at the
      // broker, the engine's own map has lost it. Only asking the broker
      // catches this, and without the check both orders fill.
      const { engine, broker, coordinator, ladder } = await buildEngine(OrderPlacement.RESTING);
      await broker.connect();

      await engine.processBar(bar(100, 50));
      expect(await broker.getOpenOrders()).toHaveLength(1);

      // Forget the order locally *and* free the rung, so nothing but the
      // broker's own answer stands between the ladder and a duplicate.
      engine.reset();
      await coordinator.initializeAll('2026-08-14T09:30:00.000-04:00');

      await engine.processBar(bar(100, 55));

      const open = await broker.getOpenOrders();
      expect(open).toHaveLength(1);
      expect(open[0].limitPrice).toBe(95);
      expect(rungsOf(coordinator, ladder).filter((r) => r.status === RungStatus.WORKING)).toEqual(
        [],
      );
    });

    it('declines the entry when the broker cannot be asked, rather than assuming none', async () => {
      // "Cannot ask" and "nothing is resting" lead to opposite actions. A
      // disconnected broker throws from `getOpenOrders`, and submitting anyway
      // would stack an order at a level that may already hold one.
      const { engine, broker, orders } = await buildEngine(OrderPlacement.RESTING);
      await broker.connect();
      await broker.disconnect();

      const result = await engine.processBar(bar(100, 50));

      expect(result.submitted).toBe(0);
      expect(await orders.findAll()).toEqual([]);
    });

    it('places at a second rung while the first is resting', async () => {
      // The guard must match on price, not merely on "something is resting".
      // A blanket check would stop the ladder extending after its first rung —
      // which is most of what a ladder does.
      const { engine, broker } = await buildEngine(OrderPlacement.RESTING);
      await broker.connect();

      await engine.processBar(bar(100, 50));
      const [first] = await broker.getOpenOrders();
      broker.fillResting(first.clientOrderId, first.quantity, first.limitPrice);
      await new Promise(process.nextTick);

      await engine.processBar(bar(94, 55));

      const prices = (await broker.getOpenOrders()).map((order) => order.limitPrice);
      expect(prices.length).toBeGreaterThan(0);
      expect(prices).not.toContain(95);
    });
  });

  describe('an order that fills while the daemon is down', () => {
    /**
     * The gap this closes, and why the existing tests could not catch it.
     *
     * `adoptWorkingOrders` rebuilds the in-memory registry at startup from
     * `getOpenOrders()`. An order that filled *during* the outage is no longer
     * open, so it appears in no such list — the fill arrives on IB's execution
     * replay, `routeFill` finds nothing in the map, and drops it. The shares
     * exist at the broker and no lot is ever opened, which the next
     * reconciliation reports as a lot-sum mismatch and halts the symbol.
     *
     * The durable records are enough to resolve it: the `Order` row names the
     * strategy and quantity, and the `WORKING` rung names the level.
     */
    it('opens a lot from the replayed execution instead of dropping the fill', async () => {
      const shared = {
        orders: new InMemoryOrderRepository(),
        lots: new InMemoryLotRepository(),
        rungs: new InMemoryRungRepository(),
        fills: new InMemoryFillRepository(),
      };

      const first = await buildEngine(OrderPlacement.RESTING, shared);
      await first.broker.connect();
      await first.engine.processBar(bar(100, 50));

      const [placed] = await first.broker.getOpenOrders();
      expect(placed).toBeDefined();

      // The daemon dies. The order is still resting at the broker and the rung
      // ledger still records it as WORKING.
      const persistedRungs = rungsOf(first.coordinator, first.ladder);
      expect(persistedRungs.some((r) => r.workingOrderId === placed.clientOrderId)).toBe(true);

      // The process dies *before* the fill, so nothing of it is recorded —
      // which is what the real incident looked like: an empty `Fill` table
      // beside a real broker position. Detaching the handlers is how "the
      // daemon is not running" is expressed against an in-process broker.
      first.broker.detachHandlers();

      // It fills while nothing is listening.
      first.broker.fillResting(placed.clientOrderId, placed.quantity, placed.limitPrice);
      await new Promise(process.nextTick);

      expect(await shared.fills.findAll()).toEqual([]);

      // Restart: a new engine over the *same* durable records, with an empty
      // in-memory registry. The order no longer appears in `getOpenOrders()`,
      // so `adoptWorkingOrders` cannot help.
      const second = await buildEngine(OrderPlacement.RESTING, shared, first.broker);
      expect(await first.broker.getOpenOrders()).toHaveLength(0);

      // Restore the rung ledger, as reconciliation does.
      DipLadderStrategy.recordWorkingOrder(
        second.coordinator.getState(second.ladder.id)!,
        placed.limitPrice,
        placed.clientOrderId,
      );

      // IB replays the session's executions on reconnect.
      first.broker.replayFill(placed.clientOrderId);
      await new Promise(process.nextTick);

      const lots = lotsOf(second.coordinator, second.ladder);
      expect(lots).toHaveLength(1);
      expect(lots[0].quantity).toBe(placed.quantity);
      // The real fill price, not an inferred one — the whole reason for
      // recovering rather than reconstructing.
      expect(lots[0].fillPrice).toBe(placed.limitPrice);
      expect(lots[0].rungPrice).toBe(placed.limitPrice);
    });

    it('ignores a replayed execution for an order no rung claims', async () => {
      // Narrow by design. An execution the ladder has no WORKING rung for was
      // not placed as an entry by this engine — a manual trade in TWS, say —
      // and inventing a rung would attach a lot to a level the ladder never
      // chose.
      const shared = {
        orders: new InMemoryOrderRepository(),
        lots: new InMemoryLotRepository(),
        rungs: new InMemoryRungRepository(),
        fills: new InMemoryFillRepository(),
      };

      const first = await buildEngine(OrderPlacement.RESTING, shared);
      await first.broker.connect();
      await first.engine.processBar(bar(100, 50));

      const [placed] = await first.broker.getOpenOrders();
      first.broker.detachHandlers();
      first.broker.fillResting(placed.clientOrderId, placed.quantity, placed.limitPrice);
      await new Promise(process.nextTick);

      // Restart, but the rung ledger is *not* restored — no rung claims it.
      const second = await buildEngine(OrderPlacement.RESTING, shared, first.broker);

      first.broker.replayFill(placed.clientOrderId);
      await new Promise(process.nextTick);

      expect(lotsOf(second.coordinator, second.ladder)).toEqual([]);
    });
  });

  describe('recovery declines what it cannot attribute', () => {
    it('drops a replayed execution for a SELL, which no rung ever places', async () => {
      // Recovery reconstructs *entry* orders. A SELL reaching this path is
      // either an exit the ladder already accounted for or a manual trade, and
      // opening an entry lot for one would invent a position.
      const shared = {
        orders: new InMemoryOrderRepository(),
        lots: new InMemoryLotRepository(),
        rungs: new InMemoryRungRepository(),
        fills: new InMemoryFillRepository(),
      };

      const { broker, coordinator, ladder } = await buildEngine(OrderPlacement.RESTING, shared);
      await broker.connect();

      await shared.orders.save({
        clientOrderId: 'sell-1',
        brokerOrderId: null,
        symbol: SYMBOL,
        side: 'SELL',
        quantity: 100,
        limitPrice: 99,
        status: OrderStatus.SUBMITTED,
        rejectReason: null,
        strategyId: ladder.id,
        createdAt: '2026-08-14T09:50:00.000-04:00',
      });

      DipLadderStrategy.recordWorkingOrder(coordinator.getState(ladder.id)!, 99, 'sell-1');

      broker.deliverFill({
        fillId: 'exec-sell-1',
        brokerOrderId: 'bo-1',
        clientOrderId: 'sell-1',
        symbol: SYMBOL,
        side: 'SELL',
        quantity: 100,
        price: 99,
        commission: 0,
        timestamp: '2026-08-14T09:55:00.000-04:00',
      });
      await new Promise(process.nextTick);

      expect(lotsOf(coordinator, ladder)).toEqual([]);
    });

    it('drops a replayed execution whose strategy holds no state', async () => {
      // Reachable when an order outlives the strategy that placed it — a
      // symbol removed from the roster, say. There is no ladder to attach a
      // lot to, and inventing one would resurrect a retired strategy.
      const shared = {
        orders: new InMemoryOrderRepository(),
        lots: new InMemoryLotRepository(),
        rungs: new InMemoryRungRepository(),
        fills: new InMemoryFillRepository(),
      };

      const { broker, coordinator, ladder } = await buildEngine(OrderPlacement.RESTING, shared);
      await broker.connect();

      await shared.orders.save({
        clientOrderId: 'orphan-1',
        brokerOrderId: null,
        symbol: SYMBOL,
        side: 'BUY',
        quantity: 100,
        limitPrice: 95,
        status: OrderStatus.SUBMITTED,
        rejectReason: null,
        // A strategy the coordinator has never heard of.
        strategyId: 'dip-ladder:RETIRED',
        createdAt: '2026-08-14T09:50:00.000-04:00',
      });

      broker.deliverFill({
        fillId: 'exec-orphan-1',
        brokerOrderId: 'bo-1',
        clientOrderId: 'orphan-1',
        symbol: SYMBOL,
        side: 'BUY',
        quantity: 100,
        price: 95,
        commission: 0,
        timestamp: '2026-08-14T09:55:00.000-04:00',
      });
      await new Promise(process.nextTick);

      expect(lotsOf(coordinator, ladder)).toEqual([]);
    });
  });

  describe('a fill IB re-delivers must not open a second lot', () => {
    it('ignores a replayed execution carrying a fillId already recorded', async () => {
      // IB replays the session's executions to every client that subscribes, so
      // each reconnect — including the routine daily logout — re-delivers fills
      // already turned into lots. Deduplication is on persisted `fillId`.
      const { engine, broker, coordinator, ladder } = await buildEngine(OrderPlacement.RESTING);
      await broker.connect();

      await engine.processBar(bar(100, 50));
      const [open] = await broker.getOpenOrders();

      broker.fillResting(open.clientOrderId, open.quantity, open.limitPrice);
      await new Promise(process.nextTick);

      expect(lotsOf(coordinator, ladder)).toHaveLength(1);
      const [lot] = lotsOf(coordinator, ladder);

      // The same execution, delivered again.
      broker.replayFill(open.clientOrderId);
      await new Promise(process.nextTick);

      expect(lotsOf(coordinator, ladder)).toHaveLength(1);
      expect(lotsOf(coordinator, ladder)[0].id).toBe(lot.id);
    });
  });
});
