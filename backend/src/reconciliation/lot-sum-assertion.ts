/**
 * The lot-sum assertion (`PRD.md:343`) — the decision Story 9 exists to make.
 *
 * **IB reports a net position and an average cost; it does not report lot
 * structure.** Three lots of 100 shares and one block of 300 are
 * indistinguishable to the broker (`PRD.md:338`). So the two sources are
 * authoritative over different facts, and neither can substitute for the other:
 *
 * | Fact | Authority |
 * |---|---|
 * | How many shares exist | the broker |
 * | Which lots those shares are, what each paid, what each targets | the database |
 *
 * The only thing that can be *checked* across that boundary is the total. If
 * the summed held-lot quantities equal the broker's net position, the lot
 * structure is trusted and the ladder resumes. If they disagree, something the
 * system cannot see has happened — a manual trade, a fill lost in a crash, a
 * corporate action — and the symbol is halted.
 *
 * ## Why there is no repair path here
 *
 * It is tempting to close the gap: scale the lots, synthesize one for the
 * difference, drop the oldest until the sum fits. Every one of those is a guess
 * at lot composition, and **guessing wrong means selling the wrong lot at the
 * wrong target** (`PRD.md:347`) — booking a loss on a lot that should have been
 * held, on a 3x leveraged ETF with no stop-loss underneath it. A halt is
 * recoverable by a human in minutes; a wrong lot sold is not recoverable at all.
 *
 * This module is pure and has no I/O — it computes a verdict and returns it.
 * Acting on the verdict is `ReconciliationService`'s job.
 */

import { Lot, heldLots } from '../strategies/dip-ladder/lot';

export enum ReconciliationStatus {
  /** Lot sum equals broker net position. The ladder may resume. */
  MATCHED = 'MATCHED',
  /** The DB holds lots the broker does not report a position for. */
  MISSING_AT_BROKER = 'MISSING_AT_BROKER',
  /** The broker reports a position the DB has no lots for. */
  UNTRACKED_AT_BROKER = 'UNTRACKED_AT_BROKER',
  /** Both sides hold the symbol, but the quantities disagree. */
  QUANTITY_MISMATCH = 'QUANTITY_MISMATCH',
}

export interface LotSumVerdict {
  symbol: string;
  status: ReconciliationStatus;
  /** Sum of held lot quantities from the database. */
  lotQuantity: number;
  /** Net position as the broker reports it. */
  brokerQuantity: number;
  /** How many held lots contributed to `lotQuantity`. */
  heldLotCount: number;
  /** True only when the ladder may resume trading this symbol. */
  reconciled: boolean;
  /** Always populated — an operator reading a halt needs to know why. */
  reason: string;
}

/**
 * Compares the database's lot composition against the broker's net position.
 *
 * `brokerQuantity` is the *net* figure; absence of a position is 0, which is
 * how the broker reports "flat" and is deliberately not modelled as null. A
 * flat broker against held lots is a genuine mismatch, not missing data.
 */
export function assertLotSum(symbol: string, lots: Lot[], brokerQuantity: number): LotSumVerdict {
  // Closed lots are history — they describe shares no longer owned and must
  // not be counted against a live position.
  const held = heldLots(lots);
  const lotQuantity = held.reduce((sum, lot) => sum + lot.quantity, 0);

  const base = {
    symbol,
    lotQuantity,
    brokerQuantity,
    heldLotCount: held.length,
  };

  if (lotQuantity === brokerQuantity) {
    return {
      ...base,
      status: ReconciliationStatus.MATCHED,
      reconciled: true,
      reason:
        held.length === 0
          ? `${symbol}: flat at broker and no held lots — nothing to reconcile`
          : `${symbol}: ${held.length} held lot(s) summing to ${lotQuantity} match the broker's net position`,
    };
  }

  // The three disagreement shapes are distinguished because they mean
  // genuinely different things to whoever resolves the halt: a missing broker
  // position suggests a fill that never happened or a manual close, an
  // untracked one suggests a manual buy or lost lot records, and a plain
  // quantity gap suggests a partial fill recorded on one side only.
  const status =
    brokerQuantity === 0
      ? ReconciliationStatus.MISSING_AT_BROKER
      : lotQuantity === 0
        ? ReconciliationStatus.UNTRACKED_AT_BROKER
        : ReconciliationStatus.QUANTITY_MISMATCH;

  return {
    ...base,
    status,
    reconciled: false,
    reason: describeMismatch(status, symbol, lotQuantity, brokerQuantity, held.length),
  };
}

function describeMismatch(
  status: ReconciliationStatus,
  symbol: string,
  lotQuantity: number,
  brokerQuantity: number,
  heldLotCount: number,
): string {
  switch (status) {
    case ReconciliationStatus.MISSING_AT_BROKER:
      return (
        `${symbol}: database holds ${heldLotCount} lot(s) totalling ${lotQuantity} share(s) ` +
        'but the broker reports no position — halted for manual resolution'
      );
    case ReconciliationStatus.UNTRACKED_AT_BROKER:
      return (
        `${symbol}: broker reports ${brokerQuantity} share(s) but the database holds no lots — ` +
        'lot composition is unknown, halted for manual resolution'
      );
    default:
      return (
        `${symbol}: lot sum ${lotQuantity} does not equal broker net position ${brokerQuantity} ` +
        `(difference ${lotQuantity - brokerQuantity}) — halted for manual resolution`
      );
  }
}

/**
 * Held-lot quantities keyed by symbol.
 *
 * Lots carry no symbol field of their own — a ladder instance is per-symbol and
 * its lots are implicitly its own (`lot.ts:19`). The caller supplies the symbol
 * from the strategy registration, so this exists to keep that grouping in one
 * place rather than repeated at each call site.
 */
export function sumHeldQuantity(lots: Lot[]): number {
  return heldLots(lots).reduce((sum, lot) => sum + lot.quantity, 0);
}
