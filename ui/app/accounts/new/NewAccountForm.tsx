'use client';

/**
 * The form that creates an account. Validation is the backend's
 * (`POST /accounts`): it alone knows which aliases and IB ids are taken, and
 * duplicating the rules here would let the two disagree on a control that
 * starts a trading process.
 */

import { useState, useTransition } from 'react';
import { createAccount, type ActionResult } from '../../actions';

/**
 * The symbol the dip ladder trades (`DIP_LADDER_SYMBOL`). An allocation for it
 * is mandatory — without one the daemon's startup assertion refuses to boot.
 */
const LADDER_SYMBOL = 'TQQQ';

const inputClass =
  'mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 placeholder:text-slate-600';

function TextField({
  name,
  label,
  hint,
  placeholder,
  required = false,
  type = 'text',
  step,
}: {
  name: string;
  label: string;
  hint: string;
  placeholder?: string;
  required?: boolean;
  type?: 'text' | 'number';
  step?: number;
}) {
  return (
    <label className="block text-xs text-slate-400">
      <span className="font-medium text-slate-300">{label}</span>
      <input
        name={name}
        type={type}
        step={step}
        min={type === 'number' ? 0 : undefined}
        required={required}
        placeholder={placeholder}
        aria-label={label}
        className={`${inputClass} ${type === 'number' ? 'font-mono' : ''}`}
      />
      <span className="mt-0.5 block text-[11px] text-slate-600">{hint}</span>
    </label>
  );
}

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function amount(formData: FormData, name: string): number {
  const raw = text(formData, name);
  return raw === '' ? NaN : Number(raw);
}

export function NewAccountForm() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [mode, setMode] = useState('PAPER');

  function submit(formData: FormData) {
    startTransition(async () => {
      setResult(
        await createAccount({
          alias: text(formData, 'alias'),
          label: text(formData, 'label'),
          mode: text(formData, 'mode'),
          ibAccountId: text(formData, 'ibAccountId'),
          equity: amount(formData, 'equity'),
          symbolCapital: { [LADDER_SYMBOL]: amount(formData, 'symbolCapital') },
          dailyLossThreshold: amount(formData, 'dailyLossThreshold'),
          dailyLossBasis: text(formData, 'dailyLossBasis'),
          reason: text(formData, 'reason'),
        }),
      );
    });
  }

  return (
    <form action={submit} className="space-y-4" aria-label="Create account">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="alias"
          label="Alias"
          required
          placeholder="second"
          hint="Lower-case letters, digits, hyphens. Owns every row this account writes; cannot change later."
        />
        <TextField
          name="label"
          label="Label"
          required
          placeholder="Second paper account"
          hint="Shown in the account switcher."
        />
        <TextField
          name="ibAccountId"
          label="IB account id"
          placeholder="DU1234567"
          hint="The broker account (DU… paper / U… live). Must be managed by the Gateway login every account shares."
        />
        <label className="block text-xs text-slate-400">
          <span className="font-medium text-slate-300">Mode</span>
          <select
            name="mode"
            aria-label="Mode"
            value={mode}
            onChange={(event) => setMode(event.target.value)}
            className={inputClass}
          >
            <option value="PAPER">PAPER</option>
            <option value="LIVE">LIVE</option>
          </select>
          <span className="mt-0.5 block text-[11px] text-slate-600">
            The account&apos;s only permitted mode.
          </span>
        </label>
      </div>

      {mode === 'LIVE' && (
        <p
          role="note"
          className="rounded border border-amber-800 bg-amber-950/40 p-2 text-xs text-amber-200"
        >
          LIVE is recorded as this account&apos;s mode, but the startup assertions still refuse to
          boot LIVE until Story 15 enables it. The daemon will not trade — it will refuse to start
          and be retried by the supervisor.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          name="equity"
          label="Equity (USD)"
          type="number"
          step={1000}
          required
          hint="The 60% global cap is measured against this. Convert a CAD balance by hand."
        />
        <TextField
          name="symbolCapital"
          label={`${LADDER_SYMBOL} allocation (USD)`}
          type="number"
          step={1000}
          required
          hint="Expected deployment, not a ceiling."
        />
        <TextField
          name="dailyLossThreshold"
          label="Daily loss threshold (USD)"
          type="number"
          step={500}
          required
          hint="The breaker halts new entries past this. It never liquidates."
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-xs text-slate-400">
          <span className="font-medium text-slate-300">Daily loss basis</span>
          <select
            name="dailyLossBasis"
            aria-label="Daily loss basis"
            defaultValue="REALIZED_AND_UNREALIZED"
            className={inputClass}
          >
            <option value="REALIZED_AND_UNREALIZED">Realized and unrealized</option>
            <option value="REALIZED">Realized only</option>
          </select>
          <span className="mt-0.5 block text-[11px] text-slate-600">
            Realized-only never fires for a ladder that only exits in profit.
          </span>
        </label>
        <TextField
          name="reason"
          label="Reason"
          placeholder="why this account"
          hint="Recorded in the account audit log."
        />
      </div>

      <button
        type="submit"
        disabled={pending}
        className="rounded bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:opacity-50"
      >
        {pending ? 'Creating…' : 'Create account'}
      </button>

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
            <ul className="mt-1 list-disc pl-4">
              {result.failures.map((failure) => (
                <li key={failure}>{failure}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}
