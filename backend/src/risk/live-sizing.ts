/**
 * Reduced-size live trading (Story 15).
 *
 * The first weeks of `LIVE` trade a fraction of each intent's nominal size.
 * Going straight from paper to full size means the first real drawdown is also
 * the first real position — on a 3x leveraged ETF, averaged down, with no
 * stop-loss.
 *
 * Applied in the risk layer rather than in any strategy, so it binds every
 * strategy the same way whatever its sizing rule — the ladder's
 * `fixedQuantity` bypasses `symbolCapital` entirely, so scaling the allocation
 * alone would not have shrunk a single order.
 *
 * **BUYs only.** A lot's exit sells what actually filled, which is already the
 * reduced quantity; scaling a SELL would leave shares behind with no order
 * covering them.
 */

import { ExecutionMode } from '../config/execution-mode';
import { RiskIntent } from './types';

export interface LiveSizing {
  /** Shares after scaling. Zero means nothing is left to submit. */
  quantity: number;
  /** Null when no scaling applied. */
  detail: string | null;
}

export function applyLiveSizing(
  intent: RiskIntent,
  mode: ExecutionMode,
  multiplier: number,
): LiveSizing {
  if (mode !== ExecutionMode.LIVE || intent.side !== 'BUY' || multiplier >= 1) {
    return { quantity: intent.quantity, detail: null };
  }

  // Floored, never rounded: rounding up would commit more than the reduced
  // size permits, which is the one direction this control exists to prevent.
  const quantity = Math.floor(intent.quantity * multiplier);

  return {
    quantity,
    detail:
      `LIVE reduced size ×${multiplier}: ${intent.quantity} → ${quantity} shares ` +
      '(step-up is an explicit config change — see live.config.ts)',
  };
}
