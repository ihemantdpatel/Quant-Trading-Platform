'use client';

/**
 * The risk layer's per-symbol capital ceiling (`RiskConfig.perSymbolLimits`,
 * `capital-cap.ts`) — extracted out of `ParameterEditor` so both it and
 * `GridParameterEditor` render the identical control rather than duplicating
 * it. This is deliberately a **separate** edit from either strategy's own
 * parameters: the ceiling bounds capital deployed across *every* strategy
 * trading a symbol, not one strategy's geometry, so it posts to its own
 * endpoint via its own action.
 */

import { useState, useTransition } from 'react';
import { editRiskLimit, type ActionResult } from '../actions';
import type { RiskLimitChange } from '../lib/api';
import { Field } from './ParameterFields';

export function RiskLimitEditor({
  symbol,
  riskLimit,
  riskLimitChanges,
}: {
  /** The symbol this governs. Absent hides the whole section. */
  symbol?: string | null;
  /** Current `RiskConfig.perSymbolLimits[symbol]`. Null means unconstrained. */
  riskLimit?: number | null;
  riskLimitChanges?: RiskLimitChange[];
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [reason, setReason] = useState('');

  function submit(formData: FormData) {
    if (!symbol) {
      return;
    }

    const raw = formData.get('riskLimit');
    const limit = typeof raw === 'string' ? Number(raw) : NaN;

    startTransition(async () => {
      setResult(await editRiskLimit(symbol, limit, reason));
      setReason('');
    });
  }

  if (!symbol) {
    return null;
  }

  return (
    <div className="border-t border-slate-800 p-4">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
        Risk limit — {symbol}
      </h3>
      <p className="mt-1 text-xs text-slate-500">
        The risk layer&apos;s per-symbol capital ceiling (<code>RiskConfig.perSymbolLimits</code>).
        A separate control from the strategy parameters above: this bounds capital deployed across
        every strategy trading {symbol}, not one strategy&apos;s own geometry. A rejected BUY names
        this limit when it is the binding one.
      </p>

      <form action={submit} className="mt-3 flex flex-wrap items-end gap-3">
        <Field
          name="riskLimit"
          label="Per-symbol limit"
          hint={
            riskLimit === null || riskLimit === undefined
              ? 'Currently unconstrained'
              : 'Currently deployed capital, at cost, is capped here'
          }
          prefix="$"
          step={1000}
          defaultValue={riskLimit ?? ''}
        />

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

        <button
          type="submit"
          disabled={pending}
          className="rounded bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:opacity-50"
        >
          {pending ? 'Applying…' : 'Update limit'}
        </button>
      </form>

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
        </div>
      )}

      {riskLimitChanges && riskLimitChanges.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-slate-400">
          {[...riskLimitChanges]
            .reverse()
            .slice(0, 8)
            .map((change) => (
              <li key={change.id} className="font-mono">
                {change.oldValue ?? '(unconstrained)'} →{' '}
                <span className="text-sky-300">{change.newValue}</span>{' '}
                <span className="text-slate-600">{change.timestamp}</span>
                {change.reason ? <span className="text-slate-500"> — {change.reason}</span> : null}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
