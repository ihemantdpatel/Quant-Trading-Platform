/**
 * The decision half of account registration: whether a daemon's alias and IB
 * account id agree with what the database already pinned. See
 * `AccountRegistrationService` for why the pairing is checked at all.
 *
 * Pure, and kept outside `repositories/prisma/` so it runs — and counts toward
 * coverage — in the ordinary suite rather than only against a live MySQL.
 */

export interface StoredAccount {
  id: string;
  ibAccountId: string | null;
  label: string;
}

export interface AccountRegistrationInput {
  alias: string;
  label: string;
  /** `undefined` under the mock broker: there is no broker account to pin. */
  ibAccountId: string | undefined;
  /**
   * True only once IB has confirmed the login manages `ibAccountId` — i.e. a
   * connect succeeded, which `checkManagedAccount` gates. **Nothing is pinned
   * before then.** Pinning the configured value at boot, before IB was asked,
   * once saved an alias typed into `IB_ACCOUNT_ID` as though it were an IB id,
   * and the pin then refused the corrected value on the next boot.
   *
   * An unconfirmed id is still *checked* against an existing pin — that check
   * is what refuses a copied `.env` — it is just never *written*.
   */
  confirmedByBroker: boolean;
}

export type AccountRegistrationPlan =
  | { action: 'CREATE'; ibAccountId: string | null }
  | { action: 'UPDATE'; ibAccountId: string | null; label: string }
  | { action: 'NONE' }
  | { action: 'REFUSE'; failure: string };

/**
 * Decides what registration should do, given what is already stored.
 *
 * Pure so every branch is testable without a database.
 *
 * - `existing` — the row for this alias, if any.
 * - `ownerOfIbId` — the alias currently holding the configured IB id, if any.
 */
export function planAccountRegistration(
  input: AccountRegistrationInput,
  existing: StoredAccount | null,
  ownerOfIbId: string | null,
): AccountRegistrationPlan {
  const configuredId = input.ibAccountId ?? null;

  if (configuredId !== null && ownerOfIbId !== null && ownerOfIbId !== input.alias) {
    return {
      action: 'REFUSE',
      failure:
        `IB account ${maskAccountId(configuredId)} is already registered to account ` +
        `"${ownerOfIbId}", not "${input.alias}". One broker account is traded by one alias — ` +
        "check IB_ACCOUNT_ID and ACCOUNT_ALIAS in this daemon's environment.",
    };
  }

  const pinnable = input.confirmedByBroker ? configuredId : null;

  if (existing === null) {
    return { action: 'CREATE', ibAccountId: pinnable };
  }

  if (
    existing.ibAccountId !== null &&
    configuredId !== null &&
    existing.ibAccountId !== configuredId
  ) {
    return {
      action: 'REFUSE',
      failure:
        `Account "${input.alias}" is pinned to IB account ${maskAccountId(existing.ibAccountId)}, ` +
        `but this daemon is configured with ${maskAccountId(configuredId)}. Its lots came from ` +
        "the pinned account's fills; reconciling them against another account's position " +
        'would be wrong. Fix IB_ACCOUNT_ID, or register the new account under its own alias.',
    };
  }

  // Pin on first IB boot; never *unpin* when a later boot runs on the mock
  // broker with no id — the pairing is a fact about the rows, not the process.
  const ibAccountId = existing.ibAccountId ?? pinnable;

  if (ibAccountId !== existing.ibAccountId || input.label !== existing.label) {
    return { action: 'UPDATE', ibAccountId, label: input.label };
  }

  return { action: 'NONE' };
}

/**
 * `DU1234567` → `DU•••567`. Enough to tell two accounts apart in a log line or
 * on the dashboard without reproducing the whole id everywhere it is shown.
 */
export function maskAccountId(id: string): string {
  if (id.length <= 5) {
    return '•'.repeat(id.length);
  }

  return `${id.slice(0, 2)}•••${id.slice(-3)}`;
}
