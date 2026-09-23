'use client';

/**
 * Holdings & trade history, as two tabs rather than two always-visible panels.
 *
 * `LotTable` (held lots) and `TradeHistoryTable` (closed cycles) used to stack
 * unconditionally on the Execution page — trade history is a look-back an
 * operator reaches for occasionally, not something that needs to occupy screen
 * space during every session. Same split as `OrdersFillsHistory`: one tab
 * shown at a time, switching is the only way to move between them.
 *
 * A Client Component only for the tab state — `LotTable` and
 * `TradeHistoryTable` stay pure presentation over props.
 */

import { useState } from 'react';
import { LotTable } from './LotTable';
import { TradeHistoryTable } from './TradeHistoryTable';
import type { LotLike } from '../lib/api';

type Tab = 'holdings' | 'history';

export function HoldingsPanel({
  holdings,
  allLots,
  mark,
  unavailable = false,
}: {
  /** Lots to show in the Holdings tab — filtered to `HELD` by `LotTable`. */
  holdings: LotLike[];
  /**
   * Lots to show in the Trade history tab — filtered to `CLOSED` by
   * `TradeHistoryTable`. Passed separately from `holdings` since the two tabs
   * can carry differently-tagged rows (e.g. `holdings` adds a `strategy`
   * field the history table has no column for).
   */
  allLots: LotLike[];
  mark: number | null;
  unavailable?: boolean;
}) {
  const [tab, setTab] = useState<Tab>('holdings');
  const held = holdings.filter((lot) => lot.status === 'HELD');
  const closed = allLots.filter((lot) => lot.status === 'CLOSED');

  return (
    <section aria-label="Holdings" className="rounded-lg border border-slate-800 bg-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Holdings</h2>
        <div role="tablist" aria-label="Holdings view" className="flex gap-1">
          <TabButton active={tab === 'holdings'} onClick={() => setTab('holdings')}>
            Holdings ({held.length})
          </TabButton>
          <TabButton active={tab === 'history'} onClick={() => setTab('history')}>
            Trade history ({closed.length})
          </TabButton>
        </div>
      </div>

      <div role="tabpanel">
        {tab === 'holdings' ? (
          <LotTable lots={holdings} mark={mark} unavailable={unavailable} showHeader={false} />
        ) : (
          <TradeHistoryTable lots={allLots} unavailable={unavailable} showHeader={false} />
        )}
      </div>
    </section>
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
