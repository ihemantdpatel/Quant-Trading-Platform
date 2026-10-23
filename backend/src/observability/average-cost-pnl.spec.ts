import { Fill } from '../broker/broker-adapter.interface';
import { PositionSnapshotRecord } from '../repositories/repository.interfaces';
import { buildLedger, cents } from './average-cost-pnl';

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

const OPEN = '2026-10-05T09:00:00.000-04:00';

describe('buildLedger — average cost', () => {
  // The operator's own example, and the reason this module exists: per-lot
  // pairing reports +$50 for this sell (against the 79 lot); IB reports $0.
  it('realizes nothing selling at the average: 80, 79.5, 79 bought, 79.5 sold', () => {
    const ledger = buildLedger(
      [snapshot(OPEN, 0, 0)],
      [
        fill('BUY', 100, 80, '2026-10-05T10:00:00.000-04:00'),
        fill('BUY', 100, 79.5, '2026-10-05T10:30:00.000-04:00'),
        fill('BUY', 100, 79, '2026-10-05T11:00:00.000-04:00'),
        fill('SELL', 100, 79.5, '2026-10-05T11:30:00.000-04:00'),
      ],
    );

    expect(ledger.sells).toHaveLength(1);
    expect(ledger.sells[0]).toMatchObject({ averageCost: 79.5, gross: 0, realized: 0 });
    expect(ledger.holdings).toEqual([{ symbol: 'TQQQ', quantity: 200, averageCost: 79.5 }]);
  });

  it('starts from IB’s average, and a sell leaves the average unchanged', () => {
    const ledger = buildLedger(
      [snapshot(OPEN, 200, 80)],
      [
        fill('BUY', 100, 77, '2026-10-05T10:00:00.000-04:00'),
        fill('SELL', 100, 80, '2026-10-05T11:00:00.000-04:00'),
        fill('SELL', 100, 78, '2026-10-05T12:00:00.000-04:00'),
      ],
    );

    expect(ledger.sells.map((s) => [s.averageCost, s.realized])).toEqual([
      [79, 100],
      [79, -100],
    ]);
    expect(ledger.holdings).toEqual([{ symbol: 'TQQQ', quantity: 100, averageCost: 79 }]);
  });

  it('resets the average once flat, so the next buy starts a fresh basis', () => {
    const ledger = buildLedger(
      [snapshot(OPEN, 100, 80)],
      [
        fill('SELL', 100, 81, '2026-10-05T10:00:00.000-04:00'),
        fill('BUY', 50, 70, '2026-10-05T11:00:00.000-04:00'),
        fill('SELL', 50, 71, '2026-10-05T12:00:00.000-04:00'),
      ],
    );

    expect(ledger.sells.map((s) => [s.averageCost, s.realized])).toEqual([
      [80, 100],
      [70, 50],
    ]);
    expect(ledger.holdings).toEqual([]);
  });

  it('folds buy commissions into the average and subtracts sell commissions', () => {
    const ledger = buildLedger(
      [snapshot(OPEN, 0, 0)],
      [
        fill('BUY', 100, 80, '2026-10-05T10:00:00.000-04:00', 1),
        fill('SELL', 100, 81, '2026-10-05T11:00:00.000-04:00', 1.05),
      ],
    );

    expect(ledger.sells[0].averageCost).toBeCloseTo(80.01, 10);
    expect(ledger.sells[0]).toMatchObject({ gross: 99, commission: 1.05, realized: 97.95 });
  });

  it('skips fills before the first snapshot — their basis is unknown', () => {
    const ledger = buildLedger(
      [snapshot('2026-10-05T12:00:00.000-04:00', 100, 80)],
      [
        fill('SELL', 100, 90, '2026-10-05T10:00:00.000-04:00'),
        fill('SELL', 100, 81, '2026-10-05T13:00:00.000-04:00'),
      ],
    );

    expect(ledger.trackedSince).toBe('2026-10-05T12:00:00.000-04:00');
    expect(ledger.sells.map((s) => s.realized)).toEqual([100]);
  });

  it('tracks nothing without a snapshot', () => {
    const ledger = buildLedger([], [fill('SELL', 100, 81, '2026-10-05T13:00:00.000-04:00')]);

    expect(ledger).toEqual({ trackedSince: null, sells: [], mismatches: [], holdings: [] });
  });

  it('keeps its own count past a later snapshot whose average differs from IB’s', () => {
    // IB's average drifts from ours by cents (commission rounding); ours must
    // not be overwritten by it, or the figure is IB's rather than our count.
    const ledger = buildLedger(
      [snapshot(OPEN, 100, 80), snapshot('2026-10-05T16:20:00.000-04:00', 200, 78.9)],
      [
        fill('BUY', 100, 78, '2026-10-05T10:00:00.000-04:00'),
        fill('SELL', 100, 80, '2026-10-06T10:00:00.000-04:00'),
      ],
    );

    expect(ledger.mismatches).toEqual([]);
    expect(ledger.sells[0]).toMatchObject({ averageCost: 79, realized: 100 });
    expect(ledger.holdings).toEqual([{ symbol: 'TQQQ', quantity: 100, averageCost: 79 }]);
  });

  it('reports a quantity the fills cannot explain, and does not reset to IB’s', () => {
    const ledger = buildLedger(
      [snapshot(OPEN, 100, 80), snapshot('2026-10-05T16:20:00.000-04:00', 200, 79)],
      [
        // A 100-share buy placed in TWS is missing from the record.
        fill('SELL', 50, 82, '2026-10-06T10:00:00.000-04:00'),
      ],
    );

    expect(ledger.mismatches).toEqual([
      {
        symbol: 'TQQQ',
        takenAt: '2026-10-05T16:20:00.000-04:00',
        replayedQuantity: 100,
        brokerQuantity: 200,
        replayedAverageCost: 80,
        brokerAverageCost: 79,
      },
    ]);
    expect(ledger.sells[0]).toMatchObject({ averageCost: 80, realized: 100 });
    expect(ledger.holdings).toEqual([{ symbol: 'TQQQ', quantity: 50, averageCost: 80 }]);
  });

  it('flags a symbol a later snapshot omits or adds, without adopting IB’s figure', () => {
    const ledger = buildLedger(
      [snapshot(OPEN, 100, 80), snapshot('2026-10-05T16:20:00.000-04:00', 10, 20, 'SQQQ')],
      [],
    );

    expect(ledger.mismatches).toEqual([
      expect.objectContaining({ symbol: 'TQQQ', replayedQuantity: 100, brokerQuantity: 0 }),
      expect.objectContaining({ symbol: 'SQQQ', replayedQuantity: 0, brokerQuantity: 10 }),
    ]);
    expect(ledger.holdings).toEqual([{ symbol: 'TQQQ', quantity: 100, averageCost: 80 }]);
  });

  it('realizes nothing on shares sold beyond the known holding, and says how many', () => {
    const ledger = buildLedger(
      [snapshot(OPEN, 50, 80)],
      [fill('SELL', 80, 82, '2026-10-05T10:00:00.000-04:00')],
    );

    expect(ledger.sells[0]).toMatchObject({ gross: 100, realized: 100, uncovered: 30 });
    expect(ledger.holdings).toEqual([]);
  });

  it('applies a fill stamped at the snapshot instant before the snapshot', () => {
    const at = '2026-10-05T16:20:00.000-04:00';
    const ledger = buildLedger(
      [snapshot(OPEN, 100, 80), snapshot(at, 0, 0)],
      [fill('SELL', 100, 81, at)],
    );

    expect(ledger.mismatches).toEqual([]);
    expect(ledger.sells.map((s) => s.realized)).toEqual([100]);
  });

  it('keeps symbols apart and orders events across offsets', () => {
    const ledger = buildLedger(
      [snapshot(OPEN, 0, 0), snapshot(OPEN, 0, 0, 'SQQQ')],
      [
        fill('BUY', 10, 20, '2026-10-05T14:00:00.000Z', 0, 'SQQQ'), // 10:00 ET
        fill('BUY', 100, 80, '2026-10-05T09:30:00.000-04:00'),
        fill('SELL', 10, 21, '2026-10-05T10:30:00.000-04:00', 0, 'SQQQ'),
        fill('SELL', 100, 79, '2026-10-05T15:00:00.000Z'), // 11:00 ET
      ],
    );

    expect(ledger.sells.map((s) => [s.symbol, s.realized])).toEqual([
      ['SQQQ', 10],
      ['TQQQ', -100],
    ]);
  });

  it('stops at `until`', () => {
    const ledger = buildLedger(
      [snapshot(OPEN, 100, 80)],
      [fill('SELL', 100, 81, '2026-10-06T10:00:00.000-04:00')],
      '2026-10-05T23:59:59.999-04:00',
    );

    expect(ledger.sells).toEqual([]);
    expect(ledger.holdings).toEqual([{ symbol: 'TQQQ', quantity: 100, averageCost: 80 }]);
  });

  it('refuses an unparseable timestamp', () => {
    expect(() => buildLedger([snapshot('nope', 1, 1)], [])).toThrow(/unparseable/);
  });

  it('rounds to cents without float drift', () => {
    expect(cents(1.005)).toBe(1.01);
    expect(cents(0.1 + 0.2)).toBe(0.3);
  });
});
