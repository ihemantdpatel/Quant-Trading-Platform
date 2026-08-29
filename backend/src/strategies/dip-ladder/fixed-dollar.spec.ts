/**
 * Fixed-dollar spacing and fixed quantity — the "$50 per round trip" config.
 *
 * The operator requirement these serve is a *currency* figure per cycle rather
 * than a percentage return: buy 50 shares, sell them one dollar higher, book
 * $50 — at any price level. Percentage spacing cannot express that, because
 * 1% of $72 and 1% of $100 are different amounts of money.
 *
 * The assertions below are therefore written in dollars of realized profit,
 * not in percentages, because that is the property being bought.
 */

import { buildDipLadderConfig, SpacingMode } from './config';
import { rungQuantity } from './ladder';
import { exitTargetFor, openLot } from './lot';
import { realizedPnl } from './exits';
import { nextRungPrice, resolveSpacing } from './spacing';

const FIXED_DOLLAR_CONFIG = {
  spacingMode: SpacingMode.FIXED_DOLLAR,
  spacingDollars: 1,
  takeProfitDollars: 1,
  fixedQuantity: 50,
  symbolCapital: 40_000,
};

describe('fixed-dollar ladder', () => {
  describe('spacing', () => {
    it('places rungs exactly one dollar apart regardless of price level', () => {
      const config = buildDipLadderConfig('TQQQ', FIXED_DOLLAR_CONFIG);

      expect(nextRungPrice(72, config)).toBe(71);
      expect(nextRungPrice(71, config)).toBe(70);
      // The same absolute gap at a very different price — the property a
      // percentage mode cannot provide.
      expect(nextRungPrice(300, config)).toBe(299);
    });

    it('reports FIXED_DOLLAR without falling back, since it consults no history', () => {
      const config = buildDipLadderConfig('TQQQ', FIXED_DOLLAR_CONFIG);

      expect(resolveSpacing(72, config, [])).toEqual({
        distance: 1,
        mode: SpacingMode.FIXED_DOLLAR,
        fellBack: false,
      });
    });

    it('does not disturb percentage spacing, which remains the default', () => {
      const config = buildDipLadderConfig('TQQQ', { symbolCapital: 40_000 });

      expect(resolveSpacing(72, config).mode).toBe(SpacingMode.PERCENTAGE);
      expect(nextRungPrice(72, config)).toBe(68.4);
    });
  });

  describe('quantity', () => {
    it('returns the fixed count at every price and depth', () => {
      const config = buildDipLadderConfig('TQQQ', FIXED_DOLLAR_CONFIG);

      expect(rungQuantity(72, 0, config)).toBe(50);
      expect(rungQuantity(71, 1, config)).toBe(50);
      expect(rungQuantity(300, 4, config)).toBe(50);
    });

    it('ignores symbolCapital, so an unset allocation still sizes the rung', () => {
      const config = buildDipLadderConfig('TQQQ', {
        ...FIXED_DOLLAR_CONFIG,
        symbolCapital: null,
      });

      expect(rungQuantity(72, 0, config)).toBe(50);
    });

    it('leaves capital-derived sizing untouched when fixedQuantity is null', () => {
      const config = buildDipLadderConfig('TQQQ', { symbolCapital: 40_000 });

      // floor(40000 * 0.25 / 72)
      expect(rungQuantity(72, 0, config)).toBe(138);
    });
  });

  describe('exit targets', () => {
    it('sets the target one dollar above the fill, not a percentage above', () => {
      expect(exitTargetFor(72, 0.05, 1)).toBe(73);
      expect(exitTargetFor(71, 0.05, 1)).toBe(72);
      // At a high price the percentage rule would give 105; the absolute rule
      // holds at +1 regardless.
      expect(exitTargetFor(100, 0.05, 1)).toBe(101);
    });

    it('falls back to the percentage rule when no absolute target is set', () => {
      expect(exitTargetFor(72, 0.05)).toBe(75.6);
      expect(exitTargetFor(72, 0.05, null)).toBe(75.6);
    });
  });

  describe('the requirement: $50 per completed round trip', () => {
    it.each([
      ['the example from the operator', 71],
      ['a higher price level', 100],
      ['a lower price level', 40],
    ])('books exactly $50 at %s', (_label, fillPrice) => {
      const config = buildDipLadderConfig('TQQQ', FIXED_DOLLAR_CONFIG);

      const lot = openLot({
        id: 'lot-1',
        rungPrice: fillPrice,
        fillPrice,
        quantity: rungQuantity(fillPrice, 0, config),
        openedAt: '2026-08-26T14:00:00.000Z',
        takeProfitPercent: config.takeProfitPercent,
        takeProfitDollars: config.takeProfitDollars,
      });

      expect(lot.quantity).toBe(50);
      expect(lot.exitTarget).toBe(fillPrice + 1);
      expect(realizedPnl(lot, lot.exitTarget)).toBe(50);
    });

    it("lands a lot's target exactly on the rung above it", () => {
      const config = buildDipLadderConfig('TQQQ', FIXED_DOLLAR_CONFIG);

      // Buy at 72, next rung down is 71; the lot filled there targets 72 —
      // the level it was bought one rung below. This is what makes the ladder
      // cycle cleanly rather than leaving gaps between targets and rungs.
      const lowerRung = nextRungPrice(72, config);
      const lot = openLot({
        id: 'lot-2',
        rungPrice: lowerRung,
        fillPrice: lowerRung,
        quantity: 50,
        openedAt: '2026-08-26T14:05:00.000Z',
        takeProfitPercent: config.takeProfitPercent,
        takeProfitDollars: config.takeProfitDollars,
      });

      expect(lot.exitTarget).toBe(72);
    });
  });

  describe('validation', () => {
    it('rejects a non-positive spacingDollars', () => {
      expect(() => buildDipLadderConfig('TQQQ', { spacingDollars: 0 })).toThrow(/spacingDollars/);
      expect(() => buildDipLadderConfig('TQQQ', { spacingDollars: -1 })).toThrow(/spacingDollars/);
    });

    it('rejects a non-positive takeProfitDollars, which would book a loss', () => {
      expect(() => buildDipLadderConfig('TQQQ', { takeProfitDollars: 0 })).toThrow(
        /takeProfitDollars/,
      );
      expect(() => buildDipLadderConfig('TQQQ', { takeProfitDollars: -1 })).toThrow(
        /takeProfitDollars/,
      );
    });

    it('rejects a fractional or non-positive fixedQuantity', () => {
      expect(() => buildDipLadderConfig('TQQQ', { fixedQuantity: 0 })).toThrow(/fixedQuantity/);
      expect(() => buildDipLadderConfig('TQQQ', { fixedQuantity: 50.5 })).toThrow(/fixedQuantity/);
      expect(() => buildDipLadderConfig('TQQQ', { fixedQuantity: -50 })).toThrow(/fixedQuantity/);
    });

    it('accepts the intended configuration', () => {
      expect(() => buildDipLadderConfig('TQQQ', FIXED_DOLLAR_CONFIG)).not.toThrow();
    });
  });
});
