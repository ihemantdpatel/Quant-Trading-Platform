/**
 * `/` belongs to no account, so it sends the operator to one: the account last
 * viewed if its daemon still answers, otherwise the first that does.
 *
 * When **no** daemon answers there is nowhere safe to send them — every
 * control on an account page would fail — so this page lists each configured
 * backend and why it could not be reached. Kill-all stays in the header above
 * it throughout.
 */

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { accountPath, LAST_ACCOUNT_COOKIE, loadAccounts, pickDefaultAccount } from './lib/api';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const accounts = await loadAccounts();
  const preferred = (await cookies()).get(LAST_ACCOUNT_COOKIE)?.value;
  const target = pickDefaultAccount(accounts, preferred ? decodeURIComponent(preferred) : null);

  if (target) {
    redirect(accountPath(target));
  }

  return (
    <main
      role="alert"
      className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-200"
    >
      <p className="font-semibold">No account backend is reachable.</p>
      <ul className="mt-2 space-y-1 font-mono text-xs">
        {accounts.map((entry) => (
          <li key={entry.url}>
            {entry.url} — {entry.error ?? 'answered, but not usable'}
          </li>
        ))}
      </ul>
    </main>
  );
}
