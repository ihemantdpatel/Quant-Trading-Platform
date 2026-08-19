/**
 * Startup assertions: the app refuses to boot into `PAPER` or `LIVE` while the
 * two open PRD items are unresolved (`PRD.md:500`, `stories.md:336`).
 *
 * - **Per-symbol capital allocation** is unset (`PRD.md:503`)
 * - **Daily loss threshold** is unset (`PRD.md:505`)
 *
 * Both are `null` by design, and the whole point of this file is that `null`
 * must be *loud* rather than silently defaulted. A default capital figure would
 * size real orders off a number nobody chose; a default loss threshold would
 * either halt constantly or never halt at all, and on TQQQ with no stop-loss
 * that threshold is the only automated drawdown response there is.
 *
 * `SHADOW` boots freely with both unset — it submits nothing, which is exactly
 * why Stories 0–12 can run without either decision being made. Story 13 sets
 * the values and this assertion stops failing.
 *
 * Per-symbol capital is passed in rather than read from `dip-ladder/config.ts`
 * because the risk layer must not depend on any individual strategy. Story 6
 * supplies it from the configured strategies at wiring time.
 */

import { ExecutionMode } from '../config/execution-mode';
import { checkLiveAccountGuard } from './live-account-guard';
import { assertSingleCurrency, RiskConfig } from './risk.config';

/**
 * Capital configured for each symbol a strategy is enabled on. A `null` value
 * means the symbol is configured but its allocation is unset — the exact state
 * the assertion refuses.
 */
export type SymbolCapital = Record<string, number | null>;

export interface StartupAssertionResult {
  /** True when the requested mode may be entered. */
  permitted: boolean;
  /** One entry per failed assertion. Empty when permitted. */
  failures: string[];
}

/**
 * Thrown at bootstrap. A distinct class so the bootstrap path can present it as
 * a configuration error rather than an unexpected crash.
 */
export class StartupAssertionError extends Error {
  constructor(readonly failures: string[]) {
    super(
      `Refusing to start — ${failures.length} startup assertion(s) failed:\n` +
        failures.map((failure) => `  - ${failure}`).join('\n'),
    );
    this.name = 'StartupAssertionError';
  }
}

/**
 * Evaluates every startup assertion for a mode.
 *
 * Collects **all** failures rather than short-circuiting on the first. An
 * operator enabling PAPER should learn about both unset values in one run
 * instead of fixing one, restarting, and discovering the other.
 */
export function evaluateStartupAssertions(
  mode: ExecutionMode,
  config: RiskConfig,
  symbolCapital: SymbolCapital = {},
  /**
   * Currency of each instrument the enabled strategies trade.
   *
   * Defaults to empty, which asserts nothing — the many existing callers that
   * predate the currency check keep their behaviour. `RiskModule` supplies the
   * real list, so the check is live where it matters.
   */
  instrumentCurrencies: string[] = [],
): StartupAssertionResult {
  const failures: string[] = [];

  // The live guard applies before the parameter checks: an unset live flag is a
  // refusal regardless of whether the other values happen to be configured.
  const guard = checkLiveAccountGuard(mode, config);

  if (!guard.permitted) {
    failures.push(guard.detail!);
  }

  if (mode === ExecutionMode.SHADOW) {
    // **SHADOW is retired and is refused, not exempted.**
    //
    // It previously returned early here, skipping the capital and loss-threshold
    // checks because a mode that submits nothing cannot misuse them. That
    // exemption is now the danger: entries rest at the broker and a lot exists
    // only once a fill arrives, so a SHADOW ladder would log intents forever and
    // never open a lot — reporting a position history the system would never
    // actually have produced.
    //
    // Refusing at boot rather than quietly redirecting to PAPER: silently
    // upgrading a mode that submits nothing into one that submits real orders is
    // precisely the kind of implicit escalation this file exists to prevent.
    failures.push(
      'EXECUTION_MODE=SHADOW is retired and no longer supported. Resting limit orders make a ' +
        'lot the consequence of a broker fill, and SHADOW submits nothing — the ladder would ' +
        'record intents forever and never open a lot. Set EXECUTION_MODE=PAPER.',
    );

    return { permitted: false, failures };
  }

  const unsetSymbols = Object.entries(symbolCapital)
    .filter(([, capital]) => capital === null)
    .map(([symbol]) => symbol);

  if (unsetSymbols.length > 0) {
    failures.push(
      `EXECUTION_MODE=${mode} requires a per-symbol capital allocation, but it is unset for: ` +
        `${unsetSymbols.join(', ')} (PRD.md:503). Orders would be sized from an unchosen figure.`,
    );
  }

  if (Object.keys(symbolCapital).length === 0) {
    failures.push(
      `EXECUTION_MODE=${mode} requires at least one symbol with a configured capital ` +
        'allocation; none was supplied (PRD.md:503).',
    );
  }

  if (config.dailyLossThreshold === null) {
    failures.push(
      `EXECUTION_MODE=${mode} requires the daily loss threshold to be set (PRD.md:505). ` +
        'It is the only automated drawdown response in the system — the strategy has no ' +
        'stop-loss and the hard floor only stops adding.',
    );
  }

  if (config.accountEquity <= 0) {
    failures.push(
      `EXECUTION_MODE=${mode} requires a positive account equity for the 60% global capital ` +
        `cap to mean anything, got ${config.accountEquity}.`,
    );
  }

  // A currency mismatch makes the cap wrong by the exchange rate while looking
  // entirely normal, so it is refused rather than converted. See
  // `assertSingleCurrency`.
  failures.push(...assertSingleCurrency(config, instrumentCurrencies));

  return { permitted: failures.length === 0, failures };
}

/**
 * Assertion form: throws `StartupAssertionError` when the mode is refused.
 *
 * Bootstrap calls this. Throwing rather than returning is deliberate — a
 * process that has failed a safety assertion must not continue in a degraded
 * state, because the degraded state is one that submits orders.
 */
export function assertStartupSafe(
  mode: ExecutionMode,
  config: RiskConfig,
  symbolCapital: SymbolCapital = {},
  instrumentCurrencies: string[] = [],
): void {
  const result = evaluateStartupAssertions(mode, config, symbolCapital, instrumentCurrencies);

  if (!result.permitted) {
    throw new StartupAssertionError(result.failures);
  }
}
