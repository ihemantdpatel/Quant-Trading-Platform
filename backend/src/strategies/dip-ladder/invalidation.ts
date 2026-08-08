import { DipLadderConfig } from './config';
import { LadderPosition } from './types';

/**
 * The two strategy-level invalidation limits (`PRD.md:161`). The third, the
 * global capital cap, is enforced outside the strategy by the Story 5 risk
 * manager.
 *
 * **Both limits stop the ladder adding. Neither ever sells.** That is the
 * single most important property in this file. Liquidating the bottom of a
 * dip-buying strategy is the worst of both worlds — it buys weakness and then
 * sells more weakness — so there is no stop-loss at position or lot level, and
 * no code path here produces a sell. The functions below return *whether a buy
 * is permitted*; there is deliberately no return value that could express
 * "exit". Held lots continue to wait for their individual targets.
 *
 * Downside is bounded by concurrent rung count, flat sizing, and the hard
 * floor — not by a stop.
 */

export enum BlockReason {
  /** `maxConcurrentRungs` lots are already held. */
  MAX_RUNGS_HELD = 'MAX_RUNGS_HELD',
  /** Price is at or below the 25% hard floor beneath first entry. */
  HARD_FLOOR = 'HARD_FLOOR',
}

export interface InvalidationResult {
  /** True when a new entry is permitted. */
  canAdd: boolean;
  /** Populated only when `canAdd` is false. */
  reason?: BlockReason;
  /** Human-readable detail for the log and the dashboard. */
  detail?: string;
}

const PERMITTED: InvalidationResult = { canAdd: true };

/**
 * The hard floor price: `hardFloorPercent` below the first entry of the cycle.
 *
 * Returns null when flat — the floor is measured from first entry, so before
 * there is one it cannot bind.
 */
export function hardFloorPrice(position: LadderPosition, config: DipLadderConfig): number | null {
  if (position.firstEntryPrice === null) {
    return null;
  }

  return position.firstEntryPrice * (1 - config.hardFloorPercent);
}

/**
 * Counts rungs currently holding a lot.
 *
 * Counted over *held lots*, not over the rung ledger. A re-armed rung stays in
 * the ledger at its original price but holds nothing, so it is structurally
 * incapable of consuming a slot (`PRD.md:163`) — the limit binds on live
 * exposure rather than on how many levels the ladder has established.
 */
export function heldRungCount(position: LadderPosition): number {
  return position.heldLots.length;
}

/**
 * Decides whether the ladder may open another lot at `price`.
 *
 * Order matters only for which reason is reported; both conditions block. The
 * rung limit is checked first because it is the more common stop in ordinary
 * operation, and the more informative one to see in a log.
 */
export function evaluateInvalidation(
  position: LadderPosition,
  price: number,
  config: DipLadderConfig,
): InvalidationResult {
  const held = heldRungCount(position);

  if (held >= config.maxConcurrentRungs) {
    return {
      canAdd: false,
      reason: BlockReason.MAX_RUNGS_HELD,
      detail: `${held} of ${config.maxConcurrentRungs} concurrent rungs already held`,
    };
  }

  const floor = hardFloorPrice(position, config);

  // At or below the floor, not merely below: the floor is the level at which
  // adding stops, so a fill exactly on it is already too deep.
  if (floor !== null && price <= floor) {
    return {
      canAdd: false,
      reason: BlockReason.HARD_FLOOR,
      detail:
        `price ${price.toFixed(2)} is at or below the hard floor ${floor.toFixed(2)} ` +
        `(${(config.hardFloorPercent * 100).toFixed(0)}% below first entry ` +
        `${position.firstEntryPrice!.toFixed(2)}) — holding, not selling`,
    };
  }

  return PERMITTED;
}
