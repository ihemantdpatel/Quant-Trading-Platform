/**
 * The Parameters tab — live ladder configuration and its audit trail.
 *
 * A Server Component, per the repo's conventions; the editor itself is the
 * Client Component and owns all interactivity.
 *
 * Its own route rather than a panel on the dashboard for two reasons: it is
 * configuration rather than current execution state, and a route is what lets
 * the layout's 3s auto-refresh pause here (`AutoRefresh`) so a poll cannot
 * discard input an operator is partway through typing.
 */

import { GridParameterEditor } from '../components/GridParameterEditor';
import { ParameterEditor } from '../components/ParameterEditor';
import {
  heldLotCountFor,
  isGridParameterSet,
  loadParameters,
  type GridParameters,
  type LadderParameters,
} from '../lib/api';

/** Always fresh — parameters can be edited from this page. */
export const dynamic = 'force-dynamic';

export default async function ParametersPage() {
  const data = await loadParameters();

  return (
    <main className="flex flex-col gap-4">
      {data.error && (
        <div
          role="alert"
          className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-200"
        >
          Could not load parameters: {data.error}
        </div>
      )}

      {/*
        Stated on the page, not only in the docs. An operator about to change a
        number needs to know which positions it cannot reach before they change
        it — the editor repeats the held-lot count beside its submit button.
      */}
      <p className="rounded-lg border border-slate-800 bg-slate-900 px-4 py-3 text-xs text-slate-400">
        Edits apply to <strong className="text-slate-300">future rungs or levels only</strong>.
        Every held position&apos;s exit target is frozen at the parameters in force when it filled,
        and no edit can move a live position into or out of an exit condition. Every change is
        recorded append-only.
      </p>

      {data.parameters.length === 0 && !data.error && (
        <p className="rounded-lg border border-slate-800 bg-slate-900 px-4 py-6 text-center text-sm text-slate-500">
          No editable strategies.
        </p>
      )}

      {data.parameters.map((set) => {
        const heldLotCount = heldLotCountFor(set.strategyId, data.lots, data.gridLots);
        const changes = data.parameterChanges.filter((c) => c.strategyId === set.strategyId);
        const riskLimit = set.symbol ? (data.riskLimits[set.symbol] ?? null) : null;
        const riskLimitChanges = set.symbol
          ? data.riskLimitChanges.filter((c) => c.symbol === set.symbol)
          : [];

        // Dispatch by strategy id, mirroring the backend's own controller
        // (`ParametersController`, "dispatch, not a merged type"): the two
        // config shapes are disjoint, so a `GridParameterSet`'s `parameters`
        // is never rendered by the ladder's field list, and vice versa.
        return isGridParameterSet(set) ? (
          <GridParameterEditor
            key={set.strategyId}
            strategyId={set.strategyId}
            parameters={set.parameters as GridParameters}
            heldLotCount={heldLotCount}
            changes={changes}
            symbol={set.symbol}
            riskLimit={riskLimit}
            riskLimitChanges={riskLimitChanges}
          />
        ) : (
          <ParameterEditor
            key={set.strategyId}
            strategyId={set.strategyId}
            parameters={set.parameters as LadderParameters}
            heldLotCount={heldLotCount}
            changes={changes}
            symbol={set.symbol}
            riskLimit={riskLimit}
            riskLimitChanges={riskLimitChanges}
          />
        );
      })}
    </main>
  );
}
