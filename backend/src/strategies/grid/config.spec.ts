import { buildGridConfig, DEFAULT_GRID_CONFIG } from './config';

describe('grid config', () => {
  describe('defaults', () => {
    it('builds a config from the recorded defaults', () => {
      const config = buildGridConfig('TQQQ');

      expect(config).toEqual({
        symbol: 'TQQQ',
        ...DEFAULT_GRID_CONFIG,
      });
    });

    it('overrides take precedence over defaults', () => {
      const config = buildGridConfig('TQQQ', { gap: 1, quantity: 10 });

      expect(config.gap).toBe(1);
      expect(config.quantity).toBe(10);
      expect(config.maxBuyLevels).toBe(DEFAULT_GRID_CONFIG.maxBuyLevels);
    });
  });

  describe('validation', () => {
    it('rejects an empty symbol', () => {
      expect(() => buildGridConfig('')).toThrow(/symbol/);
    });

    it.each([0, -1])('rejects a non-positive quantity (%s)', (quantity) => {
      expect(() => buildGridConfig('TQQQ', { quantity })).toThrow(/quantity/);
    });

    it('rejects a fractional quantity', () => {
      expect(() => buildGridConfig('TQQQ', { quantity: 1.5 })).toThrow(/quantity/);
    });

    it.each([0, -0.5])('rejects a non-positive gap (%s)', (gap) => {
      expect(() => buildGridConfig('TQQQ', { gap })).toThrow(/gap/);
    });

    it.each([0, -1])('rejects a non-positive maxBuyLevels (%s)', (maxBuyLevels) => {
      expect(() => buildGridConfig('TQQQ', { maxBuyLevels })).toThrow(/maxBuyLevels/);
    });

    it.each([0, -1])('rejects a non-positive maxSellOrders (%s)', (maxSellOrders) => {
      expect(() => buildGridConfig('TQQQ', { maxSellOrders })).toThrow(/maxSellOrders/);
    });

    it('rejects a negative entryBuffer', () => {
      expect(() => buildGridConfig('TQQQ', { entryBuffer: -0.01 })).toThrow(/entryBuffer/);
    });

    it('accepts a zero entryBuffer', () => {
      expect(() => buildGridConfig('TQQQ', { entryBuffer: 0 })).not.toThrow();
    });
  });
});
