'use client';

/**
 * Connection health, live P&L, execution mode, and strategy enablement — one
 * panel at a time, switched by tab (`PRD.md:377`, `PRD.md:383`).
 *
 * This used to be two always-visible blocks: a five-column `StatusBar` grid
 * (Broker, Open positions, Deployed at cost, Realized P&L, Account equity)
 * stacked above `ExecutionControls` (Execution mode, Strategies). Splitting
 * that into seven separate tabs traded one long column for one-value-at-a-time,
 * which made the five status figures — read together at a glance, not one by
 * one — cost five taps to see. They're combined back into a single **Status**
 * tab, laid out the same way the original grid was, alongside **Execution
 * mode** and **Strategies** as their own tabs — the split that actually
 * matters is "status I read" vs. "controls I use," not one tab per figure.
 *
 * **Status is the default tab**, not Execution mode or Strategies —
 * connectivity and P&L are what an operator reads first, and controls are
 * reached for second.
 *
 * Account equity is reported as unavailable rather than as a number, because
 * the mock broker exposes positions but the per-symbol allocation that would
 * scale them is a deliberately-unset Story 13 item (`PRD.md:500`). Showing a
 * plausible-looking figure here would be inventing one.
 */

import { useState } from 'react';
import {
  formatCurrency,
  type ExecutionMode,
  type Position,
  type Status,
  type StrategySummary,
} from '../lib/api';
import { ModeSwitch } from './ModeSwitch';
import { StrategyPanel } from './StrategyPanel';

type Tab = 'status' | 'mode' | 'strategies';

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'status', label: 'Status' },
  { id: 'mode', label: 'Execution mode' },
  { id: 'strategies', label: 'Strategies' },
];

export function OverviewPanel({
  status,
  positions,
  deployed,
  realized,
  positionsUnavailable = false,
  mode,
  strategies,
}: {
  status: Status | null;
  positions: Position[];
  deployed: number;
  realized: number;
  /**
   * True when the `/positions` read failed.
   *
   * This is the field where conflating "unknown" with "empty" is most
   * dangerous: an unreachable broker would otherwise render as **flat**, which
   * is the same word a genuinely empty account gets. An operator reading
   * "flat" during a broker outage concludes they have no exposure.
   */
  positionsUnavailable?: boolean;
  mode: ExecutionMode;
  strategies: StrategySummary[];
}) {
  const [tab, setTab] = useState<Tab>('status');
  const connected = status?.broker.connected ?? false;

  return (
    <section aria-label="Overview" className="rounded-lg border border-slate-800 bg-slate-900">
      <div
        role="tablist"
        aria-label="Overview view"
        className="flex flex-wrap gap-1 border-b border-slate-800 px-4 py-2"
      >
        {TABS.map((t) => (
          <TabButton key={t.id} active={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </TabButton>
        ))}
      </div>

      <div role="tabpanel">
        {tab === 'status' && (
          <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
            <Item label="Broker">
              <span className={connected ? 'text-emerald-400' : 'text-red-400'}>
                {status ? `${status.broker.name} · ${status.broker.state}` : 'unknown'}
              </span>
            </Item>

            <Item label="Open positions">
              {positionsUnavailable ? (
                <span className="text-amber-400" title="The broker could not be asked">
                  unavailable
                </span>
              ) : positions.length === 0 ? (
                'flat'
              ) : (
                positions.map((p) => `${p.quantity} ${p.symbol}`).join(', ')
              )}
            </Item>

            <Item label="Deployed at cost">{formatCurrency(deployed)}</Item>

            <Item label="Realized P&L">
              <span className={realized >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                {formatCurrency(realized)}
              </span>
            </Item>

            <Item label="Account equity">
              {/*
                Not available from the mock broker, and not guessable. Story 13
                sets the capital figures this would be measured against.
              */}
              <span className="text-slate-500" title="Set at Story 13 (PRD.md:500)">
                not set
              </span>
            </Item>
          </div>
        )}

        {tab === 'mode' && <ModeSwitch mode={mode} />}
        {tab === 'strategies' && <StrategyPanel strategies={strategies} />}
      </div>
    </section>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="font-mono text-sm text-slate-300">{children}</p>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded px-2 py-1 text-xs font-medium transition ${
        active
          ? 'bg-slate-800 text-slate-200'
          : 'text-slate-500 hover:bg-slate-800/60 hover:text-slate-300'
      }`}
    >
      {children}
    </button>
  );
}
