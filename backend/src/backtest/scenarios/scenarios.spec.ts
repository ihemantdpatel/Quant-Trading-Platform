/**
 * The drawdown scenarios — **2022 examined explicitly** (`stories.md:665`).
 *
 * Each scenario runs the real strategy and risk code over a severe decline and
 * reports what the ladder did, rather than folding the year into a summary
 * statistic. The reports print to test output on purpose: `PRD.md:472` requires
 * the 2022 result be *examined*, and a number only an assertion ever sees has
 * not been examined by anyone.
 *
 * The assertions here are about **ladder behaviour**, which the shape of a
 * decline determines: how far the ladder extends, how long it sits at the
 * floor, whether lots reach their targets, and — most importantly — that
 * nothing ever books a loss. Those hold for any decline of this magnitude and
 * are what these fixtures are qualified to prove. The specific *figures* an
 * operator would act on must come from real cached history; see
 * `real-history.spec.ts`.
 */

import { BarSize } from '../../market-data/types';
import { runBacktest } from '../replay-harness';
import { computeStatistics } from '../statistics';
import { DEFAULT_DIP_LADDER_CONFIG } from '../../strategies/dip-ladder/config';
import {
  buildDrawdownBars,
  DrawdownShape,
  peakToTrough,
  sessionCount,
  SYNTHETIC_3X_2000,
  TQQQ_2020,
  TQQQ_2022,
} from './drawdown-fixtures';
import { buildScenarioReport, formatScenarioReport, ScenarioReport } from './scenario-report';

const CAPITAL = 100_000;
const RUNG_LIMIT = DEFAULT_DIP_LADDER_CONFIG.maxConcurrentRungs;

async function runScenario(shape: DrawdownShape, description: string) {
  const bars = buildDrawdownBars(shape);

  const result = await runBacktest({
    symbol: shape.symbol,
    barSize: BarSize.DAILY,
    bars,
    symbolCapital: CAPITAL,
    accountEquity: CAPITAL,
  });

  const statistics = computeStatistics({
    closedTrades: result.closedTrades,
    equityCurve: result.equityCurve,
    openLotsAtEnd: result.openLots.length,
    commissionPaid: result.commissionPaid,
    startingEquity: CAPITAL,
    maxConcurrentRungs: RUNG_LIMIT,
  });

  const report = buildScenarioReport({
    name: shape.name,
    description,
    result,
    statistics,
    instrumentDeclinePercent: peakToTrough(bars),
    maxConcurrentRungs: RUNG_LIMIT,
  });

  return { bars, result, statistics, report };
}

describe('scenario: 2022 — TQQQ ~-80% (the headline scenario)', () => {
  let report: ScenarioReport;
  let scenario: Awaited<ReturnType<typeof runScenario>>;

  beforeAll(async () => {
    scenario = await runScenario(
      TQQQ_2022,
      'The year this configuration is most exposed to: a 3x ETF down ~80%, ' +
        'averaged down, with no stop-loss underneath.',
    );
    report = scenario.report;

    // Printed so the result is readable, not merely asserted (`PRD.md:472`).
    process.stdout.write(formatScenarioReport(report));
  }, 120_000);

  it('covers a full trading year', () => {
    expect(sessionCount(scenario.bars)).toBeGreaterThan(240);
    expect(report.rangeStart.slice(0, 4)).toBe('2022');
  });

  it('falls roughly 80% peak to trough, as 2022 did', () => {
    expect(report.instrumentDeclinePercent).toBeGreaterThan(0.75);
    expect(report.instrumentDeclinePercent).toBeLessThan(0.9);
  });

  it('extends the ladder fully to the rung limit', () => {
    expect(report.ladderExtension.fullyExtended).toBe(true);
    expect(report.ladderExtension.reached).toBe(RUNG_LIMIT);
  });

  it('spends most of the year at the hard floor, fully deployed and unable to add', () => {
    expect(report.timeAtHardFloorPercent).toBeGreaterThan(0.5);
  });

  it('leaves lots open at year end — they never reached their targets', () => {
    // The finding the scenario exists to surface: in a decline that does not
    // recover, a per-lot take-profit ladder simply holds. This is by design —
    // there is no stop — but it must be seen rather than averaged away.
    expect(report.lotsReachingTarget.anyReachedTarget).toBe(false);
    expect(report.openLotsAtEnd).toBe(RUNG_LIMIT);
  });

  it('carries a deep mark-to-market drawdown', () => {
    expect(report.maxDrawdownPercent).toBeGreaterThan(0.4);
  });

  it('**never books a loss** — no lot exits below its entry', () => {
    // The single most important assertion in this file. The hard floor stops
    // adding; it never sells (`PRD.md:167`).
    for (const trade of scenario.result.closedTrades) {
      expect(trade.exitPrice).toBeGreaterThan(trade.entryPrice);
    }
  });

  it('**never liquidates** — every share bought is still held at the end', () => {
    const bought = scenario.result.fills
      .filter((fill) => fill.side === 'BUY')
      .reduce((sum, fill) => sum + fill.quantity, 0);
    const sold = scenario.result.fills
      .filter((fill) => fill.side === 'SELL')
      .reduce((sum, fill) => sum + fill.quantity, 0);

    expect(sold).toBe(0);
    expect(bought).toBeGreaterThan(0);
  });

  it('stops adding at the floor rather than averaging down indefinitely', () => {
    expect(scenario.statistics.maxConcurrentLots).toBeLessThanOrEqual(RUNG_LIMIT);
  });

  it('reports over contiguous bars, so the drawdown is not flattered by a gap', () => {
    // A hole in the data would read as a flat market and understate the fall.
    const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;

    expect(report.largestBarGapMs).toBeLessThan(FIVE_DAYS_MS);
  });

  it('is not synthetic — 2022 is within TQQQ’s real history', () => {
    expect(report.synthetic).toBe(false);
  });
});

describe('scenario: 2020 — TQQQ ~-70% with recovery', () => {
  let report: ScenarioReport;
  let scenario: Awaited<ReturnType<typeof runScenario>>;

  beforeAll(async () => {
    scenario = await runScenario(
      TQQQ_2020,
      'The COVID crash and its recovery — the contrast case to 2022: ' +
        'a fall just as severe, from which lots did reach their targets.',
    );
    report = scenario.report;
    process.stdout.write(formatScenarioReport(report));
  }, 120_000);

  it('falls roughly 70% peak to trough', () => {
    expect(report.instrumentDeclinePercent).toBeGreaterThan(0.6);
  });

  it('extends the ladder fully', () => {
    expect(report.ladderExtension.fullyExtended).toBe(true);
  });

  it('completes lot cycles once price recovers — the contrast with 2022', () => {
    // Same magnitude of fall, opposite outcome for the strategy, because the
    // recovery let lots reach their own targets. This pair is the argument for
    // reporting scenarios individually rather than averaging them.
    expect(report.lotsReachingTarget.anyReachedTarget).toBe(true);
    expect(report.lotsReachingTarget.completedCycles).toBeGreaterThan(0);
  });

  it('exits only in profit, even through a 70% fall', () => {
    for (const trade of scenario.result.closedTrades) {
      expect(trade.exitPrice).toBeGreaterThan(trade.entryPrice);
    }
  });

  it('books no loss on the way down', () => {
    expect(scenario.statistics.losingTrades).toBe(0);
  });
});

describe('scenario: synthetic 3x QQQ across 2000', () => {
  let report: ScenarioReport;
  let scenario: Awaited<ReturnType<typeof runScenario>>;

  beforeAll(async () => {
    scenario = await runScenario(
      SYNTHETIC_3X_2000,
      'The dot-com collapse, evaluated on synthesized 3x QQQ returns because ' +
        'TQQQ did not exist before February 2010.',
    );
    report = scenario.report;
    process.stdout.write(formatScenarioReport(report));
  }, 120_000);

  it('is labelled synthetic on the report', () => {
    expect(report.synthetic).toBe(true);
  });

  it('flags every bar synthetic, so it cannot be silently mixed with real bars', () => {
    expect(scenario.bars.every((bar) => bar.synthetic === true)).toBe(true);
  });

  it('renders the synthetic caveat in the formatted output', () => {
    // The caveat must travel with the numbers: naive 3x compounding excludes
    // the expense ratio and financing costs, so these results are optimistic.
    expect(formatScenarioReport(report)).toContain('SYNTHETIC');
    expect(formatScenarioReport(report)).toContain('expense ratio');
  });

  it('extends the ladder fully through a collapse of this depth', () => {
    expect(report.ladderExtension.fullyExtended).toBe(true);
  });

  it('books no loss even across a 90%+ decline', () => {
    expect(scenario.statistics.losingTrades).toBe(0);
    expect(scenario.result.fills.filter((fill) => fill.side === 'SELL').length).toBe(0);
  });
});

describe('drawdown fixtures', () => {
  it('are deterministic — the same shape yields identical bars', () => {
    expect(buildDrawdownBars(TQQQ_2022)).toEqual(buildDrawdownBars(TQQQ_2022));
  });

  it('emit an anchor bar and a body bar per session', () => {
    const bars = buildDrawdownBars(TQQQ_2020);

    expect(bars).toHaveLength(sessionCount(bars) * 2);
    expect(bars[0].timestamp).toContain('09:30');
    expect(bars[1].timestamp).toContain('09:45');
  });

  it('give the anchor bar no range of its own, so one day cannot fire twice', () => {
    const [anchor] = buildDrawdownBars(TQQQ_2020);

    expect(anchor.high).toBe(anchor.open);
    expect(anchor.low).toBe(anchor.open);
  });

  it('land each leg on its stated endpoint despite shock days', () => {
    // The shock correction exists so adding capitulation days changes the
    // decline's *distribution* without changing its magnitude.
    const bars = buildDrawdownBars(TQQQ_2022);
    const last = bars[bars.length - 1];

    expect(last.close).toBeGreaterThan(12);
    expect(last.close).toBeLessThan(20);
  });

  it('produce internally consistent OHLC bars', () => {
    for (const bar of buildDrawdownBars(TQQQ_2022)) {
      expect(bar.high).toBeGreaterThanOrEqual(Math.max(bar.open, bar.close));
      expect(bar.low).toBeLessThanOrEqual(Math.min(bar.open, bar.close));
      expect(bar.low).toBeGreaterThan(0);
    }
  });

  it('skip weekends', () => {
    for (const bar of buildDrawdownBars(TQQQ_2020)) {
      const day = new Date(bar.timestamp).getUTCDay();

      expect(day).not.toBe(0);
      expect(day).not.toBe(6);
    }
  });
});
