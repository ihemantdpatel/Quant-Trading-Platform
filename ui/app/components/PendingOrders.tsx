'use client';

/**
 * Pending-order check, placement, and duplicate resolution.
 *
 * **Rendered beside `ReconcileButton` and deliberately separate from it.**
 * Reconcile *repairs* — it releases rungs, restores state, and can halt a
 * symbol on the lot-sum assertion. These controls answer a narrower question:
 * do the orders resting at the broker match what the ladder thinks is resting?
 * Asking that must not change the answer, which is why the check is read-only
 * and the two actions that follow are separate, explicit steps.
 *
 * **The two acting buttons stay disabled until a check has run.** This is the
 * whole interaction design, not a convenience: placing orders against an
 * unexamined book is how duplicates get created, and cancelling one without
 * having seen which order the ladder depends on is how a working order gets
 * destroyed. The operator sees the findings first, and each button then names
 * exactly what it will do.
 *
 * A Client Component because the check's result drives what the rest of the
 * panel renders, and because both actions confirm before running.
 */

import { useState, useTransition } from 'react';
import {
  checkPendingOrders,
  placeMissingOrders,
  resolveDuplicateOrders,
  type ActionResult,
} from '../actions';
import type { OrderDiagnosis } from '../lib/api';

type Pending = 'check' | 'place' | 'duplicates' | null;

export function PendingOrders() {
  const [busy, startTransition] = useTransition();
  const [pending, setPending] = useState<Pending>(null);
  const [diagnosis, setDiagnosis] = useState<OrderDiagnosis | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [confirming, setConfirming] = useState<'place' | 'duplicates' | null>(null);

  function check() {
    setPending('check');
    setConfirming(null);
    startTransition(async () => {
      const outcome = await checkPendingOrders();
      setDiagnosis(outcome.diagnosis ?? null);
      setResult(outcome);
      setPending(null);
    });
  }

  function place() {
    setPending('place');
    setConfirming(null);
    startTransition(async () => {
      setResult(await placeMissingOrders());
      // The book has changed, so the findings on screen are now stale. Clearing
      // forces a fresh check before either action can be taken again — acting
      // twice on one diagnosis is how a duplicate gets placed.
      setDiagnosis(null);
      setPending(null);
    });
  }

  function resolve() {
    setPending('duplicates');
    setConfirming(null);
    startTransition(async () => {
      setResult(await resolveDuplicateOrders());
      setDiagnosis(null);
      setPending(null);
    });
  }

  const missing = diagnosis?.missing ?? [];
  const resolvable = (diagnosis?.duplicates ?? []).filter((group) => group.resolvable);
  const unresolvable = (diagnosis?.duplicates ?? []).filter((group) => !group.resolvable);

  return (
    <section
      aria-label="Pending orders"
      className="rounded-lg border border-slate-800 bg-slate-900 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
            Pending orders
          </h2>
          <p className="text-xs text-slate-400">
            Compares what rests at the broker with what the ladder expects. Checking changes
            nothing.
          </p>
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={check}
          className="rounded border border-slate-700 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-slate-800 disabled:opacity-50"
        >
          {pending === 'check' ? 'Checking…' : 'Check pending orders'}
        </button>
      </div>

      {diagnosis && diagnosis.brokerReachable && (
        <div className="mt-3 space-y-3">
          <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
            <Stat label="Matched" value={diagnosis.matched.length} tone="text-emerald-400" />
            <Stat label="Missing" value={missing.length} tone="text-amber-300" />
            <Stat label="Duplicates" value={diagnosis.duplicates.length} tone="text-red-400" />
            <Stat label="Unbacked" value={diagnosis.unbacked.length} tone="text-amber-300" />
            <Stat label="Orphans" value={diagnosis.orphans.length} tone="text-slate-300" />
          </dl>

          {missing.length > 0 && (
            <Finding title={`${missing.length} order(s) the ladder expects to be resting`}>
              <ul className="list-inside list-disc">
                {missing.map((order) => (
                  <li key={`${order.side}-${order.limitPrice}-${order.lotId ?? order.rungPrice}`}>
                    {order.side} {order.symbol} @ {order.limitPrice.toFixed(2)} — {order.reason}
                  </li>
                ))}
              </ul>
            </Finding>
          )}

          {resolvable.length > 0 && (
            <Finding title={`${resolvable.length} duplicate group(s) that can be resolved`}>
              <ul className="list-inside list-disc">
                {resolvable.map((group) => (
                  <li key={`${group.side}-${group.limitPrice}`}>
                    {group.side} {group.symbol} @ {group.limitPrice.toFixed(2)} — keeping{' '}
                    <code>{group.tracked[0]}</code>, cancelling{' '}
                    <code>{group.untracked.join(', ')}</code>
                  </li>
                ))}
              </ul>
            </Finding>
          )}

          {/*
            Reported separately from the resolvable groups, because the button
            will not touch these and an operator must not read the duplicate
            count as the number it is about to fix.
          */}
          {unresolvable.length > 0 && (
            <Finding
              title={`${unresolvable.length} duplicate group(s) that must be resolved in TWS`}
            >
              <ul className="list-inside list-disc">
                {unresolvable.map((group) => (
                  <li key={`${group.side}-${group.limitPrice}`}>
                    {group.side} {group.symbol} @ {group.limitPrice.toFixed(2)} —{' '}
                    {group.tracked.length === 0
                      ? 'the ladder tracks none of these, so which to keep cannot be determined'
                      : 'the ladder tracks more than one, so cancelling any would break a claim it holds'}
                  </li>
                ))}
              </ul>
            </Finding>
          )}

          {diagnosis.unbacked.length > 0 && (
            <Finding
              title={`${diagnosis.unbacked.length} level(s) blocked by an order that is gone`}
            >
              <p>
                The ladder holds a working-order id the broker does not list — a DAY order that
                expired, or one cancelled in TWS. Press <strong>Reconcile</strong> to release these;
                they are not re-placed from here.
              </p>
            </Finding>
          )}

          {diagnosis.orphans.length > 0 && (
            <Finding title={`${diagnosis.orphans.length} order(s) the ladder does not claim`}>
              <ul className="list-inside list-disc">
                {diagnosis.orphans.map((order) => (
                  <li key={order.clientOrderId}>
                    {order.side} {order.symbol} @ {order.limitPrice.toFixed(2)} —{' '}
                    <code>{order.clientOrderId}</code>
                  </li>
                ))}
              </ul>
              <p className="mt-1">
                Reported, never cancelled — one of these may have been placed by hand.
              </p>
            </Finding>
          )}

          {diagnosis.skippedSymbols.length > 0 && (
            <p className="text-xs text-slate-500">
              Skipped {diagnosis.skippedSymbols.join(', ')} — halted, so the ladder holds no live
              state to compare against.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy || missing.length === 0}
              onClick={() => setConfirming('place')}
              className="rounded bg-amber-600 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {pending === 'place' ? 'Placing…' : `Place ${missing.length} missing order(s)`}
            </button>

            <button
              type="button"
              disabled={busy || resolvable.length === 0}
              onClick={() => setConfirming('duplicates')}
              className="rounded bg-red-700 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {pending === 'duplicates'
                ? 'Cancelling…'
                : `Cancel ${resolvable.length} duplicate(s)`}
            </button>
          </div>

          {/*
            Each confirmation names the concrete consequence rather than asking
            "are you sure". These are the two controls on this dashboard that
            create and destroy real orders.
          */}
          {confirming === 'place' && (
            <Confirm
              tone="amber"
              body={`This submits ${missing.length} limit order(s) to the broker. Each one still passes the risk caps, the loss breaker, and the kill switch, and any order that would be marketable against the last close is refused rather than placed.`}
              onConfirm={place}
              onCancel={() => setConfirming(null)}
              label="Confirm placement"
              busy={busy}
            />
          )}

          {confirming === 'duplicates' && (
            <Confirm
              tone="red"
              body={`This cancels ${resolvable.reduce((n, g) => n + g.untracked.length, 0)} order(s) at the broker. The order the ladder depends on is kept in every group, and any group where that cannot be determined is left untouched.`}
              onConfirm={resolve}
              onCancel={() => setConfirming(null)}
              label="Confirm cancellation"
              busy={busy}
            />
          )}
        </div>
      )}

      {result && (
        <div
          role="status"
          className={`mt-3 text-xs ${result.ok ? 'text-emerald-400' : 'text-red-400'}`}
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

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded border border-slate-800 bg-slate-950 px-2 py-1.5">
      <dt className="text-[10px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={`text-sm font-semibold ${value > 0 ? tone : 'text-slate-600'}`}>{value}</dd>
    </div>
  );
}

function Finding({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-slate-800 bg-slate-950 p-2 text-xs text-slate-300">
      <p className="font-semibold text-slate-200">{title}</p>
      <div className="mt-1 text-slate-400">{children}</div>
    </div>
  );
}

function Confirm({
  tone,
  body,
  label,
  onConfirm,
  onCancel,
  busy,
}: {
  tone: 'amber' | 'red';
  body: string;
  label: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div
      className={`rounded border p-2 text-xs ${
        tone === 'red' ? 'border-red-800 text-red-300' : 'border-amber-800 text-amber-300'
      }`}
    >
      <p>{body}</p>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className={`rounded px-3 py-1.5 text-sm font-semibold text-white transition disabled:opacity-50 ${
            tone === 'red' ? 'bg-red-700 hover:bg-red-600' : 'bg-amber-600 hover:bg-amber-500'
          }`}
        >
          {label}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-slate-700 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-slate-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
