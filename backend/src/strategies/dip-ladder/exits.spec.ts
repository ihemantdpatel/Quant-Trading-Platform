import { hasReachedTarget, realizedPnl, selectExit } from './exits';
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

describe('hasReachedTarget', () => {
  const held = lot({ id: 'lot-1' });

  it('is true at and above the target', () => {
    expect(hasReachedTarget(held, 99.75)).toBe(true);
    expect(hasReachedTarget(held, 101)).toBe(true);
  });

  it('is false below the target', () => {
    expect(hasReachedTarget(held, 99.74)).toBe(false);
    expect(hasReachedTarget(held, 95)).toBe(false);
  });

  /**
   * A lot below its target simply continues to be held (`PRD.md:139`). There is
   * no per-lot stop, so no price — however far below the fill — produces an
   * exit.
   */
  it('is false at every price below the fill, however deep', () => {
    for (const close of [94.99, 80, 50, 1]) {
      expect(hasReachedTarget(held, close)).toBe(false);
    }
  });

  it('reads the lot’s own stored target, not a recomputed one', () => {
    // A lot whose target was frozen at different parameters keeps that target.
    const frozen = lot({ id: 'lot-2', exitTarget: 110 });

    expect(hasReachedTarget(frozen, 99.75)).toBe(false);
    expect(hasReachedTarget(frozen, 110)).toBe(true);
  });
});

describe('realizedPnl', () => {
  it('is the per-share gain times quantity', () => {
    expect(realizedPnl(lot({ id: 'lot-1' }), 99.75)).toBeCloseTo(4.75 * 26, 2);
  });

  it('is measured from the lot’s own fill, not any blended figure', () => {
    const lower = lot({ id: 'lot-2', rungPrice: 90.25, fillPrice: 90.25, quantity: 27 });

    expect(realizedPnl(lower, 94.76)).toBeCloseTo(4.51 * 27, 2);
  });

  it('is positive for every exit the strategy can produce', () => {
    // Exits only occur at or above target, and target is always above fill.
    expect(realizedPnl(lot({ id: 'lot-1' }), 99.75)).toBeGreaterThan(0);
  });
});

describe('selectExit', () => {
  it('returns null when no lot has reached its target', () => {
    expect(selectExit([lot({ id: 'lot-1' })], 97, BAR, 'TQQQ')).toBeNull();
  });

  it('returns null when nothing is held', () => {
    expect(selectExit([], 120, BAR, 'TQQQ')).toBeNull();
  });

  it('ignores already-closed lots', () => {
    const closed = lot({ id: 'lot-1', status: LotStatus.CLOSED, exitPrice: 99.75 });

    expect(selectExit([closed], 120, BAR, 'TQQQ')).toBeNull();
  });

  it('emits a SELL at the lot’s own target', () => {
    const intent = selectExit([lot({ id: 'lot-1' })], 100, BAR, 'TQQQ')!;

    expect(intent).toEqual({
      symbol: 'TQQQ',
      side: 'SELL',
      quantity: 26,
      limitPrice: 99.75,
      lotId: 'lot-1',
      rungPrice: 95,
      timestamp: BAR,
      reason: expect.stringContaining('reached its target'),
    });
  });

  /**
   * FIFO within a rung (`PRD.md:134`): the oldest lot at that rung is the one
   * sold, even when a newer lot sits at the same level.
   */
  it('disposes the oldest lot at a rung first', () => {
    const lots = [
      lot({ id: 'newer', openedAt: '2025-01-05T10:00:00.000-05:00' }),
      lot({ id: 'older', openedAt: '2025-01-02T10:00:00.000-05:00' }),
    ];

    expect(selectExit(lots, 100, BAR, 'TQQQ')!.lotId).toBe('older');
  });

  /**
   * `PRD.md:131` — "Lower lots keep running when higher lots exit." When a fast
   * recovery puts several rungs at target on one bar, the highest is disposed
   * first; the lower lots stay in place to reach their own targets.
   */
  it('disposes the highest rung first when several are at target', () => {
    const lots = [
      lot({ id: 'lower', rungPrice: 90.25, fillPrice: 90.25, exitTarget: 94.76 }),
      lot({ id: 'upper', rungPrice: 95, fillPrice: 95, exitTarget: 99.75 }),
    ];

    expect(selectExit(lots, 100, BAR, 'TQQQ')!.lotId).toBe('upper');
  });

  it('exits only one lot per bar', () => {
    const lots = [
      lot({ id: 'a', rungPrice: 95 }),
      lot({ id: 'b', rungPrice: 90.25, fillPrice: 90.25, exitTarget: 94.76 }),
    ];
    const intent = selectExit(lots, 120, BAR, 'TQQQ')!;

    // One intent, naming one lot — the caller applies it and re-evaluates.
    expect(intent.lotId).toBeDefined();
    expect(typeof intent.lotId).toBe('string');
  });

  it('exits a lower rung once the higher one is gone', () => {
    const lots = [
      lot({ id: 'upper', status: LotStatus.CLOSED, exitPrice: 99.75 }),
      lot({ id: 'lower', rungPrice: 90.25, fillPrice: 90.25, exitTarget: 94.76 }),
    ];

    expect(selectExit(lots, 100, BAR, 'TQQQ')!.lotId).toBe('lower');
  });

  it('names the rung that will re-arm', () => {
    const intent = selectExit(
      [lot({ id: 'lot-1', rungPrice: 90.25, exitTarget: 94.76 })],
      95,
      BAR,
      'TQQQ',
    )!;

    expect(intent.rungPrice).toBe(90.25);
  });

  /**
   * The structural guarantee. The only condition producing an exit is
   * `close >= lot.exitTarget`, and the target always sits above the fill, so
   * there is no input for which this function emits a sell below cost. "Selling
   * to lower the average" has no code path (`PRD.md:149`).
   */
  describe('never books a loss', () => {
    it('emits no exit at any price below the target, across a wide sweep', () => {
      const held = lot({ id: 'lot-1' });

      for (let close = 1; close < 99.75; close += 0.25) {
        expect(selectExit([held], close, BAR, 'TQQQ')).toBeNull();
      }
    });

    it('always prices the exit above the lot’s fill when it does emit', () => {
      const lots = [
        lot({ id: 'a' }),
        lot({ id: 'b', rungPrice: 90.25, fillPrice: 90.25, exitTarget: 94.76 }),
        lot({ id: 'c', rungPrice: 85.74, fillPrice: 85.74, exitTarget: 90.03 }),
      ];

      for (const close of [95, 100, 150]) {
        const intent = selectExit(lots, close, BAR, 'TQQQ');

        if (intent) {
          const source = lots.find((l) => l.id === intent.lotId)!;
          expect(intent.limitPrice).toBeGreaterThan(source.fillPrice);
        }
      }
    });
  });
});
