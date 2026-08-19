/**
 * The shared repository contract suite.
 *
 * **Every repository interface has an implementation passing the same suite**
 * (`stories.md:508`). This file is that suite: the in-memory spec and the
 * Prisma spec both call into it, so a behaviour asserted here is a behaviour
 * both implementations have, and a divergence fails a test rather than
 * surfacing as a recovery bug after a restart.
 *
 * Two properties matter more than the rest and are asserted for both:
 *
 * - **Isolation** — a caller mutating an object it saved, or one it read back,
 *   cannot alter stored state. The in-memory implementation deep-copies to
 *   imitate a database; Prisma gets it from materialising rows. Same assertion,
 *   different mechanism, which is exactly why it is worth asserting on both.
 * - **FIFO lot ordering** — oldest first, ties broken by id. Which lot gets
 *   sold depends on it.
 *
 * ## Why factories rather than instances
 *
 * Each block builds a fresh repository per test. For Prisma that also has to
 * truncate the table, since state outlives the object — which is the point of
 * Story 8 and would otherwise make every test order-dependent.
 */

import { Fill, OrderStatus } from '../broker/broker-adapter.interface';
import { Bar, BarSize } from '../market-data/types';
import { RiskEvent, RiskEventType } from '../risk/risk-event';
import { RiskReason } from '../risk/types';
import { Lot, LotStatus } from '../strategies/dip-ladder/lot';
import { ParameterChange } from '../strategies/dip-ladder/parameter-change';
import { Rung, RungStatus } from '../strategies/dip-ladder/rung';
import { equityContract, OrderType, TimeInForce } from '../strategies/types';
import {
  BacktestRepository,
  BacktestRunRecord,
  BarRepository,
  FillRepository,
  LotRepository,
  OrderIntentRecord,
  OrderIntentRepository,
  OrderRecord,
  OrderRepository,
  ParameterChangeRepository,
  RiskEventRepository,
  RungRepository,
  StrategyStateSnapshotRecord,
  StrategyStateSnapshotRepository,
} from './repository.interfaces';

/** Builds a repository for one test, already emptied. */
export type RepositoryFactory<T> = () => Promise<T> | T;

export function lotFixture(overrides: Partial<Lot> = {}): Lot {
  return {
    id: 'TQQQ-lot-1',
    rungPrice: 95,
    fillPrice: 95,
    quantity: 100,
    openedAt: '2025-01-02T10:00:00.000-05:00',
    exitTarget: 99.75,
    status: LotStatus.HELD,
    closedAt: null,
    exitPrice: null,
    ...overrides,
  };
}

export function rungFixture(price: number, overrides: Partial<Rung> = {}): Rung {
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

export function intentRecordFixture(id: string, symbol = 'TQQQ'): OrderIntentRecord {
  return {
    id,
    intent: {
      strategyId: 'dip-ladder:TQQQ',
      contract: equityContract(symbol),
      side: 'BUY',
      quantity: 100,
      orderType: OrderType.LIMIT,
      limitPrice: 95,
      timeInForce: TimeInForce.DAY,
      timestamp: '2025-01-02T10:00:00.000-05:00',
      reason: 'rung',
    },
    decision: null,
    submitted: false,
    clientOrderId: null,
    createdAt: '2025-01-02T10:00:00.000-05:00',
  };
}

export function orderFixture(clientOrderId: string): OrderRecord {
  return {
    clientOrderId,
    brokerOrderId: null,
    symbol: 'TQQQ',
    side: 'BUY',
    quantity: 100,
    limitPrice: 95,
    status: OrderStatus.SUBMITTED,
    rejectReason: null,
    strategyId: 'dip-ladder:TQQQ',
    createdAt: '2025-01-02T10:00:00.000-05:00',
  };
}

export function fillFixture(clientOrderId: string, fillId: string): Fill {
  return {
    clientOrderId,
    brokerOrderId: 'mock-order-1',
    fillId,
    symbol: 'TQQQ',
    side: 'BUY',
    quantity: 100,
    price: 95,
    commission: 0,
    timestamp: '2025-01-02T10:00:00.000-05:00',
  };
}

export function riskEventFixture(detail: string): RiskEvent {
  return {
    type: RiskEventType.REJECTION,
    reason: RiskReason.KILL_SWITCH,
    detail,
    timestamp: '2025-01-02T10:00:00.000-05:00',
    intent: null,
    approvedQuantity: null,
  };
}

export function parameterChangeFixture(
  id: string,
  overrides: Partial<ParameterChange> = {},
): ParameterChange {
  return {
    id,
    changeId: `change-${id}`,
    strategyId: 'dip-ladder:TQQQ',
    parameter: 'takeProfitPercent',
    oldValue: 0.05,
    newValue: 0.07,
    timestamp: '2025-01-02T10:00:00.000-05:00',
    stateAtChange: null,
    reason: 'widening the target',
    ...overrides,
  };
}

export function runLotRepositoryContract(create: RepositoryFactory<LotRepository>): void {
  describe('LotRepository contract', () => {
    let repo: LotRepository;

    beforeEach(async () => {
      repo = await create();
    });

    it('saves and reads back a lot', async () => {
      await repo.save(lotFixture(), 'TQQQ');

      expect(await repo.findBySymbol('TQQQ')).toEqual([lotFixture()]);
    });

    it('stores a copy — mutating the caller’s object cannot alter stored state', async () => {
      const original = lotFixture();
      await repo.save(original, 'TQQQ');

      original.fillPrice = 1;
      original.status = LotStatus.CLOSED;

      const [stored] = await repo.findBySymbol('TQQQ');
      expect(stored.fillPrice).toBe(95);
      expect(stored.status).toBe(LotStatus.HELD);
    });

    it('returns a copy — mutating a read result cannot alter stored state', async () => {
      await repo.save(lotFixture(), 'TQQQ');

      const read = await repo.findBySymbol('TQQQ');
      read[0].fillPrice = 1;

      expect((await repo.findBySymbol('TQQQ'))[0].fillPrice).toBe(95);
    });

    it('orders lots FIFO by openedAt', async () => {
      await repo.saveAll(
        [
          lotFixture({ id: 'c', openedAt: '2025-01-02T12:00:00.000-05:00' }),
          lotFixture({ id: 'a', openedAt: '2025-01-02T10:00:00.000-05:00' }),
          lotFixture({ id: 'b', openedAt: '2025-01-02T11:00:00.000-05:00' }),
        ],
        'TQQQ',
      );

      expect((await repo.findBySymbol('TQQQ')).map((l) => l.id)).toEqual(['a', 'b', 'c']);
    });

    it('breaks openedAt ties by id so the ordering is total and stable', async () => {
      // Two lots can share a timestamp when one bar fills two rungs. An unstable
      // order here would make which-lot-sold depend on row order — exactly the
      // nondeterminism that cannot be reconciled after a restart.
      const at = '2025-01-02T10:00:00.000-05:00';
      await repo.saveAll(
        [lotFixture({ id: 'z', openedAt: at }), lotFixture({ id: 'a', openedAt: at })],
        'TQQQ',
      );

      expect((await repo.findBySymbol('TQQQ')).map((l) => l.id)).toEqual(['a', 'z']);
    });

    it('preserves FIFO ordering across a persistence round trip', async () => {
      // `stories.md:515` calls this out separately from the ordering test: the
      // sort must be a property of *storage*, not of the order rows went in.
      await repo.saveAll(
        [
          lotFixture({ id: 'third', openedAt: '2025-01-02T14:00:00.000-05:00' }),
          lotFixture({ id: 'first', openedAt: '2025-01-02T09:45:00.000-05:00' }),
          lotFixture({ id: 'second', openedAt: '2025-01-02T11:30:00.000-05:00' }),
        ],
        'TQQQ',
      );

      const reread = await repo.findBySymbol('TQQQ');

      expect(reread.map((l) => l.id)).toEqual(['first', 'second', 'third']);
      expect(reread.map((l) => l.openedAt)).toEqual([...reread.map((l) => l.openedAt)].sort());
    });

    it('saveAll replaces the symbol’s whole set', async () => {
      await repo.saveAll([lotFixture({ id: 'a' }), lotFixture({ id: 'b' })], 'TQQQ');
      await repo.saveAll([lotFixture({ id: 'c' })], 'TQQQ');

      expect((await repo.findBySymbol('TQQQ')).map((l) => l.id)).toEqual(['c']);
    });

    it('saveAll with an empty set clears the symbol', async () => {
      await repo.saveAll([lotFixture({ id: 'a' })], 'TQQQ');
      await repo.saveAll([], 'TQQQ');

      expect(await repo.findBySymbol('TQQQ')).toEqual([]);
    });

    it('keeps symbols separate', async () => {
      await repo.save(lotFixture({ id: 'tqqq-1' }), 'TQQQ');
      await repo.save(lotFixture({ id: 'spy-1' }), 'SPY');

      expect(await repo.findBySymbol('TQQQ')).toHaveLength(1);
      expect(await repo.findAll()).toHaveLength(2);
    });

    it('saveAll for one symbol leaves another symbol untouched', async () => {
      await repo.save(lotFixture({ id: 'spy-1' }), 'SPY');
      await repo.saveAll([lotFixture({ id: 'tqqq-1' })], 'TQQQ');

      expect((await repo.findBySymbol('SPY')).map((l) => l.id)).toEqual(['spy-1']);
    });

    it('findHeld excludes closed lots', async () => {
      await repo.saveAll(
        [lotFixture({ id: 'held' }), lotFixture({ id: 'closed', status: LotStatus.CLOSED })],
        'TQQQ',
      );

      expect((await repo.findHeld('TQQQ')).map((l) => l.id)).toEqual(['held']);
    });

    it('round-trips a closed lot’s exit price and timestamp', async () => {
      await repo.save(
        lotFixture({
          id: 'closed',
          status: LotStatus.CLOSED,
          closedAt: '2025-01-03T11:00:00.000-05:00',
          exitPrice: 99.75,
        }),
        'TQQQ',
      );

      const [stored] = await repo.findBySymbol('TQQQ');
      expect(stored.closedAt).toBe('2025-01-03T11:00:00.000-05:00');
      expect(stored.exitPrice).toBe(99.75);
    });

    it('round-trips fractional prices without drift', async () => {
      // A lot's exit target is a percentage of what that lot paid
      // (`PRD.md:129`). A cent of storage drift would move the target.
      await repo.save(lotFixture({ fillPrice: 87.33, exitTarget: 91.7 }), 'TQQQ');

      const [stored] = await repo.findBySymbol('TQQQ');
      expect(stored.fillPrice).toBe(87.33);
      expect(stored.exitTarget).toBe(91.7);
    });

    it('returns an empty array for an unknown symbol', async () => {
      expect(await repo.findBySymbol('NOPE')).toEqual([]);
    });

    it('clear removes everything', async () => {
      await repo.save(lotFixture(), 'TQQQ');
      await repo.clear();

      expect(await repo.findAll()).toEqual([]);
    });
  });
}

export function runRungRepositoryContract(create: RepositoryFactory<RungRepository>): void {
  describe('RungRepository contract', () => {
    let repo: RungRepository;

    beforeEach(async () => {
      repo = await create();
    });

    it('saves and reads rungs by symbol', async () => {
      await repo.saveAll([rungFixture(95), rungFixture(90.25)], 'TQQQ');

      expect((await repo.findBySymbol('TQQQ')).map((r) => r.price).sort()).toEqual([90.25, 95]);
    });

    it('preserves a re-armed rung’s original price and cycle count', async () => {
      // Re-arming must survive persistence (`stories.md:490`), or a restart
      // loses the level the rung would have fired at again.
      await repo.saveAll(
        [rungFixture(95, { status: RungStatus.RE_ARMED, completedCycles: 3, lastExitAt: 'x' })],
        'TQQQ',
      );

      const [restored] = await repo.findBySymbol('TQQQ');

      expect(restored.price).toBe(95);
      expect(restored.status).toBe(RungStatus.RE_ARMED);
      expect(restored.completedCycles).toBe(3);
      expect(restored.lastExitAt).toBe('x');
    });

    it('preserves a held rung’s lot reference', async () => {
      await repo.saveAll(
        [rungFixture(95, { status: RungStatus.HELD, lotId: 'TQQQ-lot-7' })],
        'TQQQ',
      );

      const [restored] = await repo.findBySymbol('TQQQ');
      expect(restored.status).toBe(RungStatus.HELD);
      expect(restored.lotId).toBe('TQQQ-lot-7');
    });

    it('preserves a working rung’s resting order id', async () => {
      // The id is how a restart matches an order still open at IB back to the
      // rung that placed it. Losing it across the round trip would make the
      // ladder place a duplicate order at the same level on the next boot.
      await repo.saveAll(
        [rungFixture(95, { status: RungStatus.WORKING, workingOrderId: 'co-42' })],
        'TQQQ',
      );

      const [restored] = await repo.findBySymbol('TQQQ');
      expect(restored.status).toBe(RungStatus.WORKING);
      expect(restored.workingOrderId).toBe('co-42');
      expect(restored.lotId).toBeNull();
    });

    it('stores a copy', async () => {
      const rungs = [rungFixture(95)];
      await repo.saveAll(rungs, 'TQQQ');

      rungs[0].price = 1;

      expect((await repo.findBySymbol('TQQQ'))[0].price).toBe(95);
    });

    it('saveAll replaces the symbol’s set', async () => {
      await repo.saveAll([rungFixture(95), rungFixture(90.25)], 'TQQQ');
      await repo.saveAll([rungFixture(95)], 'TQQQ');

      expect((await repo.findBySymbol('TQQQ')).map((r) => r.price)).toEqual([95]);
    });

    it('findAll spans symbols and clear empties', async () => {
      await repo.saveAll([rungFixture(95)], 'TQQQ');
      await repo.saveAll([rungFixture(400)], 'SPY');

      expect(await repo.findAll()).toHaveLength(2);

      await repo.clear();
      expect(await repo.findAll()).toEqual([]);
    });

    it('returns empty for an unknown symbol', async () => {
      expect(await repo.findBySymbol('NOPE')).toEqual([]);
    });
  });
}

export function runOrderIntentRepositoryContract(
  create: RepositoryFactory<OrderIntentRepository>,
): void {
  describe('OrderIntentRepository contract', () => {
    let repo: OrderIntentRepository;

    beforeEach(async () => {
      repo = await create();
    });

    it('saves intents in insertion order', async () => {
      await repo.save(intentRecordFixture('a'));
      await repo.save(intentRecordFixture('b'));

      expect((await repo.findAll()).map((r) => r.id)).toEqual(['a', 'b']);
    });

    it('round-trips the whole intent, including the contract', async () => {
      // The contract models options from day one (`PRD.md:226`); a record that
      // dropped it would not replay.
      await repo.save(intentRecordFixture('a'));

      const [stored] = await repo.findAll();
      expect(stored.intent).toEqual(intentRecordFixture('a').intent);
    });

    it('filters by symbol', async () => {
      await repo.save(intentRecordFixture('a', 'TQQQ'));
      await repo.save(intentRecordFixture('b', 'SPY'));

      expect((await repo.findBySymbol('SPY')).map((r) => r.id)).toEqual(['b']);
    });

    it('marks an intent submitted with its client order id', async () => {
      await repo.save(intentRecordFixture('a'));

      await repo.markSubmitted('a', 'co-1');

      const [saved] = await repo.findAll();
      expect(saved.submitted).toBe(true);
      expect(saved.clientOrderId).toBe('co-1');
    });

    it('ignores markSubmitted for an unknown id rather than throwing', async () => {
      await expect(repo.markSubmitted('nope', 'co-1')).resolves.not.toThrow();
    });

    it('persists an intent before submission, with submitted false', async () => {
      // `PRD.md:366` — this row is what makes the crash window between "order
      // sent" and "fill recorded" recoverable rather than a silent gap.
      await repo.save(intentRecordFixture('a'));

      const [stored] = await repo.findAll();
      expect(stored.submitted).toBe(false);
      expect(stored.clientOrderId).toBeNull();
    });

    it('clear empties the store', async () => {
      await repo.save(intentRecordFixture('a'));
      await repo.clear();

      expect(await repo.findAll()).toEqual([]);
    });
  });
}

export function runOrderRepositoryContract(create: RepositoryFactory<OrderRepository>): void {
  describe('OrderRepository contract', () => {
    let repo: OrderRepository;

    beforeEach(async () => {
      repo = await create();
    });

    it('saves and finds by client order id', async () => {
      await repo.save(orderFixture('co-1'));

      expect(await repo.findByClientOrderId('co-1')).toEqual(orderFixture('co-1'));
    });

    it('returns null for an unknown client order id', async () => {
      expect(await repo.findByClientOrderId('nope')).toBeNull();
    });

    it('updates status and reject reason', async () => {
      await repo.save(orderFixture('co-1'));

      await repo.updateStatus('co-1', OrderStatus.REJECTED, 'no buying power');

      const found = await repo.findByClientOrderId('co-1');
      expect(found!.status).toBe(OrderStatus.REJECTED);
      expect(found!.rejectReason).toBe('no buying power');
    });

    it('preserves an existing reject reason when none is supplied', async () => {
      await repo.save(orderFixture('co-1'));
      await repo.updateStatus('co-1', OrderStatus.REJECTED, 'first reason');

      await repo.updateStatus('co-1', OrderStatus.CANCELLED);

      expect((await repo.findByClientOrderId('co-1'))!.rejectReason).toBe('first reason');
    });

    it('ignores updateStatus for an unknown order', async () => {
      await expect(repo.updateStatus('nope', OrderStatus.FILLED)).resolves.not.toThrow();
    });

    it('findAll and clear behave', async () => {
      await repo.save(orderFixture('co-1'));
      expect(await repo.findAll()).toHaveLength(1);

      await repo.clear();
      expect(await repo.findAll()).toEqual([]);
    });
  });
}

export function runFillRepositoryContract(create: RepositoryFactory<FillRepository>): void {
  describe('FillRepository contract', () => {
    let repo: FillRepository;

    beforeEach(async () => {
      repo = await create();
    });

    it('saves several fills for one order — a partial fill sequence', async () => {
      await repo.save(fillFixture('co-1', 'f1'));
      await repo.save(fillFixture('co-1', 'f2'));
      await repo.save(fillFixture('co-2', 'f3'));

      expect(await repo.findByClientOrderId('co-1')).toHaveLength(2);
      expect(await repo.findAll()).toHaveLength(3);
    });

    it('stores a copy', async () => {
      const original = fillFixture('co-1', 'f1');
      await repo.save(original);

      original.price = 1;

      expect((await repo.findAll())[0].price).toBe(95);
    });

    it('round-trips commission', async () => {
      await repo.save({ ...fillFixture('co-1', 'f1'), commission: 1.25 });

      expect((await repo.findAll())[0].commission).toBe(1.25);
    });

    // The fill router's replay guard: IB re-delivers the day's executions on
    // every reconnect, and this lookup is what distinguishes a new fill from
    // one already processed.
    it('finds a fill by its own id, and returns null for an unknown one', async () => {
      await repo.save(fillFixture('co-1', 'f1'));

      const found = await repo.findByFillId('f1');

      expect(found?.fillId).toBe('f1');
      expect(found?.clientOrderId).toBe('co-1');
      expect(await repo.findByFillId('never-seen')).toBeNull();
    });

    // `save` upserts on `fillId`, so a replayed execution must not become a
    // second row — otherwise the guard above would still hold while the fill
    // count, and any P&L derived from it, silently doubled.
    it('re-saving the same fillId updates rather than duplicates', async () => {
      await repo.save(fillFixture('co-1', 'f1'));
      await repo.save({ ...fillFixture('co-1', 'f1'), price: 74.5 });

      expect(await repo.findAll()).toHaveLength(1);
      expect((await repo.findByFillId('f1'))?.price).toBe(74.5);
    });

    it('clear empties the store', async () => {
      await repo.save(fillFixture('co-1', 'f1'));
      await repo.clear();

      expect(await repo.findAll()).toEqual([]);
    });
  });
}

export function runRiskEventRepositoryContract(
  create: RepositoryFactory<RiskEventRepository>,
): void {
  describe('RiskEventRepository contract', () => {
    let repo: RiskEventRepository;

    beforeEach(async () => {
      repo = await create();
    });

    it('saves via the repository interface', async () => {
      await repo.save(riskEventFixture('via save'));

      expect(await repo.findAll()).toHaveLength(1);
    });

    it('stores a copy', async () => {
      const original = riskEventFixture('original');
      await repo.save(original);

      original.detail = 'mutated';

      expect((await repo.findAll())[0].detail).toBe('original');
    });

    it('keeps events sharing a bar timestamp in insertion order', async () => {
      // Several rejections on one bar is the normal case when a batch is
      // evaluated against a running capital total, not an edge case.
      await repo.save(riskEventFixture('first'));
      await repo.save(riskEventFixture('second'));

      expect((await repo.findAll()).map((e) => e.detail)).toEqual(['first', 'second']);
    });

    it('round-trips an event carrying an intent', async () => {
      const withIntent: RiskEvent = {
        ...riskEventFixture('resized'),
        type: RiskEventType.RESIZE,
        approvedQuantity: 50,
        intent: {
          strategyId: 'dip-ladder:TQQQ',
          symbol: 'TQQQ',
          side: 'BUY',
          quantity: 100,
          limitPrice: 95,
          timestamp: '2025-01-02T10:00:00.000-05:00',
          reason: 'rung',
        },
      };

      await repo.save(withIntent);

      const [stored] = await repo.findAll();
      expect(stored.intent).toEqual(withIntent.intent);
      expect(stored.approvedQuantity).toBe(50);
    });

    it('clear empties the store', async () => {
      await repo.save(riskEventFixture('a'));
      await repo.clear();

      expect(await repo.findAll()).toEqual([]);
    });
  });
}

/**
 * `supportsClear` is false for the Prisma implementation, whose `clear` is a
 * documented no-op: the append-only trigger rejects DELETE, and the audit trail
 * deliberately survives `POST /engine/reset`. Stating the exemption explicitly
 * beats quietly omitting the assertion for one implementation.
 */
export function runParameterChangeRepositoryContract(
  create: RepositoryFactory<ParameterChangeRepository>,
  options: { supportsClear: boolean } = { supportsClear: true },
): void {
  describe('ParameterChangeRepository contract', () => {
    let repo: ParameterChangeRepository;

    beforeEach(async () => {
      repo = await create();
    });

    it('appends changes in order', async () => {
      await repo.append(parameterChangeFixture('a'));
      await repo.append(parameterChangeFixture('b'));

      expect((await repo.findAll()).map((c) => c.id)).toEqual(['a', 'b']);
    });

    it('round-trips old and new values with the operator’s reason', async () => {
      await repo.append(parameterChangeFixture('a'));

      const [stored] = await repo.findAll();
      expect(stored.oldValue).toBe(0.05);
      expect(stored.newValue).toBe(0.07);
      expect(stored.reason).toBe('widening the target');
    });

    it('round-trips the strategy state captured at the change', async () => {
      // `PRD.md:392` — without this, the config alone no longer explains why a
      // held lot exits where it does, because its target was frozen earlier.
      await repo.append(
        parameterChangeFixture('a', {
          stateAtChange: {
            strategyId: 'dip-ladder:TQQQ',
            version: 1,
            symbols: ['TQQQ'],
            data: { lots: [], rungs: [] },
          },
        }),
      );

      const [stored] = await repo.findAll();
      expect(stored.stateAtChange).toEqual({
        strategyId: 'dip-ladder:TQQQ',
        version: 1,
        symbols: ['TQQQ'],
        data: { lots: [], rungs: [] },
      });
    });

    it('filters by strategy', async () => {
      await repo.append(parameterChangeFixture('a'));
      await repo.append(parameterChangeFixture('b', { strategyId: 'grid:TQQQ' }));

      expect((await repo.findByStrategy('grid:TQQQ')).map((c) => c.id)).toEqual(['b']);
    });

    it('groups fields of one edit under a shared changeId', async () => {
      await repo.append(parameterChangeFixture('a', { changeId: 'edit-1' }));
      await repo.append(
        parameterChangeFixture('b', { changeId: 'edit-1', parameter: 'spacingPercent' }),
      );

      const stored = await repo.findAll();
      expect(stored.map((c) => c.changeId)).toEqual(['edit-1', 'edit-1']);
    });

    it('stores a copy', async () => {
      const original = parameterChangeFixture('a');
      await repo.append(original);

      original.newValue = 999;

      expect((await repo.findAll())[0].newValue).toBe(0.07);
    });

    it('rejects a duplicate id rather than overwriting — the log is append-only', async () => {
      await repo.append(parameterChangeFixture('a'));

      // An upsert here would silently rewrite history, which is the exact
      // operation this log exists to make impossible.
      await expect(repo.append(parameterChangeFixture('a', { newValue: 0.99 }))).rejects.toThrow();

      expect((await repo.findAll())[0].newValue).toBe(0.07);
    });

    if (options.supportsClear) {
      it('clear empties the store', async () => {
        await repo.append(parameterChangeFixture('a'));
        await repo.clear();

        expect(await repo.findAll()).toEqual([]);
      });
    }
  });
}

export function snapshotFixture(
  strategyId = 'dip-ladder:TQQQ',
  overrides: Partial<StrategyStateSnapshotRecord> = {},
): StrategyStateSnapshotRecord {
  return {
    strategyId,
    version: 1,
    symbols: ['TQQQ'],
    data: {
      lots: [],
      rungs: [],
      firstEntryPrice: 95,
      lotSequence: 3,
      previousSessionClose: 96.5,
      runningClose: 94.2,
      sessionOpen: 96,
      sessionDate: '2025-01-02',
    },
    capturedAt: '2025-01-02T16:00:00.000-05:00',
    ...overrides,
  };
}

/**
 * Strategy state snapshots — the anchor's durable home.
 *
 * The assertions that matter for recovery are ordering (`findLatest` must
 * return the *newest*, not just any) and append semantics (a save must not
 * destroy the previous snapshot). Both are what let Story 9 fall back to the
 * last good state after a crash mid-write.
 */
export function runStrategyStateSnapshotRepositoryContract(
  create: RepositoryFactory<StrategyStateSnapshotRepository>,
): void {
  describe('StrategyStateSnapshotRepository contract', () => {
    let repo: StrategyStateSnapshotRepository;

    beforeEach(async () => {
      repo = await create();
    });

    it('returns null for a strategy with no snapshot', async () => {
      expect(await repo.findLatest('dip-ladder:TQQQ')).toBeNull();
    });

    it('round-trips the anchor scalars a restart depends on', async () => {
      // These four fields are the reason this table exists — lots and rungs
      // have their own tables, but `sessionOpen`, `previousSessionClose`,
      // `firstEntryPrice`, and `lotSequence` live nowhere else. Losing them
      // means a restart forgets where the ladder measures from.
      await repo.save(snapshotFixture());

      const loaded = await repo.findLatest('dip-ladder:TQQQ');

      expect(loaded).not.toBeNull();
      expect(loaded!.data.firstEntryPrice).toBe(95);
      expect(loaded!.data.lotSequence).toBe(3);
      expect(loaded!.data.previousSessionClose).toBe(96.5);
      expect(loaded!.data.sessionOpen).toBe(96);
      expect(loaded!.version).toBe(1);
      expect(loaded!.symbols).toEqual(['TQQQ']);
    });

    it('appends rather than replacing, so the previous snapshot survives', async () => {
      await repo.save(
        snapshotFixture('dip-ladder:TQQQ', { capturedAt: '2025-01-02T10:00:00.000-05:00' }),
      );
      await repo.save(
        snapshotFixture('dip-ladder:TQQQ', { capturedAt: '2025-01-02T11:00:00.000-05:00' }),
      );

      expect(await repo.findAll('dip-ladder:TQQQ')).toHaveLength(2);
    });

    it('findLatest returns the newest by capture time', async () => {
      // Deliberately saved out of order: a naive "last row wins" would pass
      // when writes happen in order and fail here.
      await repo.save(
        snapshotFixture('dip-ladder:TQQQ', {
          capturedAt: '2025-01-02T11:00:00.000-05:00',
          data: { marker: 'newest' },
        }),
      );
      await repo.save(
        snapshotFixture('dip-ladder:TQQQ', {
          capturedAt: '2025-01-02T10:00:00.000-05:00',
          data: { marker: 'older' },
        }),
      );

      expect((await repo.findLatest('dip-ladder:TQQQ'))!.data.marker).toBe('newest');
    });

    it('keeps strategies separate', async () => {
      await repo.save(snapshotFixture('dip-ladder:TQQQ', { data: { marker: 'tqqq' } }));
      await repo.save(
        snapshotFixture('dip-ladder:SOXL', { symbols: ['SOXL'], data: { marker: 'soxl' } }),
      );

      expect((await repo.findLatest('dip-ladder:TQQQ'))!.data.marker).toBe('tqqq');
      expect((await repo.findLatest('dip-ladder:SOXL'))!.data.marker).toBe('soxl');
    });

    it('preserves the version so an unreadable snapshot can be rejected', async () => {
      // Story 9 refuses to load a version it does not understand. That is only
      // possible if the stored version is the one that was written.
      await repo.save(snapshotFixture('dip-ladder:TQQQ', { version: 99 }));

      expect((await repo.findLatest('dip-ladder:TQQQ'))!.version).toBe(99);
    });

    it('isolates stored state from later mutation of the saved object', async () => {
      const snapshot = snapshotFixture();
      await repo.save(snapshot);

      (snapshot.data as Record<string, unknown>).firstEntryPrice = 999;

      expect((await repo.findLatest('dip-ladder:TQQQ'))!.data.firstEntryPrice).toBe(95);
    });

    it('clear empties the store', async () => {
      await repo.save(snapshotFixture());
      await repo.clear();

      expect(await repo.findLatest('dip-ladder:TQQQ')).toBeNull();
    });
  });
}

export function barFixture(timestamp: string, overrides: Partial<Bar> = {}): Bar {
  return {
    symbol: 'TQQQ',
    barSize: BarSize.DAILY,
    timestamp,
    open: 40,
    high: 41,
    low: 39,
    close: 40.5,
    volume: 1_000_000,
    ...overrides,
  };
}

/**
 * The `BarRepository` contract (Story 10).
 *
 * The two properties worth the shared suite are the ones a divergence would
 * hide: **upsert on re-ingest**, because overlapping gap-fill ranges deliver
 * the same edge bar routinely and a duplicate would corrupt any range read; and
 * **synthetic exclusion by default**, because a synthetic series silently mixed
 * into a backtest reports a return the real instrument could not have produced
 * (`stories.md:619`).
 */
export function runBarRepositoryContract(create: RepositoryFactory<BarRepository>): void {
  describe('BarRepository contract', () => {
    let repo: BarRepository;

    beforeEach(async () => {
      repo = await create();
    });

    it('stores and returns bars in ascending timestamp order', async () => {
      await repo.saveAll([
        barFixture('2025-01-03T00:00:00.000-05:00'),
        barFixture('2025-01-02T00:00:00.000-05:00'),
      ]);

      const bars = await repo.findRange(
        'TQQQ',
        BarSize.DAILY,
        '2025-01-01T00:00:00.000-05:00',
        '2025-01-31T00:00:00.000-05:00',
      );

      expect(bars.map((bar) => bar.timestamp)).toEqual([
        '2025-01-02T00:00:00.000-05:00',
        '2025-01-03T00:00:00.000-05:00',
      ]);
    });

    it('upserts rather than duplicating when the same bar is ingested twice', async () => {
      const timestamp = '2025-01-02T00:00:00.000-05:00';

      await repo.saveAll([barFixture(timestamp, { close: 40 })]);
      await repo.saveAll([barFixture(timestamp, { close: 42 })]);

      const bars = await repo.findRange(
        'TQQQ',
        BarSize.DAILY,
        '2025-01-01T00:00:00.000-05:00',
        '2025-01-31T00:00:00.000-05:00',
      );

      // One row, carrying the newer value — an overlapping gap-fill must not
      // leave two closes for one instant.
      expect(bars).toHaveLength(1);
      expect(bars[0].close).toBe(42);
    });

    it('treats a range as inclusive at both ends', async () => {
      await repo.saveAll([
        barFixture('2025-01-02T00:00:00.000-05:00'),
        barFixture('2025-01-03T00:00:00.000-05:00'),
        barFixture('2025-01-04T00:00:00.000-05:00'),
      ]);

      const bars = await repo.findRange(
        'TQQQ',
        BarSize.DAILY,
        '2025-01-02T00:00:00.000-05:00',
        '2025-01-04T00:00:00.000-05:00',
      );

      // An exclusive boundary would leave a one-bar hole the gap-fill would
      // then re-request on every pass, forever.
      expect(bars).toHaveLength(3);
    });

    it('separates bar sizes for the same symbol', async () => {
      await repo.saveAll([
        barFixture('2025-01-02T00:00:00.000-05:00', { barSize: BarSize.DAILY }),
        barFixture('2025-01-02T09:30:00.000-05:00', { barSize: BarSize.FIVE_MIN }),
      ]);

      const daily = await repo.findRange(
        'TQQQ',
        BarSize.DAILY,
        '2025-01-01T00:00:00.000-05:00',
        '2025-01-31T00:00:00.000-05:00',
      );

      expect(daily).toHaveLength(1);
      expect(daily[0].barSize).toBe(BarSize.DAILY);
    });

    it('excludes synthetic bars unless explicitly asked for', async () => {
      await repo.saveAll([
        barFixture('2025-01-02T00:00:00.000-05:00'),
        barFixture('2009-01-02T00:00:00.000-05:00', { synthetic: true }),
      ]);

      const from = '2000-01-01T00:00:00.000-05:00';
      const to = '2025-12-31T00:00:00.000-05:00';

      const real = await repo.findRange('TQQQ', BarSize.DAILY, from, to);
      const all = await repo.findRange('TQQQ', BarSize.DAILY, from, to, true);

      // **The rule that keeps a backtest honest**: synthetic 3x excludes the
      // expense ratio and financing costs a real leveraged ETF pays.
      expect(real).toHaveLength(1);
      expect(real[0].synthetic).toBeUndefined();
      expect(all).toHaveLength(2);
      expect(all.some((bar) => bar.synthetic === true)).toBe(true);
    });

    it('reports the earliest and latest cached bar, so a backfill knows its reach', async () => {
      await repo.saveAll([
        barFixture('2025-01-03T00:00:00.000-05:00'),
        barFixture('2025-01-02T00:00:00.000-05:00'),
        barFixture('2025-01-04T00:00:00.000-05:00'),
      ]);

      expect((await repo.findEarliest('TQQQ', BarSize.DAILY))!.timestamp).toBe(
        '2025-01-02T00:00:00.000-05:00',
      );
      expect((await repo.findLatest('TQQQ', BarSize.DAILY))!.timestamp).toBe(
        '2025-01-04T00:00:00.000-05:00',
      );
    });

    it('returns null for earliest/latest when nothing is cached', async () => {
      expect(await repo.findEarliest('TQQQ', BarSize.DAILY)).toBeNull();
      expect(await repo.findLatest('TQQQ', BarSize.DAILY)).toBeNull();
    });

    it('counts real bars in a range', async () => {
      await repo.saveAll([
        barFixture('2025-01-02T00:00:00.000-05:00'),
        barFixture('2025-01-03T00:00:00.000-05:00'),
      ]);

      const count = await repo.countInRange(
        'TQQQ',
        BarSize.DAILY,
        '2025-01-01T00:00:00.000-05:00',
        '2025-01-31T00:00:00.000-05:00',
      );

      expect(count).toBe(2);
    });

    it('saveAll with no bars is a no-op', async () => {
      await expect(repo.saveAll([])).resolves.toBeUndefined();
    });

    it('clear empties the store', async () => {
      await repo.saveAll([barFixture('2025-01-02T00:00:00.000-05:00')]);
      await repo.clear();

      expect(await repo.findLatest('TQQQ', BarSize.DAILY)).toBeNull();
    });
  });
}

export function backtestRunFixture(overrides: Partial<BacktestRunRecord> = {}): BacktestRunRecord {
  return {
    id: 'bt-1',
    strategyId: 'dip-ladder:TQQQ',
    symbol: 'TQQQ',
    barSize: BarSize.DAILY,
    rangeStart: '2022-01-03T09:30:00.000-05:00',
    rangeEnd: '2022-12-30T09:30:00.000-05:00',
    parameters: { spacingPercent: 0.05, maxConcurrentRungs: 5 },
    synthetic: false,
    createdAt: '2022-12-30T09:30:00.000-05:00',
    ...overrides,
  };
}

/**
 * Backtest persistence (Story 11) — **results comparable across parameter
 * sets** (`stories.md:645`).
 *
 * The properties asserted here are the ones a sweep depends on: a run stores
 * the parameters it actually used, metrics are keyed uniquely per run so a
 * recomputation replaces rather than duplicates, and the synthetic flag
 * survives the round trip so a synthetic run can never be read back as real.
 */
export function runBacktestRepositoryContract(create: RepositoryFactory<BacktestRepository>): void {
  describe('BacktestRepository contract', () => {
    let repo: BacktestRepository;

    beforeEach(async () => {
      repo = await create();
    });

    it('round-trips a run with its parameter set', async () => {
      const run = backtestRunFixture();
      await repo.saveRun(run);

      expect(await repo.findRun('bt-1')).toEqual(run);
    });

    it('returns null for an unknown run', async () => {
      expect(await repo.findRun('missing')).toBeNull();
    });

    it('preserves the synthetic flag — a synthetic run must never read as real', async () => {
      await repo.saveRun(backtestRunFixture({ id: 'bt-syn', synthetic: true }));

      expect((await repo.findRun('bt-syn'))?.synthetic).toBe(true);
    });

    it('stores parameters verbatim rather than resolving them at read time', async () => {
      await repo.saveRun(
        backtestRunFixture({ parameters: { spacingPercent: 0.04, takeProfitPercent: 0.07 } }),
      );

      expect((await repo.findRun('bt-1'))?.parameters).toEqual({
        spacingPercent: 0.04,
        takeProfitPercent: 0.07,
      });
    });

    it('saves and reads back metrics for a run', async () => {
      await repo.saveRun(backtestRunFixture());
      await repo.saveResults([
        { runId: 'bt-1', metric: 'totalReturnPercent', value: 0.1234 },
        { runId: 'bt-1', metric: 'maxDrawdownPercent', value: 0.8 },
      ]);

      const results = await repo.findResults('bt-1');

      expect(results).toHaveLength(2);
      expect(results.find((r) => r.metric === 'totalReturnPercent')?.value).toBeCloseTo(0.1234, 6);
      expect(results.find((r) => r.metric === 'maxDrawdownPercent')?.value).toBeCloseTo(0.8, 6);
    });

    it('carries a detail payload for metrics that are not a single number', async () => {
      await repo.saveRun(backtestRunFixture());
      await repo.saveResults([
        { runId: 'bt-1', metric: 'rungDistribution', value: 2, detail: { '95.00': 6, '90.25': 4 } },
      ]);

      const [result] = await repo.findResults('bt-1');

      expect(result.detail).toEqual({ '95.00': 6, '90.25': 4 });
    });

    it('replaces a metric on re-save rather than storing two values for one name', async () => {
      await repo.saveRun(backtestRunFixture());
      await repo.saveResults([{ runId: 'bt-1', metric: 'winRate', value: 0.5 }]);
      await repo.saveResults([{ runId: 'bt-1', metric: 'winRate', value: 0.75 }]);

      const results = await repo.findResults('bt-1');

      expect(results).toHaveLength(1);
      expect(results[0].value).toBeCloseTo(0.75, 6);
    });

    it('keeps one run per combination distinct — the point of a sweep', async () => {
      await repo.saveRun(backtestRunFixture({ id: 'bt-a', parameters: { spacingPercent: 0.04 } }));
      await repo.saveRun(backtestRunFixture({ id: 'bt-b', parameters: { spacingPercent: 0.06 } }));

      const runs = await repo.findAllRuns();

      expect(runs).toHaveLength(2);
      expect(runs.map((run) => run.id).sort()).toEqual(['bt-a', 'bt-b']);
    });

    it('lists runs newest first', async () => {
      await repo.saveRun(
        backtestRunFixture({ id: 'older', createdAt: '2021-01-01T00:00:00.000Z' }),
      );
      await repo.saveRun(
        backtestRunFixture({ id: 'newer', createdAt: '2023-01-01T00:00:00.000Z' }),
      );

      expect((await repo.findAllRuns()).map((run) => run.id)).toEqual(['newer', 'older']);
    });

    it('re-saving a run updates it rather than duplicating the id', async () => {
      await repo.saveRun(backtestRunFixture());
      await repo.saveRun(backtestRunFixture({ symbol: 'QQQ' }));

      const runs = await repo.findAllRuns();

      expect(runs).toHaveLength(1);
      expect(runs[0].symbol).toBe('QQQ');
    });

    it('returns no metrics for a run that has none', async () => {
      await repo.saveRun(backtestRunFixture());

      expect(await repo.findResults('bt-1')).toEqual([]);
    });

    it('saveResults with an empty list is a no-op', async () => {
      await repo.saveRun(backtestRunFixture());
      await repo.saveResults([]);

      expect(await repo.findResults('bt-1')).toEqual([]);
    });

    it('clear empties runs and their metrics', async () => {
      await repo.saveRun(backtestRunFixture());
      await repo.saveResults([{ runId: 'bt-1', metric: 'winRate', value: 1 }]);
      await repo.clear();

      expect(await repo.findAllRuns()).toEqual([]);
      expect(await repo.findResults('bt-1')).toEqual([]);
    });
  });
}
