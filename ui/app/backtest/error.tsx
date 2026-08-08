'use client';

/**
 * Error boundary for the backtest route.
 *
 * Scoped to this segment so a failure rendering backtest results cannot take
 * down the dashboard — the operator's live control surface, including the kill
 * switch, is on a different route and must stay reachable.
 */

import Link from 'next/link';

export default function BacktestError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <div className="rounded-lg border border-red-800 bg-red-950/40 p-6">
        <h1 className="text-lg font-semibold text-red-200">Backtest results failed to render</h1>
        <p className="mt-2 font-mono text-sm text-red-300">{error.message}</p>
        <p className="mt-4 text-sm text-slate-300">
          Backtests are reports over stored data — nothing about the running engine is affected.
        </p>
        <div className="mt-4 flex gap-3">
          <button
            type="button"
            onClick={reset}
            className="rounded bg-slate-700 px-4 py-2 text-sm font-medium text-slate-100 hover:bg-slate-600"
          >
            Try again
          </button>
          <Link
            href="/"
            className="rounded bg-slate-800 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700"
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
