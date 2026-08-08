import { equityContract } from '../../strategies/types';
import { BrokerOrder, ConnectionState, Fill, OrderStatus } from '../broker-adapter.interface';
import { FillMode, MockBrokerAdapter } from './mock-broker.adapter';

const TIMESTAMP = '2025-01-02T10:00:00.000-05:00';

function order(overrides: Partial<BrokerOrder> = {}): BrokerOrder {
  return {
    clientOrderId: 'co-1',
    contract: equityContract('TQQQ'),
    side: 'BUY',
    quantity: 100,
    orderType: 'LMT',
    limitPrice: 95,
    timeInForce: 'DAY',
    timestamp: TIMESTAMP,
    ...overrides,
  };
}

describe('MockBrokerAdapter', () => {
  let broker: MockBrokerAdapter;

  beforeEach(async () => {
    broker = new MockBrokerAdapter();
    await broker.connect();
  });

  describe('connection lifecycle', () => {
    it('starts disconnected and connects on demand', async () => {
      const fresh = new MockBrokerAdapter();
      expect(fresh.isConnected()).toBe(false);

      await fresh.connect();

      expect(fresh.isConnected()).toBe(true);
      expect(fresh.connectionHealth().state).toBe(ConnectionState.CONNECTED);
    });

    it('notifies subscribers of connection changes', async () => {
      const states: ConnectionState[] = [];
      broker.onConnectionChange((health) => states.push(health.state));

      broker.simulateDisconnect();
      await broker.reconnect();

      expect(states).toContain(ConnectionState.DISCONNECTED);
      expect(states).toContain(ConnectionState.CONNECTED);
    });

    it('unsubscribes cleanly', () => {
      const seen: ConnectionState[] = [];
      const unsubscribe = broker.onConnectionChange((h) => seen.push(h.state));

      unsubscribe();
      broker.simulateDisconnect();

      expect(seen).toEqual([]);
    });

    it('records why the connection was lost', () => {
      broker.simulateDisconnect('IB Gateway forced re-authentication');

      expect(broker.connectionHealth().lastError).toBe('IB Gateway forced re-authentication');
      expect(broker.isConnected()).toBe(false);
    });
  });

  describe('exponential backoff on reconnect', () => {
    it('doubles the delay on each attempt', async () => {
      broker.configure({ baseBackoffMs: 1, maxReconnectAttempts: 5 });
      broker.simulateDisconnect();

      const delays = await broker.reconnect(4);

      expect(delays).toEqual([1, 2, 4, 8]);
      expect(broker.isConnected()).toBe(true);
    });

    it('reports the attempt count it succeeded on', async () => {
      broker.configure({ baseBackoffMs: 1 });
      broker.simulateDisconnect();

      await broker.reconnect(3);

      expect(broker.connectionHealth().reconnectAttempts).toBe(3);
    });

    it('lands in FAILED when retries are exhausted', async () => {
      broker.configure({ baseBackoffMs: 1, maxReconnectAttempts: 3 });
      broker.simulateDisconnect();

      // Never succeeds within the attempt budget.
      await broker.reconnect(99);

      expect(broker.connectionHealth().state).toBe(ConnectionState.FAILED);
      expect(broker.isConnected()).toBe(false);
      expect(broker.connectionHealth().lastError).toMatch(/exhausted/);
    });

    it('leaves existing positions untouched when retries are exhausted', async () => {
      // `PRD.md:316` — a network blip must never become a realized loss.
      await broker.submit(order());
      const before = await broker.getPositions();

      broker.configure({ baseBackoffMs: 1, maxReconnectAttempts: 2 });
      broker.simulateDisconnect();
      await broker.reconnect(99);

      expect(await broker.getPositions()).toEqual(before);
      expect(before[0].quantity).toBe(100);
    });
  });

  describe('submission', () => {
    it('throws when disconnected — a fault, not a rejection', async () => {
      broker.simulateDisconnect();

      await expect(broker.submit(order())).rejects.toThrow(/not connected/);
    });

    it('fills immediately at the limit price by default', async () => {
      const fills: Fill[] = [];
      broker.onFill((fill) => fills.push(fill));

      const ack = await broker.submit(order());

      expect(ack.status).toBe(OrderStatus.SUBMITTED);
      expect(fills).toHaveLength(1);
      expect(fills[0].price).toBe(95);
      expect(fills[0].quantity).toBe(100);
    });

    it('rejects with a reason in REJECT mode, without throwing', async () => {
      // A rejection is the broker answering; the engine must carry on.
      broker.configure({ fillMode: FillMode.REJECT, rejectReason: 'insufficient buying power' });

      const ack = await broker.submit(order());

      expect(ack.status).toBe(OrderStatus.REJECTED);
      expect(ack.rejectReason).toBe('insufficient buying power');
      expect(await broker.getPositions()).toEqual([]);
    });

    it('leaves an order resting in RESTING mode until filled explicitly', async () => {
      broker.configure({ fillMode: FillMode.RESTING });

      await broker.submit(order());

      expect(broker.restingOrders()).toHaveLength(1);
      expect(await broker.getPositions()).toEqual([]);

      broker.fillResting('co-1');

      expect(broker.restingOrders()).toHaveLength(0);
      expect((await broker.getPositions())[0].quantity).toBe(100);
    });

    it('fills partially and keeps the remainder resting', async () => {
      broker.configure({ fillMode: FillMode.PARTIAL, partialFillRatio: 0.4 });
      const statuses: OrderStatus[] = [];
      broker.onOrderStatus((ack) => statuses.push(ack.status));

      await broker.submit(order({ quantity: 100 }));

      expect((await broker.getPositions())[0].quantity).toBe(40);
      expect(statuses).toContain(OrderStatus.PARTIALLY_FILLED);
      expect(broker.restingOrders()).toHaveLength(1);
    });

    it('completes a partially filled order on a later fill', async () => {
      broker.configure({ fillMode: FillMode.PARTIAL, partialFillRatio: 0.4 });
      await broker.submit(order({ quantity: 100 }));

      broker.fillResting('co-1');

      expect((await broker.getPositions())[0].quantity).toBe(100);
      expect(broker.restingOrders()).toHaveLength(0);
    });

    it('never fills more than the outstanding quantity', async () => {
      broker.configure({ fillMode: FillMode.RESTING });
      await broker.submit(order({ quantity: 100 }));

      broker.fillResting('co-1', 500);

      expect((await broker.getPositions())[0].quantity).toBe(100);
    });

    it('returns null when filling an unknown or exhausted order', async () => {
      expect(broker.fillResting('nope')).toBeNull();

      broker.configure({ fillMode: FillMode.RESTING });
      await broker.submit(order());
      broker.fillResting('co-1');

      expect(broker.fillResting('co-1')).toBeNull();
    });

    it.each([
      ['zero quantity', { quantity: 0 }, /invalid order quantity/],
      ['negative quantity', { quantity: -5 }, /invalid order quantity/],
      ['zero limit price', { limitPrice: 0 }, /invalid limit price/],
    ])('rejects a malformed order: %s', async (_label, overrides, expected) => {
      // An engine bug should surface here, not in a position report.
      await expect(broker.submit(order(overrides))).rejects.toThrow(expected);
    });

    it('applies slippage against the order on both sides', async () => {
      broker.configure({ slippagePerShare: 0.03 });
      const fills: Fill[] = [];
      broker.onFill((f) => fills.push(f));

      await broker.submit(order({ clientOrderId: 'buy', side: 'BUY', limitPrice: 95 }));
      await broker.submit(order({ clientOrderId: 'sell', side: 'SELL', limitPrice: 99 }));

      expect(fills[0].price).toBe(95.03);
      expect(fills[1].price).toBe(98.97);
    });
  });

  describe('positions', () => {
    it('accumulates average cost across buys', async () => {
      await broker.submit(order({ clientOrderId: 'a', quantity: 100, limitPrice: 100 }));
      await broker.submit(order({ clientOrderId: 'b', quantity: 100, limitPrice: 90 }));

      const [position] = await broker.getPositions();

      expect(position.quantity).toBe(200);
      expect(position.averageCost).toBe(95);
    });

    it('reduces quantity on a sell and leaves average cost unchanged', async () => {
      await broker.submit(order({ clientOrderId: 'a', quantity: 100, limitPrice: 100 }));
      await broker.submit(
        order({ clientOrderId: 'b', side: 'SELL', quantity: 40, limitPrice: 105 }),
      );

      const [position] = await broker.getPositions();

      expect(position.quantity).toBe(60);
      expect(position.averageCost).toBe(100);
    });

    it('drops the position when fully sold', async () => {
      await broker.submit(order({ clientOrderId: 'a', quantity: 100, limitPrice: 100 }));
      await broker.submit(
        order({ clientOrderId: 'b', side: 'SELL', quantity: 100, limitPrice: 105 }),
      );

      expect(await broker.getPositions()).toEqual([]);
    });

    it('reports only net quantity and average cost — never lot composition', async () => {
      // Three lots and one block are indistinguishable here (`stories.md:564`),
      // which is exactly why the database owns lot composition.
      await broker.submit(order({ clientOrderId: 'a', quantity: 100, limitPrice: 100 }));
      await broker.submit(order({ clientOrderId: 'b', quantity: 100, limitPrice: 100 }));
      await broker.submit(order({ clientOrderId: 'c', quantity: 100, limitPrice: 100 }));

      const [position] = await broker.getPositions();

      expect(Object.keys(position).sort()).toEqual(['averageCost', 'quantity', 'symbol']);
      expect(position.quantity).toBe(300);
    });

    it('seeds a position for reconciliation-mismatch testing', async () => {
      broker.seedPosition({ symbol: 'TQQQ', quantity: 500, averageCost: 90 });

      expect(await broker.getPositions()).toEqual([
        { symbol: 'TQQQ', quantity: 500, averageCost: 90 },
      ]);
    });
  });

  describe('determinism', () => {
    it('produces identical results across two identical runs', async () => {
      const run = async (): Promise<unknown> => {
        const adapter = new MockBrokerAdapter();
        await adapter.connect();
        const fills: Fill[] = [];
        adapter.onFill((f) => fills.push(f));

        await adapter.submit(order({ clientOrderId: 'a', limitPrice: 95 }));
        await adapter.submit(order({ clientOrderId: 'b', limitPrice: 90 }));

        return { fills, positions: await adapter.getPositions() };
      };

      expect(await run()).toEqual(await run());
    });

    it('assigns ids from a monotonic counter, never a clock', async () => {
      await broker.submit(order({ clientOrderId: 'a' }));
      await broker.submit(order({ clientOrderId: 'b' }));

      const fills = await Promise.resolve([...broker.submittedOrders()]);

      expect(fills.map((o) => o.clientOrderId)).toEqual(['a', 'b']);
    });
  });

  describe('cancellation and bookkeeping', () => {
    it('cancels a resting order', async () => {
      broker.configure({ fillMode: FillMode.RESTING });
      await broker.submit(order());

      const ack = await broker.cancel('co-1');

      expect(ack.status).toBe(OrderStatus.CANCELLED);
      expect(broker.restingOrders()).toHaveLength(0);
    });

    it('throws when cancelling an unknown order', async () => {
      await expect(broker.cancel('nope')).rejects.toThrow(/no resting order/);
    });

    it('records every submitted order for payload assertions', async () => {
      await broker.submit(order({ clientOrderId: 'a' }));
      await broker.submit(order({ clientOrderId: 'b' }));

      expect(broker.submittedOrders().map((o) => o.clientOrderId)).toEqual(['a', 'b']);
    });

    it('reports account equity for the global capital cap', async () => {
      broker.configure({ equity: 250_000 });

      expect(await broker.getAccountSummary()).toEqual({
        equity: 250_000,
        availableFunds: 250_000,
        currency: 'USD',
      });
    });

    it('applies commission to fills', async () => {
      broker.configure({ commissionPerOrder: 1.25 });
      const fills: Fill[] = [];
      broker.onFill((f) => fills.push(f));

      await broker.submit(order());

      expect(fills[0].commission).toBe(1.25);
    });

    it('reset clears positions, resting orders, and history', async () => {
      await broker.submit(order());

      broker.reset();

      expect(await broker.getPositions()).toEqual([]);
      expect(broker.submittedOrders()).toEqual([]);
      expect(broker.restingOrders()).toEqual([]);
    });

    it('unsubscribes fill and status handlers', async () => {
      const fills: Fill[] = [];
      const statuses: OrderStatus[] = [];
      const offFill = broker.onFill((f) => fills.push(f));
      const offStatus = broker.onOrderStatus((a) => statuses.push(a.status));

      offFill();
      offStatus();
      await broker.submit(order());

      expect(fills).toEqual([]);
      expect(statuses).toEqual([]);
    });

    it('disconnect leaves positions intact', async () => {
      await broker.submit(order());

      await broker.disconnect();

      expect(broker.isConnected()).toBe(false);
      expect((await broker.getPositions())[0].quantity).toBe(100);
    });
  });
});
