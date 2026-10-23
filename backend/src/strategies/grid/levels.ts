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
import { GridLot, GridLotStatus, sellPriorityQueue } from './lot';
import { sessionDateOf } from './session';

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

export type GridBuyPricing = 'DAILY_AVERAGE' | 'GRID_STEPS';

export interface ComputeGridIntentsParams {
  symbol: string;
  /** The reference price — the last bar's close, or the current price at a recompute-on-fill call. */
  close: number;
  timestamp: string;
  /** Held lots only; the caller filters — see `heldGridLots`. */
  heldLots: GridLot[];
  config: GridConfig;
  /**
   * Which rule prices the BUY side when 1+ lots are held. The two rules are
   * deliberately different, not two views of the same number:
   *
   * - **`DAILY_AVERAGE`** — the day's first entry only. One BUY at `gap`
   *   below the quantity-weighted average hold price; pegged to the current
   *   close instead of skipped if that target has already been gapped
   *   through. Only `onBar`'s once-(genuine-)session-open recompute may use
   *   this.
   * - **`GRID_STEPS`** — every other recompute. Up to `maxBuyLevels` stepped
   *   BUYs below the *lowest* held lot, `gap` apart — the original grid
   *   rule — skipping outright (never pegging) any level the market has
   *   already gapped through.
   *
   * **Why the fill-triggered recompute (`evaluate`) must always use
   * `GRID_STEPS`, never `DAILY_AVERAGE`.** A pegged buy is marketable by
   * construction, so it fills almost immediately — and with `DAILY_AVERAGE`,
   * the recompute that fill triggers would see a new average hold price
   * barely moved by one more equal-sized lot at essentially the same price,
   * peg again, fill again, and repeat: a self-sustaining buying loop bounded
   * only by a capital cap, not by anything about the market. Not
   * hypothetical: it happened live (4 buys in under 3 minutes, all ≈70.06,
   * on 2026-09-14).
   *
   * **Why `onBar` must also confirm this is a *genuine* session open before
   * using `DAILY_AVERAGE`.** `GridStateData.sessionDate` is not restored
   * across a restart, so a mid-session restart makes `onBar` believe the
   * next bar is the day's first one even when it is not. Pegging to market
   * on that basis fired a real, unrelated marketable buy right after a
   * restart on 2026-09-14 (filled at 69.97, disconnected from anything the
   * grid had actually done that session). `onBar` guards against this by
   * checking whether any lot already opened today before choosing
   * `DAILY_AVERAGE` — see `grid.strategy.ts`.
   */
  buyPricing: GridBuyPricing;
  /**
   * The lot whose sale left the grid stranded, if any — see `rebuyCandidate`.
   * Consulted only by `GRID_STEPS`, and only when none of its stepped levels
   * is restable.
   */
  rebuyLot?: GridLot | null;
}

/**
 * The most recently closed lot, when its sale is still the latest thing the
 * grid did today — the lot a re-buy would cycle.
 *
 * Why this exists: `GRID_STEPS` steps below the *lowest held* lot, so selling
 * the lowest lot moves every buy level up to the next one held. When that lot
 * was the day's pegged `DAILY_AVERAGE` buy, the next held lot can sit well
 * above the market, every stepped level is marketable and skipped, and the
 * grid rests no buy for the rest of the session. Seen live on 2026-10-07: a
 * pegged buy at 82.32 sold at 82.82, the lowest held lot became 84.44, and
 * nothing rested below a market at 83.22.
 *
 * Derived from lots rather than passed in by the fill router, because every
 * recompute cancels resting buys it does not re-emit
 * (`EngineService.cancelSupersededGridBuys`) — a re-buy known only to the
 * recompute its sell triggered would be cancelled by the next one.
 *
 * - **Today only**: orders are DAY, so yesterday's sale says nothing about
 *   where today's grid should rest.
 * - **No lot opened since**: an open after the sale means the re-buy filled
 *   (or a later entry superseded it), and stepping resumes from held lots.
 */
export function rebuyCandidate(lots: readonly GridLot[], timestamp: string): GridLot | null {
  const today = sessionDateOf(timestamp);
  let latest: GridLot | null = null;

  for (const lot of lots) {
    if (lot.status !== GridLotStatus.CLOSED || !lot.closedAt) {
      continue;
    }

    if (!latest || Date.parse(lot.closedAt) > Date.parse(latest.closedAt!)) {
      latest = lot;
    }
  }

  if (!latest || sessionDateOf(latest.closedAt!) !== today) {
    return null;
  }

  const closedAt = Date.parse(latest.closedAt!);

  return lots.some((lot) => Date.parse(lot.openedAt) > closedAt) ? null : latest;
}

/** The quantity-weighted average fill price across a set of held lots. */
export function averageFillPrice(heldLots: GridLot[]): number {
  const totalQuantity = heldLots.reduce((sum, lot) => sum + lot.quantity, 0);
  const totalCost = heldLots.reduce((sum, lot) => sum + lot.quantity * lot.fillPrice, 0);
  return totalCost / totalQuantity;
}

/**
 * Computes the full desired set of grid orders for the current state.
 *
 * - **0 held lots**: one marketable-at-close BUY (never a true MKT order).
 * - **1+ held lots, `buyPricing: 'DAILY_AVERAGE'`**: one BUY at `gap` below
 *   the quantity-weighted average fill price of every held lot. If the
 *   market has already gapped below that price, the order is pegged to the
 *   current close instead of skipped — the same "peg to market rather than
 *   chase or sit out" rule the sell side already applies on a gap up, just
 *   mirrored for a gap down. See the doc comment on `GridBuyPricing` for why
 *   this rule is restricted to a genuine once-per-session recompute.
 * - **1+ held lots, `buyPricing: 'GRID_STEPS'`**: up to `maxBuyLevels`
 *   stepped BUYs below the *lowest* held lot, `gap` apart — the original
 *   grid rule — skipping outright (never pegging) any level the market has
 *   already gapped through. When every stepped level is skipped, `rebuyLot`
 *   (if given) rests one buy at that sold lot's own fill price instead — see
 *   `rebuyCandidate` — and when that is through the market too, up to
 *   `maxBuyLevels` BUYs step down from the close, `gap` apart, so a grid
 *   holding lots always has a buy resting below the market.
 * - **Sells**: one per held lot, lowest-fill-price first (`sellPriorityQueue`),
 *   capped at `maxSellOrders`. A lot already covered by a resting sell is
 *   skipped. A lot whose frozen target has already been passed by a gap up
 *   is pegged to the current close instead of the stale, now-marketable
 *   target.
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
  } else if (params.buyPricing === 'DAILY_AVERAGE') {
    const avgHoldPrice = averageFillPrice(heldLots);
    const target = roundToCents(avgHoldPrice - config.gap);
    const restable = isRestable(target, close);
    const pegToMarket = !restable;
    const level = pegToMarket ? roundToCents(close) : target;

    if (level > 0) {
      intents.push({
        symbol,
        side: 'BUY',
        quantity: config.quantity,
        limitPrice: level,
        timestamp,
        reason: pegToMarket
          ? `day's first dip buy: gap ${config.gap} below avg hold ${avgHoldPrice.toFixed(2)} (${target.toFixed(2)}) already through market — pegged to close`
          : `day's first dip buy: gap ${config.gap} below avg hold ${avgHoldPrice.toFixed(2)}`,
      });
    }
  } else {
    const lowestFill = Math.min(...heldLots.map((lot) => lot.fillPrice));
    const buysBefore = intents.length;

    for (let n = 1; n <= config.maxBuyLevels; n += 1) {
      const level = roundToCents(lowestFill - n * config.gap);

      if (level <= 0) {
        continue;
      }

      // Never chase a level the market has already gapped through — the
      // day's one `DAILY_AVERAGE` catch-up exists precisely so this rule
      // doesn't have to.
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

    // Stranded: rest one buy where the sold lot was bought — its sell price
    // less the gap, the grid's own cycle. Still never pegged: it must rest
    // below the market, or it is skipped like any stepped level.
    const rebuy = params.rebuyLot;

    if (intents.length === buysBefore && rebuy && isRestable(rebuy.fillPrice, close)) {
      intents.push({
        symbol,
        side: 'BUY',
        quantity: config.quantity,
        limitPrice: roundToCents(rebuy.fillPrice),
        timestamp,
        reason:
          `re-buy at sold lot ${rebuy.id}'s own fill ${rebuy.fillPrice.toFixed(2)} — ` +
          `every step below lowest held lot ${lowestFill.toFixed(2)} is already through the market`,
      });
    }

    // Still stranded: step down from the market instead. This rule runs only
    // at a fill or the session open, so without it a market that falls
    // straight through every level rests no buy until the next session — seen
    // live on 2026-10-08 with price at 79.42 under a lowest held lot of 84.44.
    // Stepping from the close keeps each level a full gap below the market,
    // so nothing here is marketable; it is not re-priced per bar, which would
    // drag the buy down with a falling market and never let it fill.
    if (intents.length === buysBefore) {
      for (let n = 1; n <= config.maxBuyLevels; n += 1) {
        const level = roundToCents(close - n * config.gap);

        if (level > 0 && isRestable(level, close)) {
          intents.push({
            symbol,
            side: 'BUY',
            quantity: config.quantity,
            limitPrice: level,
            timestamp,
            reason:
              `market dip buy ${n}: ${n}×gap below close ${close.toFixed(2)} — ` +
              `every step below lowest held lot ${lowestFill.toFixed(2)} is already through the market`,
          });
        }
      }
    }
  }

  // Lowest fill price first, not FIFO by age — see `sellPriorityQueue`'s doc
  // comment for why the two are not interchangeable here.
  const candidates = sellPriorityQueue(heldLots).slice(0, config.maxSellOrders);

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
