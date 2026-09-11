import { flatBar } from '../contract-test-suite';
import { StrategyContext, StrategyState } from '../types';
import { buildGridConfig } from './config';
import { GridStrategy, GridStateData } from './grid.strategy';
import { GridLotStatus } from './lot';

const NOW = '2025-01-02T10:00:00.000-05:00';

function context(
  strategyId: string,
  history: StrategyContext['history'] = [],
  symbols: string[] = ['TQQQ'],
): StrategyContext {
  return { strategyId, symbols, now: NOW, parameters: {}, history };
}

function dataOf(state: StrategyState): GridStateData {
  return state.data as unknown as GridStateData;
}

describe('GridStrategy', () => {
  const buildStrategy = () => new GridStrategy(buildGridConfig('TQQQ', { gap: 0.5, quantity: 50 }));

  it('has an id carrying its symbol', () => {
    expect(buildStrategy().id).toBe('grid:TQQQ');
  });

  describe('onBar', () => {
    it('ignores a bar for another symbol', async () => {
      const strategy = buildStrategy();
      const state = await strategy.initialize();

      const intents = strategy.onBar(flatBar('SPY', '2025-01-02T10:00:00.000-05:00'), state);
      expect(intents).toEqual([]);
    });

    it('ignores a pre-market bar', async () => {
      const strategy = buildStrategy();
      const state = await strategy.initialize();

      const intents = strategy.onBar(flatBar('TQQQ', '2025-01-02T08:00:00.000-05:00'), state);
      expect(intents).toEqual([]);
    });

    it("recomputes once at the session's first regular-session bar", async () => {
      const strategy = buildStrategy();
      const state = await strategy.initialize();

      const first = strategy.onBar(flatBar('TQQQ', '2025-01-02T09:30:00.000-05:00', 100), state);
      expect(first.length).toBeGreaterThan(0);

      // A second bar the same session must not re-emit — only a fill (via
      // `evaluate`) or the next session's first bar triggers a recompute.
      const second = strategy.onBar(flatBar('TQQQ', '2025-01-02T09:35:00.000-05:00', 99), state);
      expect(second).toEqual([]);
    });

    it("recomputes again on the next session's first bar", async () => {
      const strategy = buildStrategy();
      const state = await strategy.initialize();

      strategy.onBar(flatBar('TQQQ', '2025-01-02T09:30:00.000-05:00', 100), state);
      const nextDay = strategy.onBar(flatBar('TQQQ', '2025-01-03T09:30:00.000-05:00', 100), state);

      expect(nextDay.length).toBeGreaterThan(0);
    });

    it('emits a marketable-at-close BUY while flat', async () => {
      const strategy = buildStrategy();
      const state = await strategy.initialize();

      const intents = strategy.onBar(flatBar('TQQQ', '2025-01-02T09:30:00.000-05:00', 100), state);

      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject({ side: 'BUY', strategyId: 'grid:TQQQ' });
      expect(intents[0].limitPrice).toBeGreaterThan(100);
    });
  });

  describe('evaluate', () => {
    it('ignores a context for another symbol', async () => {
      const strategy = buildStrategy();
      const state = await strategy.initialize();

      const intents = strategy.evaluate(
        context('grid:TQQQ', [flatBar('SPY', NOW)], ['SPY']),
        state,
      );
      expect(intents).toEqual([]);
    });

    it('returns [] when the context carries no history', async () => {
      const strategy = buildStrategy();
      const state = await strategy.initialize();

      expect(strategy.evaluate(context('grid:TQQQ', []), state)).toEqual([]);
    });

    it('recomputes from currently held lots using the last bar in history', async () => {
      const strategy = buildStrategy();
      const state = await strategy.initialize();

      GridStrategy.openLotFromFill(state, buildGridConfig('TQQQ', { gap: 0.5 }), {
        price: 100,
        quantity: 50,
        at: '2025-01-02T10:00:00.000-05:00',
      });

      const intents = strategy.evaluate(
        context('grid:TQQQ', [flatBar('TQQQ', '2025-01-02T10:05:00.000-05:00', 100)]),
        state,
      );

      const buys = intents.filter((i) => i.side === 'BUY');
      const sells = intents.filter((i) => i.side === 'SELL');

      expect(buys.length).toBeGreaterThan(0);
      expect(sells).toHaveLength(1);
    });
  });

  describe('fill statics', () => {
    it('openLotFromFill opens a held lot with a frozen sell target', async () => {
      const strategy = buildStrategy();
      const state = await strategy.initialize();
      const config = buildGridConfig('TQQQ', { gap: 0.5 });

      const lot = GridStrategy.openLotFromFill(state, config, {
        price: 72.1,
        quantity: 50,
        at: '2025-01-02T10:00:00.000-05:00',
      });

      expect(lot.status).toBe(GridLotStatus.HELD);
      expect(lot.sellTarget).toBe(72.6);
      expect(GridStrategy.lotsOf(state)).toEqual([lot]);
    });

    it('closeLotFromFill closes a full fill', async () => {
      const strategy = buildStrategy();
      const state = await strategy.initialize();
      const config = buildGridConfig('TQQQ', { gap: 0.5 });

      const lot = GridStrategy.openLotFromFill(state, config, {
        price: 100,
        quantity: 50,
        at: '2025-01-02T10:00:00.000-05:00',
      });

      const result = GridStrategy.closeLotFromFill(state, {
        lotId: lot.id,
        price: 100.5,
        quantity: 50,
        at: '2025-01-02T11:00:00.000-05:00',
      });

      expect(result?.remainder).toBeNull();
      expect(result?.closed.status).toBe(GridLotStatus.CLOSED);
      expect(GridStrategy.lotsOf(state)[0].status).toBe(GridLotStatus.CLOSED);
    });

    it('closeLotFromFill splits a partial fill, keeping the remainder held', async () => {
      const strategy = buildStrategy();
      const state = await strategy.initialize();
      const config = buildGridConfig('TQQQ', { gap: 0.5 });

      const lot = GridStrategy.openLotFromFill(state, config, {
        price: 100,
        quantity: 100,
        at: '2025-01-02T10:00:00.000-05:00',
      });

      const result = GridStrategy.closeLotFromFill(state, {
        lotId: lot.id,
        price: 100.5,
        quantity: 40,
        at: '2025-01-02T11:00:00.000-05:00',
      });

      expect(result?.closed.quantity).toBe(40);
      expect(result?.remainder?.quantity).toBe(60);
      expect(GridStrategy.lotsOf(state)).toHaveLength(2);
    });

    it('closeLotFromFill returns null for an unknown or already-closed lot', async () => {
      const strategy = buildStrategy();
      const state = await strategy.initialize();

      const result = GridStrategy.closeLotFromFill(state, {
        lotId: 'does-not-exist',
        price: 100,
        quantity: 50,
        at: NOW,
      });

      expect(result).toBeNull();
    });

    it("recordWorkingExit and clearWorkingOrder round-trip a lot's working order id", async () => {
      const strategy = buildStrategy();
      const state = await strategy.initialize();
      const config = buildGridConfig('TQQQ', { gap: 0.5 });

      const lot = GridStrategy.openLotFromFill(state, config, {
        price: 100,
        quantity: 50,
        at: NOW,
      });

      GridStrategy.recordWorkingExit(state, lot.id, 'co-1');
      expect(GridStrategy.lotsOf(state)[0].workingOrderId).toBe('co-1');

      GridStrategy.clearWorkingOrder(state, 'co-1');
      expect(GridStrategy.lotsOf(state)[0].workingOrderId).toBeNull();
    });

    it('clearWorkingOrder is a harmless no-op for an id that matches no lot', async () => {
      const strategy = buildStrategy();
      const state = await strategy.initialize();

      expect(() => GridStrategy.clearWorkingOrder(state, 'co-unknown')).not.toThrow();
      expect(dataOf(state).lots).toEqual([]);
    });
  });
});
