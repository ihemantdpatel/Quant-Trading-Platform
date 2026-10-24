import { optionContract, OptionRight, SecurityType } from '../../domain/contract';
import { OptionQuote } from '../../domain/options';
import { runStrategyContractSuite } from '../contract-test-suite';
import { StrategyContext, StrategyState } from '../types';
import { wheelConfigSchema } from './config';
import { WheelEvaluation, WheelStrategy } from './wheel.strategy';

runStrategyContractSuite({ name: 'WheelStrategy', create: () => new WheelStrategy() });
const now = '2026-10-23T14:15:00.000Z';
const config = wheelConfigSchema.parse({ symbol: 'QQQ', allocation: 160000 });
const quote = (overrides: Partial<OptionQuote> = {}): OptionQuote => ({
  contract: optionContract({
    symbol: 'QQQ',
    strike: 500,
    expiry: '2026-11-20',
    right: OptionRight.PUT,
  }),
  bid: 2,
  ask: 2.1,
  delta: -0.2,
  openInterest: 1000,
  receivedAt: now,
  ...overrides,
});
const state: StrategyState = { strategyId: 'wheel', version: 1, symbols: ['QQQ'], data: {} };
function evaluate(input: Partial<WheelEvaluation> = {}, at = now) {
  const ctx: StrategyContext = {
    strategyId: 'wheel',
    symbols: ['QQQ'],
    parameters: {},
    history: [],
    now: at,
    wheel: {
      config,
      quotes: [quote()],
      underlyingPrice: 550,
      ownedShares: 0,
      stockCost: 0,
      cashAvailable: 100000,
      hasExposure: false,
      ...input,
    },
  };
  return new WheelStrategy().evaluate(ctx, state);
}

describe('wheel decisions', () => {
  it('sells one fully cash-secured put at the bid, without changing state', () => {
    expect(evaluate()[0]).toMatchObject({
      side: 'SELL',
      quantity: 1,
      limitPrice: 2,
      metadata: { exposureEffect: 'OPEN', collateralPerContract: 50000 },
    });
    expect(state.data).toEqual({});
  });
  it('caps quantity by the available cash and configured contract limit', () => {
    expect(
      evaluate({ config: { ...config, maxContracts: 3 }, cashAvailable: 100000 })[0].quantity,
    ).toBe(2);
  });
  it.each([0, 49999])('declines insufficient funding %s', (cashAvailable) => {
    expect(evaluate({ cashAvailable })).toEqual([]);
  });
  it('declines a new cycle while orders or shorts exist', () =>
    expect(evaluate({ hasExposure: true })).toEqual([]));
  it('does not sell puts while an odd-lot stock position remains', () =>
    expect(evaluate({ ownedShares: 99 })).toEqual([]));
  it('writes only calls covered by whole 100-share blocks, above stock basis', () => {
    const call = quote({
      contract: optionContract({
        symbol: 'QQQ',
        strike: 560,
        expiry: '2026-11-20',
        right: OptionRight.CALL,
      }),
      delta: 0.2,
    });
    expect(
      evaluate({ ownedShares: 100, stockCost: 555, cashAvailable: 0, quotes: [call] })[0],
    ).toMatchObject({ quantity: 1, metadata: { collateralPerContract: 0 } });
    expect(evaluate({ ownedShares: 100, stockCost: 570, quotes: [call] })).toEqual([]);
    expect(
      evaluate({ ownedShares: 100, underlyingPrice: 570, stockCost: 500, quotes: [call] }),
    ).toEqual([]);
  });
  it('ranks by delta, then expiry, then strike deterministically', () => {
    const a = quote({ delta: -0.1 });
    const b = quote({ delta: -0.2, contract: { ...a.contract, strike: 510 } });
    const c = quote({ contract: { ...a.contract, expiry: '2026-11-25' } });
    const d = quote();
    expect(evaluate({ quotes: [a, b, c, d] })[0].contract.strike).toBe(500);
    expect(evaluate({ quotes: [b, a, d, c] })[0].contract.strike).toBe(500);
  });
  it.each([
    ['no bids', { bid: 0 }],
    ['invalid bid', { bid: NaN }],
    ['invalid ask', { ask: NaN }],
    ['crossed market', { ask: 1 }],
    ['wide spread', { ask: 4 }],
    ['thin chain', { openInterest: 0 }],
    ['invalid open interest', { openInterest: Infinity }],
    ['missing delta', { delta: NaN }],
    ['excessive delta', { delta: -0.5 }],
    ['wrong delta sign', { delta: 0.2 }],
    ['old quote', { receivedAt: '2026-10-23T14:10:00Z' }],
    ['future quote', { receivedAt: '2026-10-23T14:16:00Z' }],
    ['bad quote time', { receivedAt: 'invalid' }],
  ] as [string, Partial<OptionQuote>][])('rejects %s', (_name, bad) =>
    expect(evaluate({ quotes: [quote(bad)] })).toEqual([]),
  );
  it.each([
    { symbol: 'SPY' },
    { secType: SecurityType.STOCK },
    { multiplier: 10 },
    { currency: 'CAD' },
    { strike: 600 },
    { right: OptionRight.CALL },
    { expiry: '2026-10-24' },
    { expiry: '2027-01-01' },
    { expiry: undefined },
    { strike: undefined },
  ])('rejects an unsuitable contract %j', (bad) => {
    expect(evaluate({ quotes: [quote({ contract: { ...quote().contract, ...bad } })] })).toEqual(
      [],
    );
  });
  it('requires the right delta sign for calls', () => {
    expect(
      evaluate({
        ownedShares: 100,
        quotes: [
          quote({ contract: { ...quote().contract, right: OptionRight.CALL, strike: 600 } }),
        ],
      }),
    ).toEqual([]);
  });
  it.each(['invalid', '2026-10-24T14:15:00Z', '2026-10-23T13:59:00Z', '2026-10-23T19:30:00Z'])(
    'does not decide outside its session: %s',
    (at) => expect(evaluate({}, at)).toEqual([]),
  );
  it('validates configuration and supplies conservative defaults', () => {
    expect(config).toMatchObject({ maxContracts: 1, minDte: 21, maxDte: 45 });
    expect(
      wheelConfigSchema.safeParse({ symbol: 'QQQ', allocation: 1, minDte: 40, maxDte: 20 }).success,
    ).toBe(false);
    expect(wheelConfigSchema.safeParse({ symbol: 'QQQ', allocation: 0 }).success).toBe(false);
  });
});
