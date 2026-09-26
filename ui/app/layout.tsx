/**
 * The operator shell, shared by every route.
 *
 * Holds what spans accounts: the account switcher, the kill-all control, the
 * refresh toggle, and the tabs. Each account's own kill switch, alert banner,
 * and order controls live in `accounts/[accountId]/layout.tsx`, where the
 * account they act on is known.
 *
 * **A kill control is on screen on every route** (`stories.md:465`,
 * `PRD.md:383`). On an account's pages that is its own kill switch; on
 * `/backtest`, which belongs to no account, it is kill-all, which is here for
 * exactly that reason.
 *
 * **This component must never throw.** `loadAccounts` never rejects — an
 * unreachable daemon is an entry with an error, not an exception — so the
 * header, and kill-all with it, renders even with every backend down, which is
 * precisely when an operator reaches for it.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import { AccountSwitcher } from './components/AccountSwitcher';
import { AutoRefresh } from './components/AutoRefresh';
import { KillAllButton } from './components/KillAllButton';
import { Tabs } from './components/Tabs';
import { loadAccounts, pickDefaultAccount } from './lib/api';

export const metadata: Metadata = {
  title: 'Trading Platform',
  description: 'Multi-strategy quantitative trading control dashboard',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const accounts = await loadAccounts();

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
            <div className="flex flex-wrap items-center gap-3">
              <AccountSwitcher accounts={accounts} />
              <Link
                href="/accounts/new"
                className="rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:border-slate-500 hover:text-slate-100"
              >
                Add account
              </Link>
              <KillAllButton />
              <AutoRefresh />
            </div>
          </header>

          {/*
            The tabs follow the account in the URL; on a page with no account
            (`/backtest`) their account links go to the first reachable one.
          */}
          <Tabs fallbackAccount={pickDefaultAccount(accounts, null)} />

          {children}
        </div>
      </body>
    </html>
  );
}
