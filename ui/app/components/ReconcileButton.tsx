'use client';

/**
 * Manual reconciliation against the broker.
 *
 * **Why an operator needs this at all.** The engine releases a rung by itself
 * when IB reports its order cancelled, rejected, or expired — but that status
 * can only be attributed to a rung for orders the *running* process placed,
 * because the id map it depends on is in memory. Cancel an order in TWS after
 * a restart and the ladder keeps showing a `WORKING` rung with no order behind
 * it, blocking that level. Reconciliation is what repairs that, and it used to
 * run only at boot.
 *
 * **Rendered in the header rather than in `EngineControls`**, which is hidden
 * whenever the bound broker is IB — the opposite of what is wanted here. This
 * control is least useful against fixtures and most useful against a live
 * Gateway, so it must not share that gate.
 *
 * A Client Component for the confirmation step. Confirmation is not ceremony:
 * this runs the *full* startup sequence, so it re-runs the lot-sum assertion
 * and can halt a symbol — a real consequence for an operator who expected a
 * harmless refresh. Naming that in the prompt is the point of the step.
 */

import { useState, useTransition } from 'react';
import { reconcileNow, type ActionResult } from '../actions';
import type { OrderReconciliationReport } from '../lib/api';

export function ReconcileButton({
  lastRun = null,
}: {
  /** The scheduled post-close job's last run, when it has fired. */
  lastRun?: OrderReconciliationReport | null;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [confirming, setConfirming] = useState(false);

  function run() {
    setConfirming(false);
    startTransition(async () => setResult(await reconcileNow()));
  }

  return (
    <section
      aria-label="Reconcile with broker"
      className="rounded-lg border border-slate-800 bg-slate-900 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
            Reconcile
          </h2>
          <p className="text-xs text-slate-400">
            Re-checks lots and resting orders against the broker. Use after cancelling an order
            outside this system.
          </p>
        </div>

        {confirming ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={run}
              className="rounded bg-amber-600 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-amber-500 disabled:opacity-50"
            >
              {pending ? 'Reconciling…' : 'Confirm reconcile'}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded border border-slate-700 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-slate-800"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={pending}
            onClick={() => setConfirming(true)}
            className="rounded border border-slate-700 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-slate-800 disabled:opacity-50"
          >
            {pending ? 'Reconciling…' : 'Reconcile now'}
          </button>
        )}
      </div>

      {/*
        Stated before the operator commits, not after. A symbol whose lots
        disagree with the broker's position halts as a result of this run, and
        discovering that from a red banner afterwards would read as the button
        having broken something.
      */}
      {confirming && (
        <p className="mt-2 text-xs text-amber-300">
          This re-runs the full startup check. A symbol whose lots disagree with the broker will be
          halted and will stop trading until you release it. No order is placed or cancelled, and no
          position is closed.
        </p>
      )}

      {/*
        The scheduled job's last run. Shown because "no news" is ambiguous
        otherwise: an operator cannot tell a job that ran and found nothing
        from one that never fired at all.
      */}
      {lastRun && (
        <p className="mt-2 text-xs text-slate-500">
          Post-close job last ran {lastRun.ranAt}
          {lastRun.brokerReachable
            ? ` — ${lastRun.ordersUpdated} order row(s) corrected.`
            : ' — the broker could not be reached, so the ledger was left unchanged.'}
        </p>
      )}

      {result && (
        <div
          role="status"
          className={`mt-2 text-xs ${result.ok ? 'text-emerald-400' : 'text-red-400'}`}
        >
          <p>{result.message}</p>
          {result.failures && result.failures.length > 0 && (
            <ul className="mt-1 list-inside list-disc">
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
