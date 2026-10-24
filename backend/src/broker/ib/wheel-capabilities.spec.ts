import { IBBrokerAdapter } from './ib-broker.adapter';
import { FakeIbSocket } from './fake-ib-socket';

describe('IB wheel capability boundary', () => {
  it('refuses unsupported or disconnected options data rather than returning an empty account', async () => {
    const adapter = new IBBrokerAdapter(new FakeIbSocket());
    await expect(adapter.getWheelFunds()).rejects.toThrow('unavailable');
    await expect(adapter.getAccountOpenOrders()).rejects.toThrow('unavailable');
    await expect(
      adapter.scanOptions({ symbol: 'QQQ', right: 'P', minDte: 21, maxDte: 45 }),
    ).rejects.toThrow('unavailable');
    await adapter.connect();
    await expect(adapter.getWheelFunds()).rejects.toThrow('unavailable');
    await expect(adapter.getAccountOpenOrders()).rejects.toThrow('unavailable');
    await expect(
      adapter.scanOptions({ symbol: 'QQQ', right: 'P', minDte: 21, maxDte: 45 }),
    ).rejects.toThrow('unavailable');
    await adapter.disconnect();
  });
  it('forwards supported requests through the connected account socket', async () => {
    const scan = {
      symbol: 'QQQ',
      right: 'P' as const,
      minDte: 21,
      maxDte: 45,
      quotes: [],
      underlyingPrice: 550,
    };
    const socket = Object.assign(new FakeIbSocket(), {
      scanOptions: jest.fn(async () => scan),
      getWheelFunds: jest.fn(async () => ({ cashUsd: 160000, realized: 10, unrealized: -20 })),
      getAccountOpenOrders: jest.fn(async () => []),
    });
    const adapter = new IBBrokerAdapter(socket);
    await adapter.connect();
    expect(
      await adapter.scanOptions({ symbol: 'QQQ', right: 'P', minDte: 21, maxDte: 45 }),
    ).toEqual(scan);
    expect(await adapter.getWheelFunds()).toEqual({
      cashUsd: 160000,
      realized: 10,
      unrealized: -20,
    });
    expect(await adapter.getAccountOpenOrders()).toEqual([]);
    await adapter.disconnect();
  });
});
