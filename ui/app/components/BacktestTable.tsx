/**
 * Backtest run listing and per-run metrics (`stories.md:646`).
 *
 * Two presentation rules here are not cosmetic:
 *
 * 1. **A synthetic run is labelled everywhere it appears.** Naive 3x compounding
 *    excludes the expense ratio and financing costs real leveraged ETFs pay, so
 *    those results are optimistic in exactly the choppy regimes this strategy
 *    targets. A row that lost its label would be read as real history.
 * 2. **Drawdown is shown beside return, never instead of it.** A dip ladder with
 *    no stop-loss can post a good return and a drawdown no operator would have
 *    held through; showing return alone is how a backtest misleads.
 *
 * Server Components — pure presentation over props, no state, no handlers.
 */

import {
  formatCurrency,
  formatDuration,
  formatPercent,
  metricsByName,
  type BacktestResultRow,
  type BacktestRun,
} from '../lib/api';

export function BacktestTable({ runs }: { runs: BacktestRun[] }) {
  if (runs.length === 0) {
    return (
      <section
        aria-label="Backtest runs"
        className="rounded-lg border border-slate-800 bg-slate-900 p-6"
      >
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
          Backtest runs
        </h2>
        <p className="mt-2 text-sm text-slate-400">
          No backtests have been run yet. A backtest reads bars from the cache only, so the history
          must be backfilled first.
        </p>
        <pre className="mt-3 overflow-x-auto rounded bg-slate-950 p-3 text-xs text-slate-300">
          {`curl -X POST localhost:3000/backtest \\
  -H 'Content-Type: application/json' \\
  -d '{"symbol":"TQQQ","barSize":"1day",
       "from":"2022-01-01T00:00:00.000-05:00",
       "to":"2022-12-31T00:00:00.000-05:00"}'`}
        </pre>
      </section>
    );
  }

  return (
    <section aria-label="Backtest runs" className="rounded-lg border border-slate-800 bg-slate-900">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-800 px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
          Backtest runs
        </h2>
        <p className="text-xs text-slate-400">
          {runs.length} run{runs.length === 1 ? '' : 's'}
        </p>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">
                Symbol
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Bars
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Range
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Spacing
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Rungs
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Target
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Source
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {runs.map((run) => (
              <tr key={run.id} className="text-slate-200">
                <td className="px-4 py-2 font-medium">{run.symbol}</td>
                <td className="px-4 py-2 text-slate-400">{run.barSize}</td>
                <td className="whitespace-nowrap px-4 py-2 text-slate-400">
                  {run.rangeStart.slice(0, 10)} → {run.rangeEnd.slice(0, 10)}
                </td>
                <td className="px-4 py-2">{formatParameter(run.parameters.spacingPercent)}</td>
                <td className="px-4 py-2">{String(run.parameters.maxConcurrentRungs ?? '—')}</td>
                <td className="px-4 py-2">{formatParameter(run.parameters.takeProfitPercent)}</td>
                <td className="px-4 py-2">
                  {run.synthetic ? (
                    <span
                      className="rounded bg-amber-900/50 px-2 py-0.5 text-xs font-medium text-amber-200"
                      title="Synthesized 3x returns — excludes expense ratio and financing costs, so results are optimistic"
                    >
                      SYNTHETIC
                    </span>
                  ) : (
                    <span className="text-xs text-slate-500">real</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * The metrics for one run.
 *
 * Ordered by what a reader needs to judge a dip ladder: how deep the drawdown
 * went and how long it sat fully deployed come **before** the return, because
 * those are the figures that decide whether the return was survivable.
 */
export function BacktestMetrics({
  run,
  results,
}: {
  run: BacktestRun;
  results: BacktestResultRow[];
}) {
  const metrics = metricsByName(results);
  const value = (name: string): number | null => metrics[name]?.value ?? null;
  const drawdownDetail = metrics.maxDrawdownPercent?.detail as
    { at?: string; peak?: number; trough?: number } | undefined;
  const rungDistribution = metrics.rungDistribution?.detail as Record<string, number> | undefined;

  return (
    <section
      aria-label={`Backtest metrics for ${run.id}`}
      className="rounded-lg border border-slate-800 bg-slate-900"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-800 px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
          {run.symbol} · {run.rangeStart.slice(0, 10)} → {run.rangeEnd.slice(0, 10)}
        </h2>
        {run.synthetic && (
          <span className="rounded bg-amber-900/50 px-2 py-0.5 text-xs font-medium text-amber-200">
            SYNTHETIC — excludes expense ratio and financing costs
          </span>
        )}
      </header>

      <dl className="grid grid-cols-2 gap-px bg-slate-800 sm:grid-cols-3 lg:grid-cols-4">
        <Metric label="Max drawdown" value={formatPercent(value('maxDrawdownPercent'))} emphasis />
        <Metric
          label="Time at hard floor"
          value={formatPercent(value('timeAtHardFloorPercent'))}
          emphasis
        />
        <Metric label="Deepest rung count" value={formatCount(value('maxConcurrentLots'))} />
        <Metric label="Open lots at end" value={formatCount(value('openLotsAtEnd'))} />

        <Metric label="Total return" value={formatPercent(value('totalReturnPercent'))} />
        <Metric label="Annualized" value={formatPercent(value('annualizedReturnPercent'))} />
        <Metric label="Realized P&L" value={formatCurrency(value('totalRealizedPnl'))} />
        <Metric label="Unrealized at end" value={formatCurrency(value('finalUnrealizedPnl'))} />

        <Metric label="Completed cycles" value={formatCount(value('completedCycles'))} />
        <Metric label="Win rate" value={formatPercent(value('winRate'))} />
        <Metric
          label="Avg holding period"
          value={formatDuration(value('averageHoldingPeriodMs'))}
        />
        <Metric label="Time in position" value={formatPercent(value('timeInPositionPercent'))} />

        <Metric label="Commission" value={formatCurrency(value('totalCommission'))} />
        <Metric label="Bars processed" value={formatCount(value('barsProcessed'))} />
        <Metric label="Losing trades" value={formatCount(value('losingTrades'))} />
        <Metric
          label="Largest bar gap"
          value={formatDuration(value('barCoverage'))}
          // Surfaced because a hole in the history reads as a flat market and
          // would flatter the drawdown — the most dangerous way to be wrong.
          hint="A large gap means missing history, which understates drawdown"
        />
      </dl>

      {drawdownDetail?.at && (
        <p className="border-t border-slate-800 px-4 py-3 text-xs text-slate-400">
          Trough on {String(drawdownDetail.at).slice(0, 10)} ·{' '}
          {formatCurrency(drawdownDetail.peak ?? null)} →{' '}
          {formatCurrency(drawdownDetail.trough ?? null)}
        </p>
      )}

      {rungDistribution && Object.keys(rungDistribution).length > 0 && (
        <div className="border-t border-slate-800 px-4 py-3">
          <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Completed cycles per rung
          </h3>
          <ul className="mt-2 flex flex-wrap gap-2">
            {Object.entries(rungDistribution).map(([price, count]) => (
              <li
                key={price}
                className="rounded bg-slate-800 px-2 py-1 font-mono text-xs text-slate-200"
              >
                ${price} · {count}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Metric({
  label,
  value,
  emphasis,
  hint,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  hint?: string;
}) {
  return (
    <div className="bg-slate-900 px-4 py-3" title={hint}>
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd
        className={`mt-1 font-mono text-sm ${emphasis ? 'font-semibold text-amber-200' : 'text-slate-200'}`}
      >
        {value}
      </dd>
    </div>
  );
}

function formatCount(value: number | null): string {
  return value === null ? '—' : String(Math.round(value));
}

/** Renders a fractional parameter as a percentage, leaving others as-is. */
function formatParameter(value: unknown): string {
  if (typeof value !== 'number') {
    return '—';
  }

  return `${(value * 100).toFixed(1)}%`;
}
