/**
 * The operator shell, shared by every tab.
 *
 * The kill switch and the alert banner live here rather than on a page because
 * both must be visible on **every dashboard route** (`stories.md:465`,
 * `PRD.md:383`). When they sat on `/`, an operator looking at backtests had no
 * kill switch on screen; adding a third view would have widened that gap.
 *
 * **This component must never throw.** `loadStatus` degrades to `{status: null,
 * error}` instead of raising, and `KillSwitch` renders an armed, clickable
 * control from those defaults. A backend outage is precisely when an operator
 * reaches for the kill switch, so the one thing the shell may not do is
 * disappear along with the backend.
 *
 * It fetches only `/status`. Anything added here is fetched on all three tabs.
 */

import type { Metadata } from 'next';
import './globals.css';
import { AlertBanner } from './components/AlertBanner';
import { AutoRefresh } from './components/AutoRefresh';
import { KillSwitch } from './components/KillSwitch';
import { ReconcileButton } from './components/ReconcileButton';
import { PendingOrders } from './components/PendingOrders';
import { Tabs } from './components/Tabs';
import { loadStatus } from './lib/api';

export const metadata: Metadata = {
  title: 'Trading Platform',
  description: 'Multi-strategy quantitative trading control dashboard',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { status, error } = await loadStatus();
  const killSwitch = status?.halts.killSwitch;

  /*
    The shell fetches only `/status`, which reports strategy ids but not the
    symbols they trade — so the instrument shown is the one the feed is
    actually delivering, read straight from the broker's last bar. `TQQQ` is
    the label used before any bar has arrived (and under the mock broker,
    which has no live feed); it names what the ladder trades rather than
    implying a price exists.

    Passed down to `KillSwitch`, which renders it centred: that panel is on
    screen on every route, so the price rides along with the guarantee the
    kill switch already has rather than needing one of its own.
  */
  const last = status?.broker.lastPrices?.[0] ?? null;

  return (
    <html lang="en">
      <body className="bg-slate-950 text-slate-100 antialiased">
        <div className="mx-auto flex max-w-[100rem] flex-col gap-4 p-4 lg:p-6">
          <header className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Trading Platform</h1>
              <p className="text-xs text-slate-500">
                Dip ladder · risk manager is the only path to a broker
              </p>
            </div>
            <AutoRefresh />
          </header>

          <AlertBanner status={status} error={error} />

          {/* Always visible, and rendered even when the backend read failed. */}
          <KillSwitch
            engaged={killSwitch?.engaged ?? false}
            reason={killSwitch?.reason ?? null}
            changedAt={killSwitch?.changedAt ?? null}
            symbol={last?.symbol ?? 'TQQQ'}
            lastPrice={last}
          />

          {/*
            Beside Reconcile, in the header rather than in `EngineControls`, for
            the same reason: these controls are least useful against fixtures
            and most useful against a live Gateway, so they must not share that
            component's hidden-when-IB-is-bound gate.
          */}
          <div className="grid gap-4 lg:grid-cols-2">
            <ReconcileButton lastRun={status?.orderReconciliation ?? null} />
            <PendingOrders />
          </div>

          <Tabs />

          {children}
        </div>
      </body>
    </html>
  );
}
