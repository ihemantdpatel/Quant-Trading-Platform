/**
 * `GridReconciliationService` — the grid strategy's restart-safety suite,
 * parallel to `reconciliation.service.spec.ts` at a much smaller scale.
 *
 * Runs against `CoordinatorService`, `InMemoryGridLotRepository`, and
 * `MockBrokerAdapter` directly — no `EngineService`/`StartupSequence` needed,
 * since this service depends on none of the engine's submit/fill machinery.
 */

import { FillMode, MockBrokerAdapter } from '../broker/mock/mock-broker.adapter';
import { equityContract } from '../domain/contract';
import {
  InMemoryGridLotRepository,
  InMemoryLotRepository,
} from '../repositories/in-memory/in-memory.repositories';
import { CoordinatorService } from '../strategies/coordinator.service';
import { buildDipLadderConfig } from '../strategies/dip-ladder/config';
import { DipLadderStrategy } from '../strategies/dip-ladder/dip-ladder.strategy';
import { buildGridConfig } from '../strategies/grid/config';
import { GridStateData, GridStrategy } from '../strategies/grid/grid.strategy';
import { GridLot, GridLotStatus } from '../strategies/grid/lot';
import { Lot, LotStatus } from '../strategies/dip-ladder/lot';
import { StrategyState } from '../strategies/types';
import { GridReconciliationStatus } from './grid-lot-sum-assertion';
import {
  GRID_HALT_BROKER_UNAVAILABLE,
  GRID_HALT_LOT_SUM_MISMATCH,
  GridReconciliationService,
} from './grid-reconciliation.service';
import { SymbolHaltService } from './symbol-halt.service';

const NOW = '2025-01-02T09:30:00.000-05:00';

function gridData(state: StrategyState): GridStateData {
  return state.data as unknown as GridStateData;
}

function ladderLot(id: string, overrides: Partial<Lot> = {}): Lot {
  return {
    id,
    rungPrice: 95,
    fillPrice: 95,
    quantity: 100,
    openedAt: '2025-01-02T09:30:00.000-05:00',
    exitTarget: 99.75,
    status: LotStatus.HELD,
    closedAt: null,
    exitPrice: null,
    workingOrderId: null,
    ...overrides,
  };
}

function gridLot(id: string, overrides: Partial<GridLot> = {}): GridLot {
  return {
    id,
    fillPrice: 95,
    quantity: 100,
    openedAt: '2025-01-02T09:30:00.000-05:00',
    sellTarget: 95.5,
    status: GridLotStatus.HELD,
    closedAt: null,
    exitPrice: null,
    workingOrderId: null,
    ...overrides,
  };
}

function buildHarness(
  options: {
    lots?: InMemoryGridLotRepository;
    /** The ladder's own lots for the same symbol — see `siblingHeldQuantity`. */
    ladderLots?: InMemoryLotRepository;
    broker?: MockBrokerAdapter;
    symbol?: string;
    /** Also register a dip-ladder instance, to prove it is skipped entirely. */
    withLadder?: boolean;
    /** Registers the grid instance disabled — see `releaseStaleDisabledSells`. */
    gridEnabled?: boolean;
  } = {},
) {
  const symbol = options.symbol ?? 'TQQQ';
  const lots = options.lots ?? new InMemoryGridLotRepository();
  const ladderLots = options.ladderLots ?? new InMemoryLotRepository();
  const broker = options.broker ?? new MockBrokerAdapter();
  const halts = new SymbolHaltService();
  const coordinator = new CoordinatorService();

  const grid = new GridStrategy(buildGridConfig(symbol));
  coordinator.register({
    strategy: grid,
    enabled: options.gridEnabled ?? true,
    symbols: [symbol],
  });

  if (options.withLadder) {
    const ladder = new DipLadderStrategy(buildDipLadderConfig(symbol, { symbolCapital: 100_000 }));
    coordinator.register({ strategy: ladder, enabled: true, symbols: [symbol] });
  }

  const reconciliation = new GridReconciliationService(
    coordinator,
    halts,
    broker,
    lots,
    ladderLots,
  );

  return { coordinator, grid, lots, ladderLots, broker, halts, reconciliation, symbol };
}

describe('GridReconciliationService', () => {
  describe('reconcileAll — clean restart', () => {
    it('restores held lots into live state when the sum matches', async () => {
      const { coordinator, lots, broker, reconciliation, grid, symbol } = buildHarness();
      await coordinator.initializeAll(NOW);
      await lots.saveAll([gridLot('TQQQ-grid-lot-1', { quantity: 100 })], grid.id, symbol);
      broker.seedPosition({ symbol, quantity: 100, averageCost: 95 });

      const report = await reconciliation.reconcileAll(NOW);

      expect(report.clean).toBe(true);
      expect(report.symbols[0].resumed).toBe(true);
      expect(report.symbols[0].restoredLots).toBe(1);
      expect(GridStrategy.lotsOf(coordinator.getState(grid.id)!)).toHaveLength(1);
    });

    it('reconciles flat at the broker with no held lots', async () => {
      const { coordinator, reconciliation } = buildHarness();
      await coordinator.initializeAll(NOW);

      const report = await reconciliation.reconcileAll(NOW);

      expect(report.clean).toBe(true);
      expect(report.symbols[0].verdict.status).toBe(GridReconciliationStatus.MATCHED);
    });

    it('re-derives lotSequence from the highest restored lot id', async () => {
      const { coordinator, lots, broker, reconciliation, grid, symbol } = buildHarness();
      await coordinator.initializeAll(NOW);
      await lots.saveAll(
        [
          gridLot('TQQQ-grid-lot-3', { quantity: 40 }),
          gridLot('TQQQ-grid-lot-7', { quantity: 60 }),
        ],
        grid.id,
        symbol,
      );
      broker.seedPosition({ symbol, quantity: 100, averageCost: 95 });

      await reconciliation.reconcileAll(NOW);

      const state = coordinator.getState(grid.id)!;
      expect(gridData(state).lotSequence).toBe(7);
    });

    it('skips a non-grid strategy entirely', async () => {
      const { coordinator, reconciliation, broker, symbol } = buildHarness({ withLadder: true });
      await coordinator.initializeAll(NOW);
      broker.seedPosition({ symbol, quantity: 0, averageCost: 0 });

      const report = await reconciliation.reconcileAll(NOW);

      expect(report.symbols).toHaveLength(1);
      expect(report.symbols[0].strategyId).toBe('grid:TQQQ');
    });
  });

  describe('reconcileAll — lot-sum mismatch', () => {
    it('halts with no repair when the broker reports more shares than lots explain', async () => {
      const { coordinator, lots, broker, reconciliation, halts, grid, symbol } = buildHarness();
      await coordinator.initializeAll(NOW);
      await lots.saveAll([gridLot('TQQQ-grid-lot-1', { quantity: 50 })], grid.id, symbol);
      broker.seedPosition({ symbol, quantity: 150, averageCost: 95 });

      const report = await reconciliation.reconcileAll(NOW);

      expect(report.clean).toBe(false);
      expect(halts.isHalted(symbol)).toBe(true);
      expect(halts.haltFor(symbol)?.code).toBe(GRID_HALT_LOT_SUM_MISMATCH);
      expect(report.symbols[0].verdict.status).toBe(GridReconciliationStatus.QUANTITY_MISMATCH);
      // Nothing restored — a halted symbol resumes with nothing, not the
      // suspect lots.
      expect(GridStrategy.lotsOf(coordinator.getState(grid.id)!)).toEqual([]);
    });

    it('halts when the database holds lots the broker does not report', async () => {
      const { coordinator, lots, broker, reconciliation, halts, grid, symbol } = buildHarness();
      await coordinator.initializeAll(NOW);
      await lots.saveAll([gridLot('TQQQ-grid-lot-1', { quantity: 50 })], grid.id, symbol);
      broker.seedPosition({ symbol, quantity: 0, averageCost: 0 });

      const report = await reconciliation.reconcileAll(NOW);

      expect(report.symbols[0].verdict.status).toBe(GridReconciliationStatus.MISSING_AT_BROKER);
      expect(halts.haltFor(symbol)?.code).toBe(GRID_HALT_LOT_SUM_MISMATCH);
    });

    it('does not attempt any repair or synthetic lot — halts with the mismatch reported verbatim', async () => {
      const { coordinator, lots, broker, reconciliation, grid, symbol } = buildHarness();
      await coordinator.initializeAll(NOW);
      await lots.saveAll([gridLot('TQQQ-grid-lot-1', { quantity: 50 })], grid.id, symbol);
      broker.seedPosition({ symbol, quantity: 150, averageCost: 95 });

      await reconciliation.reconcileAll(NOW);

      // The persisted ledger is untouched — no rebuild was written back.
      expect(await lots.findByStrategy(grid.id)).toHaveLength(1);
      expect((await lots.findByStrategy(grid.id))[0].quantity).toBe(50);
    });
  });

  describe('cross-strategy holdings (ladder trading the same symbol)', () => {
    // The mirror of `reconciliation.service.spec.ts`'s own
    // 'cross-strategy holdings' suite — the two strategies trade the same
    // symbol by design (`GRID_SYMBOL` in `strategies.module.ts`), so a real
    // position the ladder still holds must not read as an unexplained grid
    // mismatch. See `GridReconciliationService.siblingHeldQuantity`.
    it('reconciles when the ladder already accounts for the rest of the broker position', async () => {
      const { coordinator, lots, ladderLots, broker, reconciliation, halts, grid, symbol } =
        buildHarness();
      await coordinator.initializeAll(NOW);
      await lots.saveAll([gridLot('TQQQ-grid-lot-1', { quantity: 50 })], grid.id, symbol);
      await ladderLots.saveAll([ladderLot('TQQQ-lot-1', { quantity: 100 })], symbol);
      broker.seedPosition({ symbol, quantity: 150, averageCost: 95 });

      const report = await reconciliation.reconcileAll(NOW);

      expect(report.clean).toBe(true);
      expect(halts.isHalted(symbol)).toBe(false);
      expect(report.symbols[0].verdict.status).toBe(GridReconciliationStatus.MATCHED);
      expect(report.symbols[0].verdict.lotQuantity).toBe(50);
    });

    it('still halts when the grid and ladder lots together do not explain the broker position', async () => {
      const { coordinator, lots, ladderLots, broker, reconciliation, halts, symbol } =
        buildHarness();
      await coordinator.initializeAll(NOW);
      await lots.saveAll([gridLot('TQQQ-grid-lot-1', { quantity: 50 })], 'grid:TQQQ', symbol);
      await ladderLots.saveAll([ladderLot('TQQQ-lot-1', { quantity: 80 })], symbol);
      broker.seedPosition({ symbol, quantity: 150, averageCost: 95 });

      const report = await reconciliation.reconcileAll(NOW);

      expect(report.clean).toBe(false);
      expect(halts.isHalted(symbol)).toBe(true);
      expect(report.symbols[0].verdict.status).toBe(GridReconciliationStatus.QUANTITY_MISMATCH);
    });
  });

  describe('reconcileAll — broker unreachable', () => {
    it('halts with GRID_BROKER_UNAVAILABLE rather than treating unknown as flat', async () => {
      const { coordinator, broker, reconciliation, halts, symbol } = buildHarness();
      await coordinator.initializeAll(NOW);
      jest.spyOn(broker, 'getPositions').mockRejectedValue(new Error('socket closed'));

      const report = await reconciliation.reconcileAll(NOW);

      expect(report.clean).toBe(false);
      expect(halts.haltFor(symbol)?.code).toBe(GRID_HALT_BROKER_UNAVAILABLE);
    });
  });

  describe('reconcileOpenOrders (via reconcileOrders)', () => {
    it('releases a lot whose resting sell is no longer at the broker', async () => {
      const broker = new MockBrokerAdapter();
      await broker.connect();

      const { coordinator, lots, reconciliation, grid, symbol } = buildHarness({ broker });
      await coordinator.initializeAll(NOW);
      await lots.saveAll(
        [gridLot('TQQQ-grid-lot-1', { workingOrderId: 'co-cancelled-sell' })],
        grid.id,
        symbol,
      );

      // Restore into live state first — reconcileOrders reads live state, not
      // the repository directly.
      const state = coordinator.getState(grid.id)!;
      gridData(state).lots = (await lots.findByStrategy(grid.id)) as GridStateData['lots'];
      coordinator.setState(grid.id, state);

      const report = await reconciliation.reconcileOrders(NOW);

      expect(report.brokerReachable).toBe(true);
      const restored = GridStrategy.lotsOf(coordinator.getState(grid.id)!)[0];
      expect(restored.workingOrderId).toBeNull();
    });

    it('releases a disabled grid instance’s stale working-order mark directly in the database', async () => {
      // The mirror of `ReconciliationService.releaseStaleDisabledSells`'s own
      // test — a disabled grid instance has no live state for the branch
      // above to mutate, so a lot whose DAY sell expired must be released
      // straight in the database or it stays `UNBACKED` forever.
      const broker = new MockBrokerAdapter();
      await broker.connect();

      const { coordinator, lots, reconciliation, grid, symbol } = buildHarness({
        broker,
        gridEnabled: false,
      });
      await coordinator.initializeAll(NOW);
      await lots.saveAll(
        [gridLot('TQQQ-grid-lot-1', { workingOrderId: 'co-expired-sell' })],
        grid.id,
        symbol,
      );

      const report = await reconciliation.reconcileOrders(NOW);

      expect(report.brokerReachable).toBe(true);
      const persisted = await lots.findByStrategy(grid.id);
      expect(persisted[0].workingOrderId).toBeNull();
    });

    it('leaves a lot alone when its resting sell is still at the broker', async () => {
      const broker = new MockBrokerAdapter({ fillMode: FillMode.RESTING });
      await broker.connect();
      await broker.submit({
        clientOrderId: 'co-still-resting',
        contract: equityContract('TQQQ'),
        side: 'SELL',
        quantity: 50,
        orderType: 'LMT',
        limitPrice: 95.5,
        timeInForce: 'DAY',
        timestamp: NOW,
      });

      const { coordinator, lots, reconciliation, grid, symbol } = buildHarness({ broker });
      await coordinator.initializeAll(NOW);
      await lots.saveAll(
        [gridLot('TQQQ-grid-lot-1', { workingOrderId: 'co-still-resting' })],
        grid.id,
        symbol,
      );
      const state = coordinator.getState(grid.id)!;
      gridData(state).lots = (await lots.findByStrategy(grid.id)) as GridStateData['lots'];
      coordinator.setState(grid.id, state);

      await reconciliation.reconcileOrders(NOW);

      const restored = GridStrategy.lotsOf(coordinator.getState(grid.id)!)[0];
      expect(restored.workingOrderId).toBe('co-still-resting');
    });

    it('invokes onOpenOrdersReconciled with the resting orders for the symbol', async () => {
      const broker = new MockBrokerAdapter({ fillMode: FillMode.RESTING });
      await broker.connect();
      await broker.submit({
        clientOrderId: 'co-1',
        contract: equityContract('TQQQ'),
        side: 'SELL',
        quantity: 50,
        orderType: 'LMT',
        limitPrice: 95.5,
        timeInForce: 'DAY',
        timestamp: NOW,
      });

      const { coordinator, reconciliation, grid, symbol } = buildHarness({ broker });
      await coordinator.initializeAll(NOW);

      const seen: { strategyId: string; symbol: string; orderCount: number }[] = [];
      reconciliation.onOpenOrdersReconciled = (strategyId, sym, orders) => {
        seen.push({ strategyId, symbol: sym, orderCount: orders.length });
      };

      await reconciliation.reconcileOrders(NOW);

      expect(seen).toEqual([{ strategyId: grid.id, symbol, orderCount: 1 }]);
    });

    it('degrades to "changed nothing" when the broker cannot be asked', async () => {
      const { coordinator, broker, reconciliation } = buildHarness();
      await coordinator.initializeAll(NOW);
      jest.spyOn(broker, 'getOpenOrders').mockRejectedValue(new Error('socket closed'));

      const report = await reconciliation.reconcileOrders(NOW);

      expect(report.brokerReachable).toBe(false);
    });
  });

  describe('report getters', () => {
    it('lastReconciliation and lastOrderReconcile return the most recent report', async () => {
      const { coordinator, reconciliation } = buildHarness();
      await coordinator.initializeAll(NOW);

      expect(reconciliation.lastOrderReconcile()).toBeNull();

      const allReport = await reconciliation.reconcileAll(NOW);
      const ordersReport = await reconciliation.reconcileOrders(NOW);

      expect(reconciliation.lastReconciliation()).toEqual(allReport);
      expect(reconciliation.lastOrderReconcile()).toEqual(ordersReport);
    });
  });
});
