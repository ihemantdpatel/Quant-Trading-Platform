'use client';

/**
 * Route-level error boundary.
 *
 * `loadDashboard` already degrades to an error banner rather than throwing, so
 * this catches only genuinely unexpected render failures. It still names the
 * kill switch explicitly: if the dashboard itself is broken, the operator needs
 * to know the control is reachable another way rather than assuming the engine
 * is uncontrollable.
 */

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <div className="rounded-lg border border-red-800 bg-red-950/40 p-6">
        <h1 className="text-lg font-semibold text-red-200">The dashboard failed to render</h1>
        <p className="mt-2 font-mono text-sm text-red-300">{error.message}</p>
        <p className="mt-4 text-sm text-slate-300">
          The engine is unaffected by this — it runs in the backend process. The kill switch remains
          reachable directly:
        </p>
        <pre className="mt-2 overflow-x-auto rounded bg-slate-950 p-3 text-xs text-slate-300">
          {`curl -X POST localhost:3000/kill-switch \\
  -H 'Content-Type: application/json' \\
  -d '{"engaged":true,"reason":"dashboard down"}'`}
        </pre>
        <button
          type="button"
          onClick={reset}
          className="mt-4 rounded bg-slate-700 px-4 py-2 text-sm font-medium text-slate-100 hover:bg-slate-600"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
