/**
 * Accounts created from the dashboard rather than written into
 * `accounts.config.ts`.
 *
 * The code registry still holds the account that predates this (`nuuixl118`);
 * every account added since lives in the `AccountDefinition` table, with its
 * creation recorded in the append-only `AccountDefinitionChange` log. The
 * supervisor (`src/supervisor/`) reads those rows and runs one daemon per
 * account, handing each its definition as `ACCOUNT_DEFINITION` — so the daemon
 * resolves its capital figures synchronously at import time exactly as it does
 * for a code-registry account, with no database read before config validation.
 *
 * Pure: the validation and the allocation of client id and port are decided
 * here so every branch is testable without a database or a process.
 */

import { z } from 'zod';
import { LossBasis } from '../risk/risk.config';
import { maskAccountId } from './account-registration';
import type { AccountDefinition } from './accounts.config';
import { ExecutionMode } from './execution-mode';

/**
 * Lower-case, URL-safe, and short: the alias is a row owner, a URL segment,
 * and part of every `clientOrderId` (`co-<alias>-N`), so anything IB or a URL
 * would have to escape is refused rather than encoded.
 */
export const ACCOUNT_ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/;

/**
 * Aliases a dashboard-created account may not take. `new` is the dashboard's
 * own `/accounts/new` route, which would shadow the account's pages.
 */
const RESERVED_ALIASES = new Set(['new']);

/** Same shape `config.schema.ts` checks `IB_ACCOUNT_ID` against. */
const IB_ACCOUNT_ID_PATTERN = /^[A-Z]{1,3}\d{4,}$/;

const positiveMoney = z.number().finite().positive();

/**
 * What the dashboard's form submits.
 *
 * `mode` is a single mode rather than a set: the daemon is started in it, and
 * `allowedModes` is `[mode]`, so `POST /mode` cannot later move the account
 * into a mode nobody chose for it. Choosing `LIVE` records permission only —
 * the startup assertions refuse to boot `LIVE` until Story 15, whatever this
 * row says.
 */
export const accountDefinitionInputSchema = z.object({
  alias: z
    .string()
    .trim()
    .regex(ACCOUNT_ALIAS_PATTERN, {
      message: '2–32 characters: lower-case letters, digits, and hyphens, starting alphanumeric',
    })
    .refine((alias) => !RESERVED_ALIASES.has(alias), { message: 'is reserved' }),
  label: z.string().trim().min(1).max(128),
  mode: z.enum([ExecutionMode.PAPER, ExecutionMode.LIVE]),
  ibAccountId: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    z
      .string()
      .trim()
      .regex(IB_ACCOUNT_ID_PATTERN, {
        message: 'must be an IB account id such as DU1234567 — not the alias or a login name',
      })
      .nullable()
      .default(null),
  ),
  /**
   * USD only. The risk layer converts nothing and `assertSingleCurrency`
   * refuses a mix, so accepting another currency here would only create an
   * account whose daemon refuses to boot.
   */
  currency: z.literal('USD').default('USD'),
  equity: positiveMoney,
  symbolCapital: z.record(z.string().trim().min(1), positiveMoney),
  dailyLossThreshold: positiveMoney,
  dailyLossBasis: z.nativeEnum(LossBasis).default(LossBasis.REALIZED_AND_UNREALIZED),
  reason: z.string().trim().max(512).optional(),
});

export type AccountDefinitionInput = z.infer<typeof accountDefinitionInputSchema>;

/** A stored definition: the operator's input plus what the system allocated. */
export interface StoredAccountDefinition {
  alias: string;
  label: string;
  mode: ExecutionMode;
  currency: string;
  equity: number;
  symbolCapital: Record<string, number>;
  dailyLossThreshold: number;
  dailyLossBasis: LossBasis;
  /** The full id. Masked before it leaves the API. */
  ibAccountId: string | null;
  /** IB client id for this daemon; it also uses `ibClientId + 1` for executions. */
  ibClientId: number;
  /** Port the daemon listens on inside the backend container. */
  port: number;
  createdAt: string;
}

/**
 * Client ids handed to dashboard-created accounts start here and step by two.
 *
 * Two because each daemon opens a second IB connection at `clientId + 1` for
 * its execution stream (`stoqey-ib-socket.ts`) and IB drops a connection that
 * reuses a live client id. Starting at 11 leaves 1–10 to the primary daemon and
 * any hand-configured compose daemons, which conventionally take 1, 3, 5….
 */
export const MANAGED_CLIENT_ID_BASE = 11;

/** Ports for dashboard-created daemons, inside the backend container. */
export const MANAGED_PORT_BASE = 3101;

export interface DefinitionContext {
  /** Aliases in `accounts.config.ts`. */
  codeAliases: readonly string[];
  /** Every `Account` row: an alias another daemon already wrote rows under. */
  registeredAccounts: readonly { id: string; ibAccountId: string | null }[];
  /** Every dashboard-created definition. */
  definitions: readonly StoredAccountDefinition[];
  /** The IB id of the daemon serving the request, which is already in use. */
  servingIbAccountId: string | undefined;
  /**
   * True when daemons bind IB: the new daemon inherits `IB_HOST`, and its
   * config refuses to boot against IB without an account id to filter on.
   */
  ibAccountIdRequired: boolean;
  /** The ladder's traded symbol; an allocation for it is mandatory. */
  requiredSymbol: string;
  now: string;
}

export type DefinitionPlan =
  { ok: true; definition: StoredAccountDefinition } | { ok: false; failures: string[] };

/**
 * Decides whether an input may become a new account, and allocates its client
 * id and port.
 *
 * Every refusal here is a daemon that would otherwise start and then refuse to
 * boot, or — worse — boot against rows or a broker account another alias owns.
 * Catching it at creation keeps the failure in front of the operator who made
 * it rather than in a restart loop in the supervisor's log.
 */
export function planAccountDefinition(
  input: AccountDefinitionInput,
  context: DefinitionContext,
): DefinitionPlan {
  const failures: string[] = [];
  const alias = input.alias;

  if (context.codeAliases.includes(alias)) {
    failures.push(`alias "${alias}" is defined in accounts.config.ts`);
  } else if (context.definitions.some((definition) => definition.alias === alias)) {
    failures.push(`alias "${alias}" already exists`);
  } else if (context.registeredAccounts.some((account) => account.id === alias)) {
    // Rows already exist under this alias from a daemon configured by hand. A
    // new account taking the name would inherit that account's lots.
    failures.push(`alias "${alias}" already owns trading records from another daemon`);
  }

  const ibAccountId = input.ibAccountId;

  if (ibAccountId === null) {
    if (context.ibAccountIdRequired) {
      failures.push('an IB account id is required — daemons here trade through IB');
    }
  } else {
    const owner =
      context.registeredAccounts.find((account) => account.ibAccountId === ibAccountId)?.id ??
      context.definitions.find((definition) => definition.ibAccountId === ibAccountId)?.alias ??
      (context.servingIbAccountId === ibAccountId ? 'this daemon' : null);

    if (owner !== null) {
      failures.push(
        `IB account ${maskAccountId(ibAccountId)} is already traded by "${owner}" — one broker account, one alias`,
      );
    }
  }

  if (!(input.symbolCapital[context.requiredSymbol] > 0)) {
    failures.push(`symbolCapital must allocate a positive amount to ${context.requiredSymbol}`);
  }

  if (failures.length > 0) {
    return { ok: false, failures };
  }

  const clientIds = context.definitions.map((definition) => definition.ibClientId);
  const ports = context.definitions.map((definition) => definition.port);

  return {
    ok: true,
    definition: {
      alias,
      label: input.label,
      mode: input.mode,
      currency: input.currency,
      equity: input.equity,
      symbolCapital: { ...input.symbolCapital },
      dailyLossThreshold: input.dailyLossThreshold,
      dailyLossBasis: input.dailyLossBasis,
      ibAccountId,
      ibClientId: clientIds.length === 0 ? MANAGED_CLIENT_ID_BASE : Math.max(...clientIds) + 2,
      port: ports.length === 0 ? MANAGED_PORT_BASE : Math.max(...ports) + 1,
      createdAt: context.now,
    },
  };
}

/** The registry shape a daemon trades from. */
export function toAccountDefinition(stored: StoredAccountDefinition): AccountDefinition {
  return {
    alias: stored.alias,
    label: stored.label,
    allowedModes: [stored.mode],
    currency: stored.currency,
    equity: stored.equity,
    symbolCapital: { ...stored.symbolCapital },
    dailyLossThreshold: stored.dailyLossThreshold,
    dailyLossBasis: stored.dailyLossBasis,
  };
}

const accountDefinitionEnvSchema = z.object({
  alias: z.string().regex(ACCOUNT_ALIAS_PATTERN),
  label: z.string().min(1),
  allowedModes: z.array(z.nativeEnum(ExecutionMode)).min(1),
  currency: z.string().min(1),
  equity: positiveMoney,
  symbolCapital: z.record(z.string(), positiveMoney),
  dailyLossThreshold: positiveMoney,
  dailyLossBasis: z.nativeEnum(LossBasis),
});

/**
 * Parses the `ACCOUNT_DEFINITION` the supervisor passes a daemon.
 *
 * Returns `null` for anything malformed rather than throwing: it is read at
 * import time, before config validation can report it legibly, and
 * `config.schema.ts` refuses the boot on the same input with a proper message.
 */
export function parseAccountDefinitionEnv(raw: string | undefined): AccountDefinition | null {
  if (raw === undefined || raw.trim() === '') {
    return null;
  }

  try {
    const result = accountDefinitionEnvSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
