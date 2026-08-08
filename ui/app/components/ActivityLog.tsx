/**
 * Order and fill log, plus risk events (`PRD.md:379`).
 *
 * In `SHADOW` the order and fill lists are legitimately empty — the mode
 * submits nothing by definition. That is stated in the empty copy rather than
 * left blank, because an empty log during a replay otherwise reads as a bug.
 * The risk-event list is where SHADOW activity actually shows up.
 */

import { formatCurrency, type Fill, type Order, type RiskEvent } from '../lib/api';

export function ActivityLog({
  orders,
  fills,
  riskEvents,
  mode,
}: {
  orders: Order[];
  fills: Fill[];
  riskEvents: RiskEvent[];
  mode: string;
}) {
  return (
    <section aria-label="Activity" className="grid gap-4 lg:grid-cols-2">
      <Panel title="Orders & fills">
        {orders.length === 0 && fills.length === 0 ? (
          <Empty>
            {mode === 'SHADOW'
              ? 'None — SHADOW logs full order payloads and submits nothing.'
              : 'No orders yet.'}
          </Empty>
        ) : (
          <ul className="divide-y divide-slate-800 text-xs">
            {orders
              .slice(-12)
              .reverse()
              .map((order) => (
                <li key={order.clientOrderId} className="flex justify-between gap-2 px-4 py-2">
                  <span className="font-mono text-slate-300">
                    <span className={order.side === 'BUY' ? 'text-sky-400' : 'text-emerald-400'}>
                      {order.side}
                    </span>{' '}
                    {order.quantity} {order.symbol} @ {formatCurrency(order.limitPrice)}
                  </span>
                  <span className="text-slate-500">{order.status}</span>
                </li>
              ))}
            {fills
              .slice(-12)
              .reverse()
              .map((fill) => (
                <li key={fill.fillId} className="flex justify-between gap-2 px-4 py-2">
                  <span className="font-mono text-slate-400">
                    FILL {fill.quantity} @ {formatCurrency(fill.price)}
                  </span>
                  <span className="text-slate-600">{fill.timestamp}</span>
                </li>
              ))}
          </ul>
        )}
      </Panel>

      <Panel title={`Risk events (${riskEvents.length})`}>
        {riskEvents.length === 0 ? (
          <Empty>No rejections, resizes, or halts.</Empty>
        ) : (
          <ul className="divide-y divide-slate-800 text-xs">
            {riskEvents
              .slice(-12)
              .reverse()
              .map((event, index) => (
                <li key={`${event.timestamp}-${index}`} className="px-4 py-2">
                  <div className="flex justify-between gap-2">
                    <span className="font-mono font-medium text-amber-400">{event.type}</span>
                    <span className="text-slate-600">{event.timestamp}</span>
                  </div>
                  <p className="mt-0.5 text-slate-400">{event.detail}</p>
                </li>
              ))}
          </ul>
        )}
      </Panel>
    </section>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900">
      <header className="border-b border-slate-800 px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">{title}</h2>
      </header>
      <div className="max-h-72 overflow-y-auto">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-6 text-sm text-slate-500">{children}</p>;
}
