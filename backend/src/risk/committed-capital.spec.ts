import { BrokerPosition, OpenOrder } from '../broker/broker-adapter.interface';
import { equityContract, optionContract, OptionRight } from '../domain/contract';
import { committedCapital } from './committed-capital';
const put = optionContract({
  symbol: 'QQQ',
  strike: 500,
  expiry: '2026-11-20',
  right: OptionRight.PUT,
});
const call = { ...put, right: OptionRight.CALL };
const order = (overrides: Partial<OpenOrder>): OpenOrder => ({
  clientOrderId: 'x',
  brokerOrderId: '1',
  symbol: 'QQQ',
  side: 'SELL',
  quantity: 2,
  filledQuantity: 1,
  limitPrice: 2,
  contract: put,
  ...overrides,
});
const position = (overrides: Partial<BrokerPosition>): BrokerPosition => ({
  symbol: 'QQQ',
  quantity: -1,
  averageCost: 200,
  contract: put,
  ...overrides,
});
describe('gross account commitments', () => {
  it('counts short put assignment liabilities rather than premium credits', () => {
    expect(committedCapital([position({})], [order({})]).total).toBe(100000);
  });
  it('counts stocks and pending stock buys, never offsetting them with short call premiums', () => {
    const stocks = position({ contract: equityContract('QQQ'), quantity: 100, averageCost: 500 });
    expect(
      committedCapital(
        [stocks, position({ contract: call })],
        [
          order({
            contract: equityContract('TQQQ'),
            symbol: 'TQQQ',
            side: 'BUY',
            quantity: 50,
            filledQuantity: 0,
            limitPrice: 50,
          }),
        ],
      ),
    ).toEqual({ total: 52500, bySymbol: { QQQ: 50000, TQQQ: 2500 }, byStrategy: {} });
  });
  it('counts long option cost and outstanding option buy premiums with multiplier', () => {
    expect(committedCapital([position({ quantity: 1 })], [order({ side: 'BUY' })]).total).toBe(400);
  });
  it('does not add covered call sells or stock sells to gross stock capital', () => {
    expect(
      committedCapital(
        [position({ contract: equityContract('QQQ'), quantity: 200, averageCost: 1 })],
        [order({ contract: call }), order({ contract: equityContract('QQQ') })],
      ).total,
    ).toBe(200);
  });
  it('supports legacy stock shapes and empty accounts', () => {
    expect(
      committedCapital(
        [position({ contract: undefined, quantity: 10, averageCost: 5 })],
        [order({ contract: undefined, side: 'BUY' })],
      ).total,
    ).toBe(52);
    expect(committedCapital([], []).total).toBe(0);
  });
  it('never reserves negative remaining quantities', () => {
    expect(committedCapital([], [order({ filledQuantity: 3 })]).total).toBe(0);
  });
});

it('refuses naked calls and double reservation of shares against stock sells and calls', () => {
  expect(() => committedCapital([position({ contract: call })], [])).toThrow('uncovered call');
  expect(() => committedCapital([], [order({ contract: call })])).toThrow('uncovered call');
  const stock = position({ contract: equityContract('QQQ'), quantity: 100, averageCost: 500 });
  expect(() =>
    committedCapital(
      [stock, position({ contract: call })],
      [order({ contract: equityContract('QQQ'), quantity: 100, filledQuantity: 0 })],
    ),
  ).toThrow('uncovered call');
  expect(committedCapital([stock], [order({ contract: call })]).total).toBe(50000);
  expect(committedCapital([stock], [order({ contract: call, filledQuantity: 2 })]).total).toBe(
    50000,
  );
});
