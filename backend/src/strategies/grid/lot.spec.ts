import {
  closeGridLot,
  fifoQueue,
  GridLot,
  GridLotStatus,
  heldGridLots,
  isHeld,
  openGridLot,
  sellPriorityQueue,
  sellTargetFor,
  splitGridLot,
} from './lot';

function lot(overrides: Partial<GridLot> = {}): GridLot {
  return {
    id: 'lot-1',
    fillPrice: 100,
    quantity: 50,
    openedAt: '2025-01-02T10:00:00.000-05:00',
    sellTarget: 100.5,
    status: GridLotStatus.HELD,
    closedAt: null,
    exitPrice: null,
    workingOrderId: null,
    ...overrides,
  };
}

describe('sellTargetFor', () => {
  it('adds the gap to the fill price, rounded to cents', () => {
    expect(sellTargetFor(72.333, 0.5)).toBe(72.83);
  });
});

describe('openGridLot', () => {
  it('creates a held lot with the sell target frozen at the current gap', () => {
    const opened = openGridLot({
      id: 'lot-1',
      fillPrice: 72.1,
      quantity: 50,
      openedAt: '2025-01-02T10:00:00.000-05:00',
      gap: 0.5,
    });

    expect(opened).toEqual({
      id: 'lot-1',
      fillPrice: 72.1,
      quantity: 50,
      openedAt: '2025-01-02T10:00:00.000-05:00',
      sellTarget: 72.6,
      status: GridLotStatus.HELD,
      closedAt: null,
      exitPrice: null,
      workingOrderId: null,
    });
  });
});

describe('closeGridLot', () => {
  it('closes without mutating the input and clears the working order', () => {
    const held = lot({ workingOrderId: 'co-1' });
    const closed = closeGridLot(held, 100.6, '2025-01-02T11:00:00.000-05:00');

    expect(held.status).toBe(GridLotStatus.HELD);
    expect(closed).toEqual({
      ...held,
      status: GridLotStatus.CLOSED,
      exitPrice: 100.6,
      closedAt: '2025-01-02T11:00:00.000-05:00',
      workingOrderId: null,
    });
  });
});

describe('splitGridLot', () => {
  it('sells the filled portion and keeps the remainder held at the same basis', () => {
    const held = lot({ quantity: 100 });
    const { sold, remainder } = splitGridLot(
      held,
      40,
      100.5,
      '2025-01-02T11:00:00.000-05:00',
      'lot-1-r1',
    );

    expect(sold.quantity).toBe(40);
    expect(sold.status).toBe(GridLotStatus.CLOSED);
    expect(sold.exitPrice).toBe(100.5);

    expect(remainder.id).toBe('lot-1-r1');
    expect(remainder.quantity).toBe(60);
    expect(remainder.status).toBe(GridLotStatus.HELD);
    expect(remainder.fillPrice).toBe(held.fillPrice);
    expect(remainder.sellTarget).toBe(held.sellTarget);
    expect(remainder.openedAt).toBe(held.openedAt);
    expect(remainder.workingOrderId).toBeNull();

    expect(sold.quantity + remainder.quantity).toBe(held.quantity);
  });
});

describe('isHeld / heldGridLots', () => {
  it('filters to held lots only', () => {
    const held = lot({ id: 'held' });
    const closed = lot({ id: 'closed', status: GridLotStatus.CLOSED });

    expect(isHeld(held)).toBe(true);
    expect(isHeld(closed)).toBe(false);
    expect(heldGridLots([held, closed])).toEqual([held]);
  });
});

describe('fifoQueue', () => {
  it('orders lots oldest first', () => {
    const later = lot({ id: 'later', openedAt: '2025-01-02T12:00:00.000-05:00' });
    const earlier = lot({ id: 'earlier', openedAt: '2025-01-02T10:00:00.000-05:00' });

    expect(fifoQueue([later, earlier]).map((l) => l.id)).toEqual(['earlier', 'later']);
  });

  it('breaks a tied timestamp by id, for a stable total order', () => {
    const b = lot({ id: 'b', openedAt: '2025-01-02T10:00:00.000-05:00' });
    const a = lot({ id: 'a', openedAt: '2025-01-02T10:00:00.000-05:00' });

    expect(fifoQueue([b, a]).map((l) => l.id)).toEqual(['a', 'b']);
  });
});

describe('sellPriorityQueue', () => {
  it('orders lots lowest fill price first, regardless of age', () => {
    // Bought first but at the worst price — must sort last, unlike fifoQueue.
    const boughtFirstExpensive = lot({
      id: 'expensive',
      fillPrice: 100,
      openedAt: '2025-01-02T10:00:00.000-05:00',
    });
    const boughtLaterCheap = lot({
      id: 'cheap',
      fillPrice: 98,
      openedAt: '2025-01-02T12:00:00.000-05:00',
    });

    expect(sellPriorityQueue([boughtFirstExpensive, boughtLaterCheap]).map((l) => l.id)).toEqual([
      'cheap',
      'expensive',
    ]);
  });

  it('breaks a tied fill price by age, oldest first', () => {
    const newer = lot({ id: 'newer', fillPrice: 98, openedAt: '2025-01-02T12:00:00.000-05:00' });
    const older = lot({ id: 'older', fillPrice: 98, openedAt: '2025-01-02T10:00:00.000-05:00' });

    expect(sellPriorityQueue([newer, older]).map((l) => l.id)).toEqual(['older', 'newer']);
  });

  it('breaks a tied fill price and timestamp by id, for a stable total order', () => {
    const b = lot({ id: 'b', fillPrice: 98, openedAt: '2025-01-02T10:00:00.000-05:00' });
    const a = lot({ id: 'a', fillPrice: 98, openedAt: '2025-01-02T10:00:00.000-05:00' });

    expect(sellPriorityQueue([b, a]).map((l) => l.id)).toEqual(['a', 'b']);
  });
});
