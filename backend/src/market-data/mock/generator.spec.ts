import { isOnBarBoundary, isRegularSession, toEt } from '../session';
import { BarSize } from '../types';
import { generateBars, mulberry32, roundPrice, GeneratorOptions } from './generator';

const baseOptions: GeneratorOptions = {
  symbol: 'TQQQ',
  barSize: BarSize.FIVE_MIN,
  startDate: '2025-01-02',
  sessions: 2,
  startPrice: 80,
  seed: 42,
};

describe('mulberry32', () => {
  it('produces the same sequence for the same seed', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);

    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('produces a different sequence for a different seed', () => {
    expect(mulberry32(7)()).not.toEqual(mulberry32(8)());
  });

  it('stays within [0, 1)', () => {
    const rand = mulberry32(123);

    for (let i = 0; i < 500; i += 1) {
      const value = rand();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('generateBars', () => {
  it('is byte-identical for the same seed', () => {
    const first = generateBars(baseOptions);
    const second = generateBars(baseOptions);

    expect(JSON.stringify(first)).toEqual(JSON.stringify(second));
  });

  it('differs for a different seed', () => {
    const first = generateBars(baseOptions);
    const second = generateBars({ ...baseOptions, seed: 43 });

    expect(JSON.stringify(first)).not.toEqual(JSON.stringify(second));
  });

  it('emits 78 five-minute bars per session', () => {
    expect(generateBars({ ...baseOptions, sessions: 1 })).toHaveLength(78);
    expect(generateBars({ ...baseOptions, sessions: 2 })).toHaveLength(156);
  });

  it('emits one bar per session for daily bars', () => {
    const bars = generateBars({ ...baseOptions, barSize: BarSize.DAILY, sessions: 5 });

    expect(bars).toHaveLength(5);
  });

  it('places every 5-minute bar on a boundary inside the regular session', () => {
    for (const bar of generateBars(baseOptions)) {
      expect(isOnBarBoundary(bar.timestamp, BarSize.FIVE_MIN)).toBe(true);
      expect(isRegularSession(bar.timestamp)).toBe(true);
    }
  });

  it('emits bars in strictly increasing timestamp order', () => {
    const bars = generateBars({ ...baseOptions, sessions: 3 });

    for (let i = 1; i < bars.length; i += 1) {
      const prev = toEt(bars[i - 1].timestamp).toMillis();
      const curr = toEt(bars[i].timestamp).toMillis();
      expect(curr).toBeGreaterThan(prev);
    }
  });

  it('skips weekends', () => {
    // 2025-01-03 is a Friday; the next session must be Monday the 6th.
    const bars = generateBars({
      ...baseOptions,
      barSize: BarSize.DAILY,
      startDate: '2025-01-03',
      sessions: 2,
    });

    expect(toEt(bars[0].timestamp).toISODate()).toBe('2025-01-03');
    expect(toEt(bars[1].timestamp).toISODate()).toBe('2025-01-06');
  });

  it('produces internally consistent OHLC on every bar', () => {
    for (const bar of generateBars({ ...baseOptions, sessions: 3 })) {
      expect(bar.high).toBeGreaterThanOrEqual(Math.max(bar.open, bar.close));
      expect(bar.low).toBeLessThanOrEqual(Math.min(bar.open, bar.close));
      expect(bar.volume).toBeGreaterThan(0);
      expect(Number.isInteger(bar.volume)).toBe(true);
    }
  });

  it('rounds prices to cents', () => {
    for (const bar of generateBars(baseOptions)) {
      expect(bar.open).toBeCloseTo(roundPrice(bar.open), 10);
      expect(bar.close).toBeCloseTo(roundPrice(bar.close), 10);
    }
  });

  it('trends down under negative drift', () => {
    const bars = generateBars({
      ...baseOptions,
      barSize: BarSize.DAILY,
      sessions: 40,
      drift: -0.01,
      volatility: 0.001,
    });

    expect(bars[bars.length - 1].close).toBeLessThan(bars[0].open * 0.8);
  });

  it('keeps 5-minute bars on wall-clock boundaries across a DST transition', () => {
    // Starts the Friday before spring-forward and runs into the following week.
    const bars = generateBars({ ...baseOptions, startDate: '2025-03-07', sessions: 3 });

    for (const bar of bars) {
      expect(isOnBarBoundary(bar.timestamp, BarSize.FIVE_MIN)).toBe(true);
    }

    const offsets = new Set(bars.map((b) => toEt(b.timestamp).offset));
    // Spans both EST (-300) and EDT (-240), proving the transition was crossed.
    expect(offsets).toEqual(new Set([-300, -240]));
  });

  it('carries full precision between bars rather than compounding rounding', () => {
    // A long series with tiny drift would visibly diverge if each bar's open
    // were re-seeded from the previous rounded close.
    const bars = generateBars({
      ...baseOptions,
      barSize: BarSize.DAILY,
      sessions: 100,
      drift: 0.001,
      volatility: 0,
    });

    const expected = 80 * Math.pow(1.001, 100);
    expect(bars[bars.length - 1].close).toBeCloseTo(expected, 0);
  });

  it('roundPrice rounds to two decimals', () => {
    expect(roundPrice(80.005)).toBe(80.01);
    expect(roundPrice(80.004)).toBe(80.0);
  });
});
