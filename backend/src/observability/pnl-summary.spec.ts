import { Fill } from '../broker/broker-adapter.interface';
import { GridLot, GridLotStatus } from '../strategies/grid/lot';
import {
  AttributedGridLot,
  buildDailyPnl,
  buildPeriodPnl,
  cents,
  etDateOf,
  isIsoDate,
  isIsoMonth,
  monthRange,
  tradesBetween,
} from './pnl-summary';

function lot(overrides: Partial<GridLot> = {}): GridLot {
  return {
    id: 'g1',
    fillPrice: 70,
    quantity: 50,
    openedAt: '2026-09-25T10:00:00.000-04:00',
    sellTarget: 70.5,
    status: GridLotStatus.CLOSED,
    closedAt: '2026-09-25T11:00:00.000-04:00',
    exitPrice: 70.5,
    workingOrderId: null,
    ...overrides,
  };
}

function grid(l: GridLot, strategyId = 'grid:TQQQ'): AttributedGridLot {
  return { strategyId, symbol: strategyId.slice('grid:'.length), lot: l };
}

function fill(timestamp: string, commission: number): Fill {
  return {
    clientOrderId: 'co-1',
    brokerOrderId: '1',
    fillId: `f-${timestamp}-${commission}`,
    symbol: 'TQQQ',
    side: 'BUY',
    quantity: 50,
    price: 70,
    commission,
    timestamp,
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

  describe('tradesBetween', () => {
    it('lists only closed lots in range, sorted by close time across offsets', () => {
      const trades = tradesBetween(
        [
          grid(lot({ id: 'late', closedAt: '2026-09-25T19:00:00.000Z' })), // 15:00 ET
          grid(lot({ id: 'early', closedAt: '2026-09-25T10:00:00.000-04:00' })),
          grid(lot({ id: 'held', status: GridLotStatus.HELD, closedAt: null, exitPrice: null })),
          grid(lot({ id: 'other-day', closedAt: '2026-09-24T10:00:00.000-04:00' })),
        ],
        '2026-09-25',
        '2026-09-25',
      );

      expect(trades.map((t) => t.lotId)).toEqual(['early', 'late']);
    });

    it('computes gain per lot from its own buy and sell', () => {
      const [trade] = tradesBetween(
        [grid(lot({ fillPrice: 72.3456, exitPrice: 72.8456, quantity: 50 }))],
        '2026-09-25',
        '2026-09-25',
      );

      expect(trade).toMatchObject({ buyPrice: 72.3456, sellPrice: 72.8456, gain: 25 });
    });

    it('reports a loss as negative', () => {
      const [trade] = tradesBetween(
        [grid(lot({ fillPrice: 71, exitPrice: 70.5, quantity: 10 }))],
        '2026-09-25',
        '2026-09-25',
      );

      expect(trade.gain).toBe(-5);
    });
  });

  describe('buildDailyPnl', () => {
    const inputs = {
      lots: [
        grid(lot({ id: 'a', fillPrice: 70, exitPrice: 70.5, quantity: 50 })), // +25
        grid(lot({ id: 'b', fillPrice: 69.5, exitPrice: 70, quantity: 50 })), // +25
        grid(lot({ id: 's', fillPrice: 30, exitPrice: 29.9, quantity: 10 }), 'grid:SOXL'), // -1
        grid(lot({ id: 'h1', status: GridLotStatus.HELD, closedAt: null, exitPrice: null })),
        grid(lot({ id: 'h2', status: GridLotStatus.HELD, closedAt: null, exitPrice: null })),
        grid(lot({ id: 'earlier', closedAt: '2026-09-02T11:00:00.000-04:00', exitPrice: 71 })), // +50, same month
        grid(lot({ id: 'last-month', closedAt: '2026-08-31T11:00:00.000-04:00' })),
      ],
      fills: [
        fill('2026-09-25T10:00:00.000-04:00', 1),
        fill('2026-09-25T15:00:00.000Z', 1.5),
        fill('2026-09-24T10:00:00.000-04:00', 9),
        fill('2026-09-02T10:00:00.000-04:00', 2),
      ],
    };

    it('totals the day: gross from trades, commissions from every fill that day', () => {
      const daily = buildDailyPnl(inputs, '2026-09-25');

      expect(daily.trades.map((t) => t.lotId).sort()).toEqual(['a', 'b', 's']);
      expect(daily.totals).toEqual({ trades: 3, gross: 49, commissions: 2.5, net: 46.5 });
    });

    it('lists held lots per strategy', () => {
      expect(buildDailyPnl(inputs, '2026-09-25').held).toEqual([
        { symbol: 'TQQQ', strategyId: 'grid:TQQQ', lots: 2, quantity: 100 },
      ]);
    });

    it('carries month to date from the 1st through the day', () => {
      expect(buildDailyPnl(inputs, '2026-09-25').monthToDate).toEqual({
        trades: 4,
        gross: 99,
        commissions: 13.5,
        net: 85.5,
      });
    });

    it('reports an empty day as zeroes, not as missing', () => {
      const daily = buildDailyPnl(inputs, '2026-09-26');

      expect(daily.trades).toEqual([]);
      expect(daily.totals).toEqual({ trades: 0, gross: 0, commissions: 0, net: 0 });
    });
  });

  describe('buildPeriodPnl', () => {
    it('buckets by day and by strategy, including commission-only days', () => {
      const period = buildPeriodPnl(
        {
          lots: [
            grid(lot({ id: 'a', closedAt: '2026-09-24T11:00:00.000-04:00' })), // +25
            grid(lot({ id: 'b' })), // +25 on the 25th
            grid(lot({ id: 's', exitPrice: 69 }), 'grid:SOXL'), // -50 on the 25th
          ],
          fills: [
            fill('2026-09-23T10:00:00.000-04:00', 1),
            fill('2026-09-25T10:00:00.000-04:00', 2),
          ],
        },
        '2026-09-21',
        '2026-09-27',
      );

      expect(period.days).toEqual([
        { date: '2026-09-23', trades: 0, gross: 0, commissions: 1, net: -1 },
        { date: '2026-09-24', trades: 1, gross: 25, commissions: 0, net: 25 },
        { date: '2026-09-25', trades: 2, gross: -25, commissions: 2, net: -27 },
      ]);
      expect(period.byStrategy).toEqual([
        { symbol: 'SOXL', strategyId: 'grid:SOXL', trades: 1, gross: -50 },
        { symbol: 'TQQQ', strategyId: 'grid:TQQQ', trades: 2, gross: 50 },
      ]);
      expect(period.totals).toEqual({ trades: 3, gross: 0, commissions: 3, net: -3 });
    });
  });
});
