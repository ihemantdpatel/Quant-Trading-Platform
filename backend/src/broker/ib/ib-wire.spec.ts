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
import { BrokerOrder } from '../broker-adapter.interface';
import {
  durationString,
  parseIbTime,
  toDomainBar,
  toIbContract,
  toIbEndDateTime,
  toIbOrder,
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
    });
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
