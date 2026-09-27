'use client';

/**
 * Top-level navigation between the three views.
 *
 * These are **real routes**, not client-side panels, and the links are ordinary
 * `next/link` navigations. That is what preserves per-segment error boundaries:
 * a render failure in the backtest view is caught by `backtest/error.tsx` and
 * cannot take down the operator's control surface, which lives in the root and
 * account layouts rather than in any one view. Client-side tab state under one route would put all three
 * views inside a single boundary and forfeit that.
 *
 * Execution and Parameters belong to an account and link within whichever
 * account is on screen; Backtesting belongs to none. On a page with no account
 * in its path, the account links go to `fallbackAccount` — or are omitted when
 * no account is reachable, rather than linking to a page that could only fail.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { accountFromPath, accountPath } from '../lib/api';

export function Tabs({ fallbackAccount = null }: { fallbackAccount?: string | null }) {
  const pathname = usePathname();
  const current = accountFromPath(pathname);
  const account = current?.account ?? fallbackAccount;

  const tabs = [
    ...(account
      ? [
          { href: accountPath(account), label: 'Execution', active: current?.rest === '' },
          {
            href: accountPath(account, '/parameters'),
            label: 'Parameters',
            active: current?.rest.startsWith('/parameters') ?? false,
          },
        ]
      : []),
    { href: '/backtest', label: 'Backtesting', active: pathname.startsWith('/backtest') },
  ];

  return (
    <nav aria-label="Views" className="flex gap-2 border-b border-slate-800 pb-3">
      {tabs.map((tab) => (
        <Link
          key={tab.label}
          href={tab.href}
          aria-current={tab.active ? 'page' : undefined}
          className={`rounded border px-3 py-1.5 text-sm font-medium transition ${
            tab.active
              ? 'border-slate-600 bg-slate-800 text-slate-200'
              : 'border-slate-700 text-slate-400 hover:border-slate-500 hover:bg-slate-800 hover:text-slate-200'
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
