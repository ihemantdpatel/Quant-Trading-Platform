/**
 * `/parameters` predates accounts. Kept as a redirect so a bookmark lands on
 * the same tab of the account `/` would choose, rather than on a 404.
 */

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { accountPath, LAST_ACCOUNT_COOKIE, loadAccounts, pickDefaultAccount } from '../lib/api';

export const dynamic = 'force-dynamic';

export default async function LegacyParameters() {
  const preferred = (await cookies()).get(LAST_ACCOUNT_COOKIE)?.value;
  const target = pickDefaultAccount(
    await loadAccounts(),
    preferred ? decodeURIComponent(preferred) : null,
  );

  redirect(target ? accountPath(target, '/parameters') : '/');
}
