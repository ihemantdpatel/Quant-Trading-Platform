/**
 * `/accounts/new` — create an account, and see the ones already created.
 *
 * A static segment beside `[accountId]`, so Next matches it first; the backend
 * reserves the alias `new` so no account can be shadowed by this page.
 *
 * The list pairs each definition with whether its daemon answers. A created
 * account whose daemon is not up yet — or refuses to boot, as a `LIVE` one will
 * until Story 15 — must read as "not running", never as missing.
 */

import Link from 'next/link';
import {
  accountPath,
  loadAccounts,
  loadManagedAccounts,
  type AccountEntry,
  type ManagedAccount,
} from '../../lib/api';
import { NewAccountForm } from './NewAccountForm';

export const dynamic = 'force-dynamic';

function daemonState(account: ManagedAccount, entries: AccountEntry[]): string {
  const entry = entries.find((candidate) => candidate.account?.alias === account.alias);

  if (!entry?.account) {
    return 'not running';
  }

  if (entry.error) {
    return entry.error;
  }

  return entry.account.broker.connected ? 'running' : 'running · broker disconnected';
}

export default async function NewAccountPage() {
  const [managed, entries] = await Promise.all([
    loadManagedAccounts().then(
      (accounts) => ({ accounts, error: null }),
      (error: unknown) => ({
        accounts: [] as ManagedAccount[],
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
    loadAccounts(),
  ]);

  return (
    <main className="space-y-4">
      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
          New account
        </h2>
        <p className="mt-1 mb-4 text-xs text-slate-500">
          Each account trades in its own backend process, alongside every other, through the same IB
          Gateway login. The account&apos;s daemon starts within a few seconds of creation and
          trades behind the same startup assertions, risk caps, loss breaker, and kill switch as
          every other account. Accounts cannot be edited or removed here yet.
        </p>
        <NewAccountForm />
      </section>

      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
          Created accounts
        </h2>

        {managed.error ? (
          <p role="alert" className="mt-2 text-xs text-red-300">
            Could not list created accounts: {managed.error}
          </p>
        ) : managed.accounts.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500">None yet.</p>
        ) : (
          <table className="mt-2 w-full text-left text-xs">
            <thead className="text-slate-500">
              <tr>
                <th className="py-1 pr-3 font-medium">Account</th>
                <th className="py-1 pr-3 font-medium">Mode</th>
                <th className="py-1 pr-3 font-medium">IB account</th>
                <th className="py-1 pr-3 font-medium">Equity</th>
                <th className="py-1 pr-3 font-medium">Allocation</th>
                <th className="py-1 pr-3 font-medium">Daemon</th>
              </tr>
            </thead>
            <tbody className="font-mono text-slate-300">
              {managed.accounts.map((account) => (
                <tr key={account.alias} className="border-t border-slate-800">
                  <td className="py-1 pr-3">
                    <Link
                      className="text-sky-300 hover:underline"
                      href={accountPath(account.alias)}
                    >
                      {account.label}
                    </Link>{' '}
                    <span className="text-slate-500">({account.alias})</span>
                  </td>
                  <td className="py-1 pr-3">{account.mode}</td>
                  <td className="py-1 pr-3">{account.ibAccountId ?? '—'}</td>
                  <td className="py-1 pr-3">{account.equity.toLocaleString('en-US')}</td>
                  <td className="py-1 pr-3">
                    {Object.entries(account.symbolCapital)
                      .map(([symbol, value]) => `${symbol} ${value.toLocaleString('en-US')}`)
                      .join(', ')}
                  </td>
                  <td className="py-1 pr-3">{daemonState(account, entries)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
