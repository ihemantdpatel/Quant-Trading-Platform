'use client';

/**
 * Per-strategy enable/disable (`PRD.md:383`).
 *
 * Three of the four registered strategies are scaffolds, disabled and inert
 * until Story 16. They are listed rather than hidden so the plugin architecture
 * is visible: the dashboard shows what the coordinator holds, and a scaffold
 * that silently vanished from the UI would be a strategy nobody remembers is
 * registered.
 */

import { useState, useTransition } from 'react';
import { setStrategyEnabled, type ActionResult } from '../actions';
import type { StrategySummary } from '../lib/api';

export function StrategyPanel({ strategies }: { strategies: StrategySummary[] }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  function toggle(id: string, enabled: boolean) {
    startTransition(async () => {
      setResult(await setStrategyEnabled(id, enabled));
    });
  }

  return (
    <section aria-label="Strategies" className="rounded-lg border border-slate-800 bg-slate-900">
      <header className="border-b border-slate-800 px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Strategies</h2>
      </header>

      <ul className="divide-y divide-slate-800">
        {strategies.map((strategy) => (
          <li key={strategy.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <div>
              <p className="font-mono text-sm text-slate-200">{strategy.id}</p>
              <p className="text-xs text-slate-500">
                {strategy.symbols.join(', ')}
                {strategy.initialized ? '' : ' · not initialized'}
              </p>
            </div>

            <button
              type="button"
              onClick={() => toggle(strategy.id, !strategy.enabled)}
              disabled={pending}
              className={`rounded border px-3 py-1 text-xs font-medium transition disabled:opacity-40 ${
                strategy.enabled
                  ? 'border-emerald-700 bg-emerald-950/50 text-emerald-300 hover:bg-emerald-900/50'
                  : 'border-slate-700 text-slate-400 hover:bg-slate-800'
              }`}
            >
              {strategy.enabled ? 'Enabled' : 'Disabled'}
            </button>
          </li>
        ))}
      </ul>

      {result && (
        <p
          role="status"
          className={`border-t border-slate-800 px-4 py-2 text-xs ${
            result.ok ? 'text-emerald-400' : 'text-red-400'
          }`}
        >
          {result.message}
        </p>
      )}
    </section>
  );
}
