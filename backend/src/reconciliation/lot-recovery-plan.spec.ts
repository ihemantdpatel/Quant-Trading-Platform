/**
 * The lot-reconstruction arithmetic shared by the manual `recover-lots` CLI
 * and the automatic `LotRebuildService`, tested without a database.
 *
 * These are the parts that set a live position's exit targets and decide
 * whether a repair may happen at all, so they are pure and covered directly.
 */

import { buildRecoveryPlan, refuseReason, RecoveryPlan } from './lot-recovery-plan';

/** The stranded TQQQ position this arithmetic was written for. */
const STRANDED = [
  {
    clientOrderId: 'co-1',
    quantity: 135,
    limitPrice: 73.91,
    createdAt: '2026-08-18T10:40:00.000-04:00',
  },
  {
    clientOrderId: 'co-2',
    quantity: 137,
    limitPrice: 72.63,
    createdAt: '2026-08-18T10:45:00.000-04:00',
  },
];

const RUNG_OF: Record<string, number> = { 'co-1': 73.91, 'co-2': 72.63 };

function plan(orders = STRANDED, takeProfit = 0.05): RecoveryPlan {
  return buildRecoveryPlan('TQQQ', orders, (id) => RUNG_OF[id], takeProfit);
}

describe('the reconstruction', () => {
  it('gives each lot its own rung price, not a blended one', () => {
    // The whole reason limits are preferred to the broker's average cost: a
    // blended figure would give both lots the same target and collapse the
    // per-lot exits the ladder exists to produce.
    const { lots } = plan();

    expect(lots.map((lot) => lot.fillPrice)).toEqual([73.91, 72.63]);
    expect(lots.map((lot) => lot.exitTarget)).toEqual([77.61, 76.26]);
  });

  it('numbers lots oldest first, matching FIFO disposal order', () => {
    // Reversed input must not reverse the ids: which lot is sold first depends
    // on this ordering.
    const { lots } = plan([...STRANDED].reverse());

    expect(lots.map((lot) => lot.id)).toEqual(['TQQQ-lot-1', 'TQQQ-lot-2']);
    expect(lots[0].clientOrderId).toBe('co-1');
  });

  it('anchors the hard floor at the highest entry', () => {
    // `firstEntryPrice` is what the -25% floor is measured from, and it is the
    // *first* entry of the cycle — the highest rung, since a ladder works down.
    expect(plan().firstEntryPrice).toBe(73.91);
  });

  it('rounds exit targets to cents', () => {
    const { lots } = plan([{ ...STRANDED[0], limitPrice: 73.333 }]);

    expect(lots[0].exitTarget).toBe(77.0);
  });
});

describe('what the recovery refuses', () => {
  it('proceeds when the orders explain the position exactly', () => {
    expect(refuseReason(plan(), 272, 73.0)).toBeNull();
  });

  it('refuses when shares cannot be attributed to an order', () => {
    // The residual is a manual trade or a corporate action — composition is
    // genuinely unknown, which is the case the halt exists for.
    expect(refuseReason(plan(), 300, null)).toMatch(/28 share\(s\) cannot be attributed/);
  });

  it('refuses when it recovered more than the broker holds', () => {
    expect(refuseReason(plan(), 200, null)).toMatch(/cannot be attributed/);
  });

  it('refuses a reconstruction below the broker average cost', () => {
    // A buy limit fills at or below its limit, so a weighted limit price under
    // the average cost is arithmetically impossible — the orders on file are
    // not the ones that produced this position.
    expect(refuseReason(plan(), 272, 80)).toMatch(/below the broker's average cost/);
  });

  it('tolerates a half-cent of rounding against the average cost', () => {
    const weighted = plan().weightedFillPrice;

    expect(refuseReason(plan(), 272, weighted + 0.004)).toBeNull();
  });

  it('refuses when nothing was found to recover', () => {
    expect(refuseReason(plan([]), 272, null)).toMatch(/nothing to recover/);
  });

  it('skips average-cost validation when the figure was not supplied', () => {
    // Optional, because an operator may not have it to hand. Absent, the
    // quantity check still stands.
    expect(refuseReason(plan(), 272, null)).toBeNull();
  });
});
