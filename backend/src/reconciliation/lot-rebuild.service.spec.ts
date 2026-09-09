import { Fill, OrderStatus } from '../broker/broker-adapter.interface';
import {
  FillRepository,
  OrderRepository,
  OrderRecord,
} from '../repositories/repository.interfaces';
import { Lot, LotStatus } from '../strategies/dip-ladder/lot';
import {
  createRung,
  reArm,
  markHeld,
  markWorking,
  RungStatus,
} from '../strategies/dip-ladder/rung';
import { LotRebuildService, RebuildAction } from './lot-rebuild.service';
import { ReconciliationStatus } from './lot-sum-assertion';

function order(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    clientOrderId: 'co-1',
    brokerOrderId: null,
    symbol: 'TQQQ',
    side: 'BUY',
    quantity: 100,
    limitPrice: 95,
    status: OrderStatus.SUBMITTED,
    rejectReason: null,
    strategyId: 'dip-ladder:TQQQ',
    createdAt: '2026-08-18T10:40:00.000-04:00',
    ...overrides,
  };
}

function lot(overrides: Partial<Lot> = {}): Lot {
  return {
    id: 'TQQQ-lot-1',
    rungPrice: 95,
    fillPrice: 95,
    quantity: 100,
    openedAt: '2026-08-18T09:45:00.000-04:00',
    exitTarget: 99.75,
    status: LotStatus.HELD,
    closedAt: null,
    exitPrice: null,
    workingOrderId: null,
    ...overrides,
  };
}

function ordersRepo(records: OrderRecord[]): OrderRepository {
  return {
    save: jest.fn(),
    updateStatus: jest.fn(),
    findAll: jest.fn().mockResolvedValue(records),
    findByClientOrderId: jest.fn(),
    clear: jest.fn(),
  };
}

/** Empty by default — "no fill evidence at all," the ordinary write-off case. */
function fillsRepo(records: Fill[] = []): FillRepository {
  return {
    save: jest.fn(),
    findAll: jest.fn().mockResolvedValue(records),
    findByClientOrderId: jest
      .fn()
      .mockImplementation((clientOrderId: string) =>
        Promise.resolve(records.filter((fill) => fill.clientOrderId === clientOrderId)),
      ),
    findByFillId: jest.fn(),
    clear: jest.fn(),
  };
}

const NOW = '2026-08-19T10:00:00.000-04:00';

describe('LotRebuildService — delta > 0 (broker holds more)', () => {
  it('reconstructs an exact Tier 1 match from stranded orders, keeping existing correct lots', async () => {
    const workingRung = markWorking(createRung(95), 'co-1');
    const service = new LotRebuildService(
      ordersRepo([order({ clientOrderId: 'co-1', quantity: 50 })]),
      fillsRepo(),
    );

    const outcome = await service.attempt({
      symbol: 'TQQQ',
      persistedLots: [lot({ id: 'TQQQ-lot-1', quantity: 100 })],
      persistedRungs: [markHeld(createRung(90), 'TQQQ-lot-1'), workingRung],
      brokerQuantity: 150,
      brokerAverageCost: 93.33,
      takeProfitPercent: 0.05,
      takeProfitDollars: null,
      now: NOW,
    });

    expect(outcome.applied).toBe(true);
    expect(outcome.action).toBe(RebuildAction.ADD_TIER1_RECONSTRUCTED);
    expect(outcome.verdict.reconciled).toBe(true);
    expect(outcome.lots).toHaveLength(2);

    const recovered = outcome.lots.find((l) => l.id !== 'TQQQ-lot-1')!;
    expect(recovered.quantity).toBe(50);
    expect(recovered.fillPrice).toBe(95); // the order's own limit price, not a blend
    expect(recovered.status).toBe(LotStatus.HELD);

    const hostRung = outcome.rungs.find((r) => r.price === 95)!;
    expect(hostRung.status).toBe(RungStatus.HELD);
    expect(hostRung.lotId).toBe(recovered.id);
    expect(hostRung.workingOrderId).toBeNull();

    // The pre-existing, already-correct lot/rung are untouched.
    expect(outcome.lots.find((l) => l.id === 'TQQQ-lot-1')).toEqual(lot({ quantity: 100 }));
  });

  it('falls through to Tier 2 when the stranded orders do not sum exactly to the gap', async () => {
    const workingRung = markWorking(createRung(95), 'co-1');
    // Order quantity (30) does not match the gap (50).
    const service = new LotRebuildService(
      ordersRepo([order({ clientOrderId: 'co-1', quantity: 30 })]),
      fillsRepo(),
    );

    const outcome = await service.attempt({
      symbol: 'TQQQ',
      persistedLots: [lot({ id: 'TQQQ-lot-1', quantity: 100 })],
      persistedRungs: [markHeld(createRung(90), 'TQQQ-lot-1'), workingRung],
      brokerQuantity: 150,
      brokerAverageCost: 93.33,
      takeProfitPercent: 0.05,
      takeProfitDollars: null,
      now: NOW,
    });

    expect(outcome.applied).toBe(true);
    expect(outcome.action).toBe(RebuildAction.ADD_TIER2_SYNTHETIC);

    const synthetic = outcome.lots.find((l) => l.id !== 'TQQQ-lot-1')!;
    expect(synthetic.quantity).toBe(50);
    expect(synthetic.fillPrice).toBe(93.33);
    expect(synthetic.id).toMatch(/^TQQQ-lot-synthetic-/);
  });

  it('synthesizes a single lot with no stranded orders at all (UNTRACKED_AT_BROKER)', async () => {
    const service = new LotRebuildService(ordersRepo([]), fillsRepo());

    const outcome = await service.attempt({
      symbol: 'TQQQ',
      persistedLots: [],
      persistedRungs: [],
      brokerQuantity: 272,
      brokerAverageCost: 73.1,
      takeProfitPercent: 0.05,
      takeProfitDollars: null,
      now: NOW,
    });

    expect(outcome.applied).toBe(true);
    expect(outcome.action).toBe(RebuildAction.ADD_TIER2_SYNTHETIC);
    expect(outcome.verdict.status).toBe(ReconciliationStatus.MATCHED);
    expect(outcome.lots).toHaveLength(1);
    expect(outcome.lots[0].quantity).toBe(272);
    expect(outcome.lots[0].fillPrice).toBe(73.1);

    // A fresh rung is created to host it, at the broker's average cost.
    const hostRung = outcome.rungs.find((r) => r.lotId === outcome.lots[0].id)!;
    expect(hostRung.price).toBe(73.1);
    expect(hostRung.status).toBe(RungStatus.HELD);
  });

  it('hosts the synthetic lot on an existing rung at the same price instead of duplicating it', async () => {
    const service = new LotRebuildService(ordersRepo([]), fillsRepo());
    const existingRung = createRung(93.33); // PENDING, no lot

    const outcome = await service.attempt({
      symbol: 'TQQQ',
      persistedLots: [],
      persistedRungs: [existingRung],
      brokerQuantity: 50,
      brokerAverageCost: 93.33,
      takeProfitPercent: 0.05,
      takeProfitDollars: null,
      now: NOW,
    });

    expect(outcome.applied).toBe(true);
    expect(outcome.rungs).toHaveLength(1);
    expect(outcome.rungs[0].price).toBe(93.33);
    expect(outcome.rungs[0].status).toBe(RungStatus.HELD);
  });

  it('nudges the synthetic rung price aside rather than clobbering a WORKING rung at the same price', async () => {
    const service = new LotRebuildService(ordersRepo([]), fillsRepo());
    const collidingWorkingRung = markWorking(createRung(93.33), 'co-unrelated');

    const outcome = await service.attempt({
      symbol: 'TQQQ',
      persistedLots: [],
      persistedRungs: [collidingWorkingRung],
      brokerQuantity: 50,
      brokerAverageCost: 93.33,
      takeProfitPercent: 0.05,
      takeProfitDollars: null,
      now: NOW,
    });

    expect(outcome.applied).toBe(true);
    // The WORKING rung and its resting order are untouched.
    const untouched = outcome.rungs.find((r) => r.price === 93.33)!;
    expect(untouched.status).toBe(RungStatus.WORKING);
    expect(untouched.workingOrderId).toBe('co-unrelated');

    // The synthetic lot lands one cent away instead.
    const hostRung = outcome.rungs.find((r) => r.price === 93.34)!;
    expect(hostRung.status).toBe(RungStatus.HELD);
  });
});

describe('LotRebuildService — delta < 0 (broker holds less: write-off)', () => {
  it('writes off the newest excess first by closing the oldest held lot(s) at their own fill price', async () => {
    const service = new LotRebuildService(ordersRepo([]), fillsRepo());
    const older = lot({
      id: 'TQQQ-lot-1',
      quantity: 100,
      fillPrice: 90,
      openedAt: '2026-08-18T09:45:00.000-04:00',
    });
    const newer = lot({
      id: 'TQQQ-lot-2',
      quantity: 100,
      fillPrice: 95,
      openedAt: '2026-08-18T10:00:00.000-04:00',
    });

    const outcome = await service.attempt({
      symbol: 'TQQQ',
      persistedLots: [newer, older],
      persistedRungs: [
        markHeld(createRung(90), 'TQQQ-lot-1'),
        markHeld(createRung(95), 'TQQQ-lot-2'),
      ],
      brokerQuantity: 100,
      brokerAverageCost: 95,
      takeProfitPercent: 0.05,
      takeProfitDollars: null,
      now: NOW,
    });

    expect(outcome.applied).toBe(true);
    expect(outcome.action).toBe(RebuildAction.WRITE_OFF);
    expect(outcome.verdict.reconciled).toBe(true);

    const closedOlder = outcome.lots.find((l) => l.id === 'TQQQ-lot-1')!;
    expect(closedOlder.status).toBe(LotStatus.CLOSED);
    expect(closedOlder.exitPrice).toBe(90); // its own fill price, not a market price
    expect(closedOlder.exitPrice).toBe(closedOlder.fillPrice); // realizedPnl is therefore exactly 0

    const stillHeldNewer = outcome.lots.find((l) => l.id === 'TQQQ-lot-2')!;
    expect(stillHeldNewer.status).toBe(LotStatus.HELD);

    // Its rung is released without crediting a cycle — not reArm.
    const releasedRung = outcome.rungs.find((r) => r.price === 90)!;
    expect(releasedRung.status).toBe(RungStatus.PENDING);
    expect(releasedRung.completedCycles).toBe(0);
    expect(releasedRung.lastExitAt).toBeNull();
    expect(releasedRung.lotId).toBeNull();
  });

  it('releases to RE_ARMED, not PENDING, when the written-off rung had already cycled before', async () => {
    const service = new LotRebuildService(ordersRepo([]), fillsRepo());
    const cycled = reArm(markHeld(createRung(90), 'lot-old'), '2026-08-01T10:00:00.000-04:00');
    const rehed = markHeld(cycled, 'TQQQ-lot-1');

    const outcome = await service.attempt({
      symbol: 'TQQQ',
      persistedLots: [lot({ id: 'TQQQ-lot-1', quantity: 100, fillPrice: 90 })],
      persistedRungs: [rehed],
      brokerQuantity: 0,
      brokerAverageCost: 90,
      takeProfitPercent: 0.05,
      takeProfitDollars: null,
      now: NOW,
    });

    expect(outcome.applied).toBe(true);
    const released = outcome.rungs.find((r) => r.price === 90)!;
    expect(released.status).toBe(RungStatus.RE_ARMED);
    expect(released.completedCycles).toBe(1);
  });

  it('splits a lot when the write-off amount is smaller than its quantity, keeping the remainder HELD', async () => {
    const service = new LotRebuildService(ordersRepo([]), fillsRepo());
    const held = lot({ id: 'TQQQ-lot-1', quantity: 100, fillPrice: 90, exitTarget: 94.5 });

    const outcome = await service.attempt({
      symbol: 'TQQQ',
      persistedLots: [held],
      persistedRungs: [markHeld(createRung(90), 'TQQQ-lot-1')],
      brokerQuantity: 60, // writes off 40
      brokerAverageCost: 90,
      takeProfitPercent: 0.05,
      takeProfitDollars: null,
      now: NOW,
    });

    expect(outcome.applied).toBe(true);
    expect(outcome.verdict.reconciled).toBe(true);

    const closedPortion = outcome.lots.find((l) => l.status === LotStatus.CLOSED)!;
    expect(closedPortion.quantity).toBe(40);
    expect(closedPortion.exitPrice).toBe(90);

    const remainder = outcome.lots.find((l) => l.status === LotStatus.HELD)!;
    expect(remainder.quantity).toBe(60);
    // The remainder keeps the original fillPrice/exitTarget/openedAt — same
    // shares, same target, per the codebase's existing partial-sell rule.
    expect(remainder.fillPrice).toBe(90);
    expect(remainder.exitTarget).toBe(94.5);
    expect(remainder.openedAt).toBe(held.openedAt);

    // The rung stays HELD, now pointing at the remainder's fresh id.
    const rung = outcome.rungs.find((r) => r.price === 90)!;
    expect(rung.status).toBe(RungStatus.HELD);
    expect(rung.lotId).toBe(remainder.id);
  });

  /**
   * `recoverExitFills` (`reconciliation.service.ts`) already applies any fill
   * that exactly covers a lot's quantity, before this service ever runs. So a
   * `Fill` still on record for a lot's `workingOrderId` at this point is proof
   * of a *partial* sale, not proof of nothing — writing it off at the lot's
   * own cost would silently discard the real proceeds that fill recorded.
   */
  it('refuses rather than write off a lot with unresolved (partial) fill evidence', async () => {
    const service = new LotRebuildService(
      ordersRepo([]),
      fillsRepo([
        {
          clientOrderId: 'co-partial-sell',
          brokerOrderId: '1',
          fillId: 'exec-partial',
          symbol: 'TQQQ',
          side: 'SELL',
          quantity: 40,
          price: 99.75,
          commission: 0,
          timestamp: '2026-08-18T10:30:00.000-04:00',
        },
      ]),
    );
    const held = lot({
      id: 'TQQQ-lot-1',
      quantity: 100,
      fillPrice: 95,
      workingOrderId: 'co-partial-sell',
    });

    const outcome = await service.attempt({
      symbol: 'TQQQ',
      persistedLots: [held],
      persistedRungs: [markHeld(createRung(95), 'TQQQ-lot-1')],
      brokerQuantity: 60, // 40 short, exactly what the partial fill covers
      brokerAverageCost: 95,
      takeProfitPercent: 0.05,
      takeProfitDollars: null,
      now: NOW,
    });

    expect(outcome.applied).toBe(false);
    expect(outcome.action).toBeNull();
    // Untouched — the caller (`reconciliation.service.ts`) treats this exactly
    // like a mismatch no rebuild was ever attempted against: halted.
    expect(outcome.lots).toEqual([held]);
  });
});

describe('LotRebuildService — FIXED_DOLLAR geometry (takeProfitDollars supersedes percent)', () => {
  it('uses takeProfitDollars for a Tier 1 reconstruction, not the percentage', async () => {
    const workingRung = markWorking(createRung(95), 'co-1');
    const service = new LotRebuildService(
      ordersRepo([order({ clientOrderId: 'co-1', quantity: 50 })]),
      fillsRepo(),
    );

    const outcome = await service.attempt({
      symbol: 'TQQQ',
      persistedLots: [],
      persistedRungs: [workingRung],
      brokerQuantity: 50,
      brokerAverageCost: 95,
      takeProfitPercent: 0.05, // would give 99.75 — must be ignored
      takeProfitDollars: 1,
      now: NOW,
    });

    expect(outcome.applied).toBe(true);
    expect(outcome.action).toBe(RebuildAction.ADD_TIER1_RECONSTRUCTED);
    expect(outcome.lots[0].exitTarget).toBe(96); // 95 + 1, not 95 * 1.05
  });

  it('uses takeProfitDollars for a Tier 2 synthetic lot, not the percentage', async () => {
    const service = new LotRebuildService(ordersRepo([]), fillsRepo());

    const outcome = await service.attempt({
      symbol: 'TQQQ',
      persistedLots: [],
      persistedRungs: [],
      brokerQuantity: 50,
      brokerAverageCost: 95,
      takeProfitPercent: 0.05,
      takeProfitDollars: 1,
      now: NOW,
    });

    expect(outcome.applied).toBe(true);
    expect(outcome.action).toBe(RebuildAction.ADD_TIER2_SYNTHETIC);
    expect(outcome.lots[0].exitTarget).toBe(96);
  });
});

describe('LotRebuildService — no mismatch', () => {
  it('reports applied:false when delta is exactly zero', async () => {
    const service = new LotRebuildService(ordersRepo([]), fillsRepo());

    const outcome = await service.attempt({
      symbol: 'TQQQ',
      persistedLots: [lot({ quantity: 100 })],
      persistedRungs: [],
      brokerQuantity: 100,
      brokerAverageCost: 95,
      takeProfitPercent: 0.05,
      takeProfitDollars: null,
      now: NOW,
    });

    expect(outcome.applied).toBe(false);
    expect(outcome.action).toBeNull();
  });
});
