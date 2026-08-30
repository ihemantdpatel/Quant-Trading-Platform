/**
 * Startup reconciliation and crash recovery — the Story 9 behaviour suite
 * (`stories.md:554`).
 *
 * Runs against the in-memory repositories and `MockBrokerAdapter`, which is the
 * whole point of the sequencing decision at `stories.md:25`: reconciliation is
 * the riskiest code in the system, so it is built and proven against a real
 * store and a *mock* broker before the real IB socket arrives at Story 10. Only
 * one new failure source at a time.
 *
 * The assertions that matter most are the ones about what does **not** happen:
 * no liquidation, no guessed lot composition, no trading on a halted symbol.
 */

import { ExecutionMode } from '../config/execution-mode';
import { OrderStatus } from '../broker/broker-adapter.interface';
import { FillMode, MockBrokerAdapter } from '../broker/mock/mock-broker.adapter';
import { equityContract } from '../domain/contract';
import { EngineService } from '../engine/engine.service';
import { StartupSequence } from '../engine/startup.sequence';
import { ReplayService } from '../market-data/mock/replay.service';
import { BarSize } from '../market-data/types';
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
import { buildDipLadderConfig } from '../strategies/dip-ladder/config';
import {
  DIP_LADDER_STATE_VERSION,
  DipLadderStrategy,
} from '../strategies/dip-ladder/dip-ladder.strategy';
import { Lot, LotStatus } from '../strategies/dip-ladder/lot';
import { Rung, RungStatus } from '../strategies/dip-ladder/rung';
import { ReconciliationStatus } from './lot-sum-assertion';
import {
  HALT_BROKER_UNAVAILABLE,
  HALT_LOT_SUM_MISMATCH,
  HALT_STATE_VERSION_MISMATCH,
  ReconciliationService,
} from './reconciliation.service';
import { SymbolHaltService } from './symbol-halt.service';

/**
 * A complete, independently-constructed stack.
 *
 * Repositories are shared between two harnesses to simulate a restart: the
 * first writes, the second boots against the same store with a fresh
 * coordinator and fresh strategy objects — which is exactly what a process
 * restart is.
 */
function buildHarness(
  options: {
    lots?: InMemoryLotRepository;
    rungs?: InMemoryRungRepository;
    snapshots?: InMemoryStrategyStateSnapshotRepository;
    broker?: MockBrokerAdapter;
    symbols?: string[];
  } = {},
) {
  const lots = options.lots ?? new InMemoryLotRepository();
  // One instance shared with the engine below: a status the engine wrote and a
  // correction reconciliation makes must land in the same ledger, or neither
  // test can observe the other's effect.
  const orders = new InMemoryOrderRepository();
  const rungs = options.rungs ?? new InMemoryRungRepository();
  const snapshots = options.snapshots ?? new InMemoryStrategyStateSnapshotRepository();
  const broker = options.broker ?? new MockBrokerAdapter();
  const symbols = options.symbols ?? ['TQQQ'];

  const coordinator = new CoordinatorService();

  for (const symbol of symbols) {
    coordinator.register({
      strategy: new DipLadderStrategy(buildDipLadderConfig(symbol, { symbolCapital: 100_000 })),
      enabled: true,
      symbols: [symbol],
    });
  }

  const halts = new SymbolHaltService();
  jest.spyOn(halts['logger'], 'error').mockImplementation(() => undefined);
  jest.spyOn(halts['logger'], 'warn').mockImplementation(() => undefined);

  const reconciliation = new ReconciliationService(
    coordinator,
    halts,
    broker,
    lots,
    orders,
    rungs,
    snapshots,
  );
  jest.spyOn(reconciliation['logger'], 'log').mockImplementation(() => undefined);
  jest.spyOn(reconciliation['logger'], 'error').mockImplementation(() => undefined);

  const engine = new EngineService(
    new ReplayService(),
    coordinator,
    new RiskManagerService(
      buildRiskConfig({ accountEquity: 1_000_000 }),
      // PAPER so the submission path is reachable; SHADOW submits nothing by
      // definition and would hide whether a halt actually stopped anything.
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

  const startup = new StartupSequence(coordinator, reconciliation, broker);
  jest.spyOn(startup['logger'], 'log').mockImplementation(() => undefined);
  jest.spyOn(startup['logger'], 'error').mockImplementation(() => undefined);

  return {
    lots,
    orders,
    rungs,
    snapshots,
    broker,
    coordinator,
    halts,
    reconciliation,
    engine,
    startup,
  };
}

// Each `buildHarness` builds its own broker, so a spy cannot reach the next
// test's adapter — but a spy left installed still outlives the test that made
// it, and the logger spies here are on shared class prototypes. Restoring keeps
// a mock from answering for a test that never asked for one.
afterEach(() => {
  jest.restoreAllMocks();
});

const NOW = '2025-01-20T09:25:00.000-05:00';

function heldLot(id: string, overrides: Partial<Lot> = {}): Lot {
  return {
    id,
    rungPrice: 95,
    fillPrice: 95,
    quantity: 100,
    openedAt: '2025-01-02T09:45:00.000-05:00',
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

describe('Story 9: startup reconciliation', () => {
  describe('clean restart with a held ladder', () => {
    it('resumes with the exact lot structure when the lot sum matches', async () => {
      // `stories.md:555`. Three lots totalling 300 against a broker net
      // position of 300 — the ladder resumes with all three, not with one
      // synthesized block of the same size.
      const { lots, rungs, snapshots, broker } = buildHarness();

      await lots.saveAll(
        [
          heldLot('TQQQ-lot-1', { rungPrice: 95, fillPrice: 95, exitTarget: 99.75 }),
          heldLot('TQQQ-lot-2', {
            rungPrice: 90.25,
            fillPrice: 90.25,
            exitTarget: 94.76,
            openedAt: '2025-01-03T10:00:00.000-05:00',
          }),
          heldLot('TQQQ-lot-3', {
            rungPrice: 85.74,
            fillPrice: 85.74,
            exitTarget: 90.03,
            openedAt: '2025-01-06T11:00:00.000-05:00',
          }),
        ],
        'TQQQ',
      );
      await rungs.saveAll(
        [
          rung(95, { status: RungStatus.HELD, lotId: 'TQQQ-lot-1', completedCycles: 2 }),
          rung(90.25, { status: RungStatus.HELD, lotId: 'TQQQ-lot-2' }),
          rung(85.74, { status: RungStatus.HELD, lotId: 'TQQQ-lot-3' }),
        ],
        'TQQQ',
      );
      await snapshots.save({
        strategyId: 'dip-ladder:TQQQ',
        version: DIP_LADDER_STATE_VERSION,
        symbols: ['TQQQ'],
        data: {
          lots: [],
          rungs: [],
          firstEntryPrice: 95,
          lotSequence: 3,
          previousSessionClose: 96.5,
          runningClose: 86,
          sessionOpen: 96,
          sessionDate: '2025-01-06',
        },
        capturedAt: '2025-01-06T16:00:00.000-05:00',
      });

      broker.seedPosition({ symbol: 'TQQQ', quantity: 300, averageCost: 90.33 });

      // The restart: a fresh coordinator and fresh strategy objects over the
      // same store.
      const restarted = buildHarness({ lots, rungs, snapshots, broker });
      const result = await restarted.startup.run(NOW);

      expect(result.reconciliation.clean).toBe(true);
      expect(restarted.halts.active()).toEqual([]);

      const restored = restarted.engine.ladderLots();
      expect(restored.map((lot) => lot.id)).toEqual(['TQQQ-lot-1', 'TQQQ-lot-2', 'TQQQ-lot-3']);
      // Each lot kept its **own** frozen target, not a recomputed or blended one.
      expect(restored.map((lot) => lot.exitTarget)).toEqual([99.75, 94.76, 90.03]);
    });

    it('restores rung arming and cycle counts', async () => {
      // A re-armed rung that lost its cycle count would forget the level
      // entirely — the ladder would re-derive a different one from the anchor.
      const { lots, rungs, snapshots, broker } = buildHarness();

      await lots.saveAll([heldLot('TQQQ-lot-1', { quantity: 100 })], 'TQQQ');
      await rungs.saveAll(
        [
          rung(95, { status: RungStatus.HELD, lotId: 'TQQQ-lot-1' }),
          rung(90.25, {
            status: RungStatus.RE_ARMED,
            completedCycles: 4,
            lastExitAt: '2025-01-06T14:00:00.000-05:00',
          }),
        ],
        'TQQQ',
      );
      broker.seedPosition({ symbol: 'TQQQ', quantity: 100, averageCost: 95 });

      const restarted = buildHarness({ lots, rungs, snapshots, broker });
      await restarted.startup.run(NOW);

      const reArmed = restarted.engine.ladderRungs().find((r) => r.price === 90.25);
      expect(reArmed?.status).toBe(RungStatus.RE_ARMED);
      expect(reArmed?.completedCycles).toBe(4);
      expect(reArmed?.lastExitAt).toBe('2025-01-06T14:00:00.000-05:00');
    });

    it('restores the anchor scalars from the snapshot', async () => {
      // The exit criterion names the anchor alongside lots and rungs
      // (`stories.md:567`). It lives only in the snapshot — lots and rungs do
      // not carry it — so losing this would leave the ladder measuring from the
      // wrong place after every restart.
      const { lots, rungs, snapshots, broker } = buildHarness();

      await snapshots.save({
        strategyId: 'dip-ladder:TQQQ',
        version: DIP_LADDER_STATE_VERSION,
        symbols: ['TQQQ'],
        data: {
          lots: [],
          rungs: [],
          firstEntryPrice: 95,
          lotSequence: 7,
          previousSessionClose: 96.5,
          runningClose: 86,
          sessionOpen: 96,
          sessionDate: '2025-01-06',
        },
        capturedAt: '2025-01-06T16:00:00.000-05:00',
      });

      const restarted = buildHarness({ lots, rungs, snapshots, broker });
      await restarted.startup.run(NOW);

      const state = restarted.coordinator.getState('dip-ladder:TQQQ');
      const data = state!.data as Record<string, unknown>;

      expect(data.firstEntryPrice).toBe(95);
      expect(data.lotSequence).toBe(7);
      expect(data.previousSessionClose).toBe(96.5);
      expect(data.sessionOpen).toBe(96);
      expect(data.sessionDate).toBe('2025-01-06');
    });

    it('reconciles a flat account against an empty ladder', async () => {
      const { startup, halts } = buildHarness();

      const result = await startup.run(NOW);

      expect(result.reconciliation.clean).toBe(true);
      expect(halts.active()).toEqual([]);
    });
  });

  describe('injected quantity mismatch', () => {
    it('halts the symbol, raises the reason, and refuses to trade it', async () => {
      // `stories.md:557` — the headline failure case. The database says 300
      // shares in three lots; the broker says 200. Something happened that the
      // system cannot see, and lot composition is now unknowable.
      const { lots, rungs, snapshots, broker } = buildHarness();

      await lots.saveAll(
        [
          heldLot('TQQQ-lot-1', { quantity: 100 }),
          heldLot('TQQQ-lot-2', { quantity: 100, rungPrice: 90.25 }),
          heldLot('TQQQ-lot-3', { quantity: 100, rungPrice: 85.74 }),
        ],
        'TQQQ',
      );
      broker.seedPosition({ symbol: 'TQQQ', quantity: 200, averageCost: 92 });

      const restarted = buildHarness({ lots, rungs, snapshots, broker });
      const result = await restarted.startup.run(NOW);

      expect(result.reconciliation.clean).toBe(false);
      expect(restarted.halts.isHalted('TQQQ')).toBe(true);
      expect(restarted.halts.haltFor('TQQQ')?.code).toBe(HALT_LOT_SUM_MISMATCH);
      expect(restarted.halts.haltFor('TQQQ')?.reason).toContain('difference 100');

      const [symbolResult] = result.reconciliation.symbols;
      expect(symbolResult.verdict.status).toBe(ReconciliationStatus.QUANTITY_MISMATCH);
      expect(symbolResult.resumed).toBe(false);
    });

    it('never guesses at lot composition — no lots are loaded on a mismatch', async () => {
      // `PRD.md:347`. Loading the suspect lots "so the ladder has something to
      // work with" would let the exit path pick one by FIFO and sell it at a
      // target derived from records that disagree with the account.
      const { lots, rungs, snapshots, broker } = buildHarness();

      await lots.saveAll([heldLot('TQQQ-lot-1', { quantity: 300 })], 'TQQQ');
      broker.seedPosition({ symbol: 'TQQQ', quantity: 200, averageCost: 92 });

      const restarted = buildHarness({ lots, rungs, snapshots, broker });
      await restarted.startup.run(NOW);

      expect(restarted.engine.ladderLots()).toEqual([]);
      // And the persisted records are untouched, so an operator can still see
      // exactly what the system believed.
      expect(await lots.findBySymbol('TQQQ')).toHaveLength(1);
    });

    it('produces no intents at all for a halted symbol — entries or exits', async () => {
      // A reconciliation halt is stricter than the engine's technical
      // `entryHalt`, which still permits exits. Here selling is the dangerous
      // operation, so the symbol is not evaluated in either direction.
      const { lots, rungs, snapshots, broker } = buildHarness();

      await lots.saveAll([heldLot('TQQQ-lot-1', { quantity: 300 })], 'TQQQ');
      broker.seedPosition({ symbol: 'TQQQ', quantity: 200, averageCost: 92 });

      const restarted = buildHarness({ lots, rungs, snapshots, broker });
      await restarted.startup.run(NOW);

      const replayed = await restarted.engine.replayFixture('chop-range');

      expect(replayed.intentsGenerated).toBe(0);
      expect(replayed.submitted).toBe(0);
      expect(replayed.fills).toBe(0);
    });

    it('never liquidates to make the numbers agree', async () => {
      // The constraint `CLAUDE.md` states outright: a technical fault must not
      // become a realized loss. Flattening 200 shares to reconcile against an
      // empty ladder would be exactly that, and no code path may do it.
      const { lots, rungs, snapshots, broker } = buildHarness();

      broker.seedPosition({ symbol: 'TQQQ', quantity: 200, averageCost: 92 });

      const restarted = buildHarness({ lots, rungs, snapshots, broker });
      await restarted.startup.run(NOW);
      await restarted.engine.replayFixture('chop-range');

      // The position is exactly as it was. Nothing was sold.
      expect(await broker.getPositions()).toEqual([
        { symbol: 'TQQQ', quantity: 200, averageCost: 92 },
      ]);
      expect(broker.submittedOrders().filter((order) => order.side === 'SELL')).toHaveLength(0);
    });

    it('does not overwrite the persisted lots of a halted symbol', async () => {
      // The halted ladder is empty in memory. Persisting that over the stored
      // lots would destroy the evidence the operator needs.
      const { lots, rungs, snapshots, broker } = buildHarness();

      await lots.saveAll(
        [heldLot('TQQQ-lot-1', { quantity: 100 }), heldLot('TQQQ-lot-2', { quantity: 200 })],
        'TQQQ',
      );
      broker.seedPosition({ symbol: 'TQQQ', quantity: 250, averageCost: 92 });

      const restarted = buildHarness({ lots, rungs, snapshots, broker });
      await restarted.startup.run(NOW);
      await restarted.engine.replayFixture('chop-range');

      expect(await lots.findBySymbol('TQQQ')).toHaveLength(2);
    });
  });

  describe('one-sided positions', () => {
    it('halts when the broker reports a position the DB has no lots for', async () => {
      // `stories.md:560`.
      const { lots, rungs, snapshots, broker } = buildHarness();
      broker.seedPosition({ symbol: 'TQQQ', quantity: 300, averageCost: 90 });

      const restarted = buildHarness({ lots, rungs, snapshots, broker });
      const result = await restarted.startup.run(NOW);

      expect(restarted.halts.isHalted('TQQQ')).toBe(true);
      expect(result.reconciliation.symbols[0].verdict.status).toBe(
        ReconciliationStatus.UNTRACKED_AT_BROKER,
      );
    });

    it('halts when the DB has lots the broker reports no position for', async () => {
      // `stories.md:561`.
      const { lots, rungs, snapshots, broker } = buildHarness();
      await lots.saveAll([heldLot('TQQQ-lot-1', { quantity: 100 })], 'TQQQ');

      const restarted = buildHarness({ lots, rungs, snapshots, broker });
      const result = await restarted.startup.run(NOW);

      expect(restarted.halts.isHalted('TQQQ')).toBe(true);
      expect(result.reconciliation.symbols[0].verdict.status).toBe(
        ReconciliationStatus.MISSING_AT_BROKER,
      );
    });

    it('halts when the broker cannot be queried at all', async () => {
      // An unreachable broker is "unknown", not "flat". Treating it as flat
      // would let a disconnected startup reconcile an empty ladder cleanly and
      // resume trading against a position it never saw.
      const { lots, rungs, snapshots } = buildHarness();
      const broker = new MockBrokerAdapter();
      jest.spyOn(broker, 'getPositions').mockRejectedValue(new Error('socket closed'));

      const restarted = buildHarness({ lots, rungs, snapshots, broker });
      const result = await restarted.startup.run(NOW);

      expect(result.reconciliation.clean).toBe(false);
      expect(restarted.halts.haltFor('TQQQ')?.code).toBe(HALT_BROKER_UNAVAILABLE);
    });
  });

  describe('multi-symbol isolation', () => {
    it('halts only the mismatched symbol and leaves the others trading', async () => {
      // `stories.md:558`. A halt is a targeted response, not an outage.
      const lots = new InMemoryLotRepository();
      const rungs = new InMemoryRungRepository();
      const snapshots = new InMemoryStrategyStateSnapshotRepository();
      const broker = new MockBrokerAdapter();

      // TQQQ disagrees; SOXL agrees.
      await lots.saveAll([heldLot('TQQQ-lot-1', { quantity: 300 })], 'TQQQ');
      await lots.saveAll([heldLot('SOXL-lot-1', { quantity: 100 })], 'SOXL');
      broker.seedPosition({ symbol: 'TQQQ', quantity: 200, averageCost: 92 });
      broker.seedPosition({ symbol: 'SOXL', quantity: 100, averageCost: 95 });

      const harness = buildHarness({
        lots,
        rungs,
        snapshots,
        broker,
        symbols: ['TQQQ', 'SOXL'],
      });
      const result = await harness.startup.run(NOW);

      expect(harness.halts.haltedSymbols()).toEqual(['TQQQ']);
      expect(harness.halts.isHalted('SOXL')).toBe(false);

      // SOXL resumed with its lot; TQQQ did not.
      const soxl = result.reconciliation.symbols.find((s) => s.symbol === 'SOXL');
      const tqqq = result.reconciliation.symbols.find((s) => s.symbol === 'TQQQ');
      expect(soxl?.resumed).toBe(true);
      expect(soxl?.restoredLots).toBe(1);
      expect(tqqq?.resumed).toBe(false);
    });
  });

  describe('snapshot versioning', () => {
    it('refuses to load a snapshot whose version it does not understand', async () => {
      // `stories.md:514` — "loads or is explicitly rejected". Rejected: a
      // snapshot from a different schema may have fields that no longer mean
      // what they used to, and a silently misread anchor prices every future
      // rung wrong.
      const { lots, rungs, snapshots, broker } = buildHarness();

      await snapshots.save({
        strategyId: 'dip-ladder:TQQQ',
        version: DIP_LADDER_STATE_VERSION + 1,
        symbols: ['TQQQ'],
        data: { firstEntryPrice: 95, lotSequence: 3 },
        capturedAt: '2025-01-06T16:00:00.000-05:00',
      });

      const restarted = buildHarness({ lots, rungs, snapshots, broker });
      const result = await restarted.startup.run(NOW);

      expect(restarted.halts.haltFor('TQQQ')?.code).toBe(HALT_STATE_VERSION_MISMATCH);
      expect(result.reconciliation.symbols[0].snapshotVersion).toBe(DIP_LADDER_STATE_VERSION + 1);
      // The anchor was not loaded from the unreadable snapshot.
      const data = restarted.coordinator.getState('dip-ladder:TQQQ')!.data as Record<
        string,
        unknown
      >;
      expect(data.firstEntryPrice).toBeNull();
    });

    it('accepts a snapshot at the current version', async () => {
      // Guards against a version check so strict it rejects everything, which
      // would pass the test above while breaking every restart.
      const { lots, rungs, snapshots, broker } = buildHarness();

      await snapshots.save({
        strategyId: 'dip-ladder:TQQQ',
        version: DIP_LADDER_STATE_VERSION,
        symbols: ['TQQQ'],
        data: { firstEntryPrice: 95, lotSequence: 3 },
        capturedAt: '2025-01-06T16:00:00.000-05:00',
      });

      const restarted = buildHarness({ lots, rungs, snapshots, broker });
      await restarted.startup.run(NOW);

      expect(restarted.halts.active()).toEqual([]);
      const data = restarted.coordinator.getState('dip-ladder:TQQQ')!.data as Record<
        string,
        unknown
      >;
      expect(data.firstEntryPrice).toBe(95);
    });
  });

  describe('crash-window recovery', () => {
    it('reaches a consistent state when lots were only partially written', async () => {
      // `stories.md:559`. The crash: an order filled and the broker holds 200,
      // but only the first lot reached the database before the process died.
      // The DB is stale, and the assertion catches it rather than resuming on
      // a ladder that under-counts the position.
      const { lots, rungs, snapshots, broker } = buildHarness();

      await lots.saveAll([heldLot('TQQQ-lot-1', { quantity: 100 })], 'TQQQ');
      broker.seedPosition({ symbol: 'TQQQ', quantity: 200, averageCost: 92.5 });

      const restarted = buildHarness({ lots, rungs, snapshots, broker });
      const result = await restarted.startup.run(NOW);

      // Explicit halt, not a silent divergence.
      expect(result.reconciliation.clean).toBe(false);
      expect(restarted.halts.isHalted('TQQQ')).toBe(true);
      expect(restarted.engine.ladderLots()).toEqual([]);
    });

    it('resumes cleanly when the crash happened before any fill', async () => {
      // The other side of the crash window: the order never filled, so the
      // broker is flat and the DB has no lots. Nothing diverged, and halting
      // here would be a false positive that blocks a healthy restart.
      const { lots, rungs, snapshots, broker } = buildHarness();

      const restarted = buildHarness({ lots, rungs, snapshots, broker });
      const result = await restarted.startup.run(NOW);

      expect(result.reconciliation.clean).toBe(true);
      expect(restarted.halts.active()).toEqual([]);
    });
  });

  describe('ordering', () => {
    it('reconciles before any strategy hook fires', async () => {
      // `stories.md:563`, asserted by call ordering. If a bar could be
      // processed before reconciliation, the ladder would trade on state
      // nobody had checked — which is the entire failure this story prevents.
      const harness = buildHarness();
      const calls: string[] = [];

      const strategy = harness.coordinator.getStrategy('dip-ladder:TQQQ')!;
      jest.spyOn(strategy, 'onBar').mockImplementation(() => {
        calls.push('onBar');
        return [];
      });

      // Recorded on the *real* service rather than a stub, so this asserts the
      // ordering the production path actually has.
      const reconcileAll = harness.reconciliation.reconcileAll.bind(harness.reconciliation);
      jest.spyOn(harness.reconciliation, 'reconcileAll').mockImplementation(async (at: string) => {
        calls.push('reconcile');
        return reconcileAll(at);
      });

      await harness.startup.run(NOW);

      // Nothing was dispatched during startup at all.
      expect(calls).toEqual(['reconcile']);
      expect(harness.startup.hasReconciled()).toBe(true);

      // And once a bar does arrive, reconciliation is already behind it.
      await harness.engine.processBar({
        symbol: 'TQQQ',
        barSize: BarSize.FIVE_MIN,
        timestamp: '2025-01-20T10:00:00.000-05:00',
        open: 95,
        high: 95,
        low: 95,
        close: 95,
        volume: 1000,
      });

      expect(calls).toEqual(['reconcile', 'onBar']);
    });

    it('reports not-yet-reconciled before the sequence runs', async () => {
      const { startup } = buildHarness();

      expect(startup.hasReconciled()).toBe(false);

      await startup.run(NOW);

      expect(startup.hasReconciled()).toBe(true);
    });
  });

  describe('degraded startup', () => {
    it('completes startup and halts everything when the broker will not connect', async () => {
      // A broker that cannot connect must not abort the process. Coming up
      // halted keeps the dashboard — the operator's only view of the problem —
      // reachable, where exiting would take it down too.
      const broker = new MockBrokerAdapter();
      jest.spyOn(broker, 'connect').mockRejectedValue(new Error('gateway refused'));
      jest.spyOn(broker, 'getPositions').mockRejectedValue(new Error('not connected'));

      const harness = buildHarness({ broker });
      const result = await harness.startup.run(NOW);

      expect(result.brokerConnected).toBe(false);
      expect(harness.startup.hasReconciled()).toBe(true);
      expect(harness.halts.haltFor('TQQQ')?.code).toBe(HALT_BROKER_UNAVAILABLE);
    });

    it('reports the broker as connected on a healthy boot', async () => {
      // The other side, so the flag above is not always false.
      const harness = buildHarness();

      expect((await harness.startup.run(NOW)).brokerConnected).toBe(true);
    });

    it('reset reopens the gate for a fresh sequence', async () => {
      const harness = buildHarness();
      await harness.startup.run(NOW);

      harness.startup.reset();

      expect(harness.startup.hasReconciled()).toBe(false);
    });

    it('skips a ladder registered without a symbol', async () => {
      // Defensive: a registration with no symbol has nothing to reconcile
      // against, and inventing a verdict for it would put a meaningless row on
      // the dashboard.
      const harness = buildHarness();
      harness.coordinator.reset();
      harness.coordinator.register({
        strategy: new DipLadderStrategy(buildDipLadderConfig('TQQQ', { symbolCapital: 100_000 })),
        enabled: true,
        symbols: [],
      });

      const result = await harness.reconciliation.reconcileAll(NOW);

      expect(result.symbols).toEqual([]);
      expect(result.clean).toBe(true);
    });

    it('restores nothing into a strategy that was never initialized', async () => {
      // Reachable for a disabled strategy, which `initializeAll` skips.
      const { lots, rungs, snapshots, broker } = buildHarness();
      await lots.saveAll([heldLot('TQQQ-lot-1', { quantity: 100 })], 'TQQQ');
      broker.seedPosition({ symbol: 'TQQQ', quantity: 100, averageCost: 95 });

      const harness = buildHarness({ lots, rungs, snapshots, broker });
      // Reconcile without running the startup sequence, so no state exists.
      const result = await harness.reconciliation.reconcileAll(NOW);

      expect(result.clean).toBe(true);
      expect(result.symbols[0].restoredLots).toBe(0);
    });
  });

  describe('halt release', () => {
    it('resumes trading the symbol only after an operator releases the halt', async () => {
      const { lots, rungs, snapshots, broker } = buildHarness();

      await lots.saveAll([heldLot('TQQQ-lot-1', { quantity: 300 })], 'TQQQ');
      broker.seedPosition({ symbol: 'TQQQ', quantity: 200, averageCost: 92 });

      const restarted = buildHarness({ lots, rungs, snapshots, broker });
      await restarted.startup.run(NOW);

      expect((await restarted.engine.replayFixture('chop-range')).intentsGenerated).toBe(0);

      restarted.halts.release('TQQQ', NOW);

      expect((await restarted.engine.replayFixture('chop-range')).intentsGenerated).toBeGreaterThan(
        0,
      );
    });

    it('engine.reset does not dismiss an unresolved halt', async () => {
      // `POST /engine/reset` returns the engine to a known state for the next
      // replay. It is deliberately not a way to clear a mismatch nobody fixed.
      const { lots, rungs, snapshots, broker } = buildHarness();

      await lots.saveAll([heldLot('TQQQ-lot-1', { quantity: 300 })], 'TQQQ');
      broker.seedPosition({ symbol: 'TQQQ', quantity: 200, averageCost: 92 });

      const restarted = buildHarness({ lots, rungs, snapshots, broker });
      await restarted.startup.run(NOW);
      await restarted.engine.reset();

      expect(restarted.halts.isHalted('TQQQ')).toBe(true);
    });
  });

  describe('lot composition is the database’s alone', () => {
    it('cannot distinguish three lots from one block, so the DB decides', async () => {
      // `stories.md:565`. Both ladders reconcile against the same broker
      // number; what differs is entirely what the database says — which is why
      // the database is authoritative on composition and the broker on the total.
      const broker = new MockBrokerAdapter();
      broker.seedPosition({ symbol: 'TQQQ', quantity: 300, averageCost: 90.33 });

      const asThree = new InMemoryLotRepository();
      await asThree.saveAll(
        [
          heldLot('a', { quantity: 100, fillPrice: 95, exitTarget: 99.75 }),
          heldLot('b', {
            quantity: 100,
            fillPrice: 90.25,
            exitTarget: 94.76,
            openedAt: '2025-01-03T10:00:00.000-05:00',
          }),
          heldLot('c', {
            quantity: 100,
            fillPrice: 85.74,
            exitTarget: 90.03,
            openedAt: '2025-01-06T10:00:00.000-05:00',
          }),
        ],
        'TQQQ',
      );

      const asOne = new InMemoryLotRepository();
      await asOne.saveAll(
        [heldLot('single', { quantity: 300, fillPrice: 90.33, exitTarget: 94.85 })],
        'TQQQ',
      );

      const three = buildHarness({ lots: asThree, broker });
      const one = buildHarness({ lots: asOne, broker });

      await three.startup.run(NOW);
      await one.startup.run(NOW);

      expect(three.halts.active()).toEqual([]);
      expect(one.halts.active()).toEqual([]);

      // Same broker position, entirely different exit behaviour — three
      // independent targets versus one.
      expect(three.engine.ladderLots().map((l) => l.exitTarget)).toEqual([99.75, 94.76, 90.03]);
      expect(one.engine.ladderLots().map((l) => l.exitTarget)).toEqual([94.85]);
    });
  });
});

describe('open-order reconciliation across a restart', () => {
  /**
   * The failure this exists to prevent: an order placed before a restart is
   * still working at IB afterwards, and nothing in the database can confirm it
   * survived. Adopting it is what stops the next bar placing a second order at
   * the same price.
   */
  it('adopts a resting order the ladder has no record of', async () => {
    const broker = new MockBrokerAdapter({ fillMode: FillMode.RESTING });
    await broker.connect();

    // Placed by a "previous process": at the broker, absent from the rung
    // ledger this harness starts with.
    await broker.submit({
      clientOrderId: 'co-from-before-restart',
      contract: equityContract('TQQQ'),
      side: 'BUY',
      quantity: 100,
      orderType: 'LMT',
      limitPrice: 95,
      timeInForce: 'DAY',
      timestamp: NOW,
    });

    const harness = buildHarness({ broker });
    await harness.startup.run(NOW);

    const rungs = harness.engine.ladderRungs();
    const adopted = rungs.find((rung) => rung.price === 95);

    expect(adopted).toBeDefined();
    expect(adopted!.status).toBe(RungStatus.WORKING);
    expect(adopted!.workingOrderId).toBe('co-from-before-restart');
  });

  it('releases a WORKING rung whose order is no longer at the broker', async () => {
    // A DAY order that expired overnight. Left WORKING the level would be
    // blocked forever and the ladder would silently stop laddering.
    const rungs = new InMemoryRungRepository();
    await rungs.saveAll(
      [rung(95, { status: RungStatus.WORKING, workingOrderId: 'co-expired' })],
      'TQQQ',
    );

    const broker = new MockBrokerAdapter({ fillMode: FillMode.RESTING });
    await broker.connect();

    const harness = buildHarness({ rungs, broker });
    await harness.startup.run(NOW);

    const restored = harness.engine.ladderRungs().find((r) => r.price === 95);
    expect(restored!.status).not.toBe(RungStatus.WORKING);
    expect(restored!.workingOrderId).toBeNull();
  });

  it('leaves the ledger untouched when open orders cannot be read', async () => {
    // "Could not ask" is not "nothing is resting". Collapsing the two would
    // release every WORKING rung and duplicate a live order on the next bar.
    const rungs = new InMemoryRungRepository();
    await rungs.saveAll(
      [rung(95, { status: RungStatus.WORKING, workingOrderId: 'co-still-live' })],
      'TQQQ',
    );

    const broker = new MockBrokerAdapter({ fillMode: FillMode.RESTING });
    await broker.connect();
    jest.spyOn(broker, 'getOpenOrders').mockRejectedValue(new Error('IB timed out'));

    const harness = buildHarness({ rungs, broker });
    jest.spyOn(harness.reconciliation['logger'], 'warn').mockImplementation(() => undefined);
    await harness.startup.run(NOW);

    const restored = harness.engine.ladderRungs().find((r) => r.price === 95);
    expect(restored!.status).toBe(RungStatus.WORKING);
    expect(restored!.workingOrderId).toBe('co-still-live');
  });
});

/**
 * Order-history reconciliation — the stale `Order` row.
 *
 * **The gap being closed.** A terminal status reaches the engine on
 * `onOrderStatus`, which can only attribute it via an in-memory map populated
 * at submission. An order placed before a restart and then cancelled in TWS
 * produces a status this process cannot attribute, so it is dropped: the rung
 * is released correctly by open-order reconciliation, but the `Order` row sits
 * at `SUBMITTED` and the dashboard keeps showing a live order that no longer
 * exists anywhere.
 */
describe('order-history reconciliation', () => {
  const submittedOrder = (clientOrderId: string) => ({
    clientOrderId,
    strategyId: 'dip-ladder:TQQQ',
    symbol: 'TQQQ',
    side: 'BUY' as const,
    quantity: 100,
    orderType: 'LMT',
    limitPrice: 95,
    timeInForce: 'DAY',
    status: OrderStatus.SUBMITTED,
    brokerOrderId: 'ib-1',
    submittedAt: '2025-01-19T10:00:00.000-05:00',
    rejectReason: null,
  });

  it('corrects a SUBMITTED row the broker reports as cancelled', async () => {
    const h = buildHarness();
    await h.orders.save(submittedOrder('order-1') as never);

    // The broker's history knows the outcome this process never saw.
    jest.spyOn(h.broker, 'getCompletedOrders').mockResolvedValue([
      {
        clientOrderId: 'order-1',
        brokerOrderId: 'ib-1',
        symbol: 'TQQQ',
        side: 'BUY',
        quantity: 100,
        filledQuantity: 0,
        status: OrderStatus.CANCELLED,
        reason: 'cancelled in TWS',
      },
    ]);

    const report = await h.startup.run(NOW);

    expect(report.reconciliation.ordersUpdated).toBe(1);

    const corrected = await h.orders.findByClientOrderId('order-1');

    expect(corrected?.status).toBe(OrderStatus.CANCELLED);
    expect(corrected?.rejectReason).toBe('cancelled in TWS');
  });

  it('leaves a row that already reached a terminal state alone', async () => {
    const h = buildHarness();
    await h.orders.save({ ...submittedOrder('order-1'), status: OrderStatus.FILLED } as never);

    jest.spyOn(h.broker, 'getCompletedOrders').mockResolvedValue([
      {
        clientOrderId: 'order-1',
        brokerOrderId: 'ib-1',
        symbol: 'TQQQ',
        side: 'BUY',
        quantity: 100,
        filledQuantity: 100,
        // A contradiction, and the engine's own live observation wins: it saw
        // the execution, which is the more direct evidence.
        status: OrderStatus.CANCELLED,
        reason: null,
      },
    ]);

    const report = await h.startup.run(NOW);

    expect(report.reconciliation.ordersUpdated).toBe(0);
    expect((await h.orders.findByClientOrderId('order-1'))?.status).toBe(OrderStatus.FILLED);
  });

  it('does not invent a row for an order the database never had', async () => {
    const h = buildHarness();

    // A manual TWS order against the same account. Reconciling records the
    // engine owns must not put entries in the ledger it never decided to make.
    jest.spyOn(h.broker, 'getCompletedOrders').mockResolvedValue([
      {
        clientOrderId: 'placed-by-hand',
        brokerOrderId: 'ib-99',
        symbol: 'TQQQ',
        side: 'BUY',
        quantity: 50,
        filledQuantity: 50,
        status: OrderStatus.FILLED,
        reason: null,
      },
    ]);

    const report = await h.startup.run(NOW);

    expect(report.reconciliation.ordersUpdated).toBe(0);
    expect(await h.orders.findByClientOrderId('placed-by-hand')).toBeNull();
  });

  it('still reconciles positions when the history query fails', async () => {
    const h = buildHarness();
    jest.spyOn(h.broker, 'getCompletedOrders').mockRejectedValue(new Error('IB did not respond'));
    jest.spyOn(h.reconciliation['logger'], 'warn').mockImplementation(() => undefined);

    const report = await h.startup.run(NOW);

    // The history is diagnostic. The assertions that gate trading have already
    // run, so a failure here must not turn a cosmetic staleness into a halt.
    expect(report.reconciliation.clean).toBe(true);
    expect(report.reconciliation.haltedSymbols).toEqual([]);
    expect(report.reconciliation.ordersUpdated).toBe(0);
  });

  it('releases the rung from open orders even when history is unavailable', async () => {
    // The independence that matters: rung release is decided by
    // `getOpenOrders` alone, because a level is free when nothing is working
    // at it — whether or not the history query succeeded.
    const rungs = new InMemoryRungRepository();
    await rungs.saveAll(
      [rung(95, { status: RungStatus.WORKING, workingOrderId: 'gone-order' })],
      'TQQQ',
    );

    const h = buildHarness({ rungs });
    jest.spyOn(h.broker, 'getCompletedOrders').mockRejectedValue(new Error('IB did not respond'));
    jest.spyOn(h.reconciliation['logger'], 'warn').mockImplementation(() => undefined);

    await h.startup.run(NOW);

    const restored = DipLadderStrategy.rungsOf(h.coordinator.getState('dip-ladder:TQQQ')!)!;

    expect(restored.find((r) => r.price === 95)?.workingOrderId).toBeNull();
  });
});

/**
 * Orders-only reconciliation — what the post-close job runs.
 *
 * The property that matters most is what it does **not** do. It is the only
 * reconciliation entry point that runs unattended, so a run that halted a
 * symbol, or overwrote live state from the database, would take the ladder out
 * of service with nobody watching.
 */
describe('orders-only reconciliation', () => {
  it('releases a rung whose order is gone without asserting anything about positions', async () => {
    const rungs = new InMemoryRungRepository();
    await rungs.saveAll(
      [rung(95, { status: RungStatus.WORKING, workingOrderId: 'expired-at-the-close' })],
      'TQQQ',
    );

    const h = buildHarness({ rungs });
    await h.startup.run(NOW);

    // Re-block the level the way a DAY order does: the engine believes an order
    // is working, the broker has already expired it.
    const state = h.coordinator.getState('dip-ladder:TQQQ')!;
    DipLadderStrategy.recordWorkingOrder(state, 95, 'expired-at-the-close');
    h.coordinator.setState('dip-ladder:TQQQ', state);

    const report = await h.reconciliation.reconcileOrders(NOW);

    expect(report.brokerReachable).toBe(true);
    expect(report.symbols).toEqual(['TQQQ']);

    const after = DipLadderStrategy.rungsOf(h.coordinator.getState('dip-ladder:TQQQ')!)!;

    expect(after.find((r) => r.price === 95)?.workingOrderId).toBeNull();
  });

  it('never halts a symbol, even when lots disagree with the broker', async () => {
    // The decisive difference from `reconcileAll`. A lot sum that does not
    // match is a genuine finding, but discovering it at 16:15 with nobody
    // watching must not stop the ladder — that is a decision for an operator
    // at a dashboard, which is what the manual control is for.
    const lots = new InMemoryLotRepository();
    await lots.saveAll([heldLot('TQQQ-lot-1')], 'TQQQ');

    const h = buildHarness({ lots });
    h.broker.seedPosition({ symbol: 'TQQQ', quantity: 999, averageCost: 95 });

    await h.reconciliation.reconcileOrders(NOW);

    expect(h.halts.haltedSymbols()).toEqual([]);
  });

  it('reports the broker as unreachable rather than emptying the ledger', async () => {
    const h = buildHarness();
    jest.spyOn(h.broker, 'getOpenOrders').mockRejectedValue(new Error('IB did not respond'));
    jest.spyOn(h.reconciliation['logger'], 'error').mockImplementation(() => undefined);
    jest.spyOn(h.reconciliation['logger'], 'warn').mockImplementation(() => undefined);

    const report = await h.reconciliation.reconcileOrders(NOW);

    // "Cannot ask" is not "nothing is resting". Collapsing the two would
    // release every WORKING rung and duplicate live orders on the next bar.
    expect(report.brokerReachable).toBe(false);
    expect(h.halts.haltedSymbols()).toEqual([]);
  });

  it('corrects a stale Order row from the broker history', async () => {
    const h = buildHarness();
    await h.orders.save({
      clientOrderId: 'order-1',
      strategyId: 'dip-ladder:TQQQ',
      symbol: 'TQQQ',
      side: 'BUY',
      quantity: 100,
      orderType: 'LMT',
      limitPrice: 95,
      timeInForce: 'DAY',
      status: OrderStatus.SUBMITTED,
      brokerOrderId: 'ib-1',
      submittedAt: '2025-01-19T10:00:00.000-05:00',
      rejectReason: null,
    } as never);

    jest.spyOn(h.broker, 'getCompletedOrders').mockResolvedValue([
      {
        clientOrderId: 'order-1',
        brokerOrderId: 'ib-1',
        symbol: 'TQQQ',
        side: 'BUY',
        quantity: 100,
        filledQuantity: 0,
        status: OrderStatus.CANCELLED,
        reason: 'expired at the close',
      },
    ]);

    const report = await h.reconciliation.reconcileOrders(NOW);

    expect(report.ordersUpdated).toBe(1);
    expect((await h.orders.findByClientOrderId('order-1'))?.status).toBe(OrderStatus.CANCELLED);
  });

  it('does not restore lots from the database over live state', async () => {
    // Mid-session the in-memory ladder is at least as current as the persisted
    // copy. This job answers a question about orders, not composition.
    const lots = new InMemoryLotRepository();
    await lots.saveAll([heldLot('TQQQ-lot-1')], 'TQQQ');

    const h = buildHarness({ lots });
    h.broker.seedPosition({ symbol: 'TQQQ', quantity: 100, averageCost: 95 });
    await h.startup.run(NOW);

    // The live ladder moves on: the lot is gone from memory but still persisted.
    const state = h.coordinator.getState('dip-ladder:TQQQ')!;
    (state.data as { lots: unknown[] }).lots = [];
    h.coordinator.setState('dip-ladder:TQQQ', state);

    await h.reconciliation.reconcileOrders(NOW);

    expect(DipLadderStrategy.lotsOf(h.coordinator.getState('dip-ladder:TQQQ')!)).toEqual([]);
  });

  it('is recorded so an operator can see it ran', async () => {
    const h = buildHarness();

    expect(h.reconciliation.lastOrderReconcile()).toBeNull();

    await h.reconciliation.reconcileOrders(NOW);

    expect(h.reconciliation.lastOrderReconcile()).toMatchObject({ ranAt: NOW });
  });
});
