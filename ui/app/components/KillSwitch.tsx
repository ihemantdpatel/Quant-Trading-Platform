'use client';

/**
 * The global kill switch — **always visible** (`PRD.md:383`).
 *
 * Rendered in the dashboard shell, so it is present on every route rather than
 * living inside a panel that could be scrolled past or collapsed. It is the one
 * control an operator reaches for when something is wrong, and hunting for it
 * is not acceptable at that moment.
 *
 * A Client Component because it owns pending state and a confirmation step.
 * The mutation itself is the `setKillSwitch` Server Action.
 *
 * **The live price is centred in this box** rather than sitting in the page
 * header, because this is the one panel guaranteed to be on screen on every
 * route — the same reason the kill switch itself is here. An operator deciding
 * whether to engage it is reading the price at that moment, so the number and
 * the control belong in one glance. It is passed in as a prop, so this
 * component still owns no fetching of its own.
 */

import { useState, useTransition } from 'react';
import { setKillSwitch, type ActionResult } from '../actions';
import { LivePrice } from './LivePrice';
import type { LastPrice } from '../lib/api';

export function KillSwitch({
  engaged,
  reason,
  changedAt,
  symbol = 'TQQQ',
  lastPrice = null,
}: {
  engaged: boolean;
  reason: string | null;
  changedAt: string | null;
  /** Instrument label for the centred price. */
  symbol?: string;
  /** The feed's last bar, or null when nothing has arrived. */
  lastPrice?: LastPrice | null;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [note, setNote] = useState('');

  function toggle() {
    startTransition(async () => {
      setResult(await setKillSwitch(!engaged, note));
      setNote('');
    });
  }

  return (
    <section
      aria-label="Global kill switch"
      className={`rounded-lg border p-4 ${
        engaged ? 'border-red-500 bg-red-950/40' : 'border-slate-700 bg-slate-900'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
            Kill Switch
          </h2>
          <p
            className={`font-mono text-lg font-bold ${engaged ? 'text-red-400' : 'text-emerald-400'}`}
            data-testid="kill-switch-state"
          >
            {engaged ? 'ENGAGED' : 'ARMED'}
          </p>
          <p className="text-xs text-slate-400">
            {engaged
              ? 'All new order submission is halted.'
              : 'Submission permitted by this control.'}
          </p>
        </div>

        {/*
          Centred between the status and the controls. `order` keeps it in the
          middle on a wide row but drops it below on a narrow one, where a
          three-way split would squeeze the price into an unreadable column.
        */}
        <div className="order-last w-full text-center sm:order-none sm:w-auto sm:flex-1">
          <LivePrice symbol={symbol} last={lastPrice} />
        </div>

        <div className="flex items-center gap-2">
          <input
            type="text"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="reason (optional)"
            aria-label="Kill switch reason"
            className="w-44 rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 placeholder:text-slate-600"
          />
          <button
            type="button"
            onClick={toggle}
            disabled={pending}
            className={`rounded px-4 py-2 text-sm font-semibold transition disabled:opacity-50 ${
              engaged
                ? 'bg-slate-700 text-slate-100 hover:bg-slate-600'
                : 'bg-red-600 text-white hover:bg-red-500'
            }`}
          >
            {pending ? 'Working…' : engaged ? 'Release' : 'Engage kill switch'}
          </button>
        </div>
      </div>

      {(reason || changedAt) && (
        <p className="mt-2 border-t border-slate-800 pt-2 text-xs text-slate-500">
          Last change: {reason ?? 'no reason recorded'}
          {changedAt ? ` — ${changedAt}` : ''}
        </p>
      )}

      {result && (
        <p
          role="status"
          className={`mt-2 text-xs ${result.ok ? 'text-emerald-400' : 'text-red-400'}`}
        >
          {result.message}
        </p>
      )}
    </section>
  );
}
