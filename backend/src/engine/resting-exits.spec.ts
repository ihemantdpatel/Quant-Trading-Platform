/**
 * Resting exit orders — Story 14a.
 *
 * Story 13 moved *entries* onto resting limit orders and left exits behind, so
 * a sell was submitted with no working-order registration, no persistent fill
 * routing, and a lot closed the moment the intent was created rather than when
 * the broker confirmed anything. Every test here targets a failure that
 * asymmetry produced and that the entry-side suite could not catch:
 *
 * - a lot closed against an order that was rejected and never filled
 * - a rung re-armed against shares that were never sold
 * - a lot closed at its assumed target rather than the broker's fill price
 * - a second sell stacked against a lot one order already covers
 * - a rally spiking through a target intra-bar selling nothing
 *
 * The harness mirrors `resting-orders.spec.ts` deliberately: these are the same
 * engine-level rules seen from the other side, and a reader comparing the two
 * files should find the differences meaningful rather than incidental.
 */

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
import { LotStatus } from '../strategies/dip-ladder/lot';
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

async function buildEngine(fillMode: FillMode = FillMode.MARKET_AWARE) {
  const config = buildDipLadderConfig(SYMBOL, {
    symbolCapital: 40_000,
    orderPlacement: OrderPlacement.RESTING,
  });
  const ladder = new DipLadderStrategy(config);
  const coordinator = new CoordinatorService();

  coordinator.register({ strategy: ladder, enabled: true, symbols: [SYMBOL] });

  const broker = new MockBrokerAdapter({ equity: 175_000, fillMode });
  const sink = new InMemoryRiskEventSink();
  const risk = new RiskManagerService(
    buildRiskConfig({ accountEquity: 175_000, perSymbolLimits: { [SYMBOL]: 40_000 } }),
    ExecutionMode.PAPER,
    new KillSwitchService(sink),
    sink,
  );

  const orders = new InMemoryOrderRepository();
  const lots = new InMemoryLotRepository();
  const engine = new EngineService(
    new ReplayService(),
    coordinator,
    risk,
    broker,
    new InMemoryOrderIntentRepository(),
    orders,
    new InMemoryFillRepository(),
    lots,
    new InMemoryRungRepository(),
    ExecutionMode.PAPER,
    new SymbolHaltService(),
  );

  await coordinator.initializeAll('2026-08-14T09:30:00.000-04:00');

  return { engine, broker, coordinator, ladder, orders, lots, config };
}

function lotsOf(coordinator: CoordinatorService, ladder: DipLadderStrategy) {
  return DipLadderStrategy.lotsOf(coordinator.getState(ladder.id)!) ?? [];
}

function rungsOf(coordinator: CoordinatorService, ladder: DipLadderStrategy) {
  return DipLadderStrategy.rungsOf(coordinator.getState(ladder.id)!) ?? [];
}

/**
 * Walks price down to 95 so one lot is held, then back to `close`.
 *
 * The entry rests at 95 (5% below the 100 anchor) and fills when price reaches
 * it, which is what leaves a lot with a resting sell at its 99.75 target.
 */
async function openOneLot(engine: EngineService, minuteFrom = 50) {
  await engine.processBar(bar(100, minuteFrom));
  // Price reaches the resting entry; the lot is created by the fill router.
  await engine.processBar(bar(95, minuteFrom + 1));
  // The fill router is invoked as a fire-and-forget subscriber, so the lot it
  // opens exists only after the microtask queue drains.
  await new Promise((resolve) => setImmediate(resolve));
  // A further bar, because the sell is emitted by `onBar` from ladder state and
  // the fill that created the lot arrives *during* the previous bar. This is the
  // real one-bar latency of the design, not a test artifact: a lot opened by a
  // fill is protected from the next evaluation onward.
  await engine.processBar(bar(95, minuteFrom + 2));
}

describe('resting exit orders', () => {
  describe('placement', () => {
    it('rests a SELL at the lot’s target as soon as the lot opens', async () => {
      const { engine, broker, coordinator, ladder } = await buildEngine();
      await broker.connect();

      await openOneLot(engine);

      const [lot] = lotsOf(coordinator, ladder);
      expect(lot.status).toBe(LotStatus.HELD);
      expect(lot.workingOrderId).not.toBeNull();

      const sells = (await broker.getOpenOrders()).filter((o) => o.side === 'SELL');
      expect(sells).toHaveLength(1);
      // 5% above the 95 fill — the lot's own frozen target.
      expect(sells[0].limitPrice).toBe(lot.exitTarget);
    });

    it('does not stack a second sell against a lot already covered', async () => {
      // The exit-side equivalent of the WORKING rung guard. Without
      // `Lot.workingOrderId` every bar would emit another sell for the same
      // shares, and each one that filled would sell a position held once.
      const { engine, broker, coordinator, ladder } = await buildEngine();
      await broker.connect();

      await openOneLot(engine);
      await engine.processBar(bar(96, 53));
      await engine.processBar(bar(97, 54));

      const sells = (await broker.getOpenOrders()).filter((o) => o.side === 'SELL');
      expect(sells).toHaveLength(1);
      expect(lotsOf(coordinator, ladder)).toHaveLength(1);
    });

    it('refuses to rest a sell whose target is already below the market', async () => {
      // `isRestableExit`. A target under the market is marketable and would sell
      // at the prevailing price rather than at the level — the case
      // `recover:lots` can produce by reconstructing an old lot. Nothing is
      // placed and the lot stays held.
      const { engine, broker, coordinator, ladder } = await buildEngine(FillMode.RESTING);
      await broker.connect();

      await openOneLot(engine);

      const [lot] = lotsOf(coordinator, ladder);
      // Force the lot's target below the market by moving price far above it.
      lot.workingOrderId = null;
      await engine.processBar(bar(lot.exitTarget + 10, 56));

      expect(lotsOf(coordinator, ladder)[0].status).toBe(LotStatus.HELD);
    });
  });

  describe('the fill is what closes the lot', () => {
    it('closes at the broker’s fill price, not the assumed target', async () => {
      const { engine, broker, coordinator, ladder } = await buildEngine(FillMode.RESTING);
      await broker.connect();

      await openOneLot(engine);

      const [held] = lotsOf(coordinator, ladder);
      const orderId = held.workingOrderId!;

      // A price strictly better than the target, so a lot closed at its own
      // assumption would be distinguishable from one closed at the real fill.
      broker.fillResting(orderId, held.quantity, 99.9, bar(100, 58).timestamp);
      await new Promise((resolve) => setImmediate(resolve));

      const [closed] = lotsOf(coordinator, ladder);
      expect(closed.status).toBe(LotStatus.CLOSED);
      expect(closed.exitPrice).toBe(99.9);
      expect(closed.exitPrice).not.toBe(closed.exitTarget);
    });

    it('re-arms the rung only once the sell has filled', async () => {
      const { engine, broker, coordinator, ladder } = await buildEngine(FillMode.RESTING);
      await broker.connect();

      await openOneLot(engine);

      const [held] = lotsOf(coordinator, ladder);
      expect(rungsOf(coordinator, ladder)[0].status).toBe(RungStatus.HELD);

      broker.fillResting(
        held.workingOrderId!,
        held.quantity,
        held.exitTarget,
        bar(100, 58).timestamp,
      );
      await new Promise((resolve) => setImmediate(resolve));

      expect(rungsOf(coordinator, ladder)[0].status).toBe(RungStatus.RE_ARMED);
    });

    it('leaves the lot HELD and the rung un-re-armed when the sell is rejected', async () => {
      // The defect this story exists to fix. Pre-14a the lot closed and the rung
      // re-armed when the *intent* was created, so a rejected sell left the
      // ladder believing it was flat at a level it still held — and free to buy
      // there again against exposure it had never released.
      const { engine, broker, coordinator, ladder } = await buildEngine(FillMode.RESTING);
      await broker.connect();

      await openOneLot(engine);

      const [held] = lotsOf(coordinator, ladder);
      const orderId = held.workingOrderId!;

      // A cancellation the engine *is* told about — the ordinary path through
      // `routeOrderStatus`. (`expireOrder` is deliberately silent and models the
      // reconciliation case instead.)
      await broker.cancel(orderId);
      await new Promise((resolve) => setImmediate(resolve));

      const [after] = lotsOf(coordinator, ladder);
      expect(after.status).toBe(LotStatus.HELD);
      expect(after.workingOrderId).toBeNull();
      expect(rungsOf(coordinator, ladder)[0].status).toBe(RungStatus.HELD);
    });
  });

  describe('partial fills split the lot', () => {
    it('closes the filled portion and keeps the remainder held at the same basis', async () => {
      const { engine, broker, coordinator, ladder } = await buildEngine(FillMode.RESTING);
      await broker.connect();

      await openOneLot(engine);

      const [held] = lotsOf(coordinator, ladder);
      const originalQuantity = held.quantity;
      const sold = Math.floor(originalQuantity / 2);

      broker.fillResting(held.workingOrderId!, sold, held.exitTarget, bar(100, 58).timestamp);
      await new Promise((resolve) => setImmediate(resolve));

      const lots = lotsOf(coordinator, ladder);
      const closed = lots.filter((lot) => lot.status === LotStatus.CLOSED);
      const remaining = lots.filter((lot) => lot.status === LotStatus.HELD);

      expect(closed).toHaveLength(1);
      expect(remaining).toHaveLength(1);
      expect(closed[0].quantity).toBe(sold);
      expect(remaining[0].quantity).toBe(originalQuantity - sold);

      // The shares are the same shares: same basis, same frozen target, same
      // place in the FIFO queue. Only the id differs.
      expect(remaining[0].fillPrice).toBe(closed[0].fillPrice);
      expect(remaining[0].exitTarget).toBe(closed[0].exitTarget);
      expect(remaining[0].openedAt).toBe(closed[0].openedAt);
      expect(remaining[0].id).not.toBe(closed[0].id);

      // The sum is what reconciliation checks against the broker position.
      expect(closed[0].quantity + remaining[0].quantity).toBe(originalQuantity);
    });

    it('does not re-arm a rung that still holds the remainder', async () => {
      // Re-arming a partially-sold level would let the ladder place an entry
      // against exposure it has not actually released.
      const { engine, broker, coordinator, ladder } = await buildEngine(FillMode.RESTING);
      await broker.connect();

      await openOneLot(engine);

      const [held] = lotsOf(coordinator, ladder);
      broker.fillResting(held.workingOrderId!, 1, held.exitTarget, bar(100, 58).timestamp);
      await new Promise((resolve) => setImmediate(resolve));

      expect(rungsOf(coordinator, ladder)[0].status).toBe(RungStatus.HELD);
    });
  });

  describe('a restart must not duplicate a resting sell', () => {
    it('persists the lot’s working order id on the bar that places it', async () => {
      // The crash window. `Lot.workingOrderId` is written by the submit path and
      // nothing else on that bar writes it — so without a post-submission
      // persist the database held a lot with no working order while a live sell
      // rested at IB. On restart the lot looked unprotected, a second sell went
      // out, and both could fill.
      const { engine, broker, coordinator, ladder, lots } = await buildEngine();
      await broker.connect();

      await openOneLot(engine);

      const [inMemory] = lotsOf(coordinator, ladder);
      expect(inMemory.workingOrderId).not.toBeNull();

      const [persisted] = await lots.findBySymbol(SYMBOL);
      expect(persisted.workingOrderId).toBe(inMemory.workingOrderId);
    });

    it('does not place a second sell for a lot whose order still rests at the broker', async () => {
      const { engine, broker, coordinator, ladder } = await buildEngine();
      await broker.connect();

      await openOneLot(engine);

      const sellsBefore = (await broker.getOpenOrders()).filter((o) => o.side === 'SELL');
      expect(sellsBefore).toHaveLength(1);

      // Clear only the in-memory mark, modelling state restored from a database
      // written before the mark was persisted. The order is still live at IB.
      lotsOf(coordinator, ladder)[0].workingOrderId = null;

      await engine.processBar(bar(96, 55));

      const sellsAfter = (await broker.getOpenOrders()).filter((o) => o.side === 'SELL');
      expect(sellsAfter).toHaveLength(1);
      expect(sellsAfter[0].clientOrderId).toBe(sellsBefore[0].clientOrderId);
    });
  });

  describe('the intra-bar rally IMMEDIATE misses', () => {
    it('fills a resting sell on a spike that retraces before the close', async () => {
      // The exit-side mirror of the dip that wicks through a rung and recovers.
      // Under IMMEDIATE the sell is only created once a bar *closes* at or above
      // the target, so a rally through it that retraces sells nothing.
      const { engine, broker, coordinator, ladder } = await buildEngine();
      await broker.connect();

      await openOneLot(engine);

      const [held] = lotsOf(coordinator, ladder);

      // Price reaches the target intra-bar; the exchange fills the resting order
      // on the way through.
      broker.advanceMarket(held.exitTarget, bar(100, 58).timestamp);
      await new Promise((resolve) => setImmediate(resolve));

      // …and the bar itself closes back below it.
      await engine.processBar(bar(96, 59));

      const closed = lotsOf(coordinator, ladder).filter((lot) => lot.status === LotStatus.CLOSED);
      expect(closed).toHaveLength(1);
      expect(closed[0].exitPrice).toBe(held.exitTarget);
    });
  });
});
