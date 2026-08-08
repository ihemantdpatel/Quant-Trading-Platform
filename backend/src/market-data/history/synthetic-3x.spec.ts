/**
 * Synthetic 3x series (`stories.md:619`).
 *
 * The label is the point. Every test here exists because an unlabelled
 * synthetic bar reaching a backtest would overstate returns in exactly the
 * volatile regimes this strategy is designed for, and would do it invisibly.
 */

import { Bar, BarSize } from '../types';
import {
  TQQQ_INCEPTION,
  beforeInception,
  containsMixedProvenance,
  synthesizeLeveragedSeries,
} from './synthetic-3x';

function qqqBar(date: string, close: number): Bar {
  return {
    symbol: 'QQQ',
    barSize: BarSize.DAILY,
    timestamp: `${date}T00:00:00.000-05:00`,
    open: close,
    high: close,
    low: close,
    close,
    volume: 500_000,
  };
}

describe('synthesizeLeveragedSeries', () => {
  it('flags every bar synthetic so it cannot be mistaken for real history', () => {
    const series = synthesizeLeveragedSeries(
      [qqqBar('2008-01-02', 100), qqqBar('2008-01-03', 101)],
      { targetSymbol: 'TQQQ' },
    );

    expect(series).toHaveLength(2);
    expect(series.every((bar) => bar.synthetic === true)).toBe(true);
  });

  it('triples the daily return, not the price level', () => {
    const series = synthesizeLeveragedSeries(
      [qqqBar('2008-01-02', 100), qqqBar('2008-01-03', 110)],
      { targetSymbol: 'TQQQ', startPrice: 100 },
    );

    // +10% in the underlying → +30% leveraged. Tripling the *price* would give
    // 330 and would be meaningless.
    expect(series[0].close).toBe(100);
    expect(series[1].close).toBe(130);
  });

  it('compounds losses path-dependently — down 10% then up 10% does not return to par', () => {
    const series = synthesizeLeveragedSeries(
      [qqqBar('2008-01-02', 100), qqqBar('2008-01-03', 90), qqqBar('2008-01-04', 99)],
      { targetSymbol: 'TQQQ', startPrice: 100 },
    );

    // -30% → 70, then +30% → 91. The decay a leveraged ETF actually suffers in
    // chop, and the reason this series is worth generating at all.
    expect(series[1].close).toBe(70);
    expect(series[2].close).toBe(91);
  });

  it('labels the output with the target symbol', () => {
    const series = synthesizeLeveragedSeries([qqqBar('2008-01-02', 100)], {
      targetSymbol: 'TQQQ',
    });

    expect(series[0].symbol).toBe('TQQQ');
  });

  it('accepts a non-default leverage', () => {
    const series = synthesizeLeveragedSeries(
      [qqqBar('2008-01-02', 100), qqqBar('2008-01-03', 110)],
      { targetSymbol: 'QLD', leverage: 2, startPrice: 100 },
    );

    expect(series[1].close).toBe(120);
  });

  it('orders the output ascending regardless of input order', () => {
    const series = synthesizeLeveragedSeries(
      [qqqBar('2008-01-03', 110), qqqBar('2008-01-02', 100)],
      { targetSymbol: 'TQQQ' },
    );

    expect(series[0].timestamp < series[1].timestamp).toBe(true);
  });

  it('returns nothing for an empty source', () => {
    expect(synthesizeLeveragedSeries([], { targetSymbol: 'TQQQ' })).toEqual([]);
  });

  it('floors at a positive price rather than going negative on an extreme drop', () => {
    // A -40% day in the underlying implies -120% leveraged. A negative price is
    // arithmetically meaningless, and this approximation does not model the
    // circuit breakers that would intervene in reality.
    const series = synthesizeLeveragedSeries(
      [qqqBar('2008-01-02', 100), qqqBar('2008-01-03', 60)],
      { targetSymbol: 'TQQQ', startPrice: 100 },
    );

    expect(series[1].close).toBeGreaterThan(0);
  });

  it('carries the level forward when a previous close is zero', () => {
    const series = synthesizeLeveragedSeries([qqqBar('2008-01-02', 0), qqqBar('2008-01-03', 100)], {
      targetSymbol: 'TQQQ',
      startPrice: 100,
    });

    // No return is computable from a zero base; fabricating one would corrupt
    // the drawdown figures this series exists to produce.
    expect(series[1].close).toBe(100);
  });
});

describe('beforeInception', () => {
  it('excludes bars at or after TQQQ inception, so synthetic never overlaps real', () => {
    const bars = [
      qqqBar('2009-12-31', 100),
      qqqBar(TQQQ_INCEPTION, 100),
      qqqBar('2011-01-03', 100),
    ];

    const kept = beforeInception(bars);

    expect(kept).toHaveLength(1);
    expect(kept[0].timestamp.startsWith('2009-12-31')).toBe(true);
  });
});

describe('containsMixedProvenance', () => {
  it('detects a set holding both real and synthetic bars', () => {
    const real = qqqBar('2011-01-03', 100);
    const synthetic = { ...qqqBar('2008-01-02', 100), synthetic: true };

    expect(containsMixedProvenance([real, synthetic])).toBe(true);
  });

  it('is false for a uniformly real or uniformly synthetic set', () => {
    const real = qqqBar('2011-01-03', 100);
    const synthetic = { ...qqqBar('2008-01-02', 100), synthetic: true };

    expect(containsMixedProvenance([real])).toBe(false);
    expect(containsMixedProvenance([synthetic])).toBe(false);
    expect(containsMixedProvenance([])).toBe(false);
  });
});
