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
      buyPricing: 'DAILY_AVERAGE',
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

  describe("buyPricing: DAILY_AVERAGE (the day's first entry only)", () => {
    it('holding one lot: one dip-buy at gap below the avg hold price, plus one sell at its own target', () => {
      const held = lot({ fillPrice: 100, quantity: 50 });

      // close sits at the lot's fill price — the dip level below it (99.5) is
      // still below the market and so rests.
      const intents = computeGridIntents({
        symbol: 'TQQQ',
        close: 100,
        timestamp: TS,
        heldLots: [held],
        config,
        buyPricing: 'DAILY_AVERAGE',
      });

      const buys = intents.filter((i) => i.side === 'BUY');
      const sells = intents.filter((i) => i.side === 'SELL');

      expect(buys.map((b) => b.limitPrice)).toEqual([99.5]);
      expect(sells).toHaveLength(1);
      expect(sells[0]).toMatchObject({ limitPrice: 100.5, quantity: 50, lotId: held.id });
    });

    it('prices the dip-buy off the quantity-weighted average of several held lots', () => {
      const first = lot({ id: 'first', fillPrice: 100, quantity: 50 });
      const second = lot({ id: 'second', fillPrice: 98, quantity: 150 });
      // weighted avg = (100*50 + 98*150) / 200 = 98.5; target = 98.5 - 0.5 = 98

      const intents = computeGridIntents({
        symbol: 'TQQQ',
        close: 99,
        timestamp: TS,
        heldLots: [first, second],
        config,
        buyPricing: 'DAILY_AVERAGE',
      });

      expect(intents.filter((i) => i.side === 'BUY').map((b) => b.limitPrice)).toEqual([98]);
    });

    it('pegs the dip-buy to the current close once the market has gapped below it', () => {
      const held = lot({ fillPrice: 100 });

      // target = 100 - 0.5 = 99.5, already above the close — pegged to 98.7
      // instead of being skipped outright.
      const intents = computeGridIntents({
        symbol: 'TQQQ',
        close: 98.7,
        timestamp: TS,
        heldLots: [held],
        config,
        buyPricing: 'DAILY_AVERAGE',
      });

      const buys = intents.filter((i) => i.side === 'BUY');
      expect(buys).toEqual([
        expect.objectContaining({
          limitPrice: 98.7,
          reason: expect.stringContaining('pegged to close'),
        }),
      ]);
    });

    it('never emits a buy at or below zero', () => {
      const held = lot({ fillPrice: 0.6 });
      const wideGapConfig = buildGridConfig('TQQQ', { gap: 0.5 });

      const intents = computeGridIntents({
        symbol: 'TQQQ',
        close: 0.5,
        timestamp: TS,
        heldLots: [held],
        config: wideGapConfig,
        buyPricing: 'DAILY_AVERAGE',
      });

      // target = 0.6 - 0.5 = 0.1, restable (< close 0.5)? No — isRestable
      // requires target < close; 0.1 < 0.5 is true, so it rests at 0.1.
      expect(intents.filter((i) => i.side === 'BUY').map((b) => b.limitPrice)).toEqual([0.1]);
    });

    it('drops a pegged-to-close buy that would land at or below zero', () => {
      const held = lot({ fillPrice: 1 });

      // target = 1 - 0.5 = 0.5, above the close of 0 — pegged to close, but
      // close itself is 0, so nothing is emitted.
      const intents = computeGridIntents({
        symbol: 'TQQQ',
        close: 0,
        timestamp: TS,
        heldLots: [held],
        config,
        buyPricing: 'DAILY_AVERAGE',
      });

      expect(intents.filter((i) => i.side === 'BUY')).toEqual([]);
    });
  });

  describe("buyPricing: GRID_STEPS (every recompute after the day's first entry)", () => {
    it('holding one lot: two stepped dip-buy levels below the lowest held lot', () => {
      const held = lot({ fillPrice: 100, quantity: 50 });

      // close sits at the lowest held lot's fill price — both dip levels
      // below it (99.5, 99.0) are still below the market and so both rest.
      const intents = computeGridIntents({
        symbol: 'TQQQ',
        close: 100,
        timestamp: TS,
        heldLots: [held],
        config,
        buyPricing: 'GRID_STEPS',
      });

      const buys = intents.filter((i) => i.side === 'BUY');
      expect(buys.map((b) => b.limitPrice)).toEqual([99.5, 99]);
    });

    it('steps below the lowest held lot, not the average, when several lots are held', () => {
      const higher = lot({ id: 'higher', fillPrice: 100, quantity: 50 });
      const lower = lot({ id: 'lower', fillPrice: 96, quantity: 150 });
      // average would be 96*150+100*50 / 200 = 97; but GRID_STEPS uses the
      // lowest fill (96), not the average, so levels are 95.5 and 95.

      const intents = computeGridIntents({
        symbol: 'TQQQ',
        close: 96,
        timestamp: TS,
        heldLots: [higher, lower],
        config,
        buyPricing: 'GRID_STEPS',
      });

      expect(intents.filter((i) => i.side === 'BUY').map((b) => b.limitPrice)).toEqual([95.5, 95]);
    });

    it('skips (never pegs) a dip-buy level the market has already gapped through', () => {
      // This is the fill-triggered recompute's guard: `evaluate` always
      // passes `buyPricing: 'GRID_STEPS'`, which never pegs — a pegged buy
      // is marketable by construction and would otherwise fill and
      // re-trigger this same recompute, pegging again, and repeat: a
      // self-sustaining buying loop. Regression for a real incident (4 buys
      // in under 3 minutes, all ~70.06, on 2026-09-14).
      const held = lot({ fillPrice: 100 });

      // close = 98.7: level 1 (99.5) and level 2 (99.0) are both >= close, so
      // both would be marketable and neither should be emitted.
      const intents = computeGridIntents({
        symbol: 'TQQQ',
        close: 98.7,
        timestamp: TS,
        heldLots: [held],
        config,
        buyPricing: 'GRID_STEPS',
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
        buyPricing: 'GRID_STEPS',
      });

      // level 1 = 0.1 (restable, kept), level 2 = -0.4 (dropped for being <= 0)
      expect(intents.filter((i) => i.side === 'BUY').map((b) => b.limitPrice)).toEqual([0.1]);
    });
  });

  it('selects sells by lowest fill price first, capped at maxSellOrders — not by age', () => {
    const capped = buildGridConfig('TQQQ', { gap: 0.5, maxSellOrders: 2, maxBuyLevels: 1 });
    // Oldest-first (FIFO) would pick `first`/`second`; lowest-price-first
    // must pick `third`/`second` instead, leaving out `first` even though it
    // was bought before both — this is the actual bug being fixed: a cap
    // meant to protect lots is otherwise blind to which ones are cheapest.
    const first = lot({ id: 'first', fillPrice: 100, openedAt: '2025-01-02T10:00:00.000-05:00' });
    const second = lot({ id: 'second', fillPrice: 99, openedAt: '2025-01-02T10:05:00.000-05:00' });
    const third = lot({ id: 'third', fillPrice: 98, openedAt: '2025-01-02T10:10:00.000-05:00' });

    const intents = computeGridIntents({
      symbol: 'TQQQ',
      close: 90,
      timestamp: TS,
      heldLots: [third, first, second],
      config: capped,
      buyPricing: 'GRID_STEPS',
    });

    const sells = intents.filter((i) => i.side === 'SELL');
    expect(sells.map((s) => s.lotId)).toEqual(['third', 'second']);
  });

  it('breaks a tie on equal fill price by age, oldest first', () => {
    const capped = buildGridConfig('TQQQ', { gap: 0.5, maxSellOrders: 1, maxBuyLevels: 1 });
    const older = lot({ id: 'older', fillPrice: 98, openedAt: '2025-01-02T10:00:00.000-05:00' });
    const newer = lot({ id: 'newer', fillPrice: 98, openedAt: '2025-01-02T10:05:00.000-05:00' });

    const intents = computeGridIntents({
      symbol: 'TQQQ',
      close: 90,
      timestamp: TS,
      heldLots: [newer, older],
      config: capped,
      buyPricing: 'GRID_STEPS',
    });

    const sells = intents.filter((i) => i.side === 'SELL');
    expect(sells.map((s) => s.lotId)).toEqual(['older']);
  });

  it('skips a lot that already has a resting sell', () => {
    const covered = lot({ workingOrderId: 'co-1' });

    const intents = computeGridIntents({
      symbol: 'TQQQ',
      close: 99,
      timestamp: TS,
      heldLots: [covered],
      config,
      buyPricing: 'GRID_STEPS',
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
      buyPricing: 'GRID_STEPS',
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
      buyPricing: 'DAILY_AVERAGE',
    });

    // The flat-entry branch only checks heldLots.length, so a caller that
    // fails to filter to held lots gets buy-level pricing off a closed lot's
    // fill price rather than the flat-entry rule — heldGridLots() is what the
    // adapter uses to avoid this, and this test documents the contract.
    expect(intents.some((i) => i.side === 'BUY' && i.limitPrice === 100.05)).toBe(false);
  });
});
