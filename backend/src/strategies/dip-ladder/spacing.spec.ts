import { Bar, BarSize } from '../../market-data/types';
import { buildDipLadderConfig, SpacingMode } from './config';
import { computeAtr, nextRungPrice, resolveSpacing, trueRange } from './spacing';

function dailyBar(close: number, high: number, low: number, day: number): Bar {
  return {
    symbol: 'TQQQ',
    barSize: BarSize.DAILY,
    timestamp: `2025-01-${String(day).padStart(2, '0')}T09:30:00.000-05:00`,
    open: close,
    high,
    low,
    close,
    volume: 1_000_000,
  };
}

/** `count` daily bars each with a true range of exactly 2.00 and a flat close. */
function flatRangeBars(count: number, range: number): Bar[] {
  return Array.from({ length: count }, (_, i) =>
    dailyBar(100, 100 + range / 2, 100 - range / 2, i + 1),
  );
}

describe('spacing', () => {
  describe('percentage mode', () => {
    it('places the rung one spacing unit below the anchor', () => {
      const config = buildDipLadderConfig('TQQQ');

      // 5% of 100.00 = 5.00 → rung at 95.00.
      expect(nextRungPrice(100, config)).toBe(95);
    });

    it('is proportional, so absolute gaps shrink as price falls', () => {
      const config = buildDipLadderConfig('TQQQ');

      expect(nextRungPrice(95, config)).toBe(90.25);
      expect(nextRungPrice(90.25, config)).toBe(85.74);
    });

    it('honours a non-default spacing percentage', () => {
      const config = buildDipLadderConfig('TQQQ', { spacingPercent: 0.1 });

      expect(nextRungPrice(100, config)).toBe(90);
    });

    it('rounds the rung price to cents', () => {
      const config = buildDipLadderConfig('TQQQ', { spacingPercent: 0.033 });

      // 87.41 * 0.033 = 2.88453 → 2.88; 87.41 - 2.88 = 84.53
      expect(nextRungPrice(87.41, config)).toBe(84.53);
    });
  });

  describe('trueRange', () => {
    it('is the bar range when there is no previous close', () => {
      expect(trueRange(dailyBar(100, 102, 99, 1), null)).toBeCloseTo(3);
    });

    it('accounts for a gap above the previous close', () => {
      // Bar 104-103 is only 1 wide, but it gapped up from a 100 close.
      expect(trueRange(dailyBar(103, 104, 103, 1), 100)).toBeCloseTo(4);
    });

    it('accounts for a gap below the previous close', () => {
      // The gap-down case that matters on TQQQ: a narrow bar far below.
      expect(trueRange(dailyBar(95, 96, 95, 1), 100)).toBeCloseTo(5);
    });
  });

  describe('computeAtr', () => {
    it('averages true range over the window', () => {
      // Every bar has range 2 and an unchanged close, so ATR is exactly 2.
      expect(computeAtr(flatRangeBars(20, 2), 14)).toBeCloseTo(2);
    });

    it('needs period + 1 bars so the first true range is gap-aware', () => {
      expect(computeAtr(flatRangeBars(14, 2), 14)).toBeNull();
      expect(computeAtr(flatRangeBars(15, 2), 14)).toBeCloseTo(2);
    });

    it('uses only the most recent window, so history depth does not change it', () => {
      const short = flatRangeBars(15, 2);
      const long = [...flatRangeBars(40, 6), ...flatRangeBars(15, 2)];

      // The long series has a wildly different early regime; a smoothed ATR
      // would still carry it. A flat window must not.
      expect(computeAtr(long, 14)).toBeCloseTo(computeAtr(short, 14)!);
    });

    it('returns null on empty history', () => {
      expect(computeAtr([], 14)).toBeNull();
    });
  });

  describe('ATR mode', () => {
    const atrConfig = buildDipLadderConfig('TQQQ', { spacingMode: SpacingMode.ATR });

    it('spaces rungs by the ATR multiple', () => {
      const result = resolveSpacing(100, atrConfig, flatRangeBars(20, 2));

      expect(result.mode).toBe(SpacingMode.ATR);
      expect(result.fellBack).toBe(false);
      expect(result.distance).toBeCloseTo(2);
      expect(nextRungPrice(100, atrConfig, flatRangeBars(20, 2))).toBe(98);
    });

    it('applies a non-default multiple', () => {
      const config = buildDipLadderConfig('TQQQ', {
        spacingMode: SpacingMode.ATR,
        atrMultiple: 2.5,
      });

      expect(nextRungPrice(100, config, flatRangeBars(20, 2))).toBe(95);
    });

    it('is absolute, so the gap does not shrink as price falls', () => {
      const bars = flatRangeBars(20, 2);

      expect(nextRungPrice(100, atrConfig, bars)).toBe(98);
      expect(nextRungPrice(50, atrConfig, bars)).toBe(48);
    });

    it('falls back to percentage spacing on insufficient history, and reports it', () => {
      const result = resolveSpacing(100, atrConfig, flatRangeBars(5, 2));

      expect(result.mode).toBe(SpacingMode.PERCENTAGE);
      expect(result.fellBack).toBe(true);
      expect(result.distance).toBe(5);
      expect(nextRungPrice(100, atrConfig, flatRangeBars(5, 2))).toBe(95);
    });

    it('falls back when history is present but produces a zero ATR', () => {
      // Bars with no range at all — a halted or synthetic series.
      const flat = Array.from({ length: 20 }, (_, i) => dailyBar(100, 100, 100, i + 1));
      const result = resolveSpacing(100, atrConfig, flat);

      expect(result.fellBack).toBe(true);
      expect(result.distance).toBe(5);
    });

    it('falls back when no daily bars are supplied at all', () => {
      expect(resolveSpacing(100, atrConfig).fellBack).toBe(true);
    });
  });

  it('clamps a rung at zero rather than emitting a negative price', () => {
    const config = buildDipLadderConfig('TQQQ', {
      spacingMode: SpacingMode.ATR,
      atrMultiple: 10,
    });
    // ATR 2 × 10 = 20 spacing against a 5.00 anchor.
    const bars = flatRangeBars(20, 2);

    expect(nextRungPrice(5, config, bars)).toBe(0);
  });
});
