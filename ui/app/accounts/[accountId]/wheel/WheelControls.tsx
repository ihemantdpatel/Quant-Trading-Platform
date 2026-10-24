'use client';

import { useState, useTransition } from 'react';
import { useAccount } from '../../../components/AccountContext';
import type { WheelState } from '../../../lib/api';
import { wheelAction, type WheelAction } from './actions';

type Preview = {
  intents: {
    quantity: number;
    limitPrice: number;
    contract: { symbol: string; right: string; strike: number; expiry: string };
  }[];
};
const button =
  'rounded border border-slate-600 px-3 py-2 text-sm disabled:opacity-40 hover:bg-slate-800';
const input = 'rounded border border-slate-600 bg-slate-950 p-2';

export function WheelControls({ state }: { state: WheelState | null }) {
  const account = useAccount();
  const [pending, startTransition] = useTransition();
  const [symbol, setSymbol] = useState(state?.config?.symbol ?? 'QQQ');
  const [allocation, setAllocation] = useState(String(state?.config?.allocation ?? 160000));
  const [reference, setReference] = useState('');
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const unavailable = pending || state === null || !account;
  function act(action: WheelAction, body: unknown = {}) {
    setMessage('');
    startTransition(async () => {
      const result = await wheelAction(account, action, body);
      setMessage(result.message);
      if (action === 'preview') setPreview(result.ok ? (result.data as Preview) : null);
    });
  }
  return (
    <>
      <section className="rounded-lg border border-slate-700 bg-slate-900 p-4 space-y-4">
        <p>
          <strong>{state?.enabled ? 'Enabled · checks once a minute' : 'Disabled'}</strong> ·{' '}
          {state?.shares ?? 0} wheel-owned shares
        </p>
        <p className="text-sm text-slate-400">
          Recorded stock cost: ${(state?.stockCost ?? 0).toFixed(2)} per share.
        </p>
        {state?.halt && (
          <p role="alert" className="text-amber-300">
            Paused: {state.halt}
          </p>
        )}
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            act('configure', { symbol, allocation: Number(allocation), maxContracts: 1 });
          }}
        >
          <label className="flex flex-col gap-1 text-sm">
            Ticker
            <input
              className={input}
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              required
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Maximum allocation (USD)
            <input
              className={input}
              type="number"
              min="1"
              step="1"
              value={allocation}
              onChange={(e) => setAllocation(e.target.value)}
              required
            />
          </label>
          <button className={button} disabled={unavailable || state?.enabled} type="submit">
            Save configuration
          </button>
        </form>
        <p className="text-xs text-slate-400">
          One standard contract at a time. Defaults: 21–45 days to expiry, maximum absolute delta
          0.20, at least 100 open contracts. The $160,000 allocation remains subject to the smaller
          shared account cap; it does not reserve that amount or increase the cap.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            className={button}
            disabled={unavailable || !state?.config}
            onClick={() => act('preview')}
          >
            Preview next order
          </button>
          <button
            className={button}
            disabled={unavailable || !state?.config || state?.enabled || !!state?.halt}
            onClick={() => act('enable')}
          >
            Enable paper wheel
          </button>
          <button
            className={button}
            disabled={unavailable || !state?.enabled}
            onClick={() => act('disable')}
          >
            Disable new orders
          </button>
          <button
            className={button}
            disabled={unavailable || !state?.enabled || !!state?.halt}
            onClick={() => act('run')}
          >
            Check and place now
          </button>
        </div>
        <p className="text-xs text-slate-400">
          Enabling permits paper orders during 10:00–15:30 New York time. Disabling leaves existing
          broker orders working. Preview reads current data and places nothing; eligibility and
          funding are checked again before submission.
        </p>
        {pending && <p role="status">Working… an options scan can take up to a minute.</p>}
        {message && <p role="status">{message}</p>}
        {preview && (
          <div className="rounded border border-slate-700 p-3 text-sm">
            {preview.intents.length === 0
              ? 'No eligible order right now.'
              : preview.intents.map((order, i) => (
                  <p key={i}>
                    Sell {order.quantity} {order.contract.symbol} {order.contract.expiry} $
                    {order.contract.strike} {order.contract.right === 'P' ? 'put' : 'call'} at a $
                    {order.limitPrice.toFixed(2)} limit per share.
                  </p>
                ))}
          </div>
        )}
      </section>
      <section className="rounded-lg border border-slate-700 p-4 space-y-3">
        <h2 className="font-semibold">Expiration, assignment, and recovery</h2>
        <p className="text-sm text-slate-400">
          After an option expires or is assigned, check IB’s activity report. Enter its reference
          and describe the result. Reconcile adopts the confirmed QQQ share balance and broker cost
          basis only after all QQQ options and working orders are gone. It submits no trades.
        </p>
        <label className="flex flex-col gap-1 text-sm">
          Broker activity reference and reason
          <input
            className={input}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </label>
        <div className="flex gap-2">
          <button
            className={button}
            disabled={unavailable || !state?.config || reference.trim().length < 8}
            onClick={() => act('reconcile', { reference })}
          >
            Confirm lifecycle and reconcile
          </button>
          <button
            className={button}
            disabled={unavailable || !state?.halt || reference.trim().length < 8}
            onClick={() => act('clear-halt', { reference })}
          >
            Verify positions and clear halt
          </button>
        </div>
      </section>
      <section className="rounded-lg border border-slate-700 p-4 space-y-3 overflow-x-auto">
        <h2 className="font-semibold">Wheel orders</h2>
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th>Contract</th>
              <th>Quantity</th>
              <th>Status</th>
              <th>Cycle</th>
            </tr>
          </thead>
          <tbody>
            {state?.orders.map((order) => (
              <tr key={order.id} className="border-t border-slate-800">
                <td className="py-2">
                  {order.contract.symbol} {order.contract.expiry} ${order.contract.strike}{' '}
                  {order.contract.right}
                </td>
                <td>{order.quantity}</td>
                <td>{order.status}</td>
                <td>{order.settled ? 'Settled' : 'Open / awaiting verification'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {state?.orders.length === 0 && (
          <p className="text-sm text-slate-400">No wheel orders yet.</p>
        )}
        <details>
          <summary className="text-sm cursor-pointer">Recent activity</summary>
          {state?.audit
            .slice(-20)
            .reverse()
            .map((event, i) => (
              <p key={i} className="text-xs text-slate-400 py-1">
                {event.at} · {event.action}: {event.reason}
              </p>
            ))}
        </details>
      </section>
    </>
  );
}
