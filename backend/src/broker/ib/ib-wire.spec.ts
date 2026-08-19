/**
 * The IB wire conversions (`stories.md:413`).
 *
 * `StoqeyIbSocket` as a whole needs a live Gateway, and that part is verified
 * by connecting to one rather than by a unit test. These conversions are pure,
 * which is why they live in their own module — they are where a mistake is
 * both easy and expensive: a mis-encoded
 * order payload is wrong by 100x on a multiplier or silently routed to the
 * wrong instrument, and neither surfaces until an order exists.
 *
 * So the functions that translate this codebase's vocabulary into IB's are
 * exported and asserted field by field here.
 */

import { OptionRight, SecurityType, equityContract, optionContract } from '../../domain/contract';
import { BarSize } from '../../market-data/types';
import { BrokerOrder, OrderStatus } from '../broker-adapter.interface';
import {
  durationString,
  parseIbTime,
  resolveClientOrderId,
  toDomainBar,
  toIbContract,
  toIbEndDateTime,
  toIbOrder,
  toCompletedOrder,
  toOrderStatus,
  toTerminalStatus,
} from './ib-wire';

describe('toIbContract', () => {
  it('maps an equity to IB’s STK form', () => {
    const ib = toIbContract(equityContract('TQQQ'));

    expect(ib).toEqual({
      symbol: 'TQQQ',
      secType: 'STK',
      exchange: 'SMART',
      currency: 'USD',
    });
  });

  it('converts an ISO expiry to IB’s YYYYMMDD wire format', () => {
    const ib = toIbContract(
      optionContract({
        symbol: 'TQQQ',
        strike: 40,
        expiry: '2025-06-20',
        right: OptionRight.CALL,
      }),
    );

    // IB rejects the ISO form outright; the domain carries ISO deliberately
    // (`contract.ts:49`) and this boundary is where it becomes IB's.
    expect(ib.lastTradeDateOrContractMonth).toBe('20250620');
    expect(ib.secType).toBe('OPT');
    expect(ib.strike).toBe(40);
    expect(ib.multiplier).toBe(100);
  });

  it('carries the option right through unchanged', () => {
    // `OptionRight` and IB's `OptionType` are both 'C' | 'P'. The cast in the
    // implementation is only sound while that holds — this asserts it does.
    expect(
      toIbContract(
        optionContract({
          symbol: 'TQQQ',
          strike: 40,
          expiry: '2025-06-20',
          right: OptionRight.PUT,
        }),
      ).right,
    ).toBe('P');
  });

  it('omits option fields entirely for an equity', () => {
    const ib = toIbContract(equityContract('TQQQ'));

    // A stray strike or expiry on a stock contract makes IB resolve a
    // different instrument than intended.
    expect(ib.strike).toBeUndefined();
    expect(ib.lastTradeDateOrContractMonth).toBeUndefined();
    expect(ib.right).toBeUndefined();
  });

  it('preserves a non-USD currency', () => {
    expect(toIbContract(equityContract('TQQQ', 'EUR')).currency).toBe('EUR');
  });

  it('marks a stock contract as STK even when secType is set explicitly', () => {
    expect(
      toIbContract({
        symbol: 'TQQQ',
        secType: SecurityType.STOCK,
        exchange: 'SMART',
        currency: 'USD',
        multiplier: 1,
      }).secType,
    ).toBe('STK');
  });
});

describe('toIbOrder', () => {
  const base: BrokerOrder = {
    clientOrderId: 'co-1',
    contract: equityContract('TQQQ'),
    side: 'BUY',
    quantity: 25,
    orderType: 'LMT',
    limitPrice: 38.5,
    timeInForce: 'DAY',
    timestamp: '2025-01-02T10:00:00.000-05:00',
  };

  it('maps a limit buy field by field', () => {
    expect(toIbOrder(base)).toEqual({
      action: 'BUY',
      orderType: 'LMT',
      totalQuantity: 25,
      lmtPrice: 38.5,
      tif: 'DAY',
      transmit: true,
      orderRef: 'co-1',
    });
  });

  it('carries clientOrderId in orderRef so it survives a restart', () => {
    // IB's numeric order ids are per-session and the map back to clientOrderId
    // lives in process memory. `orderRef` is returned with every open order, so
    // it is the only way a restart can tell which rung placed a resting order —
    // without it, reconciliation would place a duplicate.
    expect(toIbOrder(base).orderRef).toBe('co-1');
    expect(toIbOrder({ ...base, clientOrderId: 'co-99' }).orderRef).toBe('co-99');
  });

  it('maps a sell to IB’s SELL action', () => {
    expect(toIbOrder({ ...base, side: 'SELL' }).action).toBe('SELL');
  });

  it('omits the limit price entirely on a market order', () => {
    const ib = toIbOrder({ ...base, orderType: 'MKT' });

    // IB accepts and then ignores `lmtPrice` on an MKT order, which would hide
    // an engine bug that should have surfaced as a rejection.
    expect(ib.orderType).toBe('MKT');
    expect('lmtPrice' in ib).toBe(false);
  });

  it('maps GTC time-in-force', () => {
    expect(toIbOrder({ ...base, timeInForce: 'GTC' }).tif).toBe('GTC');
  });
});

describe('toIbEndDateTime', () => {
  it('formats an ISO timestamp as IB’s yyyyMMdd-HH:mm:ss in ET', () => {
    expect(toIbEndDateTime('2025-01-02T16:00:00.000-05:00')).toBe('20250102-16:00:00');
  });

  it('converts a UTC instant into ET before formatting', () => {
    // Without the zone conversion IB would read this as 21:00 in whatever zone
    // the Gateway is configured for, and return a different set of bars.
    expect(toIbEndDateTime('2025-01-02T21:00:00.000Z')).toBe('20250102-16:00:00');
  });

  it('handles a daylight-saving date', () => {
    expect(toIbEndDateTime('2025-07-01T16:00:00.000-04:00')).toBe('20250701-16:00:00');
  });
});

describe('durationString', () => {
  it('expresses a daily range in whole days', () => {
    expect(
      durationString(
        '2025-01-01T00:00:00.000-05:00',
        '2025-01-31T00:00:00.000-05:00',
        BarSize.DAILY,
      ),
    ).toBe('30 D');
  });

  it('expresses a short intraday range in seconds', () => {
    expect(
      durationString(
        '2025-01-02T09:30:00.000-05:00',
        '2025-01-02T16:00:00.000-05:00',
        BarSize.FIVE_MIN,
      ),
    ).toBe('23400 S');
  });

  it('switches to days for an intraday range beyond one day', () => {
    expect(
      durationString(
        '2025-01-02T09:30:00.000-05:00',
        '2025-01-09T16:00:00.000-05:00',
        BarSize.FIVE_MIN,
      ),
    ).toBe('8 D');
  });

  it('never requests a zero duration', () => {
    // IB rejects `0 S`; a same-instant range should still be a valid request.
    expect(
      durationString(
        '2025-01-02T09:30:00.000-05:00',
        '2025-01-02T09:30:00.000-05:00',
        BarSize.FIVE_MIN,
      ),
    ).toBe('1 S');
  });
});

describe('parseIbTime', () => {
  it('parses epoch seconds, the format formatDate: 2 requests', () => {
    // 2025-01-02 09:30 ET === 1735828200 epoch seconds.
    expect(parseIbTime('1735828200')).toBe('2025-01-02T09:30:00.000-05:00');
  });

  it('parses the yyyyMMdd form IB returns for daily bars', () => {
    // Daily bars come back in this form regardless of the requested format.
    expect(parseIbTime('20250102')).toBe('2025-01-02T00:00:00.000-05:00');
  });

  it('parses the yyyyMMdd HH:mm:ss form', () => {
    expect(parseIbTime('20250102 09:30:00')).toBe('2025-01-02T09:30:00.000-05:00');
  });

  it('returns null for an unparseable value rather than a wrong instant', () => {
    // A guessed timestamp would file a bar under the wrong bar boundary, and
    // the ladder fires on bar close.
    expect(parseIbTime('not a time')).toBeNull();
    expect(parseIbTime('')).toBeNull();
  });

  it('produces a daylight-saving offset for a summer date', () => {
    expect(parseIbTime('20250701')).toBe('2025-07-01T00:00:00.000-04:00');
  });
});

describe('toDomainBar', () => {
  const complete = { time: '20250102', open: 40, high: 41, low: 39, close: 40.5, volume: 1_000 };

  it('maps a complete IB bar into the domain shape', () => {
    expect(toDomainBar(complete, 'TQQQ', BarSize.DAILY)).toEqual({
      symbol: 'TQQQ',
      barSize: BarSize.DAILY,
      timestamp: '2025-01-02T00:00:00.000-05:00',
      open: 40,
      high: 41,
      low: 39,
      close: 40.5,
      volume: 1_000,
    });
  });

  it.each([
    ['time', { ...complete, time: undefined }],
    ['open', { ...complete, open: undefined }],
    ['high', { ...complete, high: undefined }],
    ['low', { ...complete, low: undefined }],
    ['close', { ...complete, close: undefined }],
  ])('returns null when %s is missing, rather than substituting a zero', (_field, bar) => {
    // A bar with a zero close would price a rung at zero and fire every ladder
    // level at once. Dropping an incomplete bar is the only safe reading.
    expect(toDomainBar(bar, 'TQQQ', BarSize.DAILY)).toBeNull();
  });

  it('returns null when the timestamp cannot be parsed', () => {
    expect(toDomainBar({ ...complete, time: 'garbage' }, 'TQQQ', BarSize.DAILY)).toBeNull();
  });

  it('floors a negative volume, which IB reports as -1 when unavailable', () => {
    expect(toDomainBar({ ...complete, volume: -1 }, 'TQQQ', BarSize.DAILY)!.volume).toBe(0);
  });

  it('defaults a missing volume to zero while keeping the bar', () => {
    // Volume is not a price. An absent one is worth recording as zero rather
    // than discarding a bar whose OHLC is complete.
    expect(toDomainBar({ ...complete, volume: undefined }, 'TQQQ', BarSize.DAILY)!.volume).toBe(0);
  });
});

describe('toOrderStatus', () => {
  it.each([
    ['Filled', OrderStatus.FILLED],
    ['Submitted', OrderStatus.SUBMITTED],
    ['Cancelled', OrderStatus.CANCELLED],
    // IB's spelling for a cancel that followed a client request.
    ['ApiCancelled', OrderStatus.CANCELLED],
  ])('maps IB %s to %s', (ibStatus, expected) => {
    expect(toOrderStatus(ibStatus)).toBe(expected);
  });

  it.each(['PendingSubmit', 'PreSubmitted', 'ApiPending', 'PendingCancel'])(
    'returns null for %s, which describes an order still on its way',
    (ibStatus) => {
      // `routeOrderStatus` releases the rung on a terminal status. Mapping any
      // of these onto CANCELLED would free a level while the order was still
      // live, and the next bar would place a second order at that price.
      expect(toOrderStatus(ibStatus)).toBeNull();
    },
  );

  it('returns null for Inactive rather than guessing which kind it is', () => {
    // IB uses Inactive both for a rejected order and for one suspended outside
    // trading hours. Releasing a rung for the second case duplicates a live
    // order, and the string alone cannot tell them apart.
    expect(toOrderStatus('Inactive')).toBeNull();
  });

  it('returns null for an unknown or absent status', () => {
    expect(toOrderStatus('SomethingIBAddedLater')).toBeNull();
    expect(toOrderStatus(undefined)).toBeNull();
  });
});

describe('resolveClientOrderId', () => {
  it('resolves from orderRef when the id map is empty — the restart case', () => {
    // The regression. `orderIds` is built in `placeOrder` and dies with the
    // process, so an execution replayed after a restart finds it empty. The
    // caller discards a null silently, which is how a PAPER soak came to hold
    // 272 shares with no lots: two resting orders filled while the process was
    // down and both executions were dropped here. Unrecoverable afterwards —
    // a net position cannot be decomposed back into per-lot fill prices.
    expect(resolveClientOrderId(new Map(), 41, 'co-1')).toBe('co-1');
  });

  it('prefers orderRef over a map entry that disagrees', () => {
    // IB's numeric ids are per-session and restart from `getNextValidOrderId`,
    // so a *new* order can reuse an id a previous session assigned elsewhere.
    // The map would then attribute the fill to the wrong order and open a lot
    // against a rung that never traded. `orderRef` comes from the order itself.
    const stale = new Map([['co-OLD', 41]]);

    expect(resolveClientOrderId(stale, 41, 'co-NEW')).toBe('co-NEW');
  });

  it('falls back to the map for an execution carrying no orderRef', () => {
    expect(resolveClientOrderId(new Map([['co-2', 7]]), 7)).toBe('co-2');
  });

  it('returns null for an execution that is not ours', () => {
    // A manual TWS order on the same account: no orderRef, no map entry.
    // Discarded deliberately — adopting it would attach a lot to a position
    // the ladder does not own.
    expect(resolveClientOrderId(new Map([['co-2', 7]]), 99)).toBeNull();
    expect(resolveClientOrderId(new Map(), undefined)).toBeNull();
  });

  it('treats an empty-string orderRef as absent rather than as an id', () => {
    // IB returns '' rather than omitting the field for an order placed without
    // one. Trusting it would produce a lot keyed to the empty string.
    expect(resolveClientOrderId(new Map([['co-2', 7]]), 7, '')).toBe('co-2');
    expect(resolveClientOrderId(new Map(), 7, '')).toBeNull();
  });
});

describe('toTerminalStatus', () => {
  it.each([
    ['Filled', OrderStatus.FILLED],
    ['Cancelled', OrderStatus.CANCELLED],
    ['ApiCancelled', OrderStatus.CANCELLED],
    // IB's terminal state for an order it refused outright.
    ['Inactive', OrderStatus.REJECTED],
  ])('maps IB %s to %s', (ibStatus, expected) => {
    expect(toTerminalStatus(ibStatus)).toBe(expected);
  });

  it('refuses Submitted, which a completed order cannot be', () => {
    // The distinction from `toOrderStatus`, which accepts it: admitting a
    // non-terminal status here would let it be written to an Order row from a
    // source that by definition cannot produce one.
    expect(toTerminalStatus('Submitted')).toBeNull();
  });

  it('refuses PendingCancel, because such an order can still fill', () => {
    expect(toTerminalStatus('PendingCancel')).toBeNull();
  });

  it('refuses an unrecognized status rather than guessing', () => {
    expect(toTerminalStatus('SomethingNew')).toBeNull();
    expect(toTerminalStatus(undefined)).toBeNull();
  });
});

describe('toCompletedOrder', () => {
  const contract = { symbol: 'TQQQ' };
  const order = {
    orderId: 42,
    orderRef: 'ladder-order-7',
    action: 'BUY',
    totalQuantity: 100,
    filledQuantity: 0,
  };

  it('maps a cancelled order to its clientOrderId and terminal status', () => {
    const completed = toCompletedOrder(
      contract as never,
      order as never,
      { status: 'Cancelled' } as never,
    );

    expect(completed).toEqual({
      clientOrderId: 'ladder-order-7',
      brokerOrderId: '42',
      symbol: 'TQQQ',
      side: 'BUY',
      quantity: 100,
      filledQuantity: 0,
      status: OrderStatus.CANCELLED,
      reason: null,
    });
  });

  it('carries the broker’s own explanation when it gave one', () => {
    const completed = toCompletedOrder(
      contract as never,
      order as never,
      { status: 'Inactive', completedStatus: 'expired at the close' } as never,
    );

    expect(completed?.status).toBe(OrderStatus.REJECTED);
    expect(completed?.reason).toBe('expired at the close');
  });

  it('skips an order with no orderRef rather than synthesizing an id', () => {
    // A manual TWS order. There is no Order row to join it to, and an invented
    // id would match nothing while looking like a real record.
    expect(
      toCompletedOrder(
        contract as never,
        { ...order, orderRef: undefined } as never,
        { status: 'Cancelled' } as never,
      ),
    ).toBeNull();
  });

  it('skips a non-terminal status rather than coercing it', () => {
    expect(
      toCompletedOrder(contract as never, order as never, { status: 'Submitted' } as never),
    ).toBeNull();
  });

  it('reads SELL from IB’s action', () => {
    const completed = toCompletedOrder(
      contract as never,
      { ...order, action: 'SELL' } as never,
      { status: 'Filled' } as never,
    );

    expect(completed?.side).toBe('SELL');
    expect(completed?.status).toBe(OrderStatus.FILLED);
  });
});
