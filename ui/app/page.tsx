/**
 * The Execution tab — what the engine is doing right now (`stories.md:424`,
 * `PRD.md:373`).
 *
 * A Server Component: it fetches on the server and passes plain data down, per
 * the repo's Next.js conventions. Only the pieces that need interactivity — the
 * mode switch, strategy toggles, and replay controls — are Client Components,
 * each isolated to its own control rather than pulling the page into the client.
 *
 * Scoped to *current execution state only*. The kill switch and alerts are in
 * the layout, so they hold on every tab; ladder parameters are their own tab,
 * because a 10-field form and its audit trail are configuration rather than
 * something an operator reads while watching a session.
 *
 * Ordering is about what an operator needs first under stress: connection and
 * P&L, then the controls, then the ladder itself.
 */

import { ActivityLog } from './components/ActivityLog';
import { EngineControls } from './components/EngineControls';
import { HoldingsPanel } from './components/HoldingsPanel';
import { LadderView } from './components/LadderView';
import { OverviewPanel } from './components/OverviewPanel';
import {
  isDipLadderEnabled,
  isGridEnabled,
  lastMarkPrice,
  loadExecution,
  totalDeployedCost,
  totalRealized,
} from './lib/api';

/** Always rendered fresh — this reports live engine state. */
export const dynamic = 'force-dynamic';

export default async function ExecutionPage() {
  const data = await loadExecution();
  const mark = lastMarkPrice(data.fills);
  const lotsUnavailable = data.unavailable?.lots ?? false;
  const gridLotsUnavailable = data.unavailable?.gridLots ?? false;
  const rungsUnavailable = data.unavailable?.rungs ?? false;
  // Deployed cost and realized P&L are account-wide totals in the top header,
  // so they must reflect whichever strategy actually holds a position —
  // combining both keeps the header correct once the operator switches which
  // strategy trades a symbol, rather than only ever describing the ladder.
  const allLots = [...data.lots, ...data.gridLots];

  /*
    A symbol's current holdings are one fact about the broker account, not
    two competing ones split by strategy — the same reasoning that changed
    reconciliation to sum lots across both strategies before comparing to the
    broker's position. Splitting the display into a "Dip ladder — Lots" panel
    and a "Grid — Lots" panel invited reading them as separate positions, when
    a share held by a disabled strategy is exactly as real as one held by the
    enabled one. So both render in a single table, tagged by which strategy
    opened each lot (`LotTable`'s `strategy` field), rather than two panels
    each gated on its own strategy's enabled flag.
  */
  const holdings = [
    ...data.lots.map((lot) => ({ ...lot, strategy: 'Dip ladder' })),
    ...data.gridLots.map((lot) => ({ ...lot, strategy: 'Grid' })),
  ];

  /*
    Shown whenever either strategy is enabled (so an operator sees "flat" as
    an explicit empty state rather than a missing panel), or either side
    holds a real position left over from before it was switched off (`GET
    /lots`/`GET /grid/lots` serve those from the database, flagged
    `unverified`), or a read failed outright — a failed read must not be
    hidden behind "nothing to show", which would look identical to a
    strategy that is cleanly flat. Hiding is purely cosmetic; it never
    affects which lots are actually fetched or how a halt/disable is
    enforced.
  */
  const holdingsRelevant =
    isDipLadderEnabled(data.strategies) ||
    isGridEnabled(data.strategies) ||
    data.lots.length > 0 ||
    data.gridLots.length > 0 ||
    lotsUnavailable ||
    gridLotsUnavailable;

  /*
    The rung ladder has no grid equivalent at all (the grid strategy keeps no
    persisted level ledger), so its visibility still tracks the ladder alone
    — independently of the shared holdings table above.

    Unlike Holdings, this does **not** fall back to "there is rung data" —
    a disabled ladder's rungs are still served from the database (flagged
    `unverified`) for the same reason its lots are, but a rung is the
    ladder's own internal bookkeeping (which level is armed, re-armed, or
    working), not a fact about the broker account the way a held share is.
    Once the ladder is not the strategy in use, that bookkeeping describes a
    strategy that is not deciding anything any more, and showing it reads as
    "the ladder is active here" when it is not — exactly the confusion this
    page exists to avoid. A failed read is still surfaced, the same as every
    other panel.
  */
  const rungsRelevant = isDipLadderEnabled(data.strategies) || rungsUnavailable;

  /*
    Fixture replay is mock-data scaffolding, and against a live Gateway it is
    actively harmful: it would push committed fixture bars through the same
    engine that is trading the session, and `Reset` would discard the state the
    daily soak report reads. Hidden whenever IB is the bound broker.
  */
  const replayable = data.status !== null && data.status.broker.name !== 'ib';

  return (
    <main className="flex flex-col gap-4">
      <div className={`grid gap-4 ${replayable ? 'lg:grid-cols-[minmax(0,1fr)_20rem]' : ''}`}>
        <OverviewPanel
          status={data.status}
          positions={data.positions}
          deployed={totalDeployedCost(allLots)}
          realized={totalRealized(allLots)}
          positionsUnavailable={data.unavailable?.positions ?? false}
          mode={data.status?.mode ?? 'SHADOW'}
          strategies={data.strategies}
        />
        {replayable && <EngineControls />}
      </div>

      {/*
        The ladder (rungs) and the shared holdings table are each gated on
        their own relevance now, rather than rising and falling together —
        a disabled ladder's real position still belongs in Holdings even
        with no rungs to show beside it, and a flat-but-enabled grid strategy
        can populate Holdings with nothing to say about rungs at all.
      */}
      {(rungsRelevant || holdingsRelevant) && (
        <div
          className={
            rungsRelevant && holdingsRelevant
              ? 'grid gap-4 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]'
              : 'grid gap-4'
          }
        >
          {rungsRelevant && (
            <LadderView rungs={data.rungs} mark={mark} unavailable={rungsUnavailable} />
          )}
          {holdingsRelevant && (
            <HoldingsPanel
              holdings={holdings}
              allLots={allLots}
              mark={mark}
              unavailable={lotsUnavailable || gridLotsUnavailable}
            />
          )}
        </div>
      )}

      <ActivityLog
        orders={data.orders}
        fills={data.fills}
        riskEvents={data.riskEvents}
        mode={data.status?.mode ?? 'SHADOW'}
      />
    </main>
  );
}
