/**
 * The decisions the supervisor makes, kept pure so each is testable without
 * forking a process: what environment a daemon gets, how long to wait before
 * restarting one, and which daemons to start or stop when the registry changes.
 */

import { StoredAccountDefinition, toAccountDefinition } from '../config/account-definition';

type Env = Record<string, string | undefined>;

/**
 * Variables that describe *one* daemon and must never leak from the
 * supervisor's own environment into another account's daemon. Each is set
 * explicitly below; inheriting any of them would, for example, hand a new
 * account the primary daemon's `IB_ACCOUNT_ID` — the broker account whose
 * positions it would then reconcile against.
 */
const PER_DAEMON_VARIABLES = [
  'ACCOUNT_ALIAS',
  'ACCOUNT_DEFINITION',
  'IB_ACCOUNT_ID',
  'IB_CLIENT_ID',
  'EXECUTION_MODE',
  'PORT',
] as const;

/**
 * The environment a dashboard-created account's daemon is started with.
 *
 * Everything shared — `DATABASE_URL`, `IB_HOST`, `IB_PORT` — is inherited, so
 * every account reaches the same database and the same Gateway login. What
 * identifies the account is replaced wholesale.
 */
export function childEnvironment(definition: StoredAccountDefinition, base: Env): Env {
  const env: Env = { ...base };

  for (const name of PER_DAEMON_VARIABLES) {
    delete env[name];
  }

  return {
    ...env,
    ACCOUNT_ALIAS: definition.alias,
    ACCOUNT_DEFINITION: JSON.stringify(toAccountDefinition(definition)),
    EXECUTION_MODE: definition.mode,
    PORT: String(definition.port),
    IB_CLIENT_ID: String(definition.ibClientId),
    // Absent when none was given — the daemon's config then refuses to bind IB
    // without one, and under the mock broker reports no id rather than `""`.
    ...(definition.ibAccountId === null ? {} : { IB_ACCOUNT_ID: definition.ibAccountId }),
  };
}

/**
 * The primary daemon's environment: the supervisor's own, minus any
 * `ACCOUNT_DEFINITION` — the primary account is defined by reviewed source, and
 * its daemon's config refuses one anyway.
 */
export function primaryEnvironment(base: Env): Env {
  const env: Env = { ...base };
  delete env.ACCOUNT_DEFINITION;
  return env;
}

export const RESTART_BASE_MS = 1_000;

/**
 * The cap. A daemon refusing to boot on a configuration error — a `LIVE`
 * account before Story 15, a login that does not manage its IB id — will keep
 * refusing, so it is retried slowly rather than spun; but it is still retried,
 * because a daemon that stays dead with nothing trying is a fault that latches.
 */
export const RESTART_MAX_MS = 5 * 60_000;

/**
 * A daemon that ran at least this long before exiting is treated as having
 * been healthy, so its next failure starts the backoff from the beginning.
 */
export const STABLE_RUN_MS = 60_000;

/** Delay before the `failures`-th consecutive restart (1-based). */
export function restartDelayMs(failures: number): number {
  const exponent = Math.max(0, failures - 1);
  return Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** Math.min(exponent, 30));
}

export interface ChildChanges {
  start: StoredAccountDefinition[];
  stop: string[];
}

/**
 * Which daemons to start and stop to match the registry.
 *
 * Keyed by alias only. A definition cannot change after creation, so a
 * difference in content under the same alias is not something to act on — and
 * restarting a trading daemon because a row was edited by hand would be the
 * supervisor deciding something no operator asked for.
 */
export function planChildChanges(
  running: readonly string[],
  definitions: readonly StoredAccountDefinition[],
): ChildChanges {
  const wanted = new Set(definitions.map((definition) => definition.alias));
  const current = new Set(running);

  return {
    start: definitions.filter((definition) => !current.has(definition.alias)),
    stop: running.filter((alias) => !wanted.has(alias)),
  };
}
