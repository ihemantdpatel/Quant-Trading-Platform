import { z } from 'zod';
import { DEFAULT_EXECUTION_MODE, ExecutionMode } from './execution-mode';

/**
 * Environment schema. Validation runs at startup and throws — a misconfigured
 * EXECUTION_MODE must never fall back to a silent default, because the fallback
 * would be a mode the operator did not ask for.
 */
export const configSchema = z.object({
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
   */
  IB_HOST: z.string().min(1).optional(),
  /** 4001 live / 4002 paper are IB Gateway's defaults; 7496/7497 are TWS. */
  IB_PORT: z.coerce.number().int().positive().default(4002),
  /**
   * IB requires a distinct client id per connection. Fixed rather than random
   * so a reconnect reclaims the same session instead of leaving IB holding the
   * previous one until it times out.
   */
  IB_CLIENT_ID: z.coerce.number().int().nonnegative().default(1),
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
