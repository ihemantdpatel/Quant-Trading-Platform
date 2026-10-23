import { Fill } from '../broker/broker-adapter.interface';
import { PositionSnapshotRecord } from '../repositories/repository.interfaces';
import {
  buildDailyPnl,
  buildPeriodPnl,
  cents,
  etDateOf,
  isIsoDate,
  isIsoMonth,
  monthRange,
  PnlInputs,
} from './pnl-summary';

let sequence = 0;

function fill(
  side: 'BUY' | 'SELL',
  quantity: number,
  price: number,
  timestamp: string,
  commission = 0,
  symbol = 'TQQQ',
): Fill {
  sequence += 1;
  return {
    clientOrderId: `co-${sequence}`,
    brokerOrderId: String(sequence),
    fillId: `f${sequence}`,
    symbol,
    side,
    quantity,
    price,
    commission,
    timestamp,
  };
}

function snapshot(
  takenAt: string,
  quantity: number,
  averageCost: number,
  symbol = 'TQQQ',
): PositionSnapshotRecord {
  return { takenAt, symbol, quantity, averageCost };
}

/**
 * Tracking begins at the Sep 24 close holding 100 @ 70. Sep 25 buys 100 @ 69
 * (average 69.5) and sells twice; Sep 28 sells once more. A Sep 1 sell predates
 * tracking.
 */
function inputs(): PnlInputs {
  return {
    snapshots: [snapshot('2026-09-24T16:20:00.000-04:00', 100, 70)],
    fills: [
      fill('SELL', 10, 75, '2026-09-01T10:00:00.000-04:00'),
      fill('BUY', 100, 69, '2026-09-25T10:00:00.000-04:00', 1),
      fill('SELL', 50, 70.5, '2026-09-25T11:00:00.000-04:00', 1),
      // 19:30 ET on the 25th, stored in UTC.
      fill('SELL', 50, 69, '2026-09-25T23:30:00.000Z', 1),
      fill('SELL', 50, 71, '2026-09-28T10:00:00.000-04:00', 1),
    ],
  };
}

describe('pnl-summary', () => {
  describe('etDateOf', () => {
    it('files an evening UTC timestamp under its ET date, not the UTC one', () => {
      // 01:30Z on the 26th is 21:30 ET on the 25th.
      expect(etDateOf('2026-09-26T01:30:00.000Z')).toBe('2026-09-25');
      expect(etDateOf('2026-09-25T18:26:43.071Z')).toBe('2026-09-25');
      expect(etDateOf('2026-09-25T12:10:44.267-04:00')).toBe('2026-09-25');
    });

    it('refuses an unparseable timestamp rather than bucketing it nowhere', () => {
      expect(() => etDateOf('yesterday')).toThrow(/unparseable/);
    });
  });

  it('validates dates and months', () => {
    expect(isIsoDate('2026-09-25')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('25-09-2026')).toBe(false);
    expect(isIsoMonth('2026-09')).toBe(true);
    expect(isIsoMonth('2026-13')).toBe(false);
    expect(isIsoMonth('2026-9')).toBe(false);
  });

  it('computes month ranges, including February in a leap year', () => {
    expect(monthRange('2026-09')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  it('rounds to cents without float drift', () => {
    expect(cents(1.005)).toBe(1.01);
    expect(cents(0.1 + 0.2)).toBe(0.3);
    expect(cents(-2.345)).toBe(-2.34);
  });

  describe('buildDailyPnl', () => {
    it('realizes each sell against the average, after its commission', () => {
      const day = buildDailyPnl(inputs(), '2026-09-25');

      // Average after the buy: (70×100 + 69×100 + 1) / 200 = 69.505.
      expect(day.sells.map((s) => [s.averageCost, s.realized])).toEqual([
        [69.505, 48.75],
        [69.505, -26.25],
      ]);
      expect(day.totals).toEqual({ trades: 2, gross: 24.5, commissions: 2, net: 22.5 });
    });

    it('reports the position at the end of that day, not today', () => {
      expect(buildDailyPnl(inputs(), '2026-09-25').held).toEqual([
        { symbol: 'TQQQ', quantity: 100, averageCost: 69.505 },
      ]);
      expect(buildDailyPnl(inputs(), '2026-09-28').held).toEqual([
        { symbol: 'TQQQ', quantity: 50, averageCost: 69.505 },
      ]);
    });

    it('carries month to date from the 1st through the day', () => {
      const day = buildDailyPnl(inputs(), '2026-09-28');

      expect(day.totals.net).toBe(cents((71 - 69.505) * 50 - 1));
      expect(day.monthToDate).toEqual({ trades: 3, gross: 99.25, commissions: 3, net: 96.25 });
    });

    it('marks a month that began before tracking as partial', () => {
      const day = buildDailyPnl(inputs(), '2026-09-28');

      expect(day.coverage).toEqual({
        trackedSince: '2026-09-24T16:20:00.000-04:00',
        tracked: true,
        partial: false,
      });
      expect(day.monthCoverage.partial).toBe(true);
    });

    it('reports a day before tracking as untracked, never as a quiet zero', () => {
      const day = buildDailyPnl(inputs(), '2026-09-01');

      expect(day.coverage.tracked).toBe(false);
      expect(day.sells).toEqual([]);
    });

    it('reports a quiet tracked day as zeroes', () => {
      const day = buildDailyPnl(inputs(), '2026-09-26');

      expect(day.totals).toEqual({ trades: 0, gross: 0, commissions: 0, net: 0 });
      expect(day.coverage.tracked).toBe(true);
    });

    it('surfaces that day’s snapshot mismatches', () => {
      const withMismatch = inputs();
      // Agrees with the replay at 16:20 on the 25th (200 − 50); disagrees on the 28th.
      withMismatch.snapshots.push(snapshot('2026-09-25T16:20:00.000-04:00', 150, 69.505));
      withMismatch.snapshots.push(snapshot('2026-09-28T16:20:00.000-04:00', 999, 69.505));

      expect(buildDailyPnl(withMismatch, '2026-09-25').mismatches).toEqual([]);
      expect(buildDailyPnl(withMismatch, '2026-09-28').mismatches).toEqual([
        expect.objectContaining({ replayedQuantity: 50, brokerQuantity: 999 }),
      ]);
    });
  });

  describe('buildPeriodPnl', () => {
    it('buckets by day and by symbol', () => {
      const period = buildPeriodPnl(inputs(), '2026-09-01', '2026-09-30');

      expect(period.days.map((d) => [d.date, d.trades, d.net])).toEqual([
        ['2026-09-25', 2, 22.5],
        ['2026-09-28', 1, 73.75],
      ]);
      expect(period.bySymbol).toEqual([{ symbol: 'TQQQ', trades: 3, net: 96.25 }]);
      expect(period.totals.net).toBe(96.25);
      expect(period.coverage.partial).toBe(true);
    });

    it('is untracked over a range ending before the first snapshot', () => {
      const period = buildPeriodPnl(inputs(), '2026-08-01', '2026-08-31');

      expect(period.coverage.tracked).toBe(false);
      expect(period.days).toEqual([]);
    });
  });
});
