import { SecType, OptionType } from '@stoqey/ib';
import { fromIbContract } from './ib-wire';
import { equityContract, OptionRight, SecurityType } from '../../domain/contract';
it('preserves the option series and multiplier returned by IB', () => {
  expect(
    fromIbContract({
      symbol: 'QQQ',
      secType: SecType.OPT,
      strike: 500,
      lastTradeDateOrContractMonth: '20261120',
      right: OptionType.Put,
      multiplier: 100,
      currency: 'USD',
    }),
  ).toEqual({
    symbol: 'QQQ',
    secType: SecurityType.OPTION,
    strike: 500,
    expiry: '2026-11-20',
    right: OptionRight.PUT,
    multiplier: 100,
    currency: 'USD',
    exchange: 'SMART',
  });
});
it('keeps equities in the original vocabulary, and never invents a missing option expiry', () => {
  expect(fromIbContract({ symbol: 'QQQ', secType: SecType.STK, currency: 'USD' })).toEqual(
    equityContract('QQQ'),
  );
  expect(fromIbContract({ secType: SecType.OPT }).expiry).toBeUndefined();
  expect(fromIbContract({}).symbol).toBe('');
});

import { isRequestScopedIbError } from './ib-wire';
it('keeps contract and market-data request failures separate from socket faults', () => {
  for (const code of [162, 200, 201, 202, 300, 354, 10089])
    expect(isRequestScopedIbError(code, 7)).toBe(true);
  for (const code of [502, 504, 1100, 1101, 1102, 1300])
    expect(isRequestScopedIbError(code, 7)).toBe(false);
  expect(isRequestScopedIbError(200, -1)).toBe(false);
  expect(isRequestScopedIbError(null, 7)).toBe(false);
});

import { usdCashBalance } from './ib-wire';
it('reads prefixed and legacy USD ledger fields while refusing missing or non-USD values', () => {
  const values = (key: string, currency: string, value: unknown) =>
    new Map([[key, new Map([[currency, { value }]])]]);
  expect(usdCashBalance(values('$LEDGER-CashBalance', 'USD', '160000.00'))).toBe(160000);
  expect(usdCashBalance(values('CashBalance', 'USD', '0'))).toBe(0);
  expect(usdCashBalance(values('$LEDGER-CashBalance', 'CAD', '250000'))).toBeNull();
  expect(usdCashBalance(values('CashBalance', 'USD', ''))).toBeNull();
  expect(usdCashBalance(values('CashBalance', 'USD', 'unknown'))).toBeNull();
  expect(usdCashBalance(new Map())).toBeNull();
});
