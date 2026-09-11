/**
 * Small presentational pieces shared by every strategy's parameter editor
 * (`ParameterEditor`, `GridParameterEditor`) and `RiskLimitEditor` — pulled
 * out so each editor stays focused on its own field list rather than
 * re-declaring the same input/select/change-log markup.
 */

import { formatPercent, type ParameterChange } from '../lib/api';

export function Field({
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
  /** True when another parameter supersedes this one. */
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

export function Select({
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

/** A value as it belongs in the change log — percent fields render as `%`. */
function formatChangeValue(parameter: string, value: string | number): string {
  if (typeof value === 'number' && parameter.endsWith('Percent')) {
    return formatPercent(value, 1);
  }

  return String(value);
}

/**
 * The append-only parameter change log, shared by every strategy's editor —
 * the underlying table is not strategy-specific (`ParameterChange.parameter`
 * is a plain string precisely so this list can hold either strategy's field
 * names).
 */
export function ParameterChangeLog({ changes }: { changes: ParameterChange[] }) {
  if (changes.length === 0) {
    return null;
  }

  return (
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
              {formatChangeValue(change.parameter, change.oldValue)} →{' '}
              <span className="text-sky-300">
                {formatChangeValue(change.parameter, change.newValue)}
              </span>{' '}
              <span className="text-slate-600">{change.timestamp}</span>
              {change.reason ? <span className="text-slate-500"> — {change.reason}</span> : null}
            </li>
          ))}
      </ul>
    </div>
  );
}
