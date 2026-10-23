/**
 * Today's sells, each realized against the position's **average cost** — the
 * way IB computes realized P&L, and the same rows the daily email lists.
 *
 * Pure presentation over the backend's `GET /reports/pnl/realized`. Nothing
 * here derives a figure from grid lots: pairing a sell with the lot it closed
 * reports profit IB does not (+$50 for a sell at the average, where IB books
 * $0).
 */

import { formatCurrency, type RealizedPnl } from '../lib/api';

function etTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/New_York',
  });
}

function price(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

export function RealizedSellsTable({
  realized,
  unavailable = false,
}: {
  realized: RealizedPnl | null;
  unavailable?: boolean;
}) {
  if (unavailable || realized === null) {
    return (
      <p className="px-4 py-6 text-sm text-amber-300">
        Realized P&L unavailable — this read failed. The engine is unaffected; positions are
        untouched.
      </p>
    );
  }

  if (!realized.coverage.tracked) {
    return (
      <p className="px-4 py-6 text-sm text-slate-500">
        Not tracked yet — realized P&L starts from the first IB position snapshot.
      </p>
    );
  }

  return (
    <section aria-label="Sells today">
      {realized.sells.length === 0 ? (
        <p className="px-4 py-6 text-sm text-slate-500">No sells today.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                {['Time (ET)', 'Symbol', 'Qty', 'Sell', 'Avg cost', 'Commission', 'Realized'].map(
                  (heading) => (
                    <th key={heading} scope="col" className="px-4 py-2 font-medium">
                      {heading}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {realized.sells
                .slice()
                .reverse()
                .map((sell) => (
                  <tr
                    key={sell.fillId}
                    data-testid={`sell-row-${sell.fillId}`}
                    className="text-slate-200"
                  >
                    <td className="px-4 py-2 text-slate-400">{etTime(sell.timestamp)}</td>
                    <td className="px-4 py-2">{sell.symbol}</td>
                    <td className="px-4 py-2 font-mono">{sell.quantity}</td>
                    <td className="px-4 py-2 font-mono">{price(sell.price)}</td>
                    <td data-testid="cell-avg-cost" className="px-4 py-2 font-mono">
                      {price(sell.averageCost)}
                    </td>
                    <td className="px-4 py-2 font-mono text-slate-400">
                      {formatCurrency(sell.commission)}
                    </td>
                    <td
                      data-testid="cell-realized"
                      className={`px-4 py-2 font-mono ${
                        sell.realized >= 0 ? 'text-emerald-400' : 'text-red-400'
                      }`}
                    >
                      {formatCurrency(sell.realized)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      <footer className="grid gap-3 border-t border-slate-800 px-4 py-3 text-sm sm:grid-cols-2">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Realized today</p>
          <p data-testid="sells-total" className="font-mono text-slate-300">
            {formatCurrency(realized.totals.net)}
          </p>
        </div>
        <p className="text-xs text-slate-500">
          Average-cost method, counted from our own fills: each sell realizes (sell − average cost)
          × qty, less its commission. Buy commissions are inside the average.
        </p>
      </footer>
    </section>
  );
}
