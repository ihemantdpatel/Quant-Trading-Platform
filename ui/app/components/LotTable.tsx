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
 * **Held lots only.** A closed lot has nothing left to watch — no target
 * distance, no age relative to an open position — so it belongs in
 * `TradeHistoryTable`, not here. Filtering happens once, at the top, rather
 * than per-section, so every count and total below agrees with what the rows
 * show.
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
  type LotLike,
} from '../lib/api';

export function LotTable({
  lots,
  mark,
  now,
  unavailable = false,
  title = 'Lots',
  emptyMessage = 'No lots held. Replay a fixture to drive the strategy.',
  showRungColumn = true,
  showHeader = true,
}: {
  lots: LotLike[];
  /** Last traded price, or null when the engine has seen no fills. */
  mark: number | null;
  /** Injectable clock so age rendering is deterministic under test. */
  now?: number;
  /**
   * True when the underlying read failed on this load.
   *
   * Rendered distinctly from an empty ladder: both produce zero rows, but
   * "could not read" and "holding nothing" are opposite facts, and showing the
   * flat-ladder copy during an outage would tell an operator they have no
   * position when they may be fully extended.
   */
  unavailable?: boolean;
  /**
   * Distinguishes which strategy's lots this instance renders — the same
   * component is reused for the dip ladder's `/lots` and the grid strategy's
   * `/grid/lots`, and an operator needs to tell them apart at a glance.
   */
  title?: string;
  emptyMessage?: string;
  /**
   * The dip ladder's rows carry a rung price; a grid lot has none — the
   * strategy keeps no persisted level ledger to fill it from. Rather than
   * rendering a column of dashes for every grid row, the caller omits it.
   */
  showRungColumn?: boolean;
  /**
   * Suppresses the built-in title/count header. Set by a caller that already
   * renders its own header above this table — e.g. `HoldingsPanel`'s tab bar
   * — so the title is not shown twice.
   */
  showHeader?: boolean;
}) {
  const held = lots.filter((lot) => lot.status === 'HELD');
  const blended = blendedAverageCost(held);
  // Any row served from the database because its symbol is halted. The banner
  // is per-table rather than per-row: the caveat is about the whole reading,
  // and repeating it on every row would bury it.
  const unverified = held.some((lot) => lot.unverified);
  // Auto-detected rather than a caller-supplied flag: this table now renders
  // a shared holdings view combining more than one strategy's lots, tagged
  // client-side (`page.tsx`) — the column earns its place only when there is
  // more than one strategy's worth of rows to distinguish.
  const showStrategyColumn = held.some((lot) => lot.strategy);

  return (
    <section
      aria-label={showHeader ? title : undefined}
      className={showHeader ? 'rounded-lg border border-slate-800 bg-slate-900' : undefined}
    >
      {showHeader && (
        <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-800 px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">{title}</h2>
          <p className="text-xs text-slate-400">{held.length} held</p>
        </header>
      )}

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
      ) : held.length === 0 ? (
        <p className="px-4 py-6 text-sm text-slate-500">{emptyMessage}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[54rem] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                <th scope="col" className="px-4 py-2 font-medium">
                  Lot
                </th>
                {showStrategyColumn && (
                  <th scope="col" className="px-4 py-2 font-medium">
                    Strategy
                  </th>
                )}
                {showRungColumn && (
                  <th scope="col" className="px-4 py-2 font-medium">
                    Rung
                  </th>
                )}
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
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {held.map((lot) => {
                const distance = distanceToTarget(lot, mark);

                return (
                  <tr key={lot.id} data-testid={`lot-row-${lot.id}`} className="text-slate-200">
                    <td className="px-4 py-2 font-mono text-xs text-slate-400">{lot.id}</td>
                    {showStrategyColumn && (
                      <td data-testid="cell-strategy" className="px-4 py-2 text-slate-300">
                        {lot.strategy ?? '—'}
                      </td>
                    )}
                    {showRungColumn && (
                      <td data-testid="cell-rung" className="px-4 py-2 font-mono">
                        {formatCurrency(lot.rungPrice ?? null)}
                      </td>
                    )}
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
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <footer className="grid gap-3 border-t border-slate-800 px-4 py-3 text-sm sm:grid-cols-3">
        <Metric label="Shares held" value={String(totalHeldQuantity(held))} />
        <Metric label="Deployed at cost" value={formatCurrency(totalDeployedCost(held))} />
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
