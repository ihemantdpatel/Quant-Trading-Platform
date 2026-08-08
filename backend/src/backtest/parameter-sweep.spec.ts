import { loadFixture } from '../market-data/mock/fixtures';
import { BarSize } from '../market-data/types';
import { expandGrid, rank, runParameterSweep, SweepEntry, SweepRanking } from './parameter-sweep';
import { BacktestStatistics } from './statistics';
import { DEFAULT_DIP_LADDER_CONFIG } from '../strategies/dip-ladder/config';

const SYMBOL = 'TQQQ';
const CAPITAL = 100_000;

function entry(overrides: Partial<BacktestStatistics>): SweepEntry {
  return {
    combination: { spacingPercent: 0.05, maxConcurrentRungs: 5, takeProfitPercent: 0.05 },
    result: {} as SweepEntry['result'],
    statistics: {
      totalReturnPercent: 0,
      maxDrawdownPercent: 0,
      completedCycles: 0,
      ...overrides,
    } as BacktestStatistics,
  };
}

describe('expandGrid', () => {
  it('produces the full cartesian product', () => {
    const combinations = expandGrid({
      spacingPercent: [0.04, 0.05],
      maxConcurrentRungs: [3, 5],
      takeProfitPercent: [0.05, 0.07],
    });

    expect(combinations).toHaveLength(8);
  });

  it('holds an omitted axis at its shipped default', () => {
    const combinations = expandGrid({ spacingPercent: [0.04, 0.06] });

    expect(combinations).toHaveLength(2);
    expect(
      combinations.every(
        (c) => c.maxConcurrentRungs === DEFAULT_DIP_LADDER_CONFIG.maxConcurrentRungs,
      ),
    ).toBe(true);
    expect(
      combinations.every(
        (c) => c.takeProfitPercent === DEFAULT_DIP_LADDER_CONFIG.takeProfitPercent,
      ),
    ).toBe(true);
  });

  it('treats an empty axis as omitted rather than producing no combinations', () => {
    expect(expandGrid({ spacingPercent: [] })).toHaveLength(1);
  });

  it('is a single default combination for an empty grid', () => {
    const [only] = expandGrid({});

    expect(only.spacingPercent).toBe(DEFAULT_DIP_LADDER_CONFIG.spacingPercent);
  });

  it('de-duplicates and sorts each axis so ordering does not depend on the caller', () => {
    const a = expandGrid({ spacingPercent: [0.06, 0.04, 0.06] });
    const b = expandGrid({ spacingPercent: [0.04, 0.06] });

    expect(a).toEqual(b);
    expect(a.map((c) => c.spacingPercent)).toEqual([0.04, 0.06]);
  });
});

describe('rank', () => {
  it('orders by return per unit of drawdown by default', () => {
    // 0.2/0.1 = 2.0 beats 0.5/0.5 = 1.0, despite the lower raw return.
    const entries = [
      entry({ totalReturnPercent: 0.5, maxDrawdownPercent: 0.5 }),
      entry({ totalReturnPercent: 0.2, maxDrawdownPercent: 0.1 }),
    ];

    const ranked = rank(entries, SweepRanking.RETURN_PER_DRAWDOWN);

    expect(ranked[0].statistics.totalReturnPercent).toBe(0.2);
  });

  it('orders by raw total return when asked', () => {
    const entries = [
      entry({ totalReturnPercent: 0.2, maxDrawdownPercent: 0.1 }),
      entry({ totalReturnPercent: 0.5, maxDrawdownPercent: 0.5 }),
    ];

    expect(rank(entries, SweepRanking.TOTAL_RETURN)[0].statistics.totalReturnPercent).toBe(0.5);
  });

  it('orders max drawdown ascending — shallower is better', () => {
    const entries = [entry({ maxDrawdownPercent: 0.8 }), entry({ maxDrawdownPercent: 0.2 })];

    expect(rank(entries, SweepRanking.MAX_DRAWDOWN)[0].statistics.maxDrawdownPercent).toBe(0.2);
  });

  it('orders by completed cycles when asked', () => {
    const entries = [entry({ completedCycles: 2 }), entry({ completedCycles: 9 })];

    expect(rank(entries, SweepRanking.COMPLETED_CYCLES)[0].statistics.completedCycles).toBe(9);
  });

  it('ranks a zero-drawdown run by its return rather than an infinite score', () => {
    const entries = [
      entry({ totalReturnPercent: 0.05, maxDrawdownPercent: 0 }),
      entry({ totalReturnPercent: 0.9, maxDrawdownPercent: 0.3 }),
    ];

    const ranked = rank(entries, SweepRanking.RETURN_PER_DRAWDOWN);

    // 0.9/0.3 = 3.0 beats a zero-drawdown run scored at its return of 0.05.
    expect(ranked[0].statistics.totalReturnPercent).toBe(0.9);
  });
});

describe('runParameterSweep', () => {
  it('runs one backtest per combination', async () => {
    const report = await runParameterSweep({
      symbol: SYMBOL,
      barSize: BarSize.FIVE_MIN,
      bars: loadFixture('chop-range').bars,
      symbolCapital: CAPITAL,
      accountEquity: CAPITAL,
      grid: { spacingPercent: [0.04, 0.05], takeProfitPercent: [0.05, 0.06] },
    });

    expect(report.combinationsRun).toBe(4);
    expect(report.entries).toHaveLength(4);
  }, 120_000);

  it('gives each combination its own statistics', async () => {
    const report = await runParameterSweep({
      symbol: SYMBOL,
      barSize: BarSize.FIVE_MIN,
      bars: loadFixture('chop-range').bars,
      symbolCapital: CAPITAL,
      accountEquity: CAPITAL,
      grid: { spacingPercent: [0.03, 0.08] },
    });

    // Different spacing puts rungs at different prices, so the two runs cannot
    // produce the same cycle count — if they did, the parameter was not applied.
    const cycles = report.entries.map((e) => e.statistics.completedCycles);

    expect(new Set(cycles).size).toBeGreaterThan(1);
  }, 120_000);

  it('carries each combination through to its result, so results stay attributable', async () => {
    const report = await runParameterSweep({
      symbol: SYMBOL,
      barSize: BarSize.FIVE_MIN,
      bars: loadFixture('chop-range').bars,
      symbolCapital: CAPITAL,
      accountEquity: CAPITAL,
      grid: { maxConcurrentRungs: [2, 4] },
    });

    expect(report.entries.map((e) => e.combination.maxConcurrentRungs).sort()).toEqual([2, 4]);
  }, 120_000);

  it('does not leak state between combinations', async () => {
    // The same combination run twice within one grid must produce the same
    // result; a shared coordinator would give the second one the first's lots.
    const report = await runParameterSweep({
      symbol: SYMBOL,
      barSize: BarSize.FIVE_MIN,
      bars: loadFixture('chop-range').bars,
      symbolCapital: CAPITAL,
      accountEquity: CAPITAL,
      grid: { spacingPercent: [0.05] },
    });

    const second = await runParameterSweep({
      symbol: SYMBOL,
      barSize: BarSize.FIVE_MIN,
      bars: loadFixture('chop-range').bars,
      symbolCapital: CAPITAL,
      accountEquity: CAPITAL,
      grid: { spacingPercent: [0.05] },
    });

    expect(second.entries[0].statistics).toEqual(report.entries[0].statistics);
  }, 120_000);

  it('selects nothing — the full grid is returned for a human to judge', async () => {
    const report = await runParameterSweep({
      symbol: SYMBOL,
      barSize: BarSize.FIVE_MIN,
      bars: loadFixture('chop-range').bars,
      symbolCapital: CAPITAL,
      accountEquity: CAPITAL,
      grid: { spacingPercent: [0.04, 0.05, 0.06] },
    });

    // No "best" flag anywhere: Story 11 must not change strategy defaults.
    expect(report.entries).toHaveLength(3);
    expect(report).not.toHaveProperty('best');
    expect(report.entries[0]).not.toHaveProperty('selected');
  }, 180_000);
});
