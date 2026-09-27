/**
 * The account registry — every IB account this system may trade, and the
 * capital decisions that belong to each.
 *
 * **One daemon trades one account.** Each backend process is started with
 * `ACCOUNT_ALIAS` naming an entry here, and everything it persists is owned by
 * that account. Two accounts trade concurrently by running two daemons against
 * one database, so a crash, a stuck timer, or a halt in one cannot reach the
 * other — isolation comes from the operating system rather than from every
 * singleton service remembering to key its state by account. See
 * `docs/decisions/accounts.md`.
 *
 * **Keyed by an alias, never by the IB account id.** The id (`DU…`/`U…`) is
 * supplied per daemon as `IB_ACCOUNT_ID` from a gitignored `.env`, so it never
 * enters the repository; the alias is what migrations, rows, and the dashboard
 * name. `AccountRegistrationService` pins the alias to the id on first boot and
 * refuses a later boot that pairs them differently.
 *
 * A reviewed source file rather than environment variables, for the same reason
 * `capital.config.ts` always was one: which account may trade, in which modes,
 * and how much it may deploy belong in a diff someone read.
 */

import { ExecutionMode } from './execution-mode';
import { LossBasis } from '../risk/risk.config';
import { parseAccountDefinitionEnv } from './account-definition';

export interface AccountDefinition {
  /** Registry key, row owner, and URL segment. Not secret. */
  alias: string;
  /** Human-readable name shown in the dashboard's account switcher. */
  label: string;
  /**
   * Modes this account may boot into. A paper account listing only `PAPER`
   * cannot be started as `LIVE` by a copied environment, independently of the
   * `allowLiveTrading` flag — two signals, each able to refuse.
   */
  allowedModes: readonly ExecutionMode[];
  /** The currency every figure below is expressed in. */
  currency: string;
  /**
   * The currency `equity` is denominated in, when that is the account's base
   * currency rather than `currency` (Story 15). Converted at a live rate per
   * evaluation; a stale or missing rate blocks new entries. Omitted means
   * `equity` is already in `currency` and nothing is converted.
   */
  equityCurrency?: string;
  /** Equity the 60% global cap is measured against, in `equityCurrency` ?? `currency`. */
  equity: number;
  /** Per-symbol allocation — expected deployment, not a ceiling. */
  symbolCapital: Readonly<Record<string, number>>;
  /**
   * Loss at which the breaker halts new submission. Positive magnitude; `null`
   * only for an unconfigured account, which the startup assertion refuses.
   */
  dailyLossThreshold: number | null;
  dailyLossBasis: LossBasis;
}

/**
 * The account a daemon trades when `ACCOUNT_ALIAS` is unset.
 *
 * A default rather than a required variable so the zero-dependency path —
 * `npm test`, `npm start` with no environment — keeps working exactly as it did
 * before accounts existed. It names the one account that existed then, so a
 * deployment that predates this change continues trading the account it always
 * traded.
 */
export const DEFAULT_ACCOUNT_ALIAS = 'nuuixl118';

export const ACCOUNTS: Readonly<Record<string, AccountDefinition>> = {
  nuuixl118: {
    alias: 'nuuixl118',
    label: 'nuuixl118',
    allowedModes: [ExecutionMode.PAPER],

    /**
     * **USD**, matching TQQQ: every cap and limit is expressed in the traded
     * currency, because position notional is summed in it and never converted.
     *
     * **This is not the account's base currency** — IB reports it in CAD, which
     * is `equityCurrency` below. Only equity is converted, at a live `USD.CAD`
     * rate (Story 15), replacing a hand conversion whose rate went stale the day
     * it was written.
     *
     * `assertSingleCurrency` still does its job: it compares this against the
     * instruments traded, and would fire the moment a non-USD instrument is
     * configured.
     */
    currency: 'USD',

    /**
     * The account's real base currency. Because it differs from `currency`, the
     * risk manager converts `equity` at a live `USD.CAD` ask from IB before
     * measuring the global cap, and a stale or unavailable rate blocks new
     * entries (`risk/fx-rate.ts`).
     */
    equityCurrency: 'CAD',

    /**
     * In **CAD**, converted to USD per evaluation.
     *
     * A static figure rather than a value read from the broker at boot, and that
     * is a deliberate trade-off. `RISK_CONFIG` is built by a **synchronous**
     * factory and asserted in `RiskModule.onModuleInit`, whereas
     * `getAccountSummary()` is async and needs a connected broker — and
     * `StartupSequence.run()` is pointedly *not* awaited so the HTTP server never
     * waits on IB.
     *
     * **One kind of staleness remains, down from two.** The rate is live; the
     * *balance* is still the 248,973.68 CAD IB reported on 2026-08-14. 242,800 is
     * that reading less ~2.5%, a buffer that now only has to absorb balance
     * drift. It is exactly the old 175,000 USD figure at that day's rate
     * (1.3874), so the cap is unchanged at that rate and now moves with the
     * market. See `docs/decisions/capital-allocation.md`.
     */
    equity: 242_800,

    /**
     * A full 5-rung flat ladder deploys 125% of this (`5 × 25%`), so 40,000
     * peaks at 50,000 against a 105,000 global cap. The headroom is intentional:
     * sizing this so a full ladder only just fits would make the *deepest* rung —
     * the one fired in the worst drawdown — the rung the risk manager resizes
     * away. Kept at 40,000 rather than restored to 50,000: the headroom was
     * chosen to absorb FX staleness, and the rate being live now is not on its
     * own a reason to loosen it — Story 15 revisits it with evidence.
     *
     * Keyed by literal symbol rather than by importing `DIP_LADDER_SYMBOL`: this
     * module is read *by* `strategies.module.ts`, and importing the constant back
     * would close an import cycle. `capital.config.spec.ts` asserts the key
     * matches, so the duplication cannot drift silently.
     */
    symbolCapital: { TQQQ: 40_000 },

    /**
     * The breaker never liquidates. It stops the ladder adding; positions are
     * held and the operator decides what follows. See
     * `docs/decisions/daily-loss-threshold.md`.
     */
    dailyLossThreshold: 5_000,

    /**
     * `REALIZED` only would never fire — lots close solely in profit, so a
     * ladder deep underwater would report a profitable day.
     * `REALIZED_AND_UNREALIZED` is the only basis that responds to the scenario
     * that actually matters; the threshold above sits beyond normal ladder depth
     * so it does not fire during the unrealized loss this strategy is *designed*
     * to carry.
     */
    dailyLossBasis: LossBasis.REALIZED_AND_UNREALIZED,
  },

  /**
   * **The live account — real money.** Added 2026-09-27 by operator decision,
   * ahead of the paper soak sign-off and backtest-backed figures; see
   * `docs/decisions/live-cutover.md` for what was skipped and what bounds it.
   *
   * Traded by its own daemon (`backend-live` in `docker-compose.yml`) against a
   * separate Gateway logged in with the live username. `LIVE` only: this entry
   * cannot be booted as `PAPER`, and the paper entry cannot be booted as `LIVE`.
   */
  live: {
    alias: 'live',
    label: 'Live',
    allowedModes: [ExecutionMode.LIVE],

    /**
     * USD, and so is `equity` — nothing is converted, unlike the paper account,
     * so no FX rate can block this account's entries.
     */
    currency: 'USD',

    /**
     * 200,000 USD as stated by the operator, a static reading like the paper
     * account's. The global cap is 60% of it: 120,000.
     */
    equity: 200_000,

    /**
     * The same 40,000 the paper account has run on, so live behaves like what
     * the soak observed. `LIVE` also submits each BUY at 25% of nominal
     * quantity during the reduced-size period (`live.config.ts`).
     */
    symbolCapital: { TQQQ: 40_000 },

    /**
     * Half the paper account's 5,000. BUYs start at 25% of nominal size, so
     * paper's figure would be effectively four times looser against what is
     * actually deployed. Revisit at the step-up to full size. Never liquidates.
     */
    dailyLossThreshold: 2_500,

    /** The same reasoning as the paper account: only this basis can fire. */
    dailyLossBasis: LossBasis.REALIZED_AND_UNREALIZED,
  },
};

/** The alias named by `ACCOUNT_ALIAS`, trimmed, or the default when unset or blank. */
export function activeAccountAlias(env: Record<string, string | undefined> = process.env): string {
  const alias = env.ACCOUNT_ALIAS?.trim();
  return alias ? alias : DEFAULT_ACCOUNT_ALIAS;
}

export function findAccount(alias: string): AccountDefinition | null {
  return Object.prototype.hasOwnProperty.call(ACCOUNTS, alias) ? ACCOUNTS[alias] : null;
}

/**
 * Stands in for an alias the registry does not know.
 *
 * Module-level capital constants are read at import time, before config
 * validation runs, so an unknown alias needs *some* value to import. This one
 * cannot trade: no symbol has capital, equity is zero, and it permits no mode —
 * and `validateConfig` refuses the alias before any of it is consulted.
 */
const UNCONFIGURED_ACCOUNT: AccountDefinition = {
  alias: '',
  label: '',
  allowedModes: [],
  currency: 'USD',
  equity: 0,
  symbolCapital: {},
  dailyLossThreshold: null,
  dailyLossBasis: LossBasis.REALIZED_AND_UNREALIZED,
};

/**
 * The account a dashboard-created daemon was started with, or `null`.
 *
 * The supervisor passes the definition as `ACCOUNT_DEFINITION` (see
 * `account-definition.ts`). It counts only when its alias is this daemon's
 * `ACCOUNT_ALIAS` and **not** a code-registry alias: a code-registry account is
 * defined by reviewed source, and an environment variable must not be able to
 * redefine its capital figures.
 */
export function environmentAccount(
  env: Record<string, string | undefined> = process.env,
): AccountDefinition | null {
  const alias = activeAccountAlias(env);
  const defined = parseAccountDefinitionEnv(env.ACCOUNT_DEFINITION);

  return defined !== null && defined.alias === alias && findAccount(alias) === null
    ? defined
    : null;
}

/**
 * The account this process trades.
 *
 * Read from the environment rather than injected, for the same reason
 * `repositories.module.ts` reads `DATABASE_URL` directly: the capital constants
 * feed synchronous factories and module-level exports that exist before any DI
 * container could resolve `AppConfigService`.
 */
export function resolveActiveAccount(
  env: Record<string, string | undefined> = process.env,
): AccountDefinition {
  const alias = activeAccountAlias(env);
  return (
    findAccount(alias) ??
    environmentAccount(env) ?? { ...UNCONFIGURED_ACCOUNT, alias, label: alias }
  );
}

/**
 * Checks a mode against the account's permitted set. Returns a failure message,
 * or `null` when permitted.
 */
export function checkAccountMode(account: AccountDefinition, mode: ExecutionMode): string | null {
  if (account.allowedModes.includes(mode)) {
    return null;
  }

  const permitted = account.allowedModes.length > 0 ? account.allowedModes.join(', ') : 'none';

  return (
    `Account "${account.alias}" may not run in ${mode} (permitted: ${permitted}). ` +
    'Which modes an account may trade in is set in accounts.config.ts, a reviewed file, so a ' +
    'copied environment cannot point a paper account configuration at live trading.'
  );
}
