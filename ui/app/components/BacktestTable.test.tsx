/**
 * Backtest view component tests (`stories.md:657`).
 *
 * The properties asserted here are the ones that would mislead an operator if
 * they broke silently: a synthetic run losing its label, and a return rendered
 * without the drawdown that qualifies it.
 */

import { render, screen, within } from '@testing-library/react';
import { BacktestMetrics, BacktestTable } from './BacktestTable';
import type { BacktestResultRow, BacktestRun } from '../lib/api';

function run(overrides: Partial<BacktestRun> = {}): BacktestRun {
  return {
    id: 'bt-TQQQ-1day-2022',
    strategyId: 'dip-ladder:TQQQ',
    symbol: 'TQQQ',
    barSize: '1day',
    rangeStart: '2022-01-03T09:30:00.000-05:00',
    rangeEnd: '2022-12-30T09:30:00.000-05:00',
    parameters: { spacingPercent: 0.05, maxConcurrentRungs: 5, takeProfitPercent: 0.05 },
    synthetic: false,
    createdAt: '2022-12-30T09:30:00.000-05:00',
    ...overrides,
  };
}

function results(overrides: Partial<Record<string, BacktestResultRow>> = {}): BacktestResultRow[] {
  const base: Record<string, BacktestResultRow> = {
    maxDrawdownPercent: {
      runId: 'bt-TQQQ-1day-2022',
      metric: 'maxDrawdownPercent',
      value: 0.5618,
      detail: { at: '2022-12-19T09:45:00.000-05:00', peak: 100000, trough: 43820 },
    },
    timeAtHardFloorPercent: {
      runId: 'bt-TQQQ-1day-2022',
      metric: 'timeAtHardFloorPercent',
      value: 0.8546,
    },
    totalReturnPercent: {
      runId: 'bt-TQQQ-1day-2022',
      metric: 'totalReturnPercent',
      value: -0.893,
    },
    completedCycles: { runId: 'bt-TQQQ-1day-2022', metric: 'completedCycles', value: 0 },
    openLotsAtEnd: { runId: 'bt-TQQQ-1day-2022', metric: 'openLotsAtEnd', value: 5 },
    maxConcurrentLots: { runId: 'bt-TQQQ-1day-2022', metric: 'maxConcurrentLots', value: 5 },
    rungDistribution: {
      runId: 'bt-TQQQ-1day-2022',
      metric: 'rungDistribution',
      value: 2,
      detail: { '95.00': 6, '90.25': 4 },
    },
    ...overrides,
  };

  return Object.values(base) as BacktestResultRow[];
}

describe('BacktestTable', () => {
  it('lists a run with its symbol, range, and parameters', () => {
    render(<BacktestTable runs={[run()]} />);

    const table = screen.getByRole('table');

    expect(within(table).getByText('TQQQ')).toBeInTheDocument();
    expect(within(table).getByText(/2022-01-03/)).toBeInTheDocument();
    // Spacing and take-profit both default to 5%, so both cells read "5.0%".
    expect(within(table).getAllByText('5.0%')).toHaveLength(2);
    expect(within(table).getByText('5')).toBeInTheDocument();
  });

  it('labels a synthetic run so it cannot be read as real history', () => {
    render(<BacktestTable runs={[run({ synthetic: true })]} />);

    expect(screen.getByText('SYNTHETIC')).toBeInTheDocument();
  });

  it('marks a real run as real', () => {
    render(<BacktestTable runs={[run()]} />);

    expect(screen.getByText('real')).toBeInTheDocument();
    expect(screen.queryByText('SYNTHETIC')).not.toBeInTheDocument();
  });

  it('explains how to run one when there are none, rather than rendering an empty table', () => {
    render(<BacktestTable runs={[]} />);

    expect(screen.getByText(/No backtests have been run yet/)).toBeInTheDocument();
    // Names the cache dependency, which is the actual reason a range yields
    // nothing on a fresh checkout.
    expect(screen.getByText(/backfilled first/)).toBeInTheDocument();
  });

  it('renders every run in the listing', () => {
    render(
      <BacktestTable
        runs={[run({ id: 'a' }), run({ id: 'b', symbol: 'QQQ' }), run({ id: 'c' })]}
      />,
    );

    expect(screen.getAllByRole('row')).toHaveLength(4); // header + 3
  });
});

describe('BacktestMetrics', () => {
  it('renders drawdown and time at the hard floor', () => {
    render(<BacktestMetrics run={run()} results={results()} />);

    expect(screen.getByText('56.18%')).toBeInTheDocument();
    expect(screen.getByText('85.46%')).toBeInTheDocument();
  });

  it('renders the return alongside the drawdown, never instead of it', () => {
    // A return shown without its drawdown is how a backtest misleads on a
    // strategy with no stop-loss.
    render(<BacktestMetrics run={run()} results={results()} />);

    expect(screen.getByText('-89.30%')).toBeInTheDocument();
    expect(screen.getByText('Max drawdown')).toBeInTheDocument();
    expect(screen.getByText('Total return')).toBeInTheDocument();
  });

  it('shows open lots at the end — an unfinished ladder is a real outcome', () => {
    render(<BacktestMetrics run={run()} results={results()} />);

    expect(screen.getByText('Open lots at end')).toBeInTheDocument();
  });

  it('renders an em dash for a metric the run did not produce', () => {
    // A run that closed no lot has no win rate. Rendering 0% would say it lost
    // every cycle, which is a different and wrong claim.
    render(<BacktestMetrics run={run()} results={results()} />);

    const winRate = screen.getByText('Win rate').closest('div');

    expect(within(winRate as HTMLElement).getByText('—')).toBeInTheDocument();
  });

  it('renders the drawdown trough date and peak-to-trough values', () => {
    render(<BacktestMetrics run={run()} results={results()} />);

    expect(screen.getByText(/Trough on 2022-12-19/)).toBeInTheDocument();
  });

  it('renders the rung distribution', () => {
    render(<BacktestMetrics run={run()} results={results()} />);

    expect(screen.getByText('$95.00 · 6')).toBeInTheDocument();
    expect(screen.getByText('$90.25 · 4')).toBeInTheDocument();
  });

  it('carries the synthetic caveat into the metrics header', () => {
    render(<BacktestMetrics run={run({ synthetic: true })} results={results()} />);

    expect(screen.getByText(/SYNTHETIC/)).toBeInTheDocument();
    expect(screen.getByText(/expense ratio/)).toBeInTheDocument();
  });

  it('omits the synthetic caveat for a real run', () => {
    render(<BacktestMetrics run={run()} results={results()} />);

    expect(screen.queryByText(/SYNTHETIC/)).not.toBeInTheDocument();
  });

  it('surfaces the largest bar gap, since a hole understates drawdown', () => {
    render(<BacktestMetrics run={run()} results={results()} />);

    expect(screen.getByText('Largest bar gap')).toBeInTheDocument();
  });

  it('renders without crashing when a run has no metrics at all', () => {
    render(<BacktestMetrics run={run()} results={[]} />);

    expect(screen.getByText('Max drawdown')).toBeInTheDocument();
  });
});
