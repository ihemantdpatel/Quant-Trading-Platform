/**
 * Fill modeling — stage 2 of the backtester (`PRD.md:407`).
 *
 * The replay harness answers "what would the strategy have decided?". This file
 * answers the separate and less forgiving question: **"would that order
 * actually have filled, and at what price?"** A backtest that assumes every
 * limit order fills at its limit reports the strategy's intentions rather than
 * its results, and on a ladder that only ever exits in profit those two numbers
 * diverge in one direction — optimistically.
 *
 * Three assumptions are modeled, each of which flatters the results if omitted:
 *
 * 1. **A limit order fills only when the bar trades through it.** A BUY at
 *    $50 fills only if the bar's low reached $50. Filling on a bar that merely
 *    closed below the limit would award the strategy a price that never
 *    printed.
 * 2. **Slippage works against the order**, always. The ladder places its buys
 *    below market and its sells above, so the honest direction is unambiguous:
 *    a fill costs slightly more, or realizes slightly less, than the limit.
 * 3. **Commission is a positive cost on every fill**, subtracted from realized
 *    P&L rather than netted into the price. Keeping it separate is what lets
 *    the statistics report gross and net independently — a strategy whose edge
 *    is smaller than its commissions is a specific, nameable failure.
 *
 * ## Why the touch rule is `low <= limit`, not `low < limit`
 *
 * A bar whose low exactly equals the limit price is the ambiguous case: the
 * price traded there, but whether *this* order filled depends on queue position
 * the backtest cannot know. Treating it as a fill is the optimistic reading.
 * It is chosen deliberately and narrowly — combined with mandatory slippage the
 * net assumption stays conservative, and the alternative (never filling at the
 * touch) would silently discard the exact-touch rung fires that the ladder's
 * 5% spacing makes common on round numbers.
 *
 * This module is **pure**: bar and order in, fill decision out. No clock, no
 * randomness, no I/O. That is what makes a backtest reproducible, and it is
 * why the statistics can be verified against a hand-worked fixture.
 */

import { BrokerOrder, OrderSide } from '../broker/broker-adapter.interface';
import { Bar } from '../market-data/types';

export interface FillModelConfig {
  /**
   * Per-share commission, a positive cost.
   *
   * IB's tiered US equity rate is $0.0035/share with a $1.00 order minimum;
   * both are modeled because on a ladder sizing rungs at a few hundred shares
   * the minimum binds more often than the per-share rate.
   */
  commissionPerShare: number;
  /** Floor applied per order, whatever the share count. */
  minCommissionPerOrder: number;
  /**
   * Slippage as a fraction of price, applied against the order.
   *
   * Fractional rather than per-share because the instrument is a 3x ETF whose
   * price has ranged roughly $10–$90 over the backtest window; a fixed cent
   * value would be a wildly different assumption at each end of that range.
   */
  slippagePercent: number;
  /**
   * When true, a limit order fills only if the bar's range touched the limit.
   *
   * The realistic setting and the default. Turning it off makes every approved
   * order fill at its limit on the bar that generated it, which is useful only
   * for isolating whether a discrepancy comes from the fill model or the
   * strategy.
   */
  requireTouch: boolean;
}

export const DEFAULT_FILL_MODEL_CONFIG: FillModelConfig = {
  commissionPerShare: 0.0035,
  minCommissionPerOrder: 1.0,
  slippagePercent: 0.0005,
  requireTouch: true,
};

export interface FillDecision {
  filled: boolean;
  /** Execution price including slippage. Null when the order did not fill. */
  price: number | null;
  /** Total commission for the fill, always positive. Zero when unfilled. */
  commission: number;
  /** Why an order did not fill — surfaced so an empty backtest is explicable. */
  reason: string | null;
}

/**
 * Did this bar trade through the order's limit price?
 *
 * A BUY needs the low to reach down to the limit; a SELL needs the high to
 * reach up to it. Market orders always trade.
 */
export function tradesThrough(order: BrokerOrder, bar: Bar): boolean {
  if (order.orderType === 'MKT') {
    return true;
  }

  return order.side === 'BUY' ? bar.low <= order.limitPrice : bar.high >= order.limitPrice;
}

/**
 * Applies slippage in the direction that costs the order.
 *
 * BUY fills higher, SELL fills lower. There is no configuration to make
 * slippage favourable, because a backtest with negative slippage is not
 * modeling a cost — it is inventing an edge.
 */
export function applySlippage(price: number, side: OrderSide, slippagePercent: number): number {
  const adjusted = side === 'BUY' ? price * (1 + slippagePercent) : price * (1 - slippagePercent);

  return roundToCents(adjusted);
}

/**
 * Commission for a fill: per-share, floored at the per-order minimum.
 *
 * Always positive. A zero-quantity fill is not a fill and yields zero rather
 * than charging the minimum on nothing.
 */
export function commissionFor(quantity: number, config: FillModelConfig): number {
  if (quantity <= 0) {
    return 0;
  }

  const perShare = quantity * config.commissionPerShare;

  return roundToCents(Math.max(perShare, config.minCommissionPerOrder));
}

/**
 * Decides whether an order fills against a bar, and at what price.
 *
 * **The fill price is the limit, not the bar's close.** Once the bar has traded
 * through the limit, a resting limit order executes at its own price — using
 * the close would report a fill better or worse than the order could have
 * achieved, depending on where the bar happened to end. Slippage is then the
 * only adjustment.
 */
export function evaluateFill(
  order: BrokerOrder,
  bar: Bar,
  config: FillModelConfig = DEFAULT_FILL_MODEL_CONFIG,
): FillDecision {
  if (order.quantity <= 0) {
    return { filled: false, price: null, commission: 0, reason: 'zero quantity' };
  }

  if (config.requireTouch && !tradesThrough(order, bar)) {
    const side = order.side === 'BUY' ? `low ${bar.low}` : `high ${bar.high}`;

    return {
      filled: false,
      price: null,
      commission: 0,
      reason: `bar did not trade through ${order.limitPrice} (${side})`,
    };
  }

  const base = order.orderType === 'MKT' ? bar.close : order.limitPrice;

  return {
    filled: true,
    price: applySlippage(base, order.side, config.slippagePercent),
    commission: commissionFor(order.quantity, config),
    reason: null,
  };
}

function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}
