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
import { LadderView } from './components/LadderView';
import { LotTable } from './components/LotTable';
import { ModeSwitch } from './components/ModeSwitch';
import { StatusBar } from './components/StatusBar';
import { StrategyPanel } from './components/StrategyPanel';
import { lastMarkPrice, loadExecution, totalDeployedCost, totalRealized } from './lib/api';

/** Always rendered fresh — this reports live engine state. */
export const dynamic = 'force-dynamic';

export default async function ExecutionPage() {
  const data = await loadExecution();
  const mark = lastMarkPrice(data.fills);

  /*
    Fixture replay is mock-data scaffolding, and against a live Gateway it is
    actively harmful: it would push committed fixture bars through the same
    engine that is trading the session, and `Reset` would discard the state the
    daily soak report reads. Hidden whenever IB is the bound broker.
  */
  const replayable = data.status !== null && data.status.broker.name !== 'ib';

  return (
    <main className="flex flex-col gap-4">
      <StatusBar
        status={data.status}
        positions={data.positions}
        deployed={totalDeployedCost(data.lots)}
        realized={totalRealized(data.lots)}
      />

      <div className={`grid gap-4 ${replayable ? 'lg:grid-cols-3' : 'lg:grid-cols-2'}`}>
        <ModeSwitch mode={data.status?.mode ?? 'SHADOW'} />
        {replayable && <EngineControls />}
        <StrategyPanel strategies={data.strategies} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <LadderView rungs={data.rungs} mark={mark} />
        <LotTable lots={data.lots} mark={mark} />
      </div>

      <ActivityLog
        orders={data.orders}
        fills={data.fills}
        riskEvents={data.riskEvents}
        mode={data.status?.mode ?? 'SHADOW'}
      />
    </main>
  );
}
