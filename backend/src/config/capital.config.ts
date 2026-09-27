/**
 * The Story 13 capital decisions — the two `PRD.md:500` open items — for the
 * account this process trades.
 *
 * These are the figures `startup-assertions.ts` refuses to boot `PAPER`/`LIVE`
 * without. The values themselves live per account in `accounts.config.ts`, a
 * reviewed source file, **on purpose**: which instrument this system trades and
 * how much it may deploy are decisions that belong in a diff someone read, not
 * in a deployment variable that can be changed without review. This file only
 * selects the active account's entry, so the many readers of these constants
 * need not know that more than one account exists.
 *
 * The reasoning behind each number is recorded, as Story 13 requires:
 *
 * - `docs/decisions/capital-allocation.md`
 * - `docs/decisions/daily-loss-threshold.md`
 *
 * **These were operator-chosen, not backtest-derived.** Story 13 specifies they
 * should be informed by Story 11 backtests; they were not, and both documents
 * record that deviation. Story 15 must revisit them with backtest evidence
 * before `LIVE`.
 */

import { resolveActiveAccount } from './accounts.config';

/** The registry entry for this process's `ACCOUNT_ALIAS`. */
export const ACTIVE_ACCOUNT = resolveActiveAccount();

/**
 * The currency every cap and limit is expressed in — the *traded* currency, so
 * position notional is compared like with like. See `accounts.config.ts`.
 */
export const ACCOUNT_CURRENCY = ACTIVE_ACCOUNT.currency;

/**
 * The currency `ACCOUNT_EQUITY` is denominated in, when it differs from
 * `ACCOUNT_CURRENCY` (Story 15). The risk manager then converts equity at a
 * live rate from IB, and **a stale or unavailable rate blocks new entries** —
 * it never falls back to a cached rate of unknown age (`risk/fx-rate.ts`).
 * Undefined means equity is already in `ACCOUNT_CURRENCY`.
 */
export const ACCOUNT_EQUITY_CURRENCY = ACTIVE_ACCOUNT.equityCurrency;

/**
 * Equity the 60% global cap is measured against, in `ACCOUNT_EQUITY_CURRENCY`
 * when set and `ACCOUNT_CURRENCY` otherwise.
 */
export const ACCOUNT_EQUITY = ACTIVE_ACCOUNT.equity;

/** Per-symbol capital allocation — **expected deployment, not a ceiling**. */
export const ACCOUNT_SYMBOL_CAPITAL: Record<string, number> = { ...ACTIVE_ACCOUNT.symbolCapital };

/** Loss at which the breaker halts **new submission**. It never liquidates. */
export const ACCOUNT_DAILY_LOSS_THRESHOLD = ACTIVE_ACCOUNT.dailyLossThreshold;

/** The `PRD.md:252` tension, resolved per account. */
export const ACCOUNT_DAILY_LOSS_BASIS = ACTIVE_ACCOUNT.dailyLossBasis;
