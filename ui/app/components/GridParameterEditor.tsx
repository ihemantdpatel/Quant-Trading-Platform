'use client';

/**
 * Live editing for the grid strategy's parameters — the grid counterpart to
 * `ParameterEditor`, kept as its own component rather than a branch inside
 * that one: the two config shapes are disjoint (no spacing mode, no ATR, no
 * take-profit/exit-mode duality here), and a single component juggling both
 * would need as many conditionals as two small ones have lines.
 *
 * **Applies to future buy levels and future lots only.** A held lot's sell
 * target is frozen at the `gap` in force when it filled
 * (`GridLot.sellTarget`); a `gap` edit changes where the next dip-buy levels
 * sit and what a *newly opened* lot's target will be, never an existing
 * lot's. The backend enforces this — `EDITABLE_GRID_PARAMETERS` excludes
 * every lot/level field entirely — this component only has to say so.
 *
 * `symbol` and `entryBuffer` are deliberately absent from this form, mirroring
 * `ParameterEditor`'s exclusion of `symbolCapital`: retargeting which
 * instrument a live strategy trades while it holds lots would orphan every
 * one of them, and `entryBuffer` is a one-time fill-quality tweak rather than
 * a parameter tuned live.
 */

import { useState, useTransition } from 'react';
import { editParameters, type ActionResult } from '../actions';
import type { GridParameters, ParameterChange, RiskLimitChange } from '../lib/api';
import { Field, ParameterChangeLog } from './ParameterFields';
import { RiskLimitEditor } from './RiskLimitEditor';

const NUMBER_FIELDS = [
  {
    key: 'quantity',
    label: 'Quantity',
    step: 1,
    hint: 'Shares per order — entries and exits alike',
  },
  {
    key: 'maxBuyLevels',
    label: 'Max buy levels',
    step: 1,
    hint: 'Stepped dip-buy levels maintained',
  },
  {
    key: 'maxSellOrders',
    label: 'Max sell orders',
    step: 1,
    hint: 'Concurrent resting sells; oldest lots (FIFO) get them',
  },
] as const;

export function GridParameterEditor({
  strategyId,
  parameters,
  heldLotCount,
  changes,
  symbol,
  riskLimit,
  riskLimitChanges,
}: {
  strategyId: string;
  parameters: GridParameters;
  /** How many lots keep their existing sell targets through this edit. */
  heldLotCount: number;
  changes: ParameterChange[];
  /** The symbol this grid instance trades — governs the risk-limit section below. */
  symbol?: string | null;
  /** Current `RiskConfig.perSymbolLimits[symbol]`. Null means unconstrained. */
  riskLimit?: number | null;
  riskLimitChanges?: RiskLimitChange[];
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [reason, setReason] = useState('');

  function submit(formData: FormData) {
    const payload: Record<string, number> = {};

    for (const { key } of NUMBER_FIELDS) {
      const raw = formData.get(key);
      if (typeof raw === 'string' && raw !== '') {
        payload[key] = Number(raw);
      }
    }

    const gap = formData.get('gap');
    if (typeof gap === 'string' && gap !== '') {
      payload.gap = Number(gap);
    }

    startTransition(async () => {
      setResult(await editParameters(strategyId, payload, reason));
      setReason('');
    });
  }

  return (
    <section
      aria-label="Parameter editor"
      className="rounded-lg border border-slate-800 bg-slate-900"
    >
      <header className="border-b border-slate-800 px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
          Parameters — {strategyId}
        </h2>
        <p className="mt-1 text-xs text-amber-400">
          Applies to future buy levels and future lots only. Held lots keep the sell targets they
          filled with.
        </p>
      </header>

      <form action={submit} className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field
            name="gap"
            label="Gap ($)"
            hint="Distance between dip-buy levels, and above a lot's own fill"
            prefix="$"
            step={0.25}
            defaultValue={parameters.gap}
          />

          {NUMBER_FIELDS.map((field) => (
            <Field
              key={field.key}
              name={field.key}
              label={field.label}
              hint={field.hint}
              step={field.step}
              defaultValue={parameters[field.key]}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-end justify-between gap-3 border-t border-slate-800 pt-3">
          <label className="flex-1 text-xs text-slate-400">
            Reason (recorded with the change)
            <input
              type="text"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="why this change"
              className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 placeholder:text-slate-600"
            />
          </label>

          <div className="flex items-center gap-3">
            <p className="text-xs text-slate-400" data-testid="frozen-lot-notice">
              {heldLotCount} held lot{heldLotCount === 1 ? '' : 's'} keep
              {heldLotCount === 1 ? 's' : ''} existing targets
            </p>
            <button
              type="submit"
              disabled={pending}
              className="rounded bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:opacity-50"
            >
              {pending ? 'Applying…' : 'Apply to future levels'}
            </button>
          </div>
        </div>

        {result && (
          <div
            role="status"
            className={`rounded border p-2 text-xs ${
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
      </form>

      <RiskLimitEditor symbol={symbol} riskLimit={riskLimit} riskLimitChanges={riskLimitChanges} />

      <ParameterChangeLog changes={changes} />
    </section>
  );
}
