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
import { BrokerOrder } from '../broker-adapter.interface';

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
  };
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
