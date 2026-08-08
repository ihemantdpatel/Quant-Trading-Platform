/**
 * The backtest view (`stories.md:657`).
 *
 * A Server Component, per the repo's conventions: it fetches on the server and
 * passes plain data down. Nothing here is interactive — a backtest is started
 * over HTTP or from a script, and this page reports what those produced.
 *
 * **Running a backtest is deliberately not a button.** A sweep is CPU-bound and
 * can take minutes on the same process that serves this dashboard during a live
 * session; a button inviting an operator to start one mid-session would make the
 * control surface unresponsive exactly when it matters. The `curl` is shown
 * instead, which is also the form that belongs in a runbook.
 */

import { BacktestMetrics, BacktestTable } from '../components/BacktestTable';
import { loadBacktestRun, loadBacktests } from '../lib/api';

/** Always fresh — this reports persisted engine state. */
export const dynamic = 'force-dynamic';

export default async function BacktestPage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string }>;
}) {
  const { run: selectedId } = await searchParams;
  const listing = await loadBacktests();

  // The most recent run when none is named — the one an operator just produced.
  const runId = selectedId ?? listing.runs[0]?.id;
  const detail = runId ? await loadBacktestRun(runId) : null;

  return (
    <main className="flex flex-col gap-4">
      <p className="text-xs text-slate-500">
        The same strategy and risk code, against cached history through a simulated broker
      </p>

      {listing.error && (
        <div
          role="alert"
          className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-200"
        >
          Could not load backtests: {listing.error}
        </div>
      )}

      {/*
        Stated on the page rather than only in the docs. A reader looking at a
        return figure needs to know these results never reflect a decision the
        live engine made, and that adopting a parameter set is a separate,
        deliberate act (Story 13).
      */}
      <p className="rounded-lg border border-slate-800 bg-slate-900 px-4 py-3 text-xs text-slate-400">
        Backtests read bars from the cache only and never contact a broker. Results describe what a
        parameter set <em>would</em> have done — changing the strategy&apos;s live parameters is a
        separate, explicit decision.
      </p>

      {detail && <BacktestMetrics run={detail.run} results={detail.results} />}

      <BacktestTable runs={listing.runs} />
    </main>
  );
}
