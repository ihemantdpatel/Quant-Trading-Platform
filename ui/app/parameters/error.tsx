'use client';

/**
 * Error boundary for the parameters route.
 *
 * Scoped to this segment so a failure rendering the editor cannot take down the
 * dashboard — the ladder and the activity log are on a different route, and the
 * kill switch is in the layout above this boundary, so both stay reachable.
 *
 * A render failure here changes nothing about the running engine: parameters
 * are read over HTTP and edited by an explicit POST, so a page that failed to
 * render has not altered anything.
 */

import Link from 'next/link';

export default function ParametersError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <div className="rounded-lg border border-red-800 bg-red-950/40 p-6">
        <h1 className="text-lg font-semibold text-red-200">Parameter editor failed to render</h1>
        <p className="mt-2 font-mono text-sm text-red-300">{error.message}</p>
        <p className="mt-4 text-sm text-slate-300">
          No parameter was changed — edits happen only on an explicit submit. The running engine is
          unaffected and keeps using its current values.
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
            Back to execution
          </Link>
        </div>
      </div>
    </main>
  );
}
