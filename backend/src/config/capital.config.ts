/**
 * The Story 13 capital decisions — the two `PRD.md:500` open items, now set.
 *
 * These are the figures `startup-assertions.ts` refuses to boot `PAPER`/`LIVE`
 * without. They live in a reviewed source file rather than environment
 * variables **on purpose**: which instrument this system trades and how much it
 * may deploy are decisions that belong in a diff someone read, not in a
 * deployment variable that can be changed without review (the same reasoning
 * that keeps `DIP_LADDER_SYMBOL` a constant).
 *
 * The reasoning behind each number is recorded, as Story 13 requires:
 *
 * - `docs/decisions/capital-allocation.md`
 * - `docs/decisions/daily-loss-threshold.md`
 *
 * **These were operator-chosen, not backtest-derived.** Story 13 specifies they
 * should be informed by Story 11 backtests; they were not, and both documents
 * record that deviation. They are sized to be *safe* — a full ladder fits under
 * the global cap with headroom — not to be optimal. Story 15 must revisit them
 * with backtest evidence before `LIVE`.
 */

import { LossBasis } from '../risk/risk.config';

/**
 * The currency the capital figures in this file are expressed in — **USD**,
 * matching TQQQ, so the global cap compares like with like.
 *
 * **This is not the account's base currency.** IB reports `DU7022583` in
 * **CAD** (`NetLiquidation` 248,973.68 on 2026-08-14). Stating USD here is an
 * operator decision to express the cap in the *traded* currency and convert the
 * balance once, by hand, rather than block on building FX conversion into the
 * risk layer.
 *
 * What that buys and what it costs:
 *
 * - The cap arithmetic is sound — a USD notional is compared against a USD
 *   figure, which is the error this whole check exists to prevent.
 * - But `PAPER_ACCOUNT_EQUITY` below is now a **hand-converted snapshot** that
 *   goes stale as USD/CAD moves, on top of going stale as the balance moves.
 *   A weaker CAD shrinks the real USD equity while this constant stays put,
 *   which loosens the cap. The margin below is what absorbs that.
 *
 * `assertSingleCurrency` still does its job: it now passes because both sides
 * genuinely say USD, and it would fire again the moment a non-USD instrument is
 * configured. Resolving this properly — a live `USD.CAD` rate with a staleness
 * watchdog — remains open; see `docs/decisions/capital-allocation.md`.
 */
export const PAPER_ACCOUNT_CURRENCY = 'USD';

/**
 * Account equity the 60% global cap is measured against, in
 * `PAPER_ACCOUNT_CURRENCY` (USD).
 *
 * A static figure rather than a value read from the broker at boot, and that is
 * a deliberate trade-off. `RISK_CONFIG` is built by a **synchronous** factory
 * and asserted in `RiskModule.onModuleInit`, whereas `getAccountSummary()` is
 * async and needs a connected broker — and `StartupSequence.run()` is
 * pointedly *not* awaited so the HTTP server never waits on IB
 * (`CLAUDE.md`, "The HTTP server must never wait on the broker"). Fetching
 * equity before the assertion would reintroduce exactly that dependency, and
 * the dashboard would go down precisely when IB is unreachable — when an
 * operator most needs it.
 *
 * The cost is that this goes stale if the account balance moves materially.
 * That is acceptable because it is only a *denominator for a cap*: a stale
 * figure makes the cap slightly wrong, while a boot that hangs on IB makes the
 * system unobservable. Reconciliation still verifies real positions against the
 * broker on every boot.
 *
 * **Hand-converted from CAD, and deliberately set below the result.** The
 * account reported 248,973.68 CAD on 2026-08-14 at USD.CAD 1.3874 (IDEALPRO
 * bid/ask), i.e. ~179,455 USD. 175,000 is used so that both balance drift *and*
 * adverse FX movement have room to move the real figure without the cap
 * silently becoming too loose — a ~2.5% buffer, which covers ordinary daily
 * rate movement but not a sustained CAD rally.
 *
 * Re-read the account **and** the rate together when revisiting; converting one
 * without the other reintroduces exactly the mismatch this replaced. See
 * `docs/decisions/capital-allocation.md`.
 */
export const PAPER_ACCOUNT_EQUITY = 175_000;

/**
 * Per-symbol capital allocation — **expected deployment, not a ceiling**.
 *
 * Denominated in `PAPER_ACCOUNT_CURRENCY` (USD), like every other figure in
 * this file and in `RiskConfig`, and in the same currency as the share price
 * the ladder divides it by — which is the property that makes rung sizing
 * correct.
 *
 * A full 5-rung flat ladder deploys 125% of this (`5 × 25%`), so 40,000 peaks
 * at 50,000 against a 105,000 global cap. The headroom is intentional: sizing
 * this so a full ladder only just fits would make the *deepest* rung — the one
 * fired in the worst drawdown, and the one the strategy exists to take — the
 * rung the risk manager resizes away.
 *
 * Kept at 40,000 rather than restored to the original 50,000. The equity
 * denominator is now a hand-converted figure carrying FX staleness the previous
 * one did not, and the extra headroom is what absorbs that.
 *
 * See `docs/decisions/capital-allocation.md` for the full arithmetic.
 *
 * Keyed by literal symbol rather than by importing `DIP_LADDER_SYMBOL`: this
 * module is read *by* `strategies.module.ts`, and importing the constant back
 * from there would close an import cycle. `capital.config.spec.ts` asserts the
 * key matches `DIP_LADDER_SYMBOL`, so the duplication cannot drift silently.
 */
export const PAPER_SYMBOL_CAPITAL: Record<string, number> = {
  TQQQ: 40_000,
};

/**
 * Currency loss at which the breaker halts **new submission** across all
 * strategies. Positive magnitude.
 *
 * The breaker never liquidates. It stops the ladder adding; positions are held
 * and the operator decides what follows. No code path may turn this into a
 * realized loss.
 */
export const PAPER_DAILY_LOSS_THRESHOLD = 5_000;

/**
 * The `PRD.md:252` tension, resolved.
 *
 * `REALIZED` only would never fire — lots close solely in profit, so realized
 * P&L is positive almost by construction and a ladder deep underwater would
 * report a profitable day. `REALIZED_AND_UNREALIZED` is the only basis that can
 * respond to the scenario that actually matters; the threshold above is then
 * set beyond normal ladder depth so it does not fire during the unrealized loss
 * this strategy is *designed* to carry.
 *
 * See `docs/decisions/daily-loss-threshold.md`.
 */
export const PAPER_DAILY_LOSS_BASIS = LossBasis.REALIZED_AND_UNREALIZED;
