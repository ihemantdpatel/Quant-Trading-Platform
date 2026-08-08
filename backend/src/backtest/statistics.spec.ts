/**
 * Each statistic verified against a hand-worked fixture (`stories.md:663`).
 *
 * Values are computed by hand in the comments rather than by running the code
 * and pasting the output — a test that asserts whatever the implementation
 * happens to produce cannot fail, and `CLAUDE.md` forbids exactly that.
 */

import { ClosedTrade, EquityPoint } from './replay-harness';
import {
  annualizedReturn,
  averageHoldingPeriod,
  computeStatistics,
  maxDrawdown,
  rungDistribution,
  totalReturn,
} from './statistics';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function point(overrides: Partial<EquityPoint> & { equity: number }): EquityPoint {
  return {
    timestamp: '2025-01-02T09:30:00.000-05:00',
    close: 100,
    realized: 0,
    unrealized: 0,
    positionQuantity: 0,
    heldLots: 0,
    ...overrides,
  };
}

function trade(overrides: Partial<ClosedTrade> = {}): ClosedTrade {
  return {
    lotId: 'lot-1',
    rungPrice: 95,
    quantity: 100,
    entryPrice: 95,
    exitPrice: 99.75,
    entryAt: '2025-01-02T10:00:00.000-05:00',
    exitAt: '2025-01-03T10:00:00.000-05:00',
    realizedPnl: 473,
    commission: 2,
    holdingPeriodMs: DAY,
    ...overrides,
  };
}

describe('totalReturn', () => {
  it('is realized plus unrealized over starting equity', () => {
    // (5000 + 2500) / 100000 = 0.075
    expect(totalReturn(5000, 2500, 100_000)).toBe(0.075);
  });

  it('includes unrealized loss — a ladder holding underwater is not flat', () => {
    // (1000 + -9000) / 100000 = -0.08
    expect(totalReturn(1000, -9000, 100_000)).toBe(-0.08);
  });

  it('is zero when starting equity is zero rather than dividing by it', () => {
    expect(totalReturn(500, 0, 0)).toBe(0);
  });
});

describe('annualizedReturn', () => {
  it('compounds a half-year return over a full year', () => {
    // Span 182.625 days = exactly half a year. (1.1)^2 - 1 = 0.21
    const curve = [
      point({ equity: 100_000, timestamp: '2025-01-01T00:00:00.000Z' }),
      point({ equity: 110_000, timestamp: '2025-07-02T15:00:00.000Z' }),
    ];

    expect(annualizedReturn(0.1, curve)).toBeCloseTo(0.21, 2);
  });

  it('returns the same figure for a run spanning exactly one year', () => {
    const curve = [
      point({ equity: 100_000, timestamp: '2024-01-01T00:00:00.000Z' }),
      point({ equity: 125_000, timestamp: '2024-12-31T06:00:00.000Z' }),
    ];

    expect(annualizedReturn(0.25, curve)).toBeCloseTo(0.25, 2);
  });

  it('is null for a span under a day — annualizing hours is meaningless', () => {
    const curve = [
      point({ equity: 100_000, timestamp: '2025-01-02T09:30:00.000-05:00' }),
      point({ equity: 101_000, timestamp: '2025-01-02T16:00:00.000-05:00' }),
    ];

    expect(annualizedReturn(0.01, curve)).toBeNull();
  });

  it('is null for a total loss, where the compounding base is non-positive', () => {
    const curve = [
      point({ equity: 100_000, timestamp: '2024-01-01T00:00:00.000Z' }),
      point({ equity: 0, timestamp: '2024-12-31T00:00:00.000Z' }),
    ];

    expect(annualizedReturn(-1, curve)).toBeNull();
  });

  it('is null with fewer than two points', () => {
    expect(annualizedReturn(0.1, [point({ equity: 100_000 })])).toBeNull();
  });
});

describe('maxDrawdown', () => {
  it('measures peak to trough', () => {
    // Peak 120000, trough 90000 → (120000-90000)/120000 = 0.25
    const curve = [
      point({ equity: 100_000, timestamp: '2025-01-01T00:00:00.000Z' }),
      point({ equity: 120_000, timestamp: '2025-01-02T00:00:00.000Z' }),
      point({ equity: 90_000, timestamp: '2025-01-03T00:00:00.000Z' }),
      point({ equity: 110_000, timestamp: '2025-01-04T00:00:00.000Z' }),
    ];

    const result = maxDrawdown(curve);

    expect(result.percent).toBe(0.25);
    expect(result.at).toBe('2025-01-03T00:00:00.000Z');
    expect(result.peak).toBe(120_000);
    expect(result.trough).toBe(90_000);
  });

  it('measures a later trough against the earlier unreclaimed peak — the 2022 shape', () => {
    // A rally to 80000 never reclaims the 100000 peak, so the final trough is
    // still measured against it: (100000-20000)/100000 = 0.8
    const curve = [
      point({ equity: 100_000, timestamp: '2022-01-03T00:00:00.000Z' }),
      point({ equity: 45_000, timestamp: '2022-06-16T00:00:00.000Z' }),
      point({ equity: 80_000, timestamp: '2022-08-15T00:00:00.000Z' }),
      point({ equity: 20_000, timestamp: '2022-12-28T00:00:00.000Z' }),
    ];

    const result = maxDrawdown(curve);

    expect(result.percent).toBe(0.8);
    expect(result.at).toBe('2022-12-28T00:00:00.000Z');
    expect(result.peak).toBe(100_000);
  });

  it('is zero on a monotonically rising curve', () => {
    const curve = [
      point({ equity: 100_000 }),
      point({ equity: 110_000 }),
      point({ equity: 120_000 }),
    ];

    expect(maxDrawdown(curve).percent).toBe(0);
  });

  it('is zero on an empty curve rather than dividing by zero', () => {
    expect(maxDrawdown([]).percent).toBe(0);
  });
});

describe('averageHoldingPeriod', () => {
  it('averages the holding periods', () => {
    // (1 day + 3 days) / 2 = 2 days
    const trades = [trade({ holdingPeriodMs: DAY }), trade({ holdingPeriodMs: 3 * DAY })];

    expect(averageHoldingPeriod(trades)).toBe(2 * DAY);
  });

  it('is null with no completed cycles', () => {
    expect(averageHoldingPeriod([])).toBeNull();
  });
});

describe('rungDistribution', () => {
  it('counts completed cycles per rung price', () => {
    const trades = [
      trade({ rungPrice: 95 }),
      trade({ rungPrice: 95 }),
      trade({ rungPrice: 90.25 }),
    ];

    expect(rungDistribution(trades)).toEqual({ '95.00': 2, '90.25': 1 });
  });

  it('is empty with no completed cycles', () => {
    expect(rungDistribution([])).toEqual({});
  });
});

describe('computeStatistics — the assembled report', () => {
  const curve = [
    point({ equity: 100_000, timestamp: '2025-01-02T09:30:00.000-05:00', heldLots: 0 }),
    point({ equity: 95_000, timestamp: '2025-01-03T09:30:00.000-05:00', heldLots: 2 }),
    point({ equity: 80_000, timestamp: '2025-01-06T09:30:00.000-05:00', heldLots: 5 }),
    point({
      equity: 104_000,
      timestamp: '2025-01-07T09:30:00.000-05:00',
      heldLots: 1,
      unrealized: 500,
    }),
  ];

  const trades = [
    trade({ lotId: 'a', realizedPnl: 473, rungPrice: 95, holdingPeriodMs: DAY }),
    trade({ lotId: 'b', realizedPnl: 300, rungPrice: 90.25, holdingPeriodMs: 3 * DAY }),
    trade({ lotId: 'c', realizedPnl: -50, rungPrice: 95, holdingPeriodMs: 2 * DAY }),
  ];

  const stats = computeStatistics({
    closedTrades: trades,
    equityCurve: curve,
    openLotsAtEnd: 1,
    commissionPaid: 6,
    startingEquity: 100_000,
    maxConcurrentRungs: 5,
  });

  it('sums realized P&L across completed cycles', () => {
    // 473 + 300 - 50 = 723
    expect(stats.totalRealizedPnl).toBe(723);
  });

  it('reports final unrealized separately from realized', () => {
    expect(stats.finalUnrealizedPnl).toBe(500);
  });

  it('computes total return from realized plus unrealized', () => {
    // (723 + 500) / 100000 = 0.01223
    expect(stats.totalReturnPercent).toBeCloseTo(0.0122, 4);
  });

  it('reports max drawdown against the running peak', () => {
    // Peak 100000, trough 80000 → 0.2
    expect(stats.maxDrawdownPercent).toBe(0.2);
    expect(stats.maxDrawdownAt).toBe('2025-01-06T09:30:00.000-05:00');
  });

  it('counts winning and losing cycles', () => {
    expect(stats.completedCycles).toBe(3);
    expect(stats.winningTrades).toBe(2);
    expect(stats.losingTrades).toBe(1);
  });

  it('computes win rate over completed cycles only', () => {
    // 2 of 3 — the one open lot is not counted as a loss.
    expect(stats.winRate).toBeCloseTo(0.6667, 4);
  });

  it('reports open lots separately rather than folding them into the win rate', () => {
    expect(stats.openLotsAtEnd).toBe(1);
  });

  it('averages holding period across cycles', () => {
    // (1 + 3 + 2) / 3 = 2 days
    expect(stats.averageHoldingPeriodMs).toBe(2 * DAY);
  });

  it('measures time in position as the fraction of bars holding a lot', () => {
    // 3 of 4 bars had heldLots > 0
    expect(stats.timeInPositionPercent).toBe(0.75);
  });

  it('measures time at the hard floor as bars at the concurrent-rung limit', () => {
    // 1 of 4 bars had heldLots >= 5
    expect(stats.timeAtHardFloorPercent).toBe(0.25);
  });

  it('reports the deepest simultaneous rung count', () => {
    expect(stats.maxConcurrentLots).toBe(5);
  });

  it('distributes completed cycles across rung prices', () => {
    expect(stats.rungDistribution).toEqual({ '95.00': 2, '90.25': 1 });
  });

  it('passes commission through', () => {
    expect(stats.totalCommission).toBe(6);
  });
});

describe('computeStatistics — empty run', () => {
  const stats = computeStatistics({
    closedTrades: [],
    equityCurve: [],
    openLotsAtEnd: 0,
    commissionPaid: 0,
    startingEquity: 100_000,
    maxConcurrentRungs: 5,
  });

  it('reports null rather than a fabricated win rate', () => {
    expect(stats.winRate).toBeNull();
    expect(stats.averageHoldingPeriodMs).toBeNull();
  });

  it('reports zero time in position without dividing by zero bars', () => {
    expect(stats.timeInPositionPercent).toBe(0);
    expect(stats.timeAtHardFloorPercent).toBe(0);
  });
});
