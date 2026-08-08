'use client';

/**
 * Execution mode switch (`PRD.md:383`).
 *
 * **A switch to `PAPER`/`LIVE` is blocked with the reason shown**
 * (`stories.md:445`). The block is the backend's — the same startup assertion
 * that refuses to boot those modes while per-symbol capital or the daily loss
 * threshold is unset (`PRD.md:500`). This component does not re-implement that
 * check; it posts the request and renders whatever failures come back.
 *
 * That direction matters. A client-side guard could be bypassed and could drift
 * from the real rule; deferring to the backend means the UI cannot permit what
 * boot would refuse, and the operator sees the *specific* missing value rather
 * than a generic "not allowed".
 */

import { useState, useTransition } from 'react';
import { setMode, type ActionResult } from '../actions';
import type { ExecutionMode } from '../lib/api';

const MODES: ExecutionMode[] = ['SHADOW', 'PAPER', 'LIVE'];

const MODE_STYLE: Record<ExecutionMode, string> = {
  SHADOW: 'text-amber-400',
  PAPER: 'text-sky-400',
  LIVE: 'text-red-400',
};

export function ModeSwitch({ mode }: { mode: ExecutionMode }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  function request(next: ExecutionMode) {
    startTransition(async () => {
      setResult(await setMode(next));
    });
  }

  return (
    <section
      aria-label="Execution mode"
      className="rounded-lg border border-slate-800 bg-slate-900 p-4"
    >
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
        Execution mode
      </h2>
      <p className={`font-mono text-lg font-bold ${MODE_STYLE[mode]}`} data-testid="current-mode">
        {mode}
      </p>
      <p className="text-xs text-slate-400">
        {mode === 'SHADOW'
          ? 'Intents are logged with full order payloads. Nothing is submitted.'
          : 'Orders are submitted to the broker.'}
      </p>

      <div className="mt-3 flex gap-2">
        {MODES.map((candidate) => (
          <button
            key={candidate}
            type="button"
            onClick={() => request(candidate)}
            disabled={pending || candidate === mode}
            className={`rounded border px-3 py-1.5 text-sm font-medium transition disabled:opacity-40 ${
              candidate === mode
                ? 'border-slate-600 bg-slate-800 text-slate-200'
                : 'border-slate-700 text-slate-300 hover:border-slate-500 hover:bg-slate-800'
            }`}
          >
            {candidate}
          </button>
        ))}
      </div>

      {result && (
        <div
          role="status"
          className={`mt-3 rounded border p-2 text-xs ${
            result.ok
              ? 'border-emerald-800 bg-emerald-950/40 text-emerald-300'
              : 'border-red-800 bg-red-950/40 text-red-300'
          }`}
        >
          <p className="font-medium">{result.message}</p>
          {result.failures && result.failures.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {result.failures.map((failure) => (
                <li key={failure}>{failure}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
