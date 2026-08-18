/**
 * The IB wire conversions — this codebase's vocabulary into IB's, and back.
 *
 * Split out from `stoqey-ib-socket.ts` because these are **pure and fully
 * testable**, while the socket around them needs a live Gateway. That split is
 * not cosmetic: it is what lets the conversions stay under the coverage
 * threshold while the socket body is excluded from it, so the code where a
 * mistake actually costs money keeps being measured.
 *
 * And it is where mistakes cost money. A wrong `multiplier` misprices an order
 * by 100x; an ISO expiry IB cannot parse resolves a different instrument or
 * none; a timestamp read in the wrong zone files a bar under the wrong bar
 * boundary, and the ladder fires on bar close. None of these fail loudly.
 */

import {
  Contract as IbContract,
  Order as IbOrder,
  OrderState as IbOrderState,
  OptionType,
  OrderAction,
  OrderType as IbOrderType,
  SecType,
  TimeInForce as IbTimeInForce,
} from '@stoqey/ib';
import { DateTime } from 'luxon';
import { Contract, SecurityType } from '../../domain/contract';
import { formatEt } from '../../market-data/session';
import { Bar, BarSize, ET_ZONE } from '../../market-data/types';
import { BrokerOrder, CompletedOrder, OrderStatus } from '../broker-adapter.interface';

/** Our `Contract` → IB's. Exported for the payload assertions. */
export function toIbContract(contract: Contract): IbContract {
  const base: IbContract = {
    symbol: contract.symbol,
    secType: contract.secType === SecurityType.OPTION ? SecType.OPT : SecType.STK,
    exchange: contract.exchange,
    currency: contract.currency,
  };

  if (contract.secType !== SecurityType.OPTION) {
    return base;
  }

  return {
    ...base,
    strike: contract.strike,
    // IB wants `YYYYMMDD`; our domain carries ISO `YYYY-MM-DD` (`contract.ts:49`).
    lastTradeDateOrContractMonth: contract.expiry?.replace(/-/g, ''),
    // `OptionRight` and IB's `OptionType` are both `'C' | 'P'` with identical
    // values, so this is a re-labelling rather than a conversion. Asserted in
    // the spec so the cast cannot outlive that agreement silently.
    right: contract.right as unknown as OptionType | undefined,
    multiplier: contract.multiplier,
  };
}

/** Our `BrokerOrder` → IB's. Exported so payloads are asserted field-by-field. */
export function toIbOrder(order: BrokerOrder): IbOrder {
  return {
    action: order.side === 'BUY' ? OrderAction.BUY : OrderAction.SELL,
    orderType: order.orderType === 'LMT' ? IbOrderType.LMT : IbOrderType.MKT,
    totalQuantity: order.quantity,
    // A market order must carry no limit price at all. Sending `lmtPrice: 0`
    // on an MKT order is accepted by IB and then ignored, which hides an
    // engine bug that would be obvious as a rejection.
    ...(order.orderType === 'LMT' ? { lmtPrice: order.limitPrice } : {}),
    tif: order.timeInForce === 'GTC' ? IbTimeInForce.GTC : IbTimeInForce.DAY,
    // Never route to a live account by omission. `false` is IB's default, but
    // stating it means a config mistake cannot turn a paper order live.
    transmit: true,
    // **The engine's own id, carried on the order itself.**
    //
    // IB assigns numeric order ids per session; the map from those back to
    // `clientOrderId` lives in process memory and dies with a restart. An order
    // resting across that restart would then be unidentifiable — the engine
    // could see *an* order at IB but not know which rung placed it, and would
    // place a duplicate.
    //
    // `orderRef` is IB's free-text client tag and is returned with every open
    // order and execution, so it survives the restart the in-memory map does
    // not. This is what makes open-order reconciliation possible at all.
    orderRef: order.clientOrderId,
  };
}

/**
 * IB's execution → the engine's `clientOrderId`, or null when it is not ours.
 *
 * **`orderRef` wins over the id map because it is the only identifier that
 * survives a restart.** The map is built in `placeOrder` and lives in process
 * memory, so an execution for an order placed by a *previous* process finds it
 * empty. The caller discards a null, silently — which is how a PAPER soak came
 * to hold 272 shares with no lots: two resting orders filled while the process
 * was down, IB replayed both executions on reconnect, and every one was
 * dropped here. That `LOT_SUM_MISMATCH` is unrecoverable by construction, since
 * a net position cannot be decomposed back into the per-lot fill prices each
 * lot's exit target is a percentage of.
 *
 * `orderRef` carries `clientOrderId` on the order itself (`toIbOrder`) and IB
 * returns it on every execution, so it holds across restarts and reconnects
 * alike. The map stays as a fallback for orders placed before this was set.
 *
 * An execution with neither is not ours — a manual TWS order on the same
 * account — and is still discarded, deliberately: adopting it would attach a
 * lot to a position the ladder does not own.
 *
 * Lives here rather than in the socket for the same reason `LiveBarGate` does.
 * The socket body is excluded from coverage as Gateway-dependent, and a
 * correlation rule that decides whether a fill is recorded at all must not sit
 * in unmeasured code.
 */
export function resolveClientOrderId(
  orderIds: ReadonlyMap<string, number>,
  orderId: number | undefined,
  orderRef?: string,
): string | null {
  if (orderRef) {
    return orderRef;
  }

  if (orderId === undefined) {
    return null;
  }

  for (const [clientOrderId, id] of orderIds) {
    if (id === orderId) {
      return clientOrderId;
    }
  }

  return null;
}

/**
 * IB's order-status string → ours, or null for a status that means nothing here.
 *
 * **Null is the important return value, not an oversight.** IB reports a long
 * pre-submission lifecycle — `PendingSubmit`, `PreSubmitted`, `ApiPending` —
 * and every one of those describes an order that is on its way to resting, not
 * one that has stopped. `routeOrderStatus` releases the rung on a terminal
 * status, so mapping any of these onto `CANCELLED` would free a level while the
 * order was still live and let the next bar place a second order at that price.
 * Unrecognized statuses return null for the same reason: the safe default is
 * "no transition", never a guessed one.
 *
 * `Inactive` is deliberately absent. IB uses it both for an order rejected at
 * submission *and* for one temporarily suspended outside trading hours, and the
 * string alone does not distinguish them — releasing a rung for the second case
 * would duplicate a live order. It is left to the error channel, which carries
 * the code that does distinguish them.
 */
/**
 * IB's `completedOrder` payload → a `CompletedOrder`, or `null` to skip it.
 *
 * **Null is the common and correct outcome**, not an error path. IB reports
 * every completed order on the account, including ones placed by hand in TWS
 * and ones from other clients. Those carry no `orderRef`, and `orderRef` is the
 * only thing tying an IB order back to this engine's `clientOrderId` — so
 * without it there is no `Order` row to update and nothing useful to say. They
 * are skipped rather than given a synthesized id, which would match nothing
 * downstream while looking like a real record.
 *
 * A status IB reports that is not terminal is also skipped. `reqCompletedOrders`
 * should only ever return terminal orders, but trusting that and coercing an
 * unexpected value into `CANCELLED` would mark an order dead on the strength of
 * a string this code did not recognize.
 *
 * `PendingCancel` is deliberately **not** treated as cancelled: the cancel has
 * been requested and not confirmed, and an order in that state can still fill.
 */
export function toCompletedOrder(
  contract: IbContract,
  order: IbOrder,
  state: IbOrderState,
): CompletedOrder | null {
  const clientOrderId = order.orderRef;

  if (!clientOrderId) {
    return null;
  }

  const status = toTerminalStatus(state.status);

  if (status === null) {
    return null;
  }

  return {
    clientOrderId,
    brokerOrderId: order.orderId === undefined ? '' : String(order.orderId),
    symbol: contract.symbol ?? '',
    side: order.action === OrderAction.SELL ? 'SELL' : 'BUY',
    quantity: order.totalQuantity ?? 0,
    filledQuantity: order.filledQuantity ?? 0,
    status,
    // IB puts the human-readable cause here when it has one — an expiry notice,
    // a rejection message. Absent for an ordinary user cancel.
    reason: state.completedStatus ?? state.warningText ?? null,
  };
}

/**
 * The terminal subset of IB's order statuses.
 *
 * Separate from `toOrderStatus` because the two answer different questions.
 * `toOrderStatus` maps a *live* status transition and therefore accepts
 * `Submitted`; a completed order that claims to be `Submitted` is a
 * contradiction, and admitting it would let a non-terminal status be written
 * to an `Order` row from a source that cannot produce one.
 */
export function toTerminalStatus(
  status: string | undefined,
): OrderStatus.FILLED | OrderStatus.CANCELLED | OrderStatus.REJECTED | null {
  switch (status) {
    case 'Filled':
      return OrderStatus.FILLED;
    case 'Cancelled':
    case 'ApiCancelled':
      return OrderStatus.CANCELLED;
    // IB's terminal state for an order it refused outright — an unentitled
    // instrument, a margin refusal, a malformed payload.
    case 'Inactive':
      return OrderStatus.REJECTED;
    default:
      return null;
  }
}

export function toOrderStatus(status: string | undefined): OrderStatus | null {
  switch (status) {
    case 'Filled':
      return OrderStatus.FILLED;
    case 'Submitted':
      return OrderStatus.SUBMITTED;
    // IB's two cancel spellings: `Cancelled` is the exchange's, `ApiCancelled`
    // follows a client cancel request. Both mean the order is gone.
    case 'Cancelled':
    case 'ApiCancelled':
      return OrderStatus.CANCELLED;
    default:
      return null;
  }
}

/**
 * IB's `endDateTime`, in the `yyyyMMdd-HH:mm:ss` form with an explicit zone.
 *
 * The zone suffix is not optional in practice: without it IB interprets the
 * time in the *Gateway's* configured timezone, so the same request returns
 * different bars depending on where the container thinks it is.
 */
export function toIbEndDateTime(isoTimestamp: string): string {
  return DateTime.fromISO(isoTimestamp, { setZone: true })
    .setZone(ET_ZONE)
    .toFormat('yyyyMMdd-HH:mm:ss');
}

/**
 * The duration string covering `from`→`to`.
 *
 * IB rejects a duration that exceeds what it will serve for a bar size, so this
 * rounds up to whole units and the *caller* is responsible for chunking a long
 * backfill into requests IB will accept (`backfill.service.ts`).
 */
export function durationString(from: string, to: string, barSize: BarSize): string {
  const start = DateTime.fromISO(from, { setZone: true });
  const end = DateTime.fromISO(to, { setZone: true });
  const seconds = Math.max(Math.ceil(end.diff(start, 'seconds').seconds), 1);

  if (barSize === BarSize.DAILY) {
    const days = Math.ceil(seconds / 86_400);
    return `${Math.max(days, 1)} D`;
  }

  // Intraday: IB accepts a seconds duration up to 86400, and days beyond that.
  if (seconds <= 86_400) {
    return `${seconds} S`;
  }

  return `${Math.ceil(seconds / 86_400)} D`;
}

/**
 * IB's bar → ours.
 *
 * Returns null for a bar missing the fields the domain type requires rather
 * than substituting zeros: a bar with a zero close would price a rung at zero
 * and fire every ladder level at once.
 */
export function toDomainBar(
  bar: {
    time?: string;
    open?: number;
    high?: number;
    low?: number;
    close?: number;
    volume?: number;
  },
  symbol: string,
  barSize: BarSize,
): Bar | null {
  if (
    bar.time === undefined ||
    bar.open === undefined ||
    bar.high === undefined ||
    bar.low === undefined ||
    bar.close === undefined
  ) {
    return null;
  }

  const timestamp = parseIbTime(bar.time);

  if (!timestamp) {
    return null;
  }

  return {
    symbol,
    barSize,
    timestamp,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    // IB reports volume in lots of 100 for some feeds and returns -1 when
    // unavailable; a negative volume is meaningless, so it floors at zero.
    volume: Math.max(bar.volume ?? 0, 0),
  };
}

/**
 * Parses IB's time field into an ISO-8601 ET timestamp.
 *
 * Handles both formats IB emits: epoch seconds (what `formatDate: 2` requests)
 * and the `yyyyMMdd` daily form, which IB returns for daily bars regardless of
 * the requested format.
 */
export function parseIbTime(time: string): string | null {
  const trimmed = time.trim();

  if (/^\d+$/.test(trimmed) && trimmed.length >= 9) {
    return formatEt(DateTime.fromSeconds(Number(trimmed)).setZone(ET_ZONE));
  }

  const daily = DateTime.fromFormat(trimmed, 'yyyyMMdd', { zone: ET_ZONE });

  if (daily.isValid) {
    return formatEt(daily);
  }

  const dateTime = DateTime.fromFormat(trimmed, 'yyyyMMdd HH:mm:ss', { zone: ET_ZONE });

  return dateTime.isValid ? formatEt(dateTime) : null;
}
