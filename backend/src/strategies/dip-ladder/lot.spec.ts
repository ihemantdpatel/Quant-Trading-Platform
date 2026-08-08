import {
  closeLot,
  exitTargetFor,
  fifoQueueAtRung,
  heldLots,
  isHeld,
  Lot,
  LotStatus,
  oldestHeldLotAtRung,
  openLot,
} from './lot';

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

describe('exitTargetFor', () => {
  /**
   * The target is measured from **this lot's own fill price** (`PRD.md:129`).
   * Never from the blended average — that is the whole point of per-lot exits.
   */
  it('is the fill price plus the take-profit fraction', () => {
    expect(exitTargetFor(95, 0.05)).toBe(99.75);
    expect(exitTargetFor(90.25, 0.05)).toBe(94.76);
    expect(exitTargetFor(100, 0.1)).toBe(110);
  });

  it('rounds to cents', () => {
    // 87.41 × 1.05 = 91.7805 → 91.78
    expect(exitTargetFor(87.41, 0.05)).toBe(91.78);
  });

  it('is always above the fill price, so no target can book a loss', () => {
    for (const fill of [10, 87.41, 95, 250.5]) {
      expect(exitTargetFor(fill, 0.05)).toBeGreaterThan(fill);
    }
  });

  it('gives different targets to different fills — no shared level', () => {
    expect(exitTargetFor(95, 0.05)).not.toBe(exitTargetFor(90.25, 0.05));
  });
});

describe('openLot', () => {
  const created = openLot({
    id: 'lot-1',
    rungPrice: 90.25,
    fillPrice: 90.3,
    quantity: 27,
    openedAt: '2025-01-02T10:05:00.000-05:00',
    takeProfitPercent: 0.05,
  });

  it('opens HELD with no exit recorded', () => {
    expect(created.status).toBe(LotStatus.HELD);
    expect(created.closedAt).toBeNull();
    expect(created.exitPrice).toBeNull();
  });

  /**
   * The target is computed from the actual **fill**, not the rung price. Once
   * real fills exist they will differ, and a lot must exit relative to what it
   * actually paid.
   */
  it('freezes the target from the fill price, not the rung price', () => {
    expect(created.exitTarget).toBe(exitTargetFor(90.3, 0.05));
    expect(created.exitTarget).not.toBe(exitTargetFor(90.25, 0.05));
  });

  it('keeps the rung price as the re-arm level', () => {
    expect(created.rungPrice).toBe(90.25);
  });

  /**
   * Story 7 requires a parameter edit to leave held lots' targets untouched
   * (`PRD.md:386`). A stored target makes that structural.
   */
  it('stores the target rather than deriving it later', () => {
    expect(Object.keys(created)).toContain('exitTarget');
    expect(typeof created.exitTarget).toBe('number');
  });

  it('round-trips through JSON unchanged — it is the durable recovery unit', () => {
    expect(JSON.parse(JSON.stringify(created))).toEqual(created);
  });
});

describe('closeLot', () => {
  const held = lot({ id: 'lot-1' });
  const closed = closeLot(held, 99.75, '2025-01-03T11:00:00.000-05:00');

  it('records status, exit price, and close time', () => {
    expect(closed.status).toBe(LotStatus.CLOSED);
    expect(closed.exitPrice).toBe(99.75);
    expect(closed.closedAt).toBe('2025-01-03T11:00:00.000-05:00');
  });

  it('does not mutate the original', () => {
    expect(held.status).toBe(LotStatus.HELD);
    expect(held.exitPrice).toBeNull();
  });

  it('preserves fill price and quantity for P&L reconstruction', () => {
    expect(closed.fillPrice).toBe(held.fillPrice);
    expect(closed.quantity).toBe(held.quantity);
  });
});

describe('isHeld / heldLots', () => {
  const lots = [
    lot({ id: 'a' }),
    lot({ id: 'b', status: LotStatus.CLOSED, exitPrice: 99.75 }),
    lot({ id: 'c' }),
  ];

  it('filters to held lots only', () => {
    expect(heldLots(lots).map((l) => l.id)).toEqual(['a', 'c']);
  });

  it('classifies a single lot', () => {
    expect(isHeld(lots[0])).toBe(true);
    expect(isHeld(lots[1])).toBe(false);
  });
});

/**
 * FIFO disposal (`PRD.md:134`): when a rung's target is hit, the **oldest** lot
 * at that rung is the one sold.
 */
describe('fifoQueueAtRung', () => {
  const lots = [
    lot({ id: 'newest', openedAt: '2025-01-05T10:00:00.000-05:00' }),
    lot({ id: 'oldest', openedAt: '2025-01-02T10:00:00.000-05:00' }),
    lot({ id: 'middle', openedAt: '2025-01-03T10:00:00.000-05:00' }),
  ];

  it('orders lots at a rung oldest-first', () => {
    expect(fifoQueueAtRung(lots, 95).map((l) => l.id)).toEqual(['oldest', 'middle', 'newest']);
  });

  it('excludes closed lots', () => {
    const withClosed = [
      ...lots,
      lot({ id: 'gone', status: LotStatus.CLOSED, openedAt: '2025-01-01T10:00:00.000-05:00' }),
    ];

    expect(fifoQueueAtRung(withClosed, 95).map((l) => l.id)).not.toContain('gone');
  });

  it('excludes lots at other rungs', () => {
    const other = [...lots, lot({ id: 'lower', rungPrice: 90.25 })];

    expect(fifoQueueAtRung(other, 95).map((l) => l.id)).not.toContain('lower');
    expect(fifoQueueAtRung(other, 90.25).map((l) => l.id)).toEqual(['lower']);
  });

  it('matches rung prices at cent precision despite float noise', () => {
    const noisy = 95 - 4.75000000001;

    expect(fifoQueueAtRung([lot({ id: 'x', rungPrice: 90.25 })], noisy)).toHaveLength(1);
  });

  /**
   * A total, stable order matters: two lots can share a timestamp when one bar
   * fills more than one rung, and an unstable tie-break would make
   * which-lot-sold depend on array order — nondeterminism that cannot be
   * reconciled after a restart (Story 9).
   */
  it('breaks timestamp ties deterministically by id', () => {
    const sameTime = '2025-01-02T10:00:00.000-05:00';
    const forward = [lot({ id: 'b', openedAt: sameTime }), lot({ id: 'a', openedAt: sameTime })];
    const reversed = [...forward].reverse();

    expect(fifoQueueAtRung(forward, 95).map((l) => l.id)).toEqual(['a', 'b']);
    expect(fifoQueueAtRung(reversed, 95).map((l) => l.id)).toEqual(['a', 'b']);
  });

  it('returns empty when nothing is held at the rung', () => {
    expect(fifoQueueAtRung([], 95)).toEqual([]);
  });

  /**
   * Fully identical sort keys. Not a state the ladder can reach — ids are
   * unique — but the comparator must still be well-defined, because an
   * inconsistent one produces implementation-defined ordering in V8's sort.
   */
  it('handles identical sort keys without reordering', () => {
    const sameTime = '2025-01-02T10:00:00.000-05:00';
    const duplicates = [lot({ id: 'a', openedAt: sameTime }), lot({ id: 'a', openedAt: sameTime })];

    expect(fifoQueueAtRung(duplicates, 95)).toHaveLength(2);
  });
});

describe('oldestHeldLotAtRung', () => {
  it('returns the FIFO head', () => {
    const lots = [
      lot({ id: 'newer', openedAt: '2025-01-05T10:00:00.000-05:00' }),
      lot({ id: 'older', openedAt: '2025-01-02T10:00:00.000-05:00' }),
    ];

    expect(oldestHeldLotAtRung(lots, 95)!.id).toBe('older');
  });

  it('returns null when the rung holds nothing', () => {
    expect(oldestHeldLotAtRung([], 95)).toBeNull();
  });

  /**
   * A newer lot in profit does not jump the queue — FIFO is by open time, not
   * by which lot happens to be furthest above its target.
   */
  it('does not let a newer lot jump the queue', () => {
    const lots = [
      lot({
        id: 'newer',
        openedAt: '2025-01-05T10:00:00.000-05:00',
        fillPrice: 80,
        exitTarget: 84,
      }),
      lot({ id: 'older', openedAt: '2025-01-02T10:00:00.000-05:00' }),
    ];

    expect(oldestHeldLotAtRung(lots, 95)!.id).toBe('older');
  });
});
