'use client';

/**
 * Orders & fills history, as two tabs rather than one mixed list.
 *
 * Split out of `ActivityLog`'s single "Orders & fills" panel, which used to
 * stack a capped orders list directly above a capped fills list inside one
 * `<ul>` — readable, but nothing separated "what was submitted" from "what
 * actually executed," and a busy session pushed fills below the fold behind
 * orders. Tabs make that split a switch rather than a scroll.
 *
 * Each tab keeps the original panel's cap (12 rows, most recent first) — this
 * is a history log, not the live view; the Pending tab in `ActivityLog`
 * remains the uncapped answer to "what is resting right now."
 *
 * **Unbordered and headingless on purpose.** `ActivityLog` now embeds this
 * directly inside its own "Orders & fills" tab, which already supplies the box
 * and the label — a second border and a repeated "Orders & fills" heading here
 * would just be chrome around chrome. The Submitted/Filled switch below is a
 * second, nested level of tabs, which is fine: the two tablists have disjoint
 * names, and an operator reads them as "which view" then "which list."
 *
 * A Client Component only for the tab state — the rest of `ActivityLog` stays
 * a Server Component.
 */

import { useState } from 'react';
import { formatCurrency, type Fill, type Order } from '../lib/api';

type Tab = 'submitted' | 'filled';

export function OrdersFillsHistory({
  orders,
  fills,
  mode,
}: {
  orders: Order[];
  fills: Fill[];
  mode: string;
}) {
  const [tab, setTab] = useState<Tab>('submitted');

  return (
    <div>
      <div className="flex justify-end border-b border-slate-800 px-4 py-2">
        <div role="tablist" aria-label="Orders & fills view" className="flex gap-1">
          <TabButton active={tab === 'submitted'} onClick={() => setTab('submitted')}>
            Submitted ({orders.length})
          </TabButton>
          <TabButton active={tab === 'filled'} onClick={() => setTab('filled')}>
            Filled ({fills.length})
          </TabButton>
        </div>
      </div>

      <div role="tabpanel">
        {tab === 'submitted' ? (
          orders.length === 0 ? (
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
                  <li
                    key={order.clientOrderId}
                    data-testid={`order-row-${order.clientOrderId}`}
                    className="flex justify-between gap-2 px-4 py-2"
                  >
                    <span className="font-mono text-slate-300">
                      <span className={order.side === 'BUY' ? 'text-sky-400' : 'text-emerald-400'}>
                        {order.side}
                      </span>{' '}
                      {order.quantity} {order.symbol} @ {formatCurrency(order.limitPrice)}
                    </span>
                    <span className="text-slate-500">{order.status}</span>
                  </li>
                ))}
            </ul>
          )
        ) : fills.length === 0 ? (
          <Empty>
            {mode === 'SHADOW'
              ? 'None — SHADOW submits nothing, so nothing can fill.'
              : 'No fills yet.'}
          </Empty>
        ) : (
          <ul className="divide-y divide-slate-800 text-xs">
            {fills
              .slice(-12)
              .reverse()
              .map((fill) => (
                <li
                  key={fill.fillId}
                  data-testid={`fill-row-${fill.fillId}`}
                  className="flex justify-between gap-2 px-4 py-2"
                >
                  <span className="font-mono text-slate-400">
                    FILL {fill.quantity} @ {formatCurrency(fill.price)}
                  </span>
                  <span className="text-slate-600">{fill.timestamp}</span>
                </li>
              ))}
          </ul>
        )}
      </div>
    </div>
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
