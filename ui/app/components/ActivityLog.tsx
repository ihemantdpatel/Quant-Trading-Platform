'use client';

/**
 * Order and fill log, plus risk events (`PRD.md:379`).
 *
 * In `SHADOW` the order and fill lists are legitimately empty — the mode
 * submits nothing by definition. That is stated in the empty copy rather than
 * left blank, because an empty log during a replay otherwise reads as a bug.
 * The risk-event list is where SHADOW activity actually shows up.
 *
 * **Pending orders, Orders & fills, and Risk events are one panel, switched by
 * tab**, rather than three panels stacked or side by side. Once orders rest at
 * the broker rather than filling on the bar that created them, "what is live
 * right now", "what happened today", and "what the risk manager did about it"
 * are three different questions an operator asks one at a time — the same
 * reasoning `HoldingsPanel` and `OrdersFillsHistory` already apply to their own
 * pairs of views. Pending defaults to the active tab: it is the one an operator
 * most needs on first look, since a resting order placed early in a busy
 * session is otherwise the easiest thing to lose track of.
 *
 * A Client Component only for the tab state — the row rendering below stays
 * pure presentation over props, the same split `HoldingsPanel` uses.
 */

import { useState } from 'react';
import { formatCurrency, type Fill, type Order, type RiskEvent } from '../lib/api';
import { OrdersFillsHistory } from './OrdersFillsHistory';

/**
 * Statuses where the broker may still fill the order.
 *
 * `PARTIALLY_FILLED` counts: the remainder is still working, and its unfilled
 * balance is live exposure. Terminal statuses (`FILLED`, `CANCELLED`,
 * `REJECTED`) belong to the history tab instead.
 */
const OPEN_STATUSES: ReadonlySet<Order['status']> = new Set(['SUBMITTED', 'PARTIALLY_FILLED']);

export function isOpen(order: Order): boolean {
  return OPEN_STATUSES.has(order.status);
}

type Tab = 'pending' | 'history' | 'risk';

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
  const [tab, setTab] = useState<Tab>('pending');
  const pending = orders.filter(isOpen);

  return (
    <section aria-label="Activity" className="rounded-lg border border-slate-800 bg-slate-900">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Activity</h2>
        <div role="tablist" aria-label="Activity view" className="flex gap-1">
          <TabButton active={tab === 'pending'} onClick={() => setTab('pending')}>
            Pending orders ({pending.length})
          </TabButton>
          <TabButton active={tab === 'history'} onClick={() => setTab('history')}>
            Orders & fills
          </TabButton>
          <TabButton active={tab === 'risk'} onClick={() => setTab('risk')}>
            Risk events ({riskEvents.length})
          </TabButton>
        </div>
      </header>

      <div role="tabpanel" className="max-h-72 overflow-y-auto">
        {tab === 'pending' && <PendingList orders={pending} fills={fills} mode={mode} />}
        {tab === 'history' && <OrdersFillsHistory orders={orders} fills={fills} mode={mode} />}
        {tab === 'risk' && <RiskEventList events={riskEvents} />}
      </div>
    </section>
  );
}

/**
 * Orders resting at the broker right now.
 *
 * Deliberately uncapped: this list is bounded by the ladder itself (at most one
 * order per rung, five rungs concurrent), so there is no length to guard
 * against — and truncating the live view is exactly the failure the separate
 * tab exists to prevent.
 */
function PendingList({ orders, fills, mode }: { orders: Order[]; fills: Fill[]; mode: string }) {
  // Filled quantity comes from the fills, not the order row: `Order.quantity`
  // is the size originally submitted and does not shrink as partials arrive.
  const filledByOrder = new Map<string, number>();

  fills.forEach((fill) => {
    filledByOrder.set(
      fill.clientOrderId,
      (filledByOrder.get(fill.clientOrderId) ?? 0) + fill.quantity,
    );
  });

  if (orders.length === 0) {
    return (
      <Empty>
        {mode === 'SHADOW'
          ? 'None — SHADOW submits nothing, so no order can rest at the broker.'
          : 'No orders resting at the broker.'}
      </Empty>
    );
  }

  return (
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
  );
}

function RiskEventList({ events }: { events: RiskEvent[] }) {
  if (events.length === 0) {
    return <Empty>No rejections, resizes, or halts.</Empty>;
  }

  return (
    <ul className="divide-y divide-slate-800 text-xs">
      {events
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
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded px-2 py-1 text-xs font-medium transition ${
        active
          ? 'bg-slate-800 text-slate-200'
          : 'text-slate-500 hover:bg-slate-800/60 hover:text-slate-300'
      }`}
    >
      {children}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-6 text-sm text-slate-500">{children}</p>;
}
