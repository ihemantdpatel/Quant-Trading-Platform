/**
 * The engine's order ids, and which account's they are.
 *
 * `clientOrderId` travels to IB as `orderRef` and comes back on every open
 * order, completed order, and execution — it is the only identifier that
 * survives a restart. With one daemon per account sharing a database (and
 * possibly an IB login), it must also say *whose* order it is: two daemons each
 * counting from `co-1` would hand IB two orders with one `orderRef`, and each
 * daemon's reconciliation could adopt the other's.
 *
 * - `co-<alias>-<n>` — every id issued since accounts existed.
 * - `co-<n>` — legacy, issued before accounts existed, and therefore always the
 *   default account's: that was the only account there was.
 */

import { DEFAULT_ACCOUNT_ALIAS } from '../config/accounts.config';

const LEGACY = /^co-(\d+)$/;
const SCOPED = /^co-(.+)-(\d+)$/;

/**
 * Formats the `sequence`-th id. `accountAlias` null issues the legacy form —
 * kept for engines constructed without an account (the unit suites), whose
 * expectations were written against it.
 */
export function formatClientOrderId(sequence: number, accountAlias: string | null): string {
  return accountAlias === null ? `co-${sequence}` : `co-${accountAlias}-${sequence}`;
}

/**
 * The sequence number of an id this account issued, or `null` for anyone
 * else's — another account's, or an id this generator never produced.
 *
 * Legacy `co-N` ids count for every alias: one sequence spans the change, so
 * the first scoped id continues past the last legacy one rather than restarting
 * at 1. They can only ever be in the default account's rows anyway.
 */
export function clientOrderSequenceOf(id: string, accountAlias: string | null): number | null {
  const legacy = LEGACY.exec(id);

  if (legacy) {
    return Number(legacy[1]);
  }

  const scoped = SCOPED.exec(id);

  if (scoped && accountAlias !== null && scoped[1] === accountAlias) {
    return Number(scoped[2]);
  }

  return null;
}

/**
 * Whether an order id could belong to `accountAlias`.
 *
 * **Refuses only on positive evidence of another account** — an id in this
 * generator's scoped form naming a different alias, or a legacy id seen by a
 * non-default account. Anything else (an id this generator never issued) is
 * left to the caller's existing rules, which already refuse to attach a rung
 * to an order they cannot explain.
 */
export function ownsClientOrderId(id: string, accountAlias: string): boolean {
  if (LEGACY.test(id)) {
    return accountAlias === DEFAULT_ACCOUNT_ALIAS;
  }

  const scoped = SCOPED.exec(id);

  return scoped ? scoped[1] === accountAlias : true;
}
