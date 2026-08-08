/**
 * The engine running against **durable** repositories.
 *
 * The contract suite proves the Prisma repositories behave like the in-memory
 * ones in isolation. This file proves the swap actually took: the same
 * `EngineService`, unmodified, replays a fixture and leaves rows in MySQL —
 * which is the Story 8 claim that no call site changed (`stories.md:487`).
 *
 * Story 9 completed the other half. Rows landing durably was all Story 8 owned;
 * reloading them into a live strategy on boot is the startup sequence
 * (`stories.md:531`), and the restart tests at the bottom of this file now
 * assert the reload — conditional on reconciliation, which is the point. Those
 * two tests replaced the single assertion that used to pin the gap open.
 */

import { ExecutionMode } from '../../config/execution-mode';
import { EngineService } from '../../engine/engine.service';
import { StartupSequence } from '../../engine/startup.sequence';
import { ReconciliationService } from '../../reconciliation/reconciliation.service';
import { SymbolHaltService } from '../../reconciliation/symbol-halt.service';
import { LotStatus } from '../../strategies/dip-ladder/lot';
import { MockBrokerAdapter } from '../../broker/mock/mock-broker.adapter';
import { ReplayService } from '../../market-data/mock/replay.service';
import { CoordinatorService } from '../../strategies/coordinator.service';
import { DipLadderStrategy } from '../../strategies/dip-ladder/dip-ladder.strategy';
import { buildDipLadderConfig } from '../../strategies/dip-ladder/config';
import { RiskManagerService } from '../../risk/risk-manager.service';
import { KillSwitchService } from '../../risk/kill-switch.service';
import { InMemoryRiskEventSink } from '../../risk/risk-event';
import { buildRiskConfig } from '../../risk/risk.config';
import {
  PrismaFillRepository,
  PrismaLotRepository,
  PrismaOrderIntentRepository,
  PrismaOrderRepository,
  PrismaRungRepository,
  PrismaStrategyStateSnapshotRepository,
} from './prisma.repositories';
import { PrismaService } from './prisma.service';
import {
  describeWithDatabase,
  disconnectTestClient,
  resetDatabase,
  testClient,
} from './test-database';

describeWithDatabase('engine persistence through Prisma repositories', () => {
  const prisma = testClient();

  afterAll(async () => {
    await disconnectTestClient();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  /**
   * Builds the engine wired to Prisma repositories.
   *
   * `PAPER` rather than `SHADOW`: the submission path is unreachable in SHADOW
   * by definition, and the point here is to exercise the writes that happen
   * *around* a submission — intent, order, fill (`engine.service.spec.ts` uses
   * the same technique for the same reason).
   */
  function buildEngine(): {
    engine: EngineService;
    coordinator: CoordinatorService;
    startup: StartupSequence;
    halts: SymbolHaltService;
    broker: MockBrokerAdapter;
  } {
    const service = prisma as PrismaService;
    const coordinator = new CoordinatorService();
    const broker = new MockBrokerAdapter();
    const halts = new SymbolHaltService();
    const snapshots = new PrismaStrategyStateSnapshotRepository(service);

    coordinator.register({
      strategy: new DipLadderStrategy(buildDipLadderConfig('TQQQ', { symbolCapital: 100_000 })),
      enabled: true,
      symbols: ['TQQQ'],
    });

    const riskManager = new RiskManagerService(
      buildRiskConfig({ accountEquity: 1_000_000 }),
      ExecutionMode.PAPER,
      new KillSwitchService(new InMemoryRiskEventSink()),
      new InMemoryRiskEventSink(),
    );

    const lots = new PrismaLotRepository(service);
    const rungs = new PrismaRungRepository(service);

    const engine = new EngineService(
      new ReplayService(),
      coordinator,
      riskManager,
      broker,
      new PrismaOrderIntentRepository(service),
      new PrismaOrderRepository(service),
      new PrismaFillRepository(service),
      lots,
      rungs,
      ExecutionMode.PAPER,
      halts,
      snapshots,
    );

    // Story 9's startup sequence, sharing the *same* halt registry the engine
    // enforces — a second instance would let a halted symbol keep trading.
    const startup = new StartupSequence(
      coordinator,
      new ReconciliationService(coordinator, halts, broker, lots, rungs, snapshots),
      broker,
    );

    return { engine, coordinator, startup, halts, broker };
  }

  it('writes intents, orders, fills, lots, and rungs to MySQL on replay', async () => {
    const { engine, coordinator } = buildEngine();
    await coordinator.initializeAll('2025-01-02T09:30:00.000-05:00');

    const result = await engine.replayFixture('chop-range');

    expect(result.intentsGenerated).toBeGreaterThan(0);

    // Every intent is a row, whether or not it was submitted.
    expect(await prisma.orderIntent.count()).toBe(result.intentsGenerated);
    expect(await prisma.lot.count()).toBeGreaterThan(0);
    expect(await prisma.rung.count()).toBeGreaterThan(0);

    // Order rows are written *before* `broker.submit()` and are deliberately
    // NOT equal to `result.submitted`, which counts only calls that returned an
    // ack. A submission that throws — this fixture ends in a broker disconnect
    // — leaves its row behind on purpose: that row is the evidence Story 9
    // needs to tell "never sent" from "sent, outcome unknown" (`PRD.md:366`).
    const orderCount = await prisma.order.count();
    expect(orderCount).toBeGreaterThanOrEqual(result.submitted);
    expect(await prisma.orderIntent.count({ where: { submitted: true } })).toBe(orderCount);
  });

  it('persists an intent before its order — the crash window is recoverable', async () => {
    // `PRD.md:366`. Asserted on the stored data rather than by spying on call
    // order: an intent row that exists without its order row is exactly the
    // state a crash between the two would leave, and it must be legible.
    const { engine, coordinator } = buildEngine();
    await coordinator.initializeAll('2025-01-02T09:30:00.000-05:00');

    await engine.replayFixture('chop-range');

    const intents = await prisma.orderIntent.findMany({ where: { submitted: true } });
    expect(intents.length).toBeGreaterThan(0);

    for (const intent of intents) {
      // Every submitted intent carries the client order id linking it to the
      // order row, so recovery can pair them without guessing.
      expect(intent.clientOrderId).not.toBeNull();

      const order = await prisma.order.findUnique({
        where: { clientOrderId: intent.clientOrderId! },
      });
      expect(order).not.toBeNull();
    }
  });

  it('stores lots in FIFO order with their frozen exit targets', async () => {
    const { engine, coordinator } = buildEngine();
    await coordinator.initializeAll('2025-01-02T09:30:00.000-05:00');

    await engine.replayFixture('chop-range');

    const lots = await new PrismaLotRepository(prisma as PrismaService).findBySymbol('TQQQ');
    expect(lots.length).toBeGreaterThan(0);

    const openedAts = lots.map((lot) => lot.openedAt);
    expect(openedAts).toEqual([...openedAts].sort());

    for (const lot of lots) {
      // Each lot's target is its own fill price plus the take-profit, never the
      // blended average (`PRD.md:129`) — and it survived storage intact.
      expect(lot.exitTarget).toBeGreaterThan(lot.fillPrice);
    }
  });

  it('re-armed rungs keep their original price and cycle count in the database', async () => {
    // The chop fixture exists to make rungs cycle. Those cycles are what a
    // restart must not forget (`stories.md:490`).
    const { engine, coordinator } = buildEngine();
    await coordinator.initializeAll('2025-01-02T09:30:00.000-05:00');

    await engine.replayFixture('chop-range');

    const rungs = await new PrismaRungRepository(prisma as PrismaService).findBySymbol('TQQQ');
    const cycled = rungs.filter((rung) => rung.completedCycles > 0);

    expect(cycled.length).toBeGreaterThan(0);
    for (const rung of cycled) {
      expect(rung.price).toBeGreaterThan(0);
    }
  });

  it('reloads persisted lots into a restarted engine once reconciliation passes', async () => {
    // **The Story 8 boundary, now closed by Story 9.**
    //
    // This assertion is the inverse of the one it replaces. Until Story 9 this
    // test asserted that a restart did *not* reload — the gap was pinned so it
    // could not be closed by accident and go unnoticed. Story 9's startup
    // sequence closes it, so the assertion flipped rather than being deleted.
    //
    // The reload is conditional on reconciliation, which is the point: the
    // second engine gets its lots only because the broker's net position agrees
    // with what the database holds.
    const first = buildEngine();
    await first.coordinator.initializeAll('2025-01-02T09:30:00.000-05:00');
    await first.engine.replayFixture('chop-range');

    const persisted = await prisma.lot.count();
    expect(persisted).toBeGreaterThan(0);

    const heldQuantity = first.engine
      .ladderLots()
      .filter((lot) => lot.status === LotStatus.HELD)
      .reduce((sum, lot) => sum + lot.quantity, 0);

    // A second engine over the same database — the in-process analogue of a
    // restart, with no strategy state carried over.
    const second = buildEngine();

    // The broker agrees with the database, so the lot sum reconciles.
    second.broker.seedPosition({ symbol: 'TQQQ', quantity: heldQuantity, averageCost: 92 });

    await second.startup.run('2025-01-20T09:25:00.000-05:00');

    expect(second.halts.active()).toEqual([]);
    expect(second.engine.ladderLots().length).toBeGreaterThan(0);
    expect(
      second.engine
        .ladderLots()
        .filter((lot) => lot.status === LotStatus.HELD)
        .reduce((sum, lot) => sum + lot.quantity, 0),
    ).toBe(heldQuantity);
    expect(await prisma.lot.count()).toBe(persisted);
  });

  it('halts the symbol instead of reloading when the broker disagrees', async () => {
    // The same restart, one share different. Durable state alone is not enough
    // to resume — it has to reconcile first.
    const first = buildEngine();
    await first.coordinator.initializeAll('2025-01-02T09:30:00.000-05:00');
    await first.engine.replayFixture('chop-range');

    const heldQuantity = first.engine
      .ladderLots()
      .filter((lot) => lot.status === LotStatus.HELD)
      .reduce((sum, lot) => sum + lot.quantity, 0);

    const second = buildEngine();
    second.broker.seedPosition({ symbol: 'TQQQ', quantity: heldQuantity - 1, averageCost: 92 });

    await second.startup.run('2025-01-20T09:25:00.000-05:00');

    expect(second.halts.isHalted('TQQQ')).toBe(true);
    expect(second.engine.ladderLots()).toHaveLength(0);
    // The persisted lots are untouched — the operator needs them to resolve it.
    expect(await prisma.lot.count()).toBeGreaterThan(0);
  });

  it('engine.reset clears engine state but leaves the parameter audit trail', async () => {
    // `POST /engine/reset` returns the engine to a known state for the next
    // replay; it is deliberately not a way to erase the audit trail.
    const { engine, coordinator } = buildEngine();
    await coordinator.initializeAll('2025-01-02T09:30:00.000-05:00');

    await engine.replayFixture('chop-range');
    await prisma.parameterChange.create({
      data: {
        id: 'pc-1',
        changeId: 'edit-1',
        strategyId: 'dip-ladder:TQQQ',
        parameter: 'takeProfitPercent',
        oldValue: 0.05,
        newValue: 0.07,
        timestamp: '2025-01-02T10:00:00.000-05:00',
        reason: null,
      },
    });

    await engine.reset();

    expect(await prisma.lot.count()).toBe(0);
    expect(await prisma.orderIntent.count()).toBe(0);
    expect(await prisma.parameterChange.count()).toBe(1);
  });
});
