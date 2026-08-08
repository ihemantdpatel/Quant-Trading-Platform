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
import { MockBrokerAdapter } from '../broker/mock/mock-broker.adapter';
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
    new InMemoryOrderRepository(),
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

  return { lots, rungs, snapshots, broker, coordinator, halts, reconciliation, engine, startup };
}

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
    ...overrides,
  };
}

function rung(price: number, overrides: Partial<Rung> = {}): Rung {
  return {
    price,
    status: RungStatus.PENDING,
    lotId: null,
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
