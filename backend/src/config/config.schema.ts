import { z } from 'zod';
import { parseAccountDefinitionEnv } from './account-definition';
import { ACCOUNTS, DEFAULT_ACCOUNT_ALIAS } from './accounts.config';
import { DEFAULT_EXECUTION_MODE, ExecutionMode } from './execution-mode';

/** Compose passes unset variables as `''`; blank and absent mean the same thing. */
const blankAsUnset = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/**
 * Environment schema. Validation runs at startup and throws — a misconfigured
 * EXECUTION_MODE must never fall back to a silent default, because the fallback
 * would be a mode the operator did not ask for.
 */
export const configSchema = z
  .object({
    /**
     * The account this daemon trades — a key of `ACCOUNTS` in
     * `accounts.config.ts`. One daemon trades one account; a second account is a
     * second daemon.
     *
     * An alias the registry does not know is refused rather than defaulted: a
     * daemon that silently fell back to another account's capital figures would
     * size real orders from numbers chosen for a different balance.
     */
    ACCOUNT_ALIAS: z.preprocess(blankAsUnset, z.string().trim().default(DEFAULT_ACCOUNT_ALIAS)),
    /**
     * A dashboard-created account's definition, as JSON. Set by the supervisor
     * (`src/supervisor/`) for the daemons it starts; never by hand. Checked in
     * the refinement below together with `ACCOUNT_ALIAS`.
     */
    ACCOUNT_DEFINITION: z.preprocess(blankAsUnset, z.string().optional()),
    /**
     * The IB account id (`DU…`/`U…`) this daemon's alias trades. Kept in the
     * environment rather than `accounts.config.ts` so it never enters git.
     *
     * **Required whenever IB is bound** (see the refinement below). Every IB
     * response is filtered to this id and every order is sent with it, so a login
     * that sees several accounts cannot leak one account's positions into another
     * account's lot-sum assertion — which is exactly what an unfiltered read did.
     */
    IB_ACCOUNT_ID: z.preprocess(
      blankAsUnset,
      z
        .string()
        .trim()
        // IB ids are an upper-case prefix and digits — U1234567 (live),
        // DU1234567 (paper), F…/DF… (advisor masters). Checked because the
        // alias and the login username are the obvious wrong things to paste
        // here, and one of them was: it failed only later, at connect.
        .regex(/^[A-Z]{1,3}\d{4,}$/, {
          message:
            'must be an IB account id such as U1234567 or DU1234567 — not the ACCOUNT_ALIAS or the IB login username',
        })
        .optional(),
    ),
    EXECUTION_MODE: z.nativeEnum(ExecutionMode).default(DEFAULT_EXECUTION_MODE),
    PORT: z.coerce.number().int().positive().default(3000),
    /**
     * MySQL connection string (Story 8).
     *
     * **Optional, and its presence is what selects durable storage.** With it
     * set the engine binds the Prisma repositories; without it, the in-memory
     * ones. Keeping it optional preserves the Story 0 property that the whole
     * stack runs and tests green with zero external dependencies, which is what
     * makes the mock-data-first sequencing work (`stories.md:8`).
     *
     * Validated as a URL rather than accepted as any string: a typo'd DSN would
     * otherwise surface as a connection failure at the first repository call —
     * mid-replay, after the engine has already reported itself healthy.
     */
    DATABASE_URL: z.string().url().optional(),
    /**
     * IB Gateway host (Story 10).
     *
     * **Optional, and its presence selects the IB broker** over the mock —
     * deliberately the same convention `DATABASE_URL` uses for storage. A
     * separate `BROKER=IB|MOCK` flag could disagree with the connection settings
     * and leave the engine believing it is trading through a gateway it was never
     * given an address for; one variable cannot contradict itself
     * (`repositories.module.ts`).
     *
     * Unset keeps the Story 0 property that the whole stack runs and tests green
     * with zero external dependencies. `GET /status` reports which broker is
     * live.
     *
     * **An empty string means unset, not invalid.** Compose passes `IB_HOST:
     * ${IB_HOST:-}` (`docker-compose.yml`), which supplies `''` rather than
     * omitting the variable — so without this, `docker compose up` with no `.env`
     * fails validation at boot and the backend never starts. That is the default
     * path for a new checkout, where the mock broker is exactly what should bind.
     * Blank is coerced to `undefined` so "absent" and "explicitly blank" select
     * the same broker; a non-empty value is still validated.
     */
    IB_HOST: z.preprocess(blankAsUnset, z.string().min(1).optional()),
    /** 4001 live / 4002 paper are IB Gateway's defaults; 7496/7497 are TWS. */
    IB_PORT: z.coerce.number().int().positive().default(4002),
    /**
     * IB requires a distinct client id per connection. Fixed rather than random
     * so a reconnect reclaims the same session instead of leaving IB holding the
     * previous one until it times out.
     */
    IB_CLIENT_ID: z.coerce.number().int().nonnegative().default(1),
  })
  .superRefine((config, context) => {
    const inRegistry = Object.prototype.hasOwnProperty.call(ACCOUNTS, config.ACCOUNT_ALIAS);

    if (config.ACCOUNT_DEFINITION === undefined) {
      if (!inRegistry) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ACCOUNT_ALIAS'],
          message: `must be one of ${Object.keys(ACCOUNTS).join(', ')} (accounts.config.ts), or a dashboard-created account started by the supervisor`,
        });
      }
    } else if (inRegistry) {
      // Reviewed source defines this account; an environment variable must not
      // be able to substitute other capital figures for it.
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ACCOUNT_DEFINITION'],
        message: `must not be set for "${config.ACCOUNT_ALIAS}", which accounts.config.ts defines`,
      });
    } else {
      const defined = parseAccountDefinitionEnv(config.ACCOUNT_DEFINITION);

      if (defined === null || defined.alias !== config.ACCOUNT_ALIAS) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ACCOUNT_DEFINITION'],
          message: `is not a valid account definition for "${config.ACCOUNT_ALIAS}"`,
        });
      }
    }

    // Without an id to filter on, an IB login that manages more than one
    // account would report their positions merged — and reconciliation would
    // compare this account's lots against another account's shares.
    if (config.IB_HOST !== undefined && config.IB_ACCOUNT_ID === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['IB_ACCOUNT_ID'],
        message: 'is required when IB_HOST is set (the IB account id this daemon trades)',
      });
    }
  });

export type AppConfig = z.infer<typeof configSchema>;

/**
 * Wrapped so a Zod failure surfaces as a readable startup error naming the
 * offending variable and its allowed values, rather than a raw ZodError dump.
 */
export function validateConfig(env: Record<string, unknown>): AppConfig {
  const result = configSchema.safeParse(env);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration — ${details}`);
  }

  return result.data;
}
