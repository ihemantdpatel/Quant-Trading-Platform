'use client';

/**
 * Trade history — completed lot cycles, split out of `LotTable` so that table
 * can show currently held lots only.
 *
 * Each row is a lot that has fully exited: its own fill price, its own exit
 * price, and the realized P&L those two produced — never a blended figure,
 * for the same reason `LotTable` never shows one (`PRD.md:129`).
 *
 * **Paginated, `PAGE_SIZE` rows at a time.** A soaking account accumulates
 * closed cycles without bound, and rendering all of them turns this into the
 * longest table on the page for no reason an operator asked for — the recent
 * trades are what get checked, and older ones are a click away rather than a
 * scroll away. A Client Component for that reason alone; everything else here
 * stays pure presentation over props.
 */

import { useEffect, useState } from 'react';
import { formatCurrency, formatDuration, type LotLike } from '../lib/api';

const PAGE_SIZE = 10;

export function TradeHistoryTable({
  lots,
  unavailable = false,
  showHeader = true,
}: {
  /**
   * Closed lots from **either** strategy. `LotLike` carries no rung, so the
   * dip ladder's and the grid strategy's closed cycles can be merged into one
   * shared history table — each row still shows its own fill/exit price and
   * realized P&L regardless of which strategy produced it.
   */
  lots: LotLike[];
  /**
   * True when the underlying read failed on this load.
   *
   * Mirrors `LotTable`'s flag: both tables read the same endpoint(s), so a
   * failed read empties both, and each says so rather than rendering a silent
   * "no trades" that would be indistinguishable from a genuinely quiet history.
   */
  unavailable?: boolean;
  /**
   * Suppresses the built-in title/count header. Set by a caller that already
   * renders its own header above this table — e.g. `HoldingsPanel`'s tab bar
   * — so the title is not shown twice.
   */
  showHeader?: boolean;
}) {
  const closed = lots.filter((lot) => lot.status === 'CLOSED');
  const totalRealized = closed.reduce((sum, lot) => sum + (lot.realized ?? 0), 0);
  const unverified = closed.some((lot) => lot.unverified);

  // Most recently closed first — the trade an operator just watched exit is
  // the one they are most likely checking on.
  const sorted = closed.slice().sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''));
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const [page, setPage] = useState(0);
  // A poll (`AutoRefresh`) re-renders this component with fresh props every
  // few seconds without remounting it, so `page` is state that outlives any
  // one set of props — clamp rather than reset, so a shrinking or growing
  // list can't strand the viewer on a page number that no longer exists.
  const currentPage = Math.min(page, pageCount - 1);
  useEffect(() => {
    if (page !== currentPage) {
      setPage(currentPage);
    }
  }, [page, currentPage]);
  const pageRows = sorted.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);

  return (
    <section
      aria-label={showHeader ? 'Trade history' : undefined}
      className={showHeader ? 'rounded-lg border border-slate-800 bg-slate-900' : undefined}
    >
      {showHeader && (
        <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-800 px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
            Trade history
          </h2>
          <p className="text-xs text-slate-400">
            {closed.length} closed cycle{closed.length === 1 ? '' : 's'}
          </p>
        </header>
      )}

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
        <>
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
                {pageRows.map((lot) => {
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

          {pageCount > 1 && (
            <nav
              aria-label="Trade history pages"
              className="flex items-center justify-between gap-2 border-t border-slate-800 px-4 py-2 text-xs text-slate-400"
            >
              <button
                type="button"
                onClick={() => setPage((value) => Math.max(0, value - 1))}
                disabled={currentPage === 0}
                className="rounded border border-slate-700 px-2 py-1 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Previous
              </button>
              <span data-testid="history-page-indicator">
                Page {currentPage + 1} of {pageCount}
              </span>
              <button
                type="button"
                onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
                disabled={currentPage === pageCount - 1}
                className="rounded border border-slate-700 px-2 py-1 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
              </button>
            </nav>
          )}
        </>
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
