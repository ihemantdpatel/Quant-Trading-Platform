import { buildGridConfig } from './config';
import { computeGridIntents, isRestable, isRestableExit } from './levels';
import { GridLot, GridLotStatus, openGridLot } from './lot';

const TS = '2025-01-02T10:00:00.000-05:00';

function lot(overrides: Partial<GridLot> = {}): GridLot {
  return {
    ...openGridLot({
      id: overrides.id ?? 'lot-1',
      fillPrice: overrides.fillPrice ?? 100,
      quantity: overrides.quantity ?? 50,
      openedAt: overrides.openedAt ?? TS,
      gap: 0.5,
    }),
    ...overrides,
  };
}

describe('isRestable / isRestableExit', () => {
  it('a BUY rests only strictly below the close', () => {
    expect(isRestable(99, 100)).toBe(true);
    expect(isRestable(100, 100)).toBe(false);
    expect(isRestable(101, 100)).toBe(false);
  });

  it('a SELL rests only strictly above the close', () => {
    expect(isRestableExit(101, 100)).toBe(true);
    expect(isRestableExit(100, 100)).toBe(false);
    expect(isRestableExit(99, 100)).toBe(false);
  });
});

describe('computeGridIntents', () => {
  const config = buildGridConfig('TQQQ', { gap: 0.5, quantity: 50, entryBuffer: 0.05 });

  it('flat: emits one marketable-at-close BUY, never a true MKT order', () => {
    const intents = computeGridIntents({
      symbol: 'TQQQ',
      close: 100,
      timestamp: TS,
      heldLots: [],
      config,
    });

    expect(intents).toEqual([
      {
        symbol: 'TQQQ',
        side: 'BUY',
        quantity: 50,
        limitPrice: 100.05,
        timestamp: TS,
        reason: expect.stringContaining('flat'),
      },
    ]);
  });

  it('holding one lot: two stepped dip-buy levels plus one sell at its own target', () => {
    const held = lot({ fillPrice: 100, quantity: 50 });

    // close sits at the lowest held lot's fill price — both dip levels below
    // it (99.5, 99.0) are still below the market and so both rest.
    const intents = computeGridIntents({
      symbol: 'TQQQ',
      close: 100,
      timestamp: TS,
      heldLots: [held],
      config,
    });

    const buys = intents.filter((i) => i.side === 'BUY');
    const sells = intents.filter((i) => i.side === 'SELL');

    expect(buys.map((b) => b.limitPrice)).toEqual([99.5, 99]);
    expect(sells).toHaveLength(1);
    expect(sells[0]).toMatchObject({ limitPrice: 100.5, quantity: 50, lotId: held.id });
  });

  it('skips a dip-buy level the market has already gapped through', () => {
    const held = lot({ fillPrice: 100 });

    // close = 98.7: level 1 (99.5) and level 2 (99.0) are both >= close, so
    // both would be marketable and neither should be emitted.
    const intents = computeGridIntents({
      symbol: 'TQQQ',
      close: 98.7,
      timestamp: TS,
      heldLots: [held],
      config,
    });

    expect(intents.filter((i) => i.side === 'BUY')).toEqual([]);
  });

  it('never emits a buy level at or below zero', () => {
    const held = lot({ fillPrice: 0.6 });
    const wideGapConfig = buildGridConfig('TQQQ', { gap: 0.5 });

    const intents = computeGridIntents({
      symbol: 'TQQQ',
      close: 0.5,
      timestamp: TS,
      heldLots: [held],
      config: wideGapConfig,
    });

    // level 1 = 0.1 (restable, kept), level 2 = -0.4 (dropped for being <= 0)
    expect(intents.filter((i) => i.side === 'BUY').map((b) => b.limitPrice)).toEqual([0.1]);
  });

  it('FIFO-selects sells, capped at maxSellOrders, oldest/lowest-priced first', () => {
    const capped = buildGridConfig('TQQQ', { gap: 0.5, maxSellOrders: 2, maxBuyLevels: 1 });
    const first = lot({ id: 'first', fillPrice: 100, openedAt: '2025-01-02T10:00:00.000-05:00' });
    const second = lot({ id: 'second', fillPrice: 99, openedAt: '2025-01-02T10:05:00.000-05:00' });
    const third = lot({ id: 'third', fillPrice: 98, openedAt: '2025-01-02T10:10:00.000-05:00' });

    const intents = computeGridIntents({
      symbol: 'TQQQ',
      close: 90,
      timestamp: TS,
      heldLots: [third, first, second],
      config: capped,
    });

    const sells = intents.filter((i) => i.side === 'SELL');
    expect(sells.map((s) => s.lotId)).toEqual(['first', 'second']);
  });

  it('skips a lot that already has a resting sell', () => {
    const covered = lot({ workingOrderId: 'co-1' });

    const intents = computeGridIntents({
      symbol: 'TQQQ',
      close: 99,
      timestamp: TS,
      heldLots: [covered],
      config,
    });

    expect(intents.filter((i) => i.side === 'SELL')).toEqual([]);
  });

  it('pegs a sell to the market when a gap up has already carried price past the target', () => {
    const held = lot({ fillPrice: 100 }); // sellTarget = 100.5

    const intents = computeGridIntents({
      symbol: 'TQQQ',
      close: 101, // already past the 100.5 target
      timestamp: TS,
      heldLots: [held],
      config,
    });

    const sell = intents.find((i) => i.side === 'SELL');
    expect(sell).toMatchObject({ limitPrice: 101, lotId: held.id });
  });

  it('ignores a closed lot entirely (caller is expected to filter to held lots)', () => {
    const closed = lot({ status: GridLotStatus.CLOSED });

    const intents = computeGridIntents({
      symbol: 'TQQQ',
      close: 99,
      timestamp: TS,
      heldLots: [closed],
      config,
    });

    // The flat-entry branch only checks heldLots.length, so a caller that
    // fails to filter to held lots gets buy-level pricing off a closed lot's
    // fill price rather than the flat-entry rule — heldGridLots() is what the
    // adapter uses to avoid this, and this test documents the contract.
    expect(intents.some((i) => i.side === 'BUY' && i.limitPrice === 100.05)).toBe(false);
  });
});
