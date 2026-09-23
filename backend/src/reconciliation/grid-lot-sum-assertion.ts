/**
 * The lot-sum assertion for the grid strategy — parallel to
 * `lot-sum-assertion.ts`, on `GridLot` rather than `Lot`.
 *
 * Same reasoning as the ladder's version, restated for a second consumer
 * rather than shared: IB reports a net position and nothing about lot
 * structure, so the only fact checkable across that boundary is the total.
 * **No repair path here either** — a mismatch halts, matching the ladder's
 * pre-auto-rebuild philosophy exactly, per this feature's explicit design
 * decision. This module is pure and has no I/O.
 */

import { GridLot, heldGridLots } from '../strategies/grid/lot';

export enum GridReconciliationStatus {
  MATCHED = 'MATCHED',
  MISSING_AT_BROKER = 'MISSING_AT_BROKER',
  UNTRACKED_AT_BROKER = 'UNTRACKED_AT_BROKER',
  QUANTITY_MISMATCH = 'QUANTITY_MISMATCH',
}

export interface GridLotSumVerdict {
  symbol: string;
  status: GridReconciliationStatus;
  lotQuantity: number;
  brokerQuantity: number;
  heldLotCount: number;
  reconciled: boolean;
  reason: string;
}

/** Compares the database's grid lot composition against the broker's net position. */
export function assertGridLotSum(
  symbol: string,
  lots: GridLot[],
  brokerQuantity: number,
): GridLotSumVerdict {
  const held = heldGridLots(lots);
  const lotQuantity = held.reduce((sum, lot) => sum + lot.quantity, 0);

  const base = { symbol, lotQuantity, brokerQuantity, heldLotCount: held.length };

  if (lotQuantity === brokerQuantity) {
    return {
      ...base,
      status: GridReconciliationStatus.MATCHED,
      reconciled: true,
      reason:
        held.length === 0
          ? `${symbol}: flat at broker and no held grid lots — nothing to reconcile`
          : `${symbol}: ${held.length} held grid lot(s) summing to ${lotQuantity} match the ` +
            'broker’s net position',
    };
  }

  const status =
    brokerQuantity === 0
      ? GridReconciliationStatus.MISSING_AT_BROKER
      : lotQuantity === 0
        ? GridReconciliationStatus.UNTRACKED_AT_BROKER
        : GridReconciliationStatus.QUANTITY_MISMATCH;

  return {
    ...base,
    status,
    reconciled: false,
    reason: describeMismatch(status, symbol, lotQuantity, brokerQuantity, held.length),
  };
}

function describeMismatch(
  status: GridReconciliationStatus,
  symbol: string,
  lotQuantity: number,
  brokerQuantity: number,
  heldLotCount: number,
): string {
  switch (status) {
    case GridReconciliationStatus.MISSING_AT_BROKER:
      return (
        `${symbol}: database holds ${heldLotCount} grid lot(s) totalling ${lotQuantity} ` +
        'share(s) but the broker reports no position — halted for manual resolution'
      );
    case GridReconciliationStatus.UNTRACKED_AT_BROKER:
      return (
        `${symbol}: broker reports ${brokerQuantity} share(s) but the database holds no grid ` +
        'lots — lot composition is unknown, halted for manual resolution'
      );
    default:
      return (
        `${symbol}: grid lot sum ${lotQuantity} does not equal broker net position ` +
        `${brokerQuantity} (difference ${lotQuantity - brokerQuantity}) — halted for manual ` +
        'resolution'
      );
  }
}

export function sumHeldGridQuantity(lots: GridLot[]): number {
  return heldGridLots(lots).reduce((sum, lot) => sum + lot.quantity, 0);
}
