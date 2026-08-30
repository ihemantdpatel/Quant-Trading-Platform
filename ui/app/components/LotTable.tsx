/**
 * The per-lot table — the view this whole design exists to make possible
 * (`PRD.md:378`).
 *
 * Each row shows a lot's **own** fill price, quantity, age, **individual
 * target**, and distance to that target. There is deliberately no column
 * showing a target derived from the blended average: a lot's target comes from
 * its own fill price and nothing else (`PRD.md:129`), and rendering a blended
 * target beside it would imply an exit rule the system does not have.
 *
 * Blended average cost appears **once**, below the table, labelled "reference
 * only" (`PRD.md:378`).
 *
 * A Server Component — it is pure presentation over props, with no state and no
 * handlers.
 */

import {
  blendedAverageCost,
  distanceToTarget,
  formatCurrency,
  formatPercent,
  lotAge,
  totalDeployedCost,
  totalHeldQuantity,
  totalRealized,
  type Lot,
} from '../lib/api';

export function LotTable({
  lots,
  mark,
  now,
  unavailable = false,
}: {
  lots: Lot[];
  /** Last traded price, or null when the engine has seen no fills. */
  mark: number | null;
  /** Injectable clock so age rendering is deterministic under test. */
  now?: number;
  /**
   * True when the `/lots` read failed on this load.
   *
   * Rendered distinctly from an empty ladder: both produce zero rows, but
   * "could not read" and "holding nothing" are opposite facts, and showing the
   * flat-ladder copy during an outage would tell an operator they have no
   * position when they may be fully extended.
   */
  unavailable?: boolean;
}) {
  const held = lots.filter((lot) => lot.status === 'HELD');
  const closed = lots.filter((lot) => lot.status === 'CLOSED');
  const blended = blendedAverageCost(lots);
  // Any row served from the database because its symbol is halted. The banner
  // is per-table rather than per-row: the caveat is about the whole reading,
  // and repeating it on every row would bury it.
  const unverified = lots.some((lot) => lot.unverified);

  return (
    <section aria-label="Per-lot table" className="rounded-lg border border-slate-800 bg-slate-900">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-800 px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Lots</h2>
        <p className="text-xs text-slate-400">
          {held.length} held · {closed.length} closed cycle{closed.length === 1 ? '' : 's'}
        </p>
      </header>

      {unverified && (
        <p className="border-b border-amber-800/60 bg-amber-950/40 px-4 py-2 text-xs text-amber-200">
          Some lots are shown from the <strong>database</strong> because their symbol is halted.
          They have not been verified against the broker — that is why the symbol is halted. Treat
          them as the last recorded state, not as confirmed positions.
        </p>
      )}

      {unavailable ? (
        <p className="px-4 py-6 text-sm text-amber-300">
          Lots unavailable — this read failed. The engine is unaffected; positions are untouched.
        </p>
      ) : lots.length === 0 ? (
        <p className="px-4 py-6 text-sm text-slate-500">
          No lots yet. Replay a fixture to drive the ladder.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[54rem] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                <th scope="col" className="px-4 py-2 font-medium">
                  Lot
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Rung
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Fill price
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Qty
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Age
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Own target
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Distance
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Realized
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {lots.map((lot) => {
                const distance = lot.status === 'HELD' ? distanceToTarget(lot, mark) : null;

                return (
                  <tr key={lot.id} data-testid={`lot-row-${lot.id}`} className="text-slate-200">
                    <td className="px-4 py-2 font-mono text-xs text-slate-400">{lot.id}</td>
                    <td data-testid="cell-rung" className="px-4 py-2 font-mono">
                      {formatCurrency(lot.rungPrice)}
                    </td>
                    <td data-testid="cell-fill" className="px-4 py-2 font-mono">
                      {formatCurrency(lot.fillPrice)}
                    </td>
                    <td data-testid="cell-qty" className="px-4 py-2 font-mono">
                      {lot.quantity}
                    </td>
                    <td data-testid="cell-age" className="px-4 py-2 text-slate-400">
                      {lotAge(lot.openedAt, now)}
                    </td>
                    <td data-testid="cell-target" className="px-4 py-2 font-mono text-amber-300">
                      {formatCurrency(lot.exitTarget)}
                    </td>
                    <td data-testid="cell-distance" className="px-4 py-2 font-mono text-slate-300">
                      {distance === null ? '—' : formatPercent(distance)}
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={`rounded px-2 py-0.5 text-xs font-medium ${
                          lot.status === 'HELD'
                            ? 'bg-sky-950 text-sky-300'
                            : 'bg-emerald-950 text-emerald-300'
                        }`}
                      >
                        {lot.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 font-mono text-emerald-400">
                      {lot.realized === null ? '—' : formatCurrency(lot.realized)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <footer className="grid gap-3 border-t border-slate-800 px-4 py-3 text-sm sm:grid-cols-4">
        <Metric label="Shares held" value={String(totalHeldQuantity(lots))} />
        <Metric label="Deployed at cost" value={formatCurrency(totalDeployedCost(lots))} />
        <Metric label="Realized P&L" value={formatCurrency(totalRealized(lots))} accent />
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">
            Blended average{' '}
            {/*
              The label is not decoration. Per `PRD.md:378` this figure is
              display-only and no exit decision reads it — showing it unlabelled
              beside real targets would invite exactly the average-cost thinking
              per-lot exits exist to avoid.
            */}
            <span className="font-semibold text-amber-500">(reference only)</span>
          </p>
          <p data-testid="blended-average" className="font-mono text-slate-300">
            {formatCurrency(blended)}
          </p>
        </div>
      </footer>
    </section>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`font-mono ${accent ? 'text-emerald-400' : 'text-slate-300'}`}>{value}</p>
    </div>
  );
}
