/**
 * Live-account guard: refuses to run against a live account absent an explicit
 * config flag, asserted at startup (`PRD.md:259`, `PRD.md:493`).
 *
 * The guard exists because every other safety control in this system fails
 * *safe* — a cap rejects, a breaker halts, a kill switch stops. Mode selection
 * is the one place where the dangerous state is reachable by a single wrong
 * value in the environment, and an env var is exactly the thing that gets
 * copied between machines by accident. So `LIVE` requires two independent
 * signals that disagree by default: the mode itself, and `allowLiveTrading`.
 *
 * Story 15 sets the flag. Story 5 only builds the refusal.
 */

import { ExecutionMode } from '../config/execution-mode';
import { RiskConfig } from './risk.config';

export interface GuardVerdict {
  /** True when the mode is permitted. */
  permitted: boolean;
  /** Populated only when refused. */
  detail: string | null;
}

const PERMITTED: GuardVerdict = { permitted: true, detail: null };

/**
 * Checks a mode against the live flag.
 *
 * Only `LIVE` is gated here. `SHADOW` submits nothing and `PAPER` reaches a
 * paper account, so neither can move real capital — they are gated instead by
 * the capital and loss-threshold assertions in `startup-assertions.ts`, which
 * is a different question with a different answer.
 */
export function checkLiveAccountGuard(mode: ExecutionMode, config: RiskConfig): GuardVerdict {
  if (mode !== ExecutionMode.LIVE) {
    return PERMITTED;
  }

  if (!config.allowLiveTrading) {
    return {
      permitted: false,
      detail:
        'EXECUTION_MODE=LIVE requires the explicit allowLiveTrading flag, which is not set. ' +
        'Live trading places orders with real capital against a 3x leveraged instrument ' +
        'carrying no stop-loss — the flag must be set deliberately, never inherited from ' +
        'a copied environment.',
    };
  }

  return PERMITTED;
}
