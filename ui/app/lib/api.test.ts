/**
 * Derived display values.
 *
 * These mirror `backend/src/strategies/dip-ladder/average-cost.ts`. Tested here
 * because a divergence would put a different number in the browser than in the
 * engine — and the blended average in particular is a figure an operator must
 * be able to trust is *only* a reference, computed the same way the backend
 * computes it.
 */

import {
  blendedAverageCost,
  distanceToTarget,
  lastMarkPrice,
  lotAge,
  totalDeployedCost,
  totalHeldQuantity,
  totalRealized,
  formatCurrency,
  formatPercent,
  type Fill,
  type Lot,
} from './api';

function lot(overrides: Partial<Lot> = {}): Lot {
  return {
    id: 'TQQQ-lot-1',
    symbol: 'TQQQ',
    rungPrice: 95,
    fillPrice: 95,
    quantity: 10,
    openedAt: '2024-03-04T09:50:00-05:00',
    exitTarget: 99.75,
    status: 'HELD',
    closedAt: null,
    exitPrice: null,
    realized: null,
    ...overrides,
  };
}

describe('blendedAverageCost', () => {
  it('is quantity-weighted, not an unweighted mean', () => {
    const lots = [lot({ fillPrice: 100, quantity: 10 }), lot({ fillPrice: 90, quantity: 30 })];

    // Unweighted would be 95; weighted is 92.50.
    expect(blendedAverageCost(lots)).toBe(92.5);
  });

  it('excludes closed lots', () => {
    const lots = [
      lot({ id: 'a', fillPrice: 100, quantity: 10, status: 'CLOSED' }),
      lot({ id: 'b', fillPrice: 90, quantity: 10 }),
    ];

    expect(blendedAverageCost(lots)).toBe(90);
  });

  it('is null when flat', () => {
    expect(blendedAverageCost([])).toBeNull();
    expect(blendedAverageCost([lot({ status: 'CLOSED' })])).toBeNull();
  });

  it('is null rather than NaN when held lots carry zero quantity', () => {
    expect(blendedAverageCost([lot({ quantity: 0 })])).toBeNull();
  });
});

describe('distanceToTarget', () => {
  it('measures from the mark up to the lot own target', () => {
    expect(distanceToTarget(lot({ exitTarget: 99.75 }), 95)).toBeCloseTo(0.05, 5);
  });

  it('is negative once the mark is above the target', () => {
    expect(distanceToTarget(lot({ exitTarget: 99.75 }), 105)).toBeLessThan(0);
  });

  it('is null without a mark price', () => {
    expect(distanceToTarget(lot(), null)).toBeNull();
    expect(distanceToTarget(lot(), 0)).toBeNull();
  });
});

describe('totals', () => {
  it('sums realized P&L across completed cycles only', () => {
    const lots = [
      lot({ id: 'a', status: 'CLOSED', realized: 47.5 }),
      lot({ id: 'b', status: 'CLOSED', realized: 22.25 }),
      lot({ id: 'c' }),
    ];

    expect(totalRealized(lots)).toBe(69.75);
  });

  it('counts only held shares and their cost', () => {
    const lots = [
      lot({ id: 'a', quantity: 10, fillPrice: 95 }),
      lot({ id: 'b', quantity: 5, fillPrice: 90, status: 'CLOSED' }),
    ];

    expect(totalHeldQuantity(lots)).toBe(10);
    expect(totalDeployedCost(lots)).toBe(950);
  });
});

describe('lastMarkPrice', () => {
  it('takes the most recent fill', () => {
    const fills = [{ price: 95 } as Fill, { price: 99.75 } as Fill];

    expect(lastMarkPrice(fills)).toBe(99.75);
  });

  it('is null when there are no fills — SHADOW submits nothing', () => {
    expect(lastMarkPrice([])).toBeNull();
  });
});

describe('lotAge', () => {
  const now = Date.parse('2024-03-04T11:00:00-05:00');

  it('renders minutes under an hour', () => {
    expect(lotAge('2024-03-04T10:35:00-05:00', now)).toBe('25m');
  });

  it('renders hours and minutes under a day', () => {
    expect(lotAge('2024-03-04T09:50:00-05:00', now)).toBe('1h 10m');
  });

  it('renders days and hours beyond that', () => {
    expect(lotAge('2024-03-01T09:00:00-05:00', now)).toBe('3d 2h');
  });

  it('does not render a negative age for a future timestamp', () => {
    expect(lotAge('2024-03-04T12:00:00-05:00', now)).toBe('0m');
  });

  it('degrades to a dash on an unparseable timestamp', () => {
    expect(lotAge('not-a-date', now)).toBe('—');
  });
});

describe('formatting', () => {
  it('renders a dash rather than a zero for missing values', () => {
    expect(formatCurrency(null)).toBe('—');
    expect(formatPercent(null)).toBe('—');
  });

  it('formats currency and percentages', () => {
    expect(formatCurrency(99.75)).toBe('$99.75');
    expect(formatPercent(0.05)).toBe('5.00%');
  });
});
