/**
 * The grid strategy's pure recompute algorithm — the one place its trading
 * rules live. Every price this strategy places comes from this file; the
 * adapter (`grid.strategy.ts`) only decides *when* to call it.
 *
 * **No pre-computed level ledger.** Unlike the dip ladder's `Rung`, this
 * strategy needs no persisted record of "this level is pending" or "this
 * level re-arms here": every call recomputes buy/sell prices from scratch
 * from the lots currently held, because every order is DAY time-in-force and
 * expires with the session — there is nothing to re-arm across days.
 *
 * `workingBuyOrders`/`workingSellOrders` are deliberately **not** inputs
 * here. `EngineService`'s existing duplicate-order guard already asks the
 * broker what is resting and silently drops whatever this function re-emits
 * that already exists — the one exception is a lot with a resting sell
 * already recorded (`lot.workingOrderId`), which this function does consult,
 * mirroring the dip ladder's own per-lot guard.
 */

import { GridConfig } from './config';
import { fifoQueue, GridLot } from './lot';

export interface GridEntryIntent {
  symbol: string;
  side: 'BUY';
  quantity: number;
  limitPrice: number;
  timestamp: string;
  reason: string;
}

export interface GridExitIntent {
  symbol: string;
  side: 'SELL';
  quantity: number;
  limitPrice: number;
  /** The lot this sell would close, so a fill can be matched back to it. */
  lotId: string;
  timestamp: string;
  reason: string;
}

export type GridIntent = GridEntryIntent | GridExitIntent;

function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * True when a BUY limit at `limitPrice` would rest below the market rather
 * than fill immediately. Mirrors `isRestable` in the dip ladder exactly —
 * same sign, same reasoning: a level at or above the close is marketable.
 */
export function isRestable(limitPrice: number, close: number): boolean {
  return roundToCents(limitPrice) < roundToCents(close);
}

/**
 * The mirror for a SELL: a limit above the close rests; at or below it, it
 * is marketable. Used here to decide whether a lot's frozen sell target is
 * still above the market or whether a gap up has already carried price past
 * it, in which case the sell is pegged to the current close instead.
 */
export function isRestableExit(limitPrice: number, close: number): boolean {
  return roundToCents(limitPrice) > roundToCents(close);
}

export interface ComputeGridIntentsParams {
  symbol: string;
  /** The reference price — the last bar's close, or the current price at a recompute-on-fill call. */
  close: number;
  timestamp: string;
  /** Held lots only; the caller filters — see `heldGridLots`. */
  heldLots: GridLot[];
  config: GridConfig;
}

/**
 * Computes the full desired set of grid orders for the current state.
 *
 * - **0 held lots**: one marketable-at-close BUY (never a true MKT order).
 * - **1+ held lots**: up to `maxBuyLevels` stepped BUYs below the lowest held
 *   lot's fill price, skipping any level the market has already gapped
 *   through rather than chasing it with a marketable order.
 * - **Sells**: one per held lot, oldest/lowest-priced first (FIFO), capped at
 *   `maxSellOrders`. A lot already covered by a resting sell is skipped. A
 *   lot whose frozen target has already been passed by a gap up is pegged to
 *   the current close instead of the stale, now-marketable target.
 */
export function computeGridIntents(params: ComputeGridIntentsParams): GridIntent[] {
  const { symbol, close, timestamp, heldLots, config } = params;
  const intents: GridIntent[] = [];

  if (heldLots.length === 0) {
    intents.push({
      symbol,
      side: 'BUY',
      quantity: config.quantity,
      limitPrice: roundToCents(close + config.entryBuffer),
      timestamp,
      reason: 'flat — marketable entry at last close',
    });
  } else {
    const lowestFill = Math.min(...heldLots.map((lot) => lot.fillPrice));

    for (let n = 1; n <= config.maxBuyLevels; n += 1) {
      const level = roundToCents(lowestFill - n * config.gap);

      if (level <= 0) {
        continue;
      }

      // Never chase a level the market has already gapped through — the same
      // reasoning as the dip ladder's `isRestable` guard: a marketable dip
      // buy is a fill price this strategy would then have to hold with no
      // stop underneath it.
      if (isRestable(level, close)) {
        intents.push({
          symbol,
          side: 'BUY',
          quantity: config.quantity,
          limitPrice: level,
          timestamp,
          reason: `dip buy ${n}: ${n}×gap below lowest held lot ${lowestFill.toFixed(2)}`,
        });
      }
    }
  }

  const candidates = fifoQueue(heldLots).slice(0, config.maxSellOrders);

  for (const lot of candidates) {
    if (lot.workingOrderId) {
      continue;
    }

    const pegToMarket = !isRestableExit(lot.sellTarget, close);
    const price = pegToMarket ? roundToCents(close) : lot.sellTarget;

    intents.push({
      symbol,
      side: 'SELL',
      quantity: lot.quantity,
      limitPrice: price,
      lotId: lot.id,
      timestamp,
      reason: pegToMarket
        ? `gap up past target ${lot.sellTarget.toFixed(2)} — pegged to market`
        : `lot ${lot.id} own fill ${lot.fillPrice.toFixed(2)} + gap`,
    });
  }

  return intents;
}
