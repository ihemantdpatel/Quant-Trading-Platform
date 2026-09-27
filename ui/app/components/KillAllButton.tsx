'use client';

/**
 * Engages the kill switch on every account at once — the one control that
 * crosses accounts, and only in the safe direction. It is in the root layout
 * so it is on screen on every route, including `/backtest`, which belongs to
 * no account and so has no per-account kill switch.
 *
 * Two clicks rather than one: it halts every account, and a stray click in a
 * header is easy. It never releases — resuming is per account.
 *
 * The outcome is shown per account, and an account that could not be halted
 * is listed as such. "I pressed kill all" must never read as "everything is
 * halted" while one daemon was unreachable and is still trading.
 */

import { useState, useTransition } from 'react';
import { killAllAccounts, type ActionResult, type KillAllOutcome } from '../actions';

export function KillAllButton() {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<(ActionResult & { outcomes: KillAllOutcome[] }) | null>(
    null,
  );

  function killAll() {
    setConfirming(false);
    startTransition(async () => setResult(await killAllAccounts()));
  }

  return (
    <div className="relative flex items-center gap-2">
      {confirming ? (
        <>
          <span className="text-xs text-red-300">Halt every account?</span>
          <button
            type="button"
            onClick={killAll}
            className="rounded bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-500"
          >
            Confirm kill all
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="rounded border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
          >
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => {
            setResult(null);
            setConfirming(true);
          }}
          disabled={pending}
          className="rounded border border-red-700 px-3 py-1.5 text-sm font-semibold text-red-300 hover:bg-red-950/60 disabled:opacity-50"
        >
          {pending ? 'Halting…' : 'Kill all accounts'}
        </button>
      )}

      {result && (
        <div
          role="status"
          className={`absolute right-0 top-full z-10 mt-2 w-80 rounded-lg border p-3 text-xs ${
            result.ok ? 'border-emerald-800 bg-slate-900' : 'border-red-700 bg-red-950/90'
          }`}
        >
          <p className={result.ok ? 'text-emerald-400' : 'font-semibold text-red-300'}>
            {result.message}
          </p>
          <ul className="mt-2 space-y-1">
            {result.outcomes.map((outcome) => (
              <li key={outcome.target} className={outcome.ok ? 'text-slate-300' : 'text-red-300'}>
                <span className="font-mono">{outcome.target}</span> — {outcome.message}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setResult(null)}
            className="mt-2 text-slate-400 underline hover:text-slate-200"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
