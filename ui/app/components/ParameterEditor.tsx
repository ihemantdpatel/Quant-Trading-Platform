'use client';

/**
 * Live parameter editing (`PRD.md:386`).
 *
 * **Applies to future rungs only.** Every held lot's exit target is frozen at
 * the parameters in force when it filled; new values reach only rungs that hold
 * no lot, including re-armed ones, which pick up current parameters on their
 * next fire. Full recompute is not permitted.
 *
 * The rule is enforced in the backend, not here — held lots store their targets
 * and no endpoint can retarget a filled rung. What this component owes the
 * operator is that the rule is *visible*: the count of currently-held lots
 * whose targets will not move is shown next to the submit button, so the
 * consequence of the edit is stated before it is made rather than discovered
 * afterwards.
 *
 * `symbolCapital` is deliberately absent from this form. It is a Story 13 open
 * item (`PRD.md:500`) and the backend refuses it over HTTP.
 */

import { useState, useTransition } from 'react';
import { editParameters, type ActionResult } from '../actions';
import { formatPercent, type LadderParameters, type ParameterChange } from '../lib/api';

/**
 * Percentage-valued fields, rendered as percent and sent as fractions.
 *
 * `supersededBy` names the absolute field that overrides this one. When that
 * field holds a value the percentage is **inert** — the backend reads the
 * absolute one and ignores this — so the form marks it rather than displaying a
 * live-looking number that changes nothing when edited. Showing a stale 5%
 * next to a ladder actually running $1 rungs is the specific confusion this
 * avoids.
 */
const PERCENT_FIELDS = [
  {
    key: 'spacingPercent',
    label: 'Rung spacing',
    hint: 'Distance between rungs',
    supersededBy: 'spacingDollars',
    supersededWhen: (p: LadderParameters) => p.spacingMode === 'FIXED_DOLLAR',
  },
  {
    key: 'takeProfitPercent',
    label: 'Take profit',
    hint: "Each lot's own target, from its own fill",
    supersededBy: 'takeProfitDollars',
    supersededWhen: (p: LadderParameters) => p.takeProfitDollars !== null,
  },
  {
    key: 'sizePerRung',
    label: 'Size per rung',
    hint: 'Fraction of symbol capital',
    supersededBy: 'fixedQuantity',
    supersededWhen: (p: LadderParameters) => p.fixedQuantity !== null,
  },
  { key: 'hardFloorPercent', label: 'Hard floor', hint: 'Stops adding; never sells' },
] as const;

/**
 * Currency-valued fields, sent as-is rather than divided by 100.
 *
 * Separate from `NUMBER_FIELDS` only so they can carry a `$` prefix; the
 * submit path treats them identically.
 */
const DOLLAR_FIELDS = [
  {
    key: 'spacingDollars',
    label: 'Rung spacing ($)',
    step: 0.25,
    hint: 'Used when spacing mode is FIXED_DOLLAR',
  },
  {
    key: 'takeProfitDollars',
    label: 'Take profit ($)',
    step: 0.25,
    hint: 'Per lot, above its own fill. Blank = use %',
  },
] as const;

const NUMBER_FIELDS = [
  {
    key: 'maxConcurrentRungs',
    label: 'Max concurrent rungs',
    step: 1,
    hint: 'Rungs holding a lot',
  },
  {
    key: 'fixedQuantity',
    label: 'Fixed quantity',
    step: 1,
    hint: 'Shares per rung. Blank = size from capital',
  },
  { key: 'escalationFactor', label: 'Escalation factor', step: 0.05, hint: '1 = flat sizing' },
  { key: 'atrMultiple', label: 'ATR multiple', step: 0.1, hint: 'Used in ATR spacing mode' },
  { key: 'atrPeriod', label: 'ATR period', step: 1, hint: 'Daily bars' },
] as const;

/**
 * Fields the backend accepts as `null` to mean "unset, fall back to the
 * percentage rule". An empty input must therefore be sent as an explicit null
 * rather than skipped — skipping is how you *keep* a value, which would make
 * clearing the box impossible.
 */
const NULLABLE_FIELDS = new Set(['takeProfitDollars', 'fixedQuantity']);

export function ParameterEditor({
  strategyId,
  parameters,
  heldLotCount,
  changes,
}: {
  strategyId: string;
  parameters: LadderParameters;
  /** How many lots keep their existing targets through this edit. */
  heldLotCount: number;
  changes: ParameterChange[];
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [reason, setReason] = useState('');

  function submit(formData: FormData) {
    const payload: Record<string, number | string | null> = {};

    for (const field of PERCENT_FIELDS) {
      // A superseded field is not submitted at all. Sending it would write an
      // audit record for a value the engine does not read, implying a change
      // the operator did not get.
      if ('supersededWhen' in field && field.supersededWhen(parameters)) {
        continue;
      }

      const raw = formData.get(field.key);
      if (typeof raw === 'string' && raw !== '') {
        // Displayed as percent, stored as a fraction — matching
        // `DipLadderConfig`, where 0.05 means 5%.
        payload[field.key] = Number(raw) / 100;
      }
    }

    for (const { key } of [...DOLLAR_FIELDS, ...NUMBER_FIELDS]) {
      const raw = formData.get(key);

      if (typeof raw !== 'string') {
        continue;
      }

      if (raw === '') {
        // Empty means "unset" for a nullable field and "leave alone" for the
        // rest — a required field cannot be cleared, only changed.
        if (NULLABLE_FIELDS.has(key)) {
          payload[key] = null;
        }
        continue;
      }

      payload[key] = Number(raw);
    }

    const spacingMode = formData.get('spacingMode');
    if (typeof spacingMode === 'string') {
      payload.spacingMode = spacingMode;
    }

    const exitMode = formData.get('exitMode');
    if (typeof exitMode === 'string') {
      payload.exitMode = exitMode;
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
          Applies to future rungs only. Held lots keep the targets they filled with.
        </p>
      </header>

      <form action={submit} className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {PERCENT_FIELDS.map((field) => {
            const superseded = 'supersededWhen' in field && field.supersededWhen(parameters);

            return (
              <Field
                key={field.key}
                name={field.key}
                label={field.label}
                hint={
                  superseded
                    ? `Overridden by ${(field as { supersededBy: string }).supersededBy}`
                    : field.hint
                }
                suffix="%"
                step={0.1}
                defaultValue={round(parameters[field.key] * 100)}
                disabled={superseded}
              />
            );
          })}

          {DOLLAR_FIELDS.map((field) => (
            <Field
              key={field.key}
              name={field.key}
              label={field.label}
              hint={field.hint}
              prefix="$"
              step={field.step}
              defaultValue={parameters[field.key] ?? ''}
            />
          ))}

          {NUMBER_FIELDS.map((field) => (
            <Field
              key={field.key}
              name={field.key}
              label={field.label}
              hint={field.hint}
              step={field.step}
              defaultValue={parameters[field.key] ?? ''}
            />
          ))}

          <Select
            name="spacingMode"
            label="Spacing mode"
            hint="Percentage is the default"
            defaultValue={parameters.spacingMode}
            options={['PERCENTAGE', 'ATR', 'FIXED_DOLLAR']}
          />
          <Select
            name="exitMode"
            label="Exit mode"
            hint="Per-lot is the default"
            defaultValue={parameters.exitMode}
            options={['PER_LOT', 'AVERAGE_COST']}
          />
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
              {pending ? 'Applying…' : 'Apply to future rungs'}
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

      {changes.length > 0 && (
        <div className="border-t border-slate-800 px-4 py-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Change log (append-only)
          </h3>
          <ul className="mt-2 space-y-1 text-xs text-slate-400">
            {[...changes]
              .reverse()
              .slice(0, 8)
              .map((change) => (
                <li key={change.id} className="font-mono">
                  <span className="text-slate-300">{change.parameter}</span>{' '}
                  {formatValue(change.parameter, change.oldValue)} →{' '}
                  <span className="text-sky-300">
                    {formatValue(change.parameter, change.newValue)}
                  </span>{' '}
                  <span className="text-slate-600">{change.timestamp}</span>
                  {change.reason ? (
                    <span className="text-slate-500"> — {change.reason}</span>
                  ) : null}
                </li>
              ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Field({
  name,
  label,
  hint,
  defaultValue,
  step,
  suffix,
  prefix,
  disabled = false,
}: {
  name: string;
  label: string;
  hint: string;
  /** Empty string renders a blank input, which nullable fields read as "unset". */
  defaultValue: number | string;
  step: number;
  suffix?: string;
  prefix?: string;
  /** True when another parameter supersedes this one — see `PERCENT_FIELDS`. */
  disabled?: boolean;
}) {
  return (
    <label className={`block text-xs ${disabled ? 'text-slate-600' : 'text-slate-400'}`}>
      <span className={`font-medium ${disabled ? 'text-slate-500' : 'text-slate-300'}`}>
        {prefix ?? ''}
        {label}
        {suffix ? ` (${suffix})` : ''}
      </span>
      <input
        type="number"
        name={name}
        defaultValue={defaultValue}
        step={step}
        disabled={disabled}
        aria-label={label}
        data-testid={name}
        className={`mt-1 w-full rounded border px-2 py-1.5 font-mono text-sm ${
          disabled
            ? 'cursor-not-allowed border-slate-800 bg-slate-900 text-slate-500 line-through'
            : 'border-slate-700 bg-slate-950 text-slate-100'
        }`}
      />
      <span
        className={`mt-0.5 block text-[11px] ${disabled ? 'text-amber-600/70' : 'text-slate-600'}`}
      >
        {hint}
      </span>
    </label>
  );
}

function Select({
  name,
  label,
  hint,
  defaultValue,
  options,
}: {
  name: string;
  label: string;
  hint: string;
  defaultValue: string;
  options: string[];
}) {
  return (
    <label className="block text-xs text-slate-400">
      <span className="font-medium text-slate-300">{label}</span>
      <select
        name={name}
        defaultValue={defaultValue}
        aria-label={label}
        className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <span className="mt-0.5 block text-[11px] text-slate-600">{hint}</span>
    </label>
  );
}

function formatValue(parameter: string, value: string | number): string {
  if (typeof value === 'number' && parameter.endsWith('Percent')) {
    return formatPercent(value, 1);
  }

  return String(value);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
