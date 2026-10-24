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
