'use client';

/**
 * The account the current page belongs to, for the controls on it.
 *
 * Every Server Action takes the account explicitly (`actions.ts`), and this is
 * where a control gets it: from the `[accountId]` segment of the page it is
 * rendered on, provided once by that account's layout. A control rendered
 * outside any account — none are, today — reads `null`, and the action refuses
 * rather than defaulting to some account the operator did not pick.
 *
 * Also records the account as the last one visited, so `/` returns there.
 */

import { createContext, useContext, useEffect } from 'react';
import { LAST_ACCOUNT_COOKIE } from '../lib/api';

const AccountContext = createContext<string | null>(null);

export function AccountProvider({
  account,
  children,
}: {
  account: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    // A convenience for the landing redirect only. Nothing that acts reads it:
    // actions take the account from this context, never from the cookie.
    document.cookie = `${LAST_ACCOUNT_COOKIE}=${encodeURIComponent(account)}; path=/; max-age=31536000; samesite=lax`;
  }, [account]);

  return <AccountContext.Provider value={account}>{children}</AccountContext.Provider>;
}

/** The alias of the account whose page this control is on, or null outside one. */
export function useAccount(): string | null {
  return useContext(AccountContext);
}
