/**
 * The grid strategy driven through the full engine path against
 * `MockBrokerAdapter` — the same pattern `resting-orders.spec.ts` and
 * `resting-exits.spec.ts` use for the dip ladder.
 *
 * The fixture suites (`chop-range` et al.) exercise `IMMEDIATE` placement and
 * say nothing about a strategy that rests every order and recomputes on
 * fills rather than on the next bar's close — this file is that coverage for
 * the grid strategy, mirroring the ladder's own reasoning for why its
 * resting-order behaviour needed a dedicated suite rather than the fixtures.
 *
 * `FillMode.MARKET_AWARE` is what makes any of this testable: a marketable
 * order fills on arrival via `advanceSimulatedMarket`, driven per bar exactly
 * as the assembled app drives it in `engine.module.ts`.
 */

import { FillMode, MockBrokerAdapter } from '../broker/mock/mock-broker.adapter';
import { ExecutionMode } from '../config/execution-mode';
import { equityContract } from '../domain/contract';
import { ReplayService } from '../market-data/mock/replay.service';
import { Bar, BarSize } from '../market-data/types';
import { GridReconciliationService } from '../reconciliation/grid-reconciliation.service';
import { SymbolHaltService } from '../reconciliation/symbol-halt.service';
import {
  InMemoryFillRepository,
  InMemoryGridLotRepository,
  InMemoryLotRepository,
  InMemoryOrderIntentRepository,
  InMemoryOrderRepository,
  InMemoryRungRepository,
} from '../repositories/in-memory/in-memory.repositories';
import { KillSwitchService } from '../risk/kill-switch.service';
import { InMemoryRiskEventSink } from '../risk/risk-event';
import { RiskManagerService } from '../risk/risk-manager.service';
import { buildRiskConfig } from '../risk/risk.config';
import { CoordinatorService } from '../strategies/coordinator.service';
import { buildGridConfig } from '../strategies/grid/config';
import { GridStrategy } from '../strategies/grid/grid.strategy';
import { GridLotStatus } from '../strategies/grid/lot';
import { EngineService } from './engine.service';

const SYMBOL = 'TQQQ';

function bar(close: number, timestamp: string, open = close): Bar {
  return {
    symbol: SYMBOL,
    barSize: BarSize.ONE_MIN,
    timestamp,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: 1_000,
  };
}

async function buildEngine(options: { fillMode?: FillMode } = {}) {
  const config = buildGridConfig(SYMBOL, {
    quantity: 10,
    gap: 1,
    maxBuyLevels: 2,
    maxSellOrders: 2,
    entryBuffer: 0.05,
  });
  const grid = new GridStrategy(config);
  const coordinator = new CoordinatorService();

  coordinator.register({ strategy: grid, enabled: true, symbols: [SYMBOL] });

  const broker = new MockBrokerAdapter({
    equity: 175_000,
    fillMode: options.fillMode ?? FillMode.MARKET_AWARE,
  });
  await broker.connect();

  const sink = new InMemoryRiskEventSink();
  const risk = new RiskManagerService(
    buildRiskConfig({ accountEquity: 175_000, perSymbolLimits: { [SYMBOL]: 40_000 } }),
    ExecutionMode.PAPER,
    new KillSwitchService(sink),
    sink,
  );

  const gridLots = new InMemoryGridLotRepository();
  const engine = new EngineService(
    new ReplayService(),
    coordinator,
    risk,
    broker,
    new InMemoryOrderIntentRepository(),
    new InMemoryOrderRepository(),
    new InMemoryFillRepository(),
    new InMemoryLotRepository(),
    new InMemoryRungRepository(),
    ExecutionMode.PAPER,
    new SymbolHaltService(),
    null,
    gridLots,
  );

  await coordinator.initializeAll('2026-08-14T09:30:00.000-04:00');

  return { engine, broker, coordinator, grid, gridLots, config };
}

function gridLotsOf(coordinator: CoordinatorService, grid: GridStrategy) {
  return GridStrategy.lotsOf(coordinator.getState(grid.id)!) ?? [];
}

/**
 * The fill router is invoked as a fire-and-forget subscriber (`onFill`), and
 * `EngineService.routeFill` chains its work onto a promise — the same
 * asynchronous gap `resting-orders.spec.ts`/`resting-exits.spec.ts` flush
 * with a macrotask so a fill's routing (and, here, its recompute) has
 * genuinely completed before the next assertion or bar.
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('grid strategy — engine integration', () => {
  it('flat: the session-open bar places a marketable buy that fills, opening a lot and immediately resting its dip-buys and sell', async () => {
    const { engine, coordinator, grid, broker } = await buildEngine();

    await engine.processBar(bar(100, '2026-08-14T09:30:00.000-04:00'));
    await flush();

    const lots = gridLotsOf(coordinator, grid);
    expect(lots).toHaveLength(1);
    expect(lots[0].status).toBe(GridLotStatus.HELD);
    expect(lots[0].fillPrice).toBe(100);
    expect(lots[0].sellTarget).toBe(101);
    expect(lots[0].workingOrderId).not.toBeNull();

    const resting = await broker.getOpenOrders();
    const buys = resting
      .filter((o) => o.side === 'BUY')
      .map((o) => o.limitPrice)
      .sort((a, b) => a - b);
    const sells = resting.filter((o) => o.side === 'SELL');

    // The flat entry itself uses `DAILY_AVERAGE` (marketable-at-close, filed
    // under the "0 held lots" branch); the fill it produces immediately
    // triggers the fill-recompute, which always uses `GRID_STEPS` — two
    // levels below the one held lot's fill price, gap=1 apart.
    expect(buys).toEqual([98, 99]);
    expect(sells).toHaveLength(1);
    expect(sells[0]).toMatchObject({ limitPrice: 101, quantity: 10 });
  });

  it('a dip-buy fill opens a second lot and rests its own sell immediately, without waiting for the next bar', async () => {
    const { engine, coordinator, grid, broker } = await buildEngine();

    await engine.processBar(bar(100, '2026-08-14T09:30:00.000-04:00'));
    await flush();

    // Price reaches the first dip level (99) — MARKET_AWARE fills it via
    // `advanceMarket` before the bar is even dispatched to the strategy.
    await engine.processBar(bar(99, '2026-08-14T09:31:00.000-04:00'));
    await flush();

    const lots = gridLotsOf(coordinator, grid);
    expect(lots.filter((l) => l.status === GridLotStatus.HELD)).toHaveLength(2);
    expect(lots.map((l) => l.fillPrice).sort((a, b) => a - b)).toEqual([99, 100]);

    // Both lots have their own resting sell — the second one placed by the
    // fill-triggered recompute, not by an `onBar` this session will not fire
    // again until tomorrow.
    const sells = (await broker.getOpenOrders())
      .filter((o) => o.side === 'SELL')
      .map((o) => o.limitPrice)
      .sort((a, b) => a - b);
    expect(sells).toEqual([100, 101]);
  });

  it('a rally fills the resting sell at a lot’s frozen target, closing it', async () => {
    const { engine, coordinator, grid } = await buildEngine();

    await engine.processBar(bar(100, '2026-08-14T09:30:00.000-04:00'));
    await flush();

    await engine.processBar(bar(101, '2026-08-14T09:31:00.000-04:00'));
    await flush();

    const lots = gridLotsOf(coordinator, grid);
    const closed = lots.find((l) => l.id === 'TQQQ-grid-lot-1');
    expect(closed?.status).toBe(GridLotStatus.CLOSED);
    expect(closed?.exitPrice).toBe(101);

    // Closing the only held lot leaves the strategy flat for an instant, and
    // the exit-triggered recompute's flat-entry rule buys right back in at
    // the same price — a marketable order on arrival, by construction. This
    // is the "always in the market" consequence of a 0-lots rule with no
    // minimum dwell time, not a test artefact.
    const held = lots.filter((l) => l.status === GridLotStatus.HELD);
    expect(held).toHaveLength(1);
    expect(held[0].fillPrice).toBe(101);
  });

  it('a sell cancelled out of band is repriced at the next session’s open, pegged to a gap past its frozen target', async () => {
    const { engine, coordinator, grid, broker } = await buildEngine();

    await engine.processBar(bar(100, '2026-08-14T09:30:00.000-04:00'));
    await flush();

    const [lot] = gridLotsOf(coordinator, grid);
    const sellOrderId = lot.workingOrderId!;
    expect(sellOrderId).not.toBeNull();

    // Simulates a DAY expiry or an operator cancelling the resting sell in
    // TWS: the broker reports it gone, and the engine's `onOrderStatus`
    // router releases the lot's `workingOrderId`.
    await broker.cancel(sellOrderId);
    await flush();

    expect(gridLotsOf(coordinator, grid)[0].workingOrderId).toBeNull();

    // The next session's first bar, already above the frozen 101 target —
    // the gap this strategy has no rung to strand a stale level against.
    await engine.processBar(bar(102, '2026-08-17T09:30:00.000-04:00'));
    await flush();

    const lots = gridLotsOf(coordinator, grid);
    const original = lots.find((l) => l.id === 'TQQQ-grid-lot-1');

    // Pegged to the market close rather than the stale 101 target — and
    // filled immediately, because a limit priced exactly at the current
    // close is marketable on arrival. This is the concrete shape of "if the
    // current price is higher, it's market price": the fill happens now,
    // not a resting order waiting at 102.
    expect(original?.status).toBe(GridLotStatus.CLOSED);
    expect(original?.exitPrice).toBe(102);

    // Flat for an instant, the strategy immediately re-enters at the same
    // price (see the previous test), so its own fresh sell is what's left
    // resting — one level higher, above the market this time.
    const held = lots.filter((l) => l.status === GridLotStatus.HELD);
    expect(held).toHaveLength(1);
    expect(held[0].fillPrice).toBe(102);

    const sells = await broker
      .getOpenOrders()
      .then((orders) => orders.filter((o) => o.side === 'SELL'));

    expect(sells).toHaveLength(1);
    expect(sells[0]).toMatchObject({ limitPrice: 103, quantity: 10 });
  });

  /**
   * `POST /orders/place-missing` (`EngineService.placeMissingOrders`) must
   * work for a grid candidate, not just a ladder one — `contractFor` used to
   * consult `ladderConfigFor` alone, so a grid candidate's `strategyId`
   * (`grid:TQQQ`) never matched and every grid placement was silently
   * declined as "no contract is registered", regardless of what the risk
   * manager decided.
   */
  it('places a missing grid sell for a lot left unprotected by an out-of-band cancel', async () => {
    const { engine, coordinator, grid, broker } = await buildEngine();

    await engine.processBar(bar(100, '2026-08-14T09:30:00.000-04:00'));
    await flush();

    const [lot] = gridLotsOf(coordinator, grid);
    await broker.cancel(lot.workingOrderId!);
    await flush();

    expect(gridLotsOf(coordinator, grid)[0].workingOrderId).toBeNull();

    const result = await engine.placeMissingOrders([
      {
        strategyId: grid.id,
        symbol: SYMBOL,
        side: 'SELL',
        quantity: lot.quantity,
        limitPrice: lot.sellTarget,
        reason: 'test — unprotected lot',
        lotId: lot.id,
      },
    ]);

    expect(result.declined).toEqual([]);
    expect(result.placed).toHaveLength(1);

    const updated = gridLotsOf(coordinator, grid).find((l) => l.id === lot.id);
    expect(updated?.workingOrderId).not.toBeNull();
  });

  /**
   * `EngineService.gridStrategyLots`/`gridLotsBySymbol` are what `GET
   * /grid/lots` reads — the grid counterpart to `ladderLots`/
   * `ladderRungsBySymbol`, asserted the same way `engine.service.spec.ts`
   * asserts those for the ladder.
   */
  it('projects grid lots by symbol for the API to serve', async () => {
    const { engine } = await buildEngine();

    await engine.processBar(bar(100, '2026-08-14T09:30:00.000-04:00'));
    await flush();

    expect(engine.gridStrategyLots()).toHaveLength(1);

    const bySymbol = engine.gridLotsBySymbol();
    expect(bySymbol).toEqual([{ symbol: SYMBOL, lots: expect.any(Array) }]);
    expect(bySymbol[0].lots).toHaveLength(1);
    expect(bySymbol[0].lots[0].fillPrice).toBe(100);
  });

  /**
   * The grid counterpart to `reconciliation.service.spec.ts`'s "adopts a
   * resting order the ladder has no record of" — the same crash window, on
   * the grid strategy's own reconciliation path. A grid buy carries no
   * persisted "pending" bookkeeping of its own (`GridStrategy`'s doc
   * comment), so if `GridReconciliationService.reconcileOpenOrders` did not
   * feed this order back into `EngineService.adoptWorkingOrders`, the fill
   * below would find no working-order entry and `dispatchFill` would return
   * having done nothing — the shares would exist at the broker and no lot
   * would ever open for them, surfacing later only as a `GRID_LOT_SUM_MISMATCH`.
   */
  it('adopts a resting buy the grid strategy has no record of, and opens a lot when it later fills', async () => {
    const { engine, coordinator, grid, broker, gridLots } = await buildEngine({
      fillMode: FillMode.RESTING,
    });

    // Placed by a "previous process": resting at the broker, absent from any
    // grid lot and from the in-memory working-order registry a fresh process
    // starts with.
    await broker.submit({
      clientOrderId: 'co-from-before-restart',
      contract: equityContract(SYMBOL),
      side: 'BUY',
      quantity: 10,
      orderType: 'LMT',
      limitPrice: 95,
      timeInForce: 'DAY',
      timestamp: '2026-08-14T09:29:00.000-04:00',
    });

    const halts = new SymbolHaltService();
    const gridReconciliation = new GridReconciliationService(
      coordinator,
      halts,
      broker,
      gridLots,
      new InMemoryLotRepository(),
      new InMemoryFillRepository(),
    );
    // The same wiring `engine.module.ts` does between the grid strategy's
    // reconciliation and the engine's working-order registry.
    gridReconciliation.onOpenOrdersReconciled = (strategyId, symbol, orders) => {
      engine.adoptWorkingOrders(strategyId, symbol, orders);
    };

    const report = await gridReconciliation.reconcileAll('2026-08-14T09:29:30.000-04:00');

    // Nothing is held yet and the broker reports no *position* (an unfilled
    // resting order is not one), so this reconciles cleanly and the halt
    // never fires — it is open-order reconciliation, not the lot-sum
    // assertion, that must adopt the order.
    expect(report.clean).toBe(true);
    expect(halts.isHalted(SYMBOL)).toBe(false);

    // The order fills after the "restart" — nothing in this process placed
    // it, so without the adoption above this fill would be silently dropped.
    broker.fillResting('co-from-before-restart', 10, 95, '2026-08-14T09:30:00.000-04:00');
    await flush();

    const lots = gridLotsOf(coordinator, grid);
    expect(lots).toHaveLength(1);
    expect(lots[0].status).toBe(GridLotStatus.HELD);
    expect(lots[0].fillPrice).toBe(95);
    expect(lots[0].quantity).toBe(10);
    expect(lots[0].sellTarget).toBe(96);
  });
});
