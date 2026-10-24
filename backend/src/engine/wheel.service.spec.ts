import { WheelService } from './wheel.service';
import { EngineService } from './engine.service';
import { StartupSequence } from './startup.sequence';
import {
  BrokerAdapter,
  BrokerPosition,
  CompletedOrder,
  Fill,
  OpenOrder,
  OrderStatus,
} from '../broker/broker-adapter.interface';
import { AppConfigService } from '../config/app-config.service';
import { ExecutionMode } from '../config/execution-mode';
import { equityContract, optionContract, OptionRight } from '../domain/contract';
import { RiskManagerService } from '../risk/risk-manager.service';
import { buildRiskConfig } from '../risk/risk.config';
import { KillSwitchService } from '../risk/kill-switch.service';
import { CoordinatorService } from '../strategies/coordinator.service';
import {
  InMemoryFillRepository,
  InMemoryOrderIntentRepository,
  InMemoryOrderRepository,
  InMemoryStrategyStateSnapshotRepository,
} from '../repositories/in-memory/in-memory.repositories';

const now = '2026-10-23T14:15:00.000Z';
const put = optionContract({
  symbol: 'QQQ',
  strike: 500,
  expiry: '2026-11-20',
  right: OptionRight.PUT,
});
function harness() {
  const snapshots = new InMemoryStrategyStateSnapshotRepository();
  const intents = new InMemoryOrderIntentRepository();
  const orders = new InMemoryOrderRepository();
  const fills = new InMemoryFillRepository();
  const config = buildRiskConfig({ accountEquity: 175000 });
  const kill = new KillSwitchService();
  const risk = new RiskManagerService(config, ExecutionMode.PAPER, kill);
  let positions: BrokerPosition[] = [];
  let open: OpenOrder[] = [];
  let completed: CompletedOrder[] = [];
  let handler: (fill: Fill) => void = () => undefined;
  const broker = {
    onFill: jest.fn((fn: typeof handler) => {
      handler = fn;
      return jest.fn();
    }),
    isConnected: jest.fn(() => true),
    getPositions: jest.fn(async () => positions),
    getOpenOrders: jest.fn(async () => open),
    getCompletedOrders: jest.fn(async () => completed),
    getWheelFunds: jest.fn(async () => ({ cashUsd: 160000, realized: 0, unrealized: 0 })),
    scanOptions: jest.fn(async () => ({
      symbol: 'QQQ',
      right: 'P' as const,
      minDte: 21,
      maxDte: 45,
      underlyingPrice: 550,
      quotes: [
        { contract: put, bid: 2, ask: 2.1, delta: -0.2, openInterest: 1000, receivedAt: now },
      ],
    })),
    submit: jest.fn(async (o: { clientOrderId: string; quantity: number }) => {
      open = [
        {
          clientOrderId: o.clientOrderId,
          brokerOrderId: '1',
          symbol: 'QQQ',
          contract: put,
          side: 'SELL',
          quantity: o.quantity,
          filledQuantity: 0,
          limitPrice: 2,
        },
      ];
      return { clientOrderId: o.clientOrderId, brokerOrderId: '1', status: OrderStatus.SUBMITTED };
    }),
  };
  const app = {
    accountAlias: 'paper',
    executionMode: ExecutionMode.PAPER,
    ibAccountId: 'DU1234567',
    hasDurableStorage: true,
  };
  let lock: Promise<unknown> = Promise.resolve();
  const engine = {
    isHalted: jest.fn(() => false),
    setWheelRiskEnabled: jest.fn(),
    runAccountSubmission: <T>(fn: () => Promise<T>): Promise<T> => {
      const next = lock.then(fn);
      lock = next.catch(() => undefined);
      return next;
    },
  };
  const startup = { hasReconciled: jest.fn(() => true) };
  const coordinator = { snapshots: jest.fn(() => [{ id: 'grid-TQQQ', symbols: ['TQQQ'] }]) };
  const create = () =>
    new WheelService(
      broker as unknown as BrokerAdapter,
      app as AppConfigService,
      risk,
      config,
      engine as unknown as EngineService,
      startup as unknown as StartupSequence,
      coordinator as unknown as CoordinatorService,
      snapshots,
      intents,
      orders,
      fills,
    );
  return {
    create,
    snapshots,
    intents,
    orders,
    fills,
    risk,
    kill,
    broker,
    app,
    engine,
    startup,
    coordinator,
    positions: (p: BrokerPosition[]) => {
      positions = p;
    },
    open: (o: OpenOrder[]) => {
      open = o;
    },
    completed: (c: CompletedOrder[]) => {
      completed = c;
    },
    emit: (f: Fill) => handler(f),
  };
}
async function configured(h: ReturnType<typeof harness>) {
  const s = h.create();
  await s.configure({ symbol: 'QQQ', allocation: 160000 });
  await s.setEnabled(true);
  return s;
}
function fill(id: string, overrides: Partial<Fill> = {}): Fill {
  return {
    clientOrderId: id,
    brokerOrderId: '1',
    fillId: 'exec-1',
    symbol: 'QQQ',
    side: 'SELL',
    quantity: 1,
    price: 2.1,
    commission: 0,
    timestamp: now,
    contract: put,
    ...overrides,
  };
}

describe('paper wheel execution and recovery', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(now));
  });
  afterEach(() => jest.useRealTimers());
  it('starts disabled, previews without submitting, persists full intent before submitting', async () => {
    const h = harness();
    const s = h.create();
    expect(await s.run()).toEqual({ submitted: null, reason: 'wheel disabled' });
    await s.configure({ symbol: 'QQQ', allocation: 160000 });
    expect((await s.preview()).intents).toHaveLength(1);
    expect(h.broker.submit).not.toHaveBeenCalled();
    await s.setEnabled(true);
    h.broker.submit.mockImplementationOnce(async (o) => {
      expect((await h.snapshots.findLatest('wheel-runtime'))!.data.orders).toEqual([
        expect.objectContaining({ id: o.clientOrderId, status: 'PREPARED' }),
      ]);
      expect((await h.intents.findAll())[0].intent.contract).toEqual(put);
      return { clientOrderId: o.clientOrderId, brokerOrderId: '1', status: OrderStatus.SUBMITTED };
    });
    expect((await s.run()).submitted).toMatch(/^wheel-paper-/);
    s.onModuleDestroy();
  });
  it('does not duplicate a working order after restart', async () => {
    const h = harness();
    const s = await configured(h);
    await s.run();
    s.onModuleDestroy();
    const restored = h.create();
    expect((await restored.run()).submitted).toBeNull();
    expect(h.broker.submit).toHaveBeenCalledTimes(1);
    restored.onModuleDestroy();
  });
  it('deduplicates execution replay and tracks a confirmed short by full contract', async () => {
    const h = harness();
    const s = await configured(h);
    const id = (await s.run()).submitted!;
    h.emit(fill(id));
    h.emit(fill(id));
    await s.status();
    h.open([]);
    h.positions([{ symbol: 'QQQ', quantity: -1, averageCost: 210, contract: put }]);
    expect((await s.run()).submitted).toBeNull();
    expect(await h.fills.findAll()).toHaveLength(1);
    expect((await s.status()).orders[0].status).toBe(OrderStatus.FILLED);
    s.onModuleDestroy();
  });
  it('halts on assignment, then accepts operator-confirmed stock basis and writes a covered call', async () => {
    const h = harness();
    const s = await configured(h);
    const id = (await s.run()).submitted!;
    h.emit(fill(id));
    await s.status();
    h.open([]);
    h.positions([
      { symbol: 'QQQ', quantity: 100, averageCost: 500, contract: equityContract('QQQ') },
    ]);
    await expect(s.run()).rejects.toThrow('positions changed');
    expect(h.broker.submit).toHaveBeenCalledTimes(1);
    await s.reconcile('IB activity: assigned one QQQ put at 500');
    const call = { ...put, right: OptionRight.CALL, strike: 560 };
    h.broker.scanOptions.mockResolvedValue({
      symbol: 'QQQ',
      right: 'P',
      minDte: 21,
      maxDte: 45,
      underlyingPrice: 550,
      quotes: [
        { contract: call, bid: 2, ask: 2.1, delta: 0.2, openInterest: 1000, receivedAt: now },
      ],
    });
    await s.run();
    expect(h.broker.submit).toHaveBeenLastCalledWith(
      expect.objectContaining({ contract: call, side: 'SELL', quantity: 1 }),
    );
    s.onModuleDestroy();
  });
  it('requires reconciliation when an option disappears, including while the daemon was down', async () => {
    const h = harness();
    const s = await configured(h);
    const id = (await s.run()).submitted!;
    h.emit(fill(id));
    await s.status();
    h.open([]);
    s.onModuleDestroy();
    const restored = h.create();
    await expect(restored.run()).rejects.toThrow('positions changed');
    await restored.reconcile('IB statement confirms put expired without assignment');
    expect((await restored.run()).submitted).not.toBeNull();
    restored.onModuleDestroy();
  });
  it('never retries an ambiguous submit failure', async () => {
    const h = harness();
    const s = await configured(h);
    h.broker.submit.mockRejectedValueOnce(new Error('socket lost after send'));
    await expect(s.run()).rejects.toThrow('socket lost');
    await expect(s.run()).rejects.toThrow('socket lost');
    expect(h.broker.submit).toHaveBeenCalledTimes(1);
    await s.reconcile('IB confirms no order and no execution');
    expect((await s.status()).halt).toBeNull();
    s.onModuleDestroy();
  });
  it('requires explicit resolution of a prepared order lost across a crash', async () => {
    const h = harness();
    const s = await configured(h);
    await s.run();
    s.onModuleDestroy();
    h.open([]);
    const restored = h.create();
    await expect(restored.run()).rejects.toThrow('unknown outcome');
    restored.onModuleDestroy();
  });
  it('reserves GRID stock BUYs and open put collateral from cash', async () => {
    const h = harness();
    const s = await configured(h);
    h.broker.getWheelFunds.mockResolvedValue({ cashUsd: 60000, realized: 0, unrealized: 0 });
    h.open([
      {
        symbol: 'TQQQ',
        side: 'BUY',
        quantity: 500,
        filledQuantity: 0,
        limitPrice: 50,
        clientOrderId: 'grid-1',
        brokerOrderId: '2',
        contract: equityContract('TQQQ'),
      },
    ]);
    expect((await s.run()).submitted).toBeNull();
    expect(h.broker.submit).not.toHaveBeenCalled();
    s.onModuleDestroy();
  });
  it('retains the account cap even with a 160000 allocation', async () => {
    const h = harness();
    const s = await configured(h);
    h.positions([
      { symbol: 'TQQQ', quantity: 1000, averageCost: 80, contract: equityContract('TQQQ') },
    ]);
    expect((await s.run()).submitted).toBeNull();
    expect(h.broker.submit).not.toHaveBeenCalled();
    s.onModuleDestroy();
  });
  it('honors the global kill switch and technical halt for SELL OPEN', async () => {
    const h = harness();
    const s = await configured(h);
    h.kill.engage('test', now);
    await expect(s.run()).rejects.toThrow('submission halted');
    expect(h.broker.submit).not.toHaveBeenCalled();
    s.onModuleDestroy();
    const h2 = harness();
    const s2 = await configured(h2);
    h2.engine.isHalted.mockReturnValue(true);
    await expect(s2.run()).rejects.toThrow('engine is halted');
    expect(h2.broker.submit).not.toHaveBeenCalled();
    s2.onModuleDestroy();
  });
  it('refuses live accounts, volatile storage, and overlapping GRID ownership', async () => {
    for (const bad of [
      { executionMode: ExecutionMode.LIVE },
      { ibAccountId: 'U1234567' },
      { hasDurableStorage: false },
    ]) {
      const h = harness();
      Object.assign(h.app, bad);
      const s = h.create();
      await expect(s.configure({ symbol: 'QQQ', allocation: 160000 })).rejects.toThrow(
        'requires PAPER',
      );
      s.onModuleDestroy();
    }
    const h = harness();
    const s = h.create();
    await expect(s.configure({ symbol: 'TQQQ', allocation: 160000 })).rejects.toThrow(
      'another strategy',
    );
    s.onModuleDestroy();
  });
  it('refuses manual working orders and unknown option positions without cancelling them', async () => {
    const h = harness();
    const s = await configured(h);
    h.open([
      {
        symbol: 'QQQ',
        contract: put,
        side: 'SELL',
        quantity: 1,
        filledQuantity: 0,
        limitPrice: 2,
        clientOrderId: 'manual-1',
        brokerOrderId: '3',
      },
    ]);
    await expect(s.run()).rejects.toThrow('untracked order');
    await expect(s.reconcile('test activity ref')).rejects.toThrow('no open');
    s.onModuleDestroy();
    const h2 = harness();
    const s2 = await configured(h2);
    h2.positions([{ symbol: 'QQQ', contract: put, quantity: -1, averageCost: 200 }]);
    await expect(s2.run()).rejects.toThrow('positions changed');
    s2.onModuleDestroy();
  });
  it('fails closed on broker errors and permits clearing a transient halt after verification', async () => {
    const h = harness();
    const s = await configured(h);
    h.broker.getPositions.mockRejectedValueOnce(new Error('broker down'));
    await expect(s.run()).rejects.toThrow('broker down');
    await s.clearHalt('gateway recovered; positions verified');
    expect((await s.status()).halt).toBeNull();
    s.onModuleDestroy();
  });
  it('does not submit if persistence fails before broker submission', async () => {
    const h = harness();
    const s = await configured(h);
    jest.spyOn(h.snapshots, 'save').mockRejectedValue(new Error('database unavailable'));
    await expect(s.run()).rejects.toThrow('database unavailable');
    expect(h.broker.submit).not.toHaveBeenCalled();
    s.onModuleDestroy();
  });
  it('disable stops new orders without cancelling existing ones', async () => {
    const h = harness();
    const s = await configured(h);
    await s.run();
    await s.setEnabled(false);
    expect((await s.run()).reason).toBe('wheel disabled');
    await expect(s.configure({ symbol: 'SPY', allocation: 160000 })).rejects.toThrow('settle');
    s.onModuleDestroy();
  });
  it('records partial contracts and never writes another option against a cancelled partial fill', async () => {
    const h = harness();
    const s = h.create();
    await s.configure({ symbol: 'QQQ', allocation: 160000, maxContracts: 2 });
    await s.setEnabled(true);
    const id = (await s.run()).submitted!;
    h.emit(fill(id));
    await s.status();
    h.positions([{ symbol: 'QQQ', contract: put, quantity: -1, averageCost: 210 }]);
    h.open([
      {
        symbol: 'QQQ',
        contract: put,
        side: 'SELL',
        quantity: 2,
        filledQuantity: 1,
        limitPrice: 2,
        clientOrderId: id,
        brokerOrderId: '1',
      },
    ]);
    expect((await s.run()).submitted).toBeNull();
    h.open([]);
    h.completed([
      {
        clientOrderId: id,
        brokerOrderId: '1',
        symbol: 'QQQ',
        side: 'SELL',
        quantity: 2,
        filledQuantity: 1,
        status: OrderStatus.CANCELLED,
        reason: null,
      },
    ]);
    expect((await s.run()).submitted).toBeNull();
    expect(h.broker.submit).toHaveBeenCalledTimes(1);
    s.onModuleDestroy();
  });
  it('clears a temporary fault while an existing short remains verified', async () => {
    const h = harness();
    const s = await configured(h);
    const id = (await s.run()).submitted!;
    h.emit(fill(id));
    await s.status();
    h.open([]);
    h.positions([{ symbol: 'QQQ', contract: put, quantity: -1, averageCost: 210 }]);
    h.broker.scanOptions.mockRejectedValueOnce(new Error('market data connection interrupted'));
    await expect(s.run()).rejects.toThrow('interrupted');
    await s.clearHalt('restored connection and confirmed short position');
    expect((await s.status()).halt).toBeNull();
    expect((await s.run()).submitted).toBeNull();
    s.onModuleDestroy();
  });
  it('does not scan or latch a fault outside the wheel entry session', async () => {
    const h = harness();
    const s = await configured(h);
    jest.setSystemTime(new Date('2026-10-24T14:15:00Z'));
    expect((await s.run()).reason).toBe('outside wheel trading session');
    expect(h.broker.scanOptions).not.toHaveBeenCalled();
    expect((await s.status()).halt).toBeNull();
    s.onModuleDestroy();
  });
  it('waits for execution replay before settling a terminal partially filled order', async () => {
    const h = harness();
    const s = await configured(h);
    const id = (await s.run()).submitted!;
    h.open([]);
    h.completed([
      {
        clientOrderId: id,
        brokerOrderId: '1',
        symbol: 'QQQ',
        side: 'SELL',
        quantity: 1,
        filledQuantity: 1,
        status: OrderStatus.CANCELLED,
        reason: null,
      },
    ]);
    await expect(s.run()).rejects.toThrow('executions are incomplete');
    expect((await s.status()).orders[0].settled).toBe(false);
    h.emit(fill(id));
    await s.status();
    h.positions([{ symbol: 'QQQ', contract: put, quantity: -1, averageCost: 210 }]);
    await s.clearHalt('execution replay arrived and broker short agrees');
    expect((await s.run()).submitted).toBeNull();
    s.onModuleDestroy();
  });
});
