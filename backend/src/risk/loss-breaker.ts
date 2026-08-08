/**
 * Daily loss circuit breaker.
 *
 * **This is the only control in the system that responds to drawdown**
 * (`PRD.md:245`). The strategy has no stop-loss at position or lot level, and
 * the hard floor only stops *adding*. On a 3x leveraged instrument that makes
 * this breaker the sole automated response to a sustained decline.
 *
 * Two properties are structural rather than conventional:
 *
 * 1. **It halts new submission; it does not liquidate.** There is no return
 *    value here that could express "sell" — the breaker produces a boolean halt
 *    and a `RiskEvent`, and nothing else. A breaker that liquidated would
 *    convert a paper drawdown into a realized loss at the worst possible
 *    moment, which is the failure the whole no-stop-loss design is avoiding.
 * 2. **An unset threshold never halts.** `null` means "not yet decided"
 *    (`PRD.md:505`), not "zero tolerance". Treating unset as a halt would make
 *    SHADOW replay useless; treating it as permissive is safe precisely because
 *    `startup-assertions.ts` refuses to reach PAPER/LIVE while it is unset.
 *
 * The realized-vs-unrealized tension at `PRD.md:246` is *not* resolved here.
 * `LossBasis` makes it a config value so Story 13 records a decision rather
 * than editing this file.
 */

import { LossBasis, RiskConfig } from './risk.config';

/**
 * The day's P&L as the breaker measures it. Losses are negative.
 *
 * Supplied by the caller, keeping this module pure and clock-free — Story 6
 * sources it from the position and fill repositories.
 */
export interface DailyPnl {
  /** Booked P&L from closed lots today. Negative is a loss. */
  realized: number;
  /** Mark-to-market on open lots. Negative is a loss. */
  unrealized: number;
}

export const FLAT_PNL: DailyPnl = { realized: 0, unrealized: 0 };

/**
 * The figure the threshold is compared against, per the configured basis.
 *
 * Returned as a signed number so a caller logging it sees a loss as negative,
 * matching how the P&L reads everywhere else.
 */
export function measuredPnl(pnl: DailyPnl, basis: LossBasis): number {
  return basis === LossBasis.REALIZED ? pnl.realized : pnl.realized + pnl.unrealized;
}

export interface BreakerVerdict {
  /** True when all strategies must stop submitting new orders. */
  halted: boolean;
  /** The P&L figure evaluated, signed. */
  measured: number;
  detail: string;
}

/**
 * Evaluates the breaker against the day's P&L.
 *
 * Breaches at or beyond the threshold, not merely beyond: a loss exactly equal
 * to the configured limit is the limit being reached, and rounding that in the
 * permissive direction would make the threshold approximate.
 */
export function evaluateLossBreaker(pnl: DailyPnl, config: RiskConfig): BreakerVerdict {
  const measured = measuredPnl(pnl, config.dailyLossBasis);

  if (config.dailyLossThreshold === null) {
    return {
      halted: false,
      measured,
      detail:
        'daily loss threshold is unset — breaker inactive (PAPER/LIVE are refused ' +
        'at startup while it stays unset)',
    };
  }

  // The threshold is stored as a positive magnitude; a loss is negative.
  const loss = -measured;

  if (loss >= config.dailyLossThreshold) {
    return {
      halted: true,
      measured,
      detail:
        `daily ${config.dailyLossBasis} loss ${loss.toFixed(2)} reached the threshold ` +
        `${config.dailyLossThreshold.toFixed(2)} — halting new submission, holding all positions`,
    };
  }

  return {
    halted: false,
    measured,
    detail:
      `daily ${config.dailyLossBasis} P&L ${measured.toFixed(2)} within threshold ` +
      `${config.dailyLossThreshold.toFixed(2)}`,
  };
}
