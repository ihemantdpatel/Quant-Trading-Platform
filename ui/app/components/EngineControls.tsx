'use client';

/**
 * Replay and reset controls.
 *
 * Not in `PRD.md` §7's list, because the PRD describes the dashboard against
 * live market data. On mock data the engine only advances when a replay is
 * requested, so without this the Story 7 exit criterion — watching the ladder
 * cycle in a browser — would require a `curl` in another terminal.
 *
 * Safe to expose: `POST /engine/replay` runs committed fixtures through the
 * same risk chokepoint as everything else, and `SHADOW` submits nothing.
 *
 * **Rendered only when the bound broker is not IB** (`page.tsx`). Against a live
 * Gateway these controls stop being scaffolding and become a hazard: `Replay`
 * would drive fixture bars through the engine that is trading the live session,
 * and `Reset` would discard the persisted state `GET /reports/daily` reads —
 * corrupting the very soak session `docs/soak-log.md` is recording. The gate is
 * on `status.broker.name` rather than on execution mode, because the danger is
 * polluting observed state, which `SHADOW` does not prevent.
 */

import { useState, useTransition } from 'react';
import { resetEngine, runReplay, type ActionResult } from '../actions';

const FIXTURES = [
  'chop-range',
  'steady-decline',
  'gap-down-open',
  'gap-down-recover',
  'session-edges',
];

export function EngineControls() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [fixture, setFixture] = useState(FIXTURES[0]);

  return (
    <section
      aria-label="Engine controls"
      className="rounded-lg border border-slate-800 bg-slate-900 p-4"
    >
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Replay</h2>
      <p className="text-xs text-slate-400">Drive the ladder with a committed fixture.</p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          value={fixture}
          onChange={(event) => setFixture(event.target.value)}
          aria-label="Fixture"
          className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
        >
          {FIXTURES.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>

        <button
          type="button"
          disabled={pending}
          onClick={() => startTransition(async () => setResult(await runReplay(fixture)))}
          className="rounded bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:opacity-50"
        >
          {pending ? 'Running…' : 'Replay'}
        </button>

        <button
          type="button"
          disabled={pending}
          onClick={() => startTransition(async () => setResult(await resetEngine()))}
          className="rounded border border-slate-700 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-slate-800 disabled:opacity-50"
        >
          Reset
        </button>
      </div>

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
