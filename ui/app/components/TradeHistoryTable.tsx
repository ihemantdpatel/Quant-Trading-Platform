/**
 * Trade history — completed lot cycles, split out of `LotTable` so that table
 * can show currently held lots only.
 *
 * Each row is a lot that has fully exited: its own fill price, its own exit
 * price, and the realized P&L those two produced — never a blended figure,
 * for the same reason `LotTable` never shows one (`PRD.md:129`).
 *
 * A Server Component — pure presentation over props, no state, no handlers.
 */

import { formatCurrency, formatDuration, type Lot } from '../lib/api';

export function TradeHistoryTable({
  lots,
  unavailable = false,
}: {
  lots: Lot[];
  /**
   * True when the `/lots` read failed on this load.
   *
   * Mirrors `LotTable`'s flag: both tables read the same endpoint, so a failed
   * read empties both, and each says so rather than rendering a silent "no
   * trades" that would be indistinguishable from a genuinely quiet history.
   */
  unavailable?: boolean;
}) {
  const closed = lots.filter((lot) => lot.status === 'CLOSED');
  const totalRealized = closed.reduce((sum, lot) => sum + (lot.realized ?? 0), 0);
  const unverified = closed.some((lot) => lot.unverified);

  return (
    <section aria-label="Trade history" className="rounded-lg border border-slate-800 bg-slate-900">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-800 px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
          Trade history
        </h2>
        <p className="text-xs text-slate-400">
          {closed.length} closed cycle{closed.length === 1 ? '' : 's'}
        </p>
      </header>

      {unverified && (
        <p className="border-b border-amber-800/60 bg-amber-950/40 px-4 py-2 text-xs text-amber-200">
          Some rows are shown from the <strong>database</strong> because their symbol is halted.
          They have not been verified against the broker — that is why the symbol is halted. Treat
          them as the last recorded state, not as confirmed history.
        </p>
      )}

      {unavailable ? (
        <p className="px-4 py-6 text-sm text-amber-300">
          Trade history unavailable — this read failed. The engine is unaffected; positions are
          untouched.
        </p>
      ) : closed.length === 0 ? (
        <p className="px-4 py-6 text-sm text-slate-500">No closed trades yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[48rem] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                <th scope="col" className="px-4 py-2 font-medium">
                  Lot
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Fill price
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Exit price
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Qty
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Held for
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Realized
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {closed
                // Most recently closed first — the trade an operator just watched
                // exit is the one they are most likely checking on.
                .slice()
                .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))
                .map((lot) => {
                  const opened = Date.parse(lot.openedAt);
                  const closedAt = lot.closedAt === null ? NaN : Date.parse(lot.closedAt);
                  const heldMs =
                    Number.isNaN(opened) || Number.isNaN(closedAt) ? null : closedAt - opened;

                  return (
                    <tr
                      key={lot.id}
                      data-testid={`history-row-${lot.id}`}
                      className="text-slate-200"
                    >
                      <td className="px-4 py-2 font-mono text-xs text-slate-400">{lot.id}</td>
                      <td data-testid="cell-fill" className="px-4 py-2 font-mono">
                        {formatCurrency(lot.fillPrice)}
                      </td>
                      <td data-testid="cell-exit" className="px-4 py-2 font-mono">
                        {formatCurrency(lot.exitPrice)}
                      </td>
                      <td data-testid="cell-qty" className="px-4 py-2 font-mono">
                        {lot.quantity}
                      </td>
                      <td data-testid="cell-held-for" className="px-4 py-2 text-slate-400">
                        {formatDuration(heldMs)}
                      </td>
                      <td
                        data-testid="cell-realized"
                        className="px-4 py-2 font-mono text-emerald-400"
                      >
                        {lot.realized === null ? '—' : formatCurrency(lot.realized)}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}

      <footer className="grid gap-3 border-t border-slate-800 px-4 py-3 text-sm sm:grid-cols-2">
        <Metric label="Closed cycles" value={String(closed.length)} />
        <Metric label="Realized P&L" value={formatCurrency(totalRealized)} accent />
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
