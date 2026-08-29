/**
 * The lot-sum assertion — pure verdict logic.
 *
 * The behavioural cases (halt, resume, other symbols unaffected) live in
 * `reconciliation.service.spec.ts`; this file pins the arithmetic and the
 * classification, which is where an off-by-one would silently permit trading
 * against a position the system has mis-measured.
 */

import { Lot, LotStatus } from '../strategies/dip-ladder/lot';
import { assertLotSum, ReconciliationStatus, sumHeldQuantity } from './lot-sum-assertion';

function lot(overrides: Partial<Lot> = {}): Lot {
  return {
    id: 'TQQQ-lot-1',
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

describe('assertLotSum', () => {
  it('reconciles when the held lot sum equals the broker net position', () => {
    const lots = [
      lot({ id: 'a', quantity: 100 }),
      lot({ id: 'b', quantity: 100 }),
      lot({ id: 'c', quantity: 100 }),
    ];

    const verdict = assertLotSum('TQQQ', lots, 300);

    expect(verdict.reconciled).toBe(true);
    expect(verdict.status).toBe(ReconciliationStatus.MATCHED);
    expect(verdict.lotQuantity).toBe(300);
    expect(verdict.heldLotCount).toBe(3);
  });

  it('treats a held ladder and a single block of the same size as identical', () => {
    // `PRD.md:338` and `stories.md:565`. The broker cannot tell these apart, so
    // both must reconcile against the same net position — and the DB alone
    // determines which one it actually is. If this test failed, the system
    // would be reading lot structure out of a number that does not contain it.
    const threeLots = [
      lot({ id: 'a', quantity: 100, fillPrice: 95 }),
      lot({ id: 'b', quantity: 100, fillPrice: 90.25 }),
      lot({ id: 'c', quantity: 100, fillPrice: 85.74 }),
    ];
    const oneBlock = [lot({ id: 'single', quantity: 300, fillPrice: 90.33 })];

    expect(assertLotSum('TQQQ', threeLots, 300).reconciled).toBe(true);
    expect(assertLotSum('TQQQ', oneBlock, 300).reconciled).toBe(true);

    // Same verdict, different composition — which is the point.
    expect(assertLotSum('TQQQ', threeLots, 300).heldLotCount).toBe(3);
    expect(assertLotSum('TQQQ', oneBlock, 300).heldLotCount).toBe(1);
  });

  it('excludes closed lots from the sum', () => {
    // A closed lot describes shares that are gone. Counting it would report a
    // position the account does not hold and halt a perfectly clean ladder.
    const lots = [
      lot({ id: 'open', quantity: 100 }),
      lot({
        id: 'closed',
        quantity: 100,
        status: LotStatus.CLOSED,
        closedAt: '2025-01-02T13:00:00.000-05:00',
        exitPrice: 99.75,
      }),
    ];

    const verdict = assertLotSum('TQQQ', lots, 100);

    expect(verdict.reconciled).toBe(true);
    expect(verdict.lotQuantity).toBe(100);
    expect(verdict.heldLotCount).toBe(1);
  });

  it('reconciles flat against flat', () => {
    const verdict = assertLotSum('TQQQ', [], 0);

    expect(verdict.reconciled).toBe(true);
    expect(verdict.reason).toContain('nothing to reconcile');
  });

  it('flags MISSING_AT_BROKER when the DB holds lots the broker does not', () => {
    // `stories.md:561`.
    const verdict = assertLotSum('TQQQ', [lot({ quantity: 200 })], 0);

    expect(verdict.reconciled).toBe(false);
    expect(verdict.status).toBe(ReconciliationStatus.MISSING_AT_BROKER);
    expect(verdict.reason).toMatch(/broker reports no position/);
  });

  it('flags UNTRACKED_AT_BROKER when the broker holds a position the DB does not', () => {
    // `stories.md:560`.
    const verdict = assertLotSum('TQQQ', [], 300);

    expect(verdict.reconciled).toBe(false);
    expect(verdict.status).toBe(ReconciliationStatus.UNTRACKED_AT_BROKER);
    expect(verdict.reason).toMatch(/lot composition is unknown/);
  });

  it('flags QUANTITY_MISMATCH when both sides hold but disagree', () => {
    const verdict = assertLotSum('TQQQ', [lot({ quantity: 300 })], 200);

    expect(verdict.reconciled).toBe(false);
    expect(verdict.status).toBe(ReconciliationStatus.QUANTITY_MISMATCH);
    expect(verdict.reason).toContain('difference 100');
  });

  it('rejects a one-share discrepancy — there is no tolerance band', () => {
    // A tolerance would be a guess wearing a threshold's clothing. One share of
    // disagreement means the two records describe different accounts, and the
    // size of the gap does not make the lot structure any more knowable.
    expect(assertLotSum('TQQQ', [lot({ quantity: 100 })], 99).reconciled).toBe(false);
    expect(assertLotSum('TQQQ', [lot({ quantity: 100 })], 101).reconciled).toBe(false);
  });

  it('detects a broker position larger than the ladder — an untracked manual buy', () => {
    const verdict = assertLotSum('TQQQ', [lot({ quantity: 100 })], 400);

    expect(verdict.status).toBe(ReconciliationStatus.QUANTITY_MISMATCH);
    expect(verdict.reason).toContain('difference -300');
  });

  it('names the symbol in every reason so a multi-symbol halt is legible', () => {
    for (const [lots, brokerQuantity] of [
      [[lot({ quantity: 100 })], 100],
      [[lot({ quantity: 100 })], 0],
      [[], 100],
      [[lot({ quantity: 100 })], 50],
    ] as [Lot[], number][]) {
      expect(assertLotSum('SOXL', lots, brokerQuantity).reason).toContain('SOXL');
    }
  });
});

describe('sumHeldQuantity', () => {
  it('sums only held lots', () => {
    expect(
      sumHeldQuantity([
        lot({ id: 'a', quantity: 100 }),
        lot({ id: 'b', quantity: 50, status: LotStatus.CLOSED }),
      ]),
    ).toBe(100);
  });

  it('is zero for an empty ladder', () => {
    expect(sumHeldQuantity([])).toBe(0);
  });
});
