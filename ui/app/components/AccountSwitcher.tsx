'use client';

/**
 * Picks which account's pages are on screen. **It changes what is viewed,
 * never what trades** — every account's daemon keeps running whichever one is
 * selected, and switching sends no request to any of them.
 *
 * The selection lives in the URL (`/accounts/<alias>/…`), not in client state,
 * so a bookmark or a second tab always shows the account it names and a
 * reload cannot silently land on a different one.
 *
 * Every configured daemon is listed, including one that did not answer: it is
 * shown and disabled rather than dropped, because an account that vanished
 * from the list reads as "not configured", and an operator should be told it
 * is unreachable.
 */

import { usePathname, useRouter } from 'next/navigation';
import { accountFromPath, accountPath, type AccountEntry } from '../lib/api';

type Health = 'ok' | 'halted' | 'disconnected' | 'unreachable';

function healthOf(entry: AccountEntry): Health {
  if (!entry.account || entry.error) {
    return 'unreachable';
  }

  if (!entry.account.broker.connected) {
    return 'disconnected';
  }

  return entry.account.halted ? 'halted' : 'ok';
}

const HEALTH_DOT: Record<Health, string> = {
  ok: 'bg-emerald-400',
  halted: 'bg-amber-400',
  disconnected: 'bg-red-500',
  unreachable: 'bg-slate-600',
};

const HEALTH_LABEL: Record<Health, string> = {
  ok: 'healthy',
  halted: 'halted',
  disconnected: 'broker disconnected',
  unreachable: 'unreachable',
};

function optionLabel(entry: AccountEntry): string {
  if (!entry.account) {
    return `${entry.url} — unreachable`;
  }

  const id = entry.account.ibAccountId ? ` (${entry.account.ibAccountId})` : '';
  const health = healthOf(entry);

  return `${entry.account.label}${id} · ${entry.account.mode}${health === 'ok' ? '' : ` · ${HEALTH_LABEL[health]}`}`;
}

export function AccountSwitcher({ accounts }: { accounts: AccountEntry[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const current = accountFromPath(pathname);
  const selected = accounts.find(
    (entry) => entry.account !== null && entry.account.alias === current?.account,
  );

  function choose(alias: string) {
    // Keep the operator on the same tab of the other account (Parameters stays
    // Parameters). From a page outside any account, land on its Execution tab.
    router.push(accountPath(alias, current?.rest ?? ''));
  }

  const health = selected ? healthOf(selected) : null;
  const mode = selected?.account?.mode ?? null;

  return (
    <div className="flex items-center gap-2" aria-label="Account" role="group">
      {health && (
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${HEALTH_DOT[health]}`}
          title={HEALTH_LABEL[health]}
          data-testid="account-health"
          aria-label={`account ${HEALTH_LABEL[health]}`}
        />
      )}

      <select
        aria-label="Switch account"
        value={selected?.account?.alias ?? ''}
        onChange={(event) => choose(event.target.value)}
        className="rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100"
      >
        {!selected && (
          <option value="" disabled>
            {current ? `${current.account} — not available` : 'Select account…'}
          </option>
        )}
        {accounts.map((entry) => (
          <option
            key={entry.url}
            value={entry.account?.alias ?? entry.url}
            disabled={!entry.account || entry.error !== null}
          >
            {optionLabel(entry)}
          </option>
        ))}
      </select>

      {mode && (
        <span
          data-testid="account-mode"
          className={`rounded px-2 py-0.5 font-mono text-xs font-semibold ${
            mode === 'LIVE' ? 'bg-red-600 text-white' : 'bg-sky-900 text-sky-200'
          }`}
        >
          {mode}
        </span>
      )}
    </div>
  );
}
