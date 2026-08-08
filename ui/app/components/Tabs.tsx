'use client';

/**
 * Top-level navigation between the three views.
 *
 * These are **real routes**, not client-side panels, and the links are ordinary
 * `next/link` navigations. That is what preserves per-segment error boundaries:
 * a render failure in the backtest view is caught by `backtest/error.tsx` and
 * cannot take down the operator's control surface, which lives in the layout
 * above this bar. Client-side tab state under one route would put all three
 * views inside a single boundary and forfeit that.
 *
 * A Client Component only because the active tab depends on the current path.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/', label: 'Execution' },
  { href: '/parameters', label: 'Parameters' },
  { href: '/backtest', label: 'Backtesting' },
] as const;

export function Tabs() {
  const pathname = usePathname();

  return (
    <nav aria-label="Views" className="flex gap-2 border-b border-slate-800 pb-3">
      {TABS.map((tab) => {
        // Execution is at the root, so it would prefix-match every route.
        const active = tab.href === '/' ? pathname === '/' : pathname.startsWith(tab.href);

        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={`rounded border px-3 py-1.5 text-sm font-medium transition ${
              active
                ? 'border-slate-600 bg-slate-800 text-slate-200'
                : 'border-slate-700 text-slate-400 hover:border-slate-500 hover:bg-slate-800 hover:text-slate-200'
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
