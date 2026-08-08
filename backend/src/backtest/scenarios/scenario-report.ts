/**
 * Scenario reporting.
 *
 * `PRD.md:472` is unusually specific about the form the 2022 result must take:
 * it "must be examined explicitly rather than averaged into a summary
 * statistic." A single return figure for 2010–present would bury the year the
 * strategy is most exposed to inside a decade that mostly went up.
 *
 * So a scenario report answers the four questions that actually matter for a
 * dip ladder in a severe drawdown, each of which a summary return hides:
 *
 * 1. **How far did the ladder extend?** Five rungs is the maximum; reaching it
 *    means every unit of allocated capital was deployed and nothing was left.
 * 2. **How long did it sit at the hard floor?** Time at the floor is time spent
 *    fully deployed and unable to add — the position is static and the operator
 *    is simply exposed.
 * 3. **Did any lot reach its target?** This is the one that separates 2020 from
 *    2022. Both fell hard; in one, lots recovered to their targets and the
 *    strategy worked as designed, and in the other they did not.
 * 4. **What was the worst mark-to-market?** Not the realized loss — the ladder
 *    realizes nothing on the way down, by design — but the drawdown actually
 *    lived through.
 */

import { BacktestRunResult } from '../replay-harness';
import { BacktestStatistics } from '../statistics';

export interface ScenarioReport {
  name: string;
  description: string;
  rangeStart: string;
  rangeEnd: string;
  /** True when the run used synthesized rather than IB-reported bars. */
  synthetic: boolean;
  /** Peak-to-trough fall of the underlying, as a positive fraction. */
  instrumentDeclinePercent: number;

  // The four questions.
  /** Deepest simultaneous rung count reached, against the configured limit. */
  ladderExtension: { reached: number; limit: number; fullyExtended: boolean };
  /** Fraction of bars spent at the concurrent-rung limit. */
  timeAtHardFloorPercent: number;
  /** Completed cycles, and whether any lot reached its target at all. */
  lotsReachingTarget: { completedCycles: number; anyReachedTarget: boolean };
  maxDrawdownPercent: number;

  // Supporting figures.
  totalReturnPercent: number;
  realizedPnl: number;
  finalUnrealizedPnl: number;
  openLotsAtEnd: number;
  timeInPositionPercent: number;
  rungDistribution: Record<string, number>;
  barsProcessed: number;
  /** Largest gap in the underlying bars — a hole would flatter the drawdown. */
  largestBarGapMs: number;
}

export function buildScenarioReport(params: {
  name: string;
  description: string;
  result: BacktestRunResult;
  statistics: BacktestStatistics;
  instrumentDeclinePercent: number;
  maxConcurrentRungs: number;
}): ScenarioReport {
  const { result, statistics } = params;

  return {
    name: params.name,
    description: params.description,
    rangeStart: result.rangeStart,
    rangeEnd: result.rangeEnd,
    synthetic: result.synthetic,
    instrumentDeclinePercent: round4(params.instrumentDeclinePercent),

    ladderExtension: {
      reached: statistics.maxConcurrentLots,
      limit: params.maxConcurrentRungs,
      fullyExtended: statistics.maxConcurrentLots >= params.maxConcurrentRungs,
    },
    timeAtHardFloorPercent: statistics.timeAtHardFloorPercent,
    lotsReachingTarget: {
      completedCycles: statistics.completedCycles,
      anyReachedTarget: statistics.completedCycles > 0,
    },
    maxDrawdownPercent: statistics.maxDrawdownPercent,

    totalReturnPercent: statistics.totalReturnPercent,
    realizedPnl: statistics.totalRealizedPnl,
    finalUnrealizedPnl: statistics.finalUnrealizedPnl,
    openLotsAtEnd: statistics.openLotsAtEnd,
    timeInPositionPercent: statistics.timeInPositionPercent,
    rungDistribution: statistics.rungDistribution,
    barsProcessed: result.barsProcessed,
    largestBarGapMs: result.coverage.largestGapMs,
  };
}

/**
 * Renders a report as text for a human to read.
 *
 * Printed by the scenario suite so the 2022 result appears in test output
 * rather than only inside assertions — "reported as its own result"
 * (`stories.md:665`) means an operator can read it, not merely that a test
 * checked it.
 */
export function formatScenarioReport(report: ScenarioReport): string {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const lines = [
    '',
    `━━━ ${report.name}${report.synthetic ? '  [SYNTHETIC — excludes expense ratio and financing costs]' : ''}`,
    `    ${report.description}`,
    `    Range: ${report.rangeStart.slice(0, 10)} → ${report.rangeEnd.slice(0, 10)} (${report.barsProcessed} bars)`,
    `    Instrument fell ${pct(report.instrumentDeclinePercent)} peak-to-trough`,
    '',
    `    Ladder extension .......... ${report.ladderExtension.reached}/${report.ladderExtension.limit} rungs${
      report.ladderExtension.fullyExtended ? '  (FULLY EXTENDED)' : ''
    }`,
    `    Time at hard floor ........ ${pct(report.timeAtHardFloorPercent)}`,
    `    Lots reaching target ...... ${report.lotsReachingTarget.completedCycles} completed cycle(s)${
      report.lotsReachingTarget.anyReachedTarget ? '' : '  (NONE REACHED TARGET)'
    }`,
    `    Max drawdown .............. ${pct(report.maxDrawdownPercent)}`,
    '',
    `    Total return .............. ${pct(report.totalReturnPercent)}`,
    `    Realized / unrealized ..... ${report.realizedPnl.toFixed(2)} / ${report.finalUnrealizedPnl.toFixed(2)}`,
    `    Open lots at end .......... ${report.openLotsAtEnd}`,
    `    Time in position .......... ${pct(report.timeInPositionPercent)}`,
    '',
  ];

  return lines.join('\n');
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
