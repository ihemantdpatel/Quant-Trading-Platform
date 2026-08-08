import {
  averageCostExitLevel,
  blendedAverageCost,
  totalDeployedCost,
  totalHeldQuantity,
  unrealizedPnl,
} from './average-cost';
import { hasReachedTarget, selectExit } from './exits';
import { Lot, LotStatus } from './lot';

const BAR = '2025-01-03T11:00:00.000-05:00';

function lot(overrides: Partial<Lot> & Pick<Lot, 'id'>): Lot {
  return {
    rungPrice: 95,
    fillPrice: 95,
    quantity: 26,
    openedAt: '2025-01-02T10:00:00.000-05:00',
    exitTarget: 99.75,
    status: LotStatus.HELD,
    closedAt: null,
    exitPrice: null,
    ...overrides,
  };
}

/** A two-lot ladder: 26 @ 95.00 and 27 @ 90.25. */
const LADDER = [
  lot({ id: 'upper' }),
  lot({ id: 'lower', rungPrice: 90.25, fillPrice: 90.25, quantity: 27, exitTarget: 94.76 }),
];

describe('blendedAverageCost', () => {
  it('is quantity-weighted', () => {
    // (95.00×26 + 90.25×27) / 53 = (2470 + 2436.75) / 53 = 92.58
    expect(blendedAverageCost(LADDER)).toBeCloseTo(92.58, 2);
  });

  /**
   * Weighted rather than a plain mean of fill prices: deeper rungs buy more
   * shares for the same allocation, so an unweighted mean would misstate the
   * basis whenever rung sizes differ.
   */
  it('differs from an unweighted mean when quantities differ', () => {
    const unweighted = (95 + 90.25) / 2;

    expect(blendedAverageCost(LADDER)).not.toBeCloseTo(unweighted, 2);
  });

  it('ignores closed lots', () => {
    const withClosed = [...LADDER, lot({ id: 'gone', fillPrice: 50, status: LotStatus.CLOSED })];

    expect(blendedAverageCost(withClosed)).toBeCloseTo(blendedAverageCost(LADDER)!, 2);
  });

  it('is null when flat', () => {
    expect(blendedAverageCost([])).toBeNull();
    expect(blendedAverageCost([lot({ id: 'x', status: LotStatus.CLOSED })])).toBeNull();
  });

  it('is null rather than dividing by zero on a zero-quantity position', () => {
    expect(blendedAverageCost([lot({ id: 'x', quantity: 0 })])).toBeNull();
  });
});

describe('position totals', () => {
  it('sums held quantity', () => {
    expect(totalHeldQuantity(LADDER)).toBe(53);
  });

  it('sums deployed cost', () => {
    expect(totalDeployedCost(LADDER)).toBeCloseTo(2470 + 2436.75, 2);
  });

  it('computes unrealized P&L at a mark', () => {
    // At 100.00: (100−95)×26 + (100−90.25)×27 = 130 + 263.25 = 393.25
    expect(unrealizedPnl(LADDER, 100)).toBeCloseTo(393.25, 2);
  });

  /**
   * A dip-buying ladder is expected to sit in unrealized loss by design
   * (`PRD.md:252`). The figure is informational and never an exit trigger.
   */
  it('reports a negative figure without that implying any action', () => {
    expect(unrealizedPnl(LADDER, 80)).toBeLessThan(0);
  });

  it('is zero when flat', () => {
    expect(totalHeldQuantity([])).toBe(0);
    expect(unrealizedPnl([], 100)).toBe(0);
  });
});

describe('averageCostExitLevel', () => {
  it('is the blend plus the take-profit fraction', () => {
    // 92.58 × 1.05 = 97.21
    expect(averageCostExitLevel(LADDER, 0.05)).toBeCloseTo(97.21, 2);
  });

  it('is null when flat', () => {
    expect(averageCostExitLevel([], 0.05)).toBeNull();
  });

  /**
   * Available as a config option but **not the default** (`PRD.md:159`). It
   * closes everything at one level, which is what per-lot exits exist to avoid:
   * in a range it forfeits the repeated upper-rung cycling that generates
   * realized gains while lower rungs hold.
   */
  it('is a single shared level, unlike the per-lot targets', () => {
    const shared = averageCostExitLevel(LADDER, 0.05)!;

    expect(LADDER[0].exitTarget).not.toBeCloseTo(shared, 2);
    expect(LADDER[1].exitTarget).not.toBeCloseTo(shared, 2);
  });
});

/**
 * The separation that makes "display only" real rather than documentary
 * (`PRD.md:157`): the default exit path cannot read the blend even by accident.
 */
describe('the blend is display-only', () => {
  it('does not influence whether a lot has reached its target', () => {
    const blend = blendedAverageCost(LADDER)!;

    // Price is above the blend but below the upper lot's own target.
    expect(blend).toBeLessThan(99.75);
    expect(hasReachedTarget(LADDER[0], blend)).toBe(false);
  });

  it('does not trigger an exit at the average-cost level', () => {
    const level = averageCostExitLevel(LADDER, 0.05)!;

    // 97.21 clears the blend's target but neither lot's own target... the lower
    // lot's 94.76 is already passed, so it exits on its own terms, not the
    // blend's. The upper lot at 99.75 does not.
    const intent = selectExit(LADDER, level, BAR, 'TQQQ');

    expect(intent!.lotId).toBe('lower');
    expect(intent!.limitPrice).toBe(94.76);
    expect(intent!.limitPrice).not.toBeCloseTo(level, 2);
  });

  it('changing the blend cannot move an exit decision', () => {
    // Adding a deep lot drags the blend down sharply.
    const withDeepLot = [
      ...LADDER,
      lot({ id: 'deep', rungPrice: 50, fillPrice: 50, quantity: 100, exitTarget: 52.5 }),
    ];

    expect(blendedAverageCost(withDeepLot)).toBeLessThan(blendedAverageCost(LADDER)!);

    // The upper lot's target is untouched by that shift.
    const before = selectExit(LADDER, 99, BAR, 'TQQQ');
    const after = selectExit(withDeepLot, 99, BAR, 'TQQQ');

    expect(before?.lotId).toBe(after?.lotId);
  });
});
