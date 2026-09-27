'use client';

/**
 * Error boundary for one account's pages.
 *
 * Sits *inside* the account layout, so a page that throws is replaced while the
 * account's kill switch above it stays on screen — the property the root
 * boundary cannot give, since it replaces everything below the root layout.
 * Still names the direct route, in case the shell itself is what broke.
 */

export default function AccountError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="rounded-lg border border-red-800 bg-red-950/40 p-6">
      <h1 className="text-lg font-semibold text-red-200">This page failed to render</h1>
      <p className="mt-2 font-mono text-sm text-red-300">{error.message}</p>
      <p className="mt-4 text-sm text-slate-300">
        The engine is unaffected — it runs in this account&apos;s backend process. Use the kill
        switch above, or reach that backend directly:
      </p>
      <pre className="mt-2 overflow-x-auto rounded bg-slate-950 p-3 text-xs text-slate-300">
        {`curl -X POST <account backend>/kill-switch \\
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
    </main>
  );
}
