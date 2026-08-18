/**
 * Order and fill log, plus risk events (`PRD.md:379`).
 *
 * In `SHADOW` the order and fill lists are legitimately empty — the mode
 * submits nothing by definition. That is stated in the empty copy rather than
 * left blank, because an empty log during a replay otherwise reads as a bug.
 * The risk-event list is where SHADOW activity actually shows up.
 *
 * **Pending orders are their own panel, not a highlighted row in the log.**
 * Once orders rest at the broker rather than filling on the bar that created
 * them, "what is live right now" and "what happened today" are different
 * questions. The log answers the second and is capped at 12 rows, so a resting
 * order placed early in a busy session scrolls out of view — the one order an
 * operator most needs to see becomes the one the log is most likely to hide.
 */

import { formatCurrency, type Fill, type Order, type RiskEvent } from '../lib/api';

/**
 * Statuses where the broker may still fill the order.
 *
 * `PARTIALLY_FILLED` counts: the remainder is still working, and its unfilled
 * balance is live exposure. Terminal statuses (`FILLED`, `CANCELLED`,
 * `REJECTED`) belong to the history log below.
 */
const OPEN_STATUSES: ReadonlySet<Order['status']> = new Set(['SUBMITTED', 'PARTIALLY_FILLED']);

export function isOpen(order: Order): boolean {
  return OPEN_STATUSES.has(order.status);
}

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
  const pending = orders.filter(isOpen);

  return (
    /*
      Pending orders spans the full width above the two history panels: it is
      live state rather than a log, and an operator reads it first. The two
      backward-looking panels keep their side-by-side pairing below it.
    */
    <section aria-label="Activity" className="grid gap-4 lg:grid-cols-2">
      <div className="lg:col-span-2">
        <PendingOrders orders={pending} fills={fills} mode={mode} />
      </div>

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

/**
 * Orders resting at the broker right now.
 *
 * Deliberately uncapped: this list is bounded by the ladder itself (at most one
 * order per rung, five rungs concurrent), so there is no length to guard
 * against — and truncating the live view is exactly the failure the separate
 * panel exists to prevent.
 */
function PendingOrders({ orders, fills, mode }: { orders: Order[]; fills: Fill[]; mode: string }) {
  // Filled quantity comes from the fills, not the order row: `Order.quantity`
  // is the size originally submitted and does not shrink as partials arrive.
  const filledByOrder = new Map<string, number>();

  fills.forEach((fill) => {
    filledByOrder.set(
      fill.clientOrderId,
      (filledByOrder.get(fill.clientOrderId) ?? 0) + fill.quantity,
    );
  });

  return (
    <Panel title={`Pending orders (${orders.length})`}>
      {orders.length === 0 ? (
        <Empty>
          {mode === 'SHADOW'
            ? 'None — SHADOW submits nothing, so no order can rest at the broker.'
            : 'No orders resting at the broker.'}
        </Empty>
      ) : (
        <ul className="divide-y divide-slate-800 text-xs">
          {orders.map((order) => {
            const filled = filledByOrder.get(order.clientOrderId) ?? 0;
            const remaining = order.quantity - filled;

            return (
              <li
                key={order.clientOrderId}
                data-testid={`pending-order-${order.clientOrderId}`}
                className="flex items-baseline justify-between gap-2 px-4 py-2"
              >
                <span className="font-mono text-slate-300">
                  <span className={order.side === 'BUY' ? 'text-sky-400' : 'text-emerald-400'}>
                    {order.side}
                  </span>{' '}
                  {remaining} {order.symbol} @ {formatCurrency(order.limitPrice)}
                </span>

                <span className="flex items-baseline gap-2">
                  {filled > 0 && (
                    <span className="text-slate-500">
                      {filled}/{order.quantity} filled
                    </span>
                  )}
                  <span className="font-medium text-amber-400">
                    {order.status === 'PARTIALLY_FILLED' ? 'Partial' : 'Working'}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
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
