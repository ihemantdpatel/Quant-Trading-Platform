/**
 * `MockBrokerAdapter` — a deterministic test double, and **a real artifact
 * rather than scaffolding** (`stories.md:385`).
 *
 * It is the only broker in existence until Story 10, so every integration test,
 * the Story 7 dashboard, and Story 9's reconciliation are all built against it.
 * That makes its fidelity load-bearing: a mock that only ever fills perfectly
 * would let the engine ship with no handling for partial fills, rejections, or
 * a socket dropping mid-order, and those paths would first execute against a
 * live broker with real money.
 *
 * So it models the awkward cases on purpose:
 *
 * - **Fills are asynchronous and configurable** — immediate, partial, delayed
 *   until a later bar, or never.
 * - **Rejections are answers, not faults.** A rejected order is acknowledged
 *   with a reason; the engine keeps running.
 * - **Disconnects are faults.** `submit()` throws, and the engine must halt new
 *   entries while **never liquidating** (`PRD.md:316`).
 * - **Reconnect uses real exponential backoff** with the same bounded-retry
 *   shape Story 10 needs, so that logic is exercised before it meets IB.
 *
 * Determinism is absolute: no clock, no randomness. Fill prices and timing come
 * from configuration and from the bar timestamps the engine passes in, so a
 * replay produces byte-identical results every run.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  AccountSummary,
  BrokerAdapter,
  BrokerOrder,
  BrokerPosition,
  ConnectionHealth,
  ConnectionState,
  Fill,
  CompletedOrder,
  OpenOrder,
  OrderSide,
  OrderAck,
  OrderStatus,
} from '../broker-adapter.interface';

export enum FillMode {
  /** Fills completely, at the limit price, on submission. The default. */
  IMMEDIATE = 'IMMEDIATE',
  /** Fills `partialFillRatio` of the quantity, leaving the rest resting. */
  PARTIAL = 'PARTIAL',
  /** Acknowledged and left resting — filled only by an explicit `fillResting`. */
  RESTING = 'RESTING',
  /**
   * Acknowledged and left resting until the **market reaches the limit** —
   * a BUY fills when price trades at or below its limit, a SELL at or above.
   *
   * The only mode that models what a resting order actually is. `IMMEDIATE`
   * fills at the limit price on submission regardless of where the market is,
   * which is roughly right for an entry (a ladder rung sits below the market,
   * so a marketable order would fill near there anyway) and completely wrong
   * for an exit: a take-profit sell rests *above* the market by construction
   * and must not fill until price rallies to it. Under `IMMEDIATE` every lot
   * opens and closes on the same bar, which is not a cycle any exchange would
   * produce.
   *
   * Requires the caller to drive `advanceMarket` per bar; without it nothing
   * ever fills, which is the honest representation of a market that never moved.
   */
  MARKET_AWARE = 'MARKET_AWARE',
  /** Refused with `rejectReason`. */
  REJECT = 'REJECT',
}

export interface MockBrokerConfig {
  fillMode: FillMode;
  /** 0–1. Used by `PARTIAL`; floored to whole shares. */
  partialFillRatio: number;
  /** Per-share slippage added to a BUY and subtracted from a SELL. */
  slippagePerShare: number;
  commissionPerOrder: number;
  rejectReason: string;
  /** Starting account equity, what the global capital cap measures against. */
  equity: number;
  /** Max reconnect attempts before the connection is declared FAILED. */
  maxReconnectAttempts: number;
  /** First backoff delay in ms; doubles each attempt. */
  baseBackoffMs: number;
}

export const DEFAULT_MOCK_BROKER_CONFIG: MockBrokerConfig = {
  fillMode: FillMode.IMMEDIATE,
  partialFillRatio: 0.5,
  slippagePerShare: 0,
  commissionPerOrder: 0,
  rejectReason: 'mock rejection',
  equity: 100_000,
  maxReconnectAttempts: 5,
  baseBackoffMs: 10,
};

/** A resting order the broker still holds. */
interface RestingOrder {
  order: BrokerOrder;
  brokerOrderId: string;
  filledQuantity: number;
}

@Injectable()
export class MockBrokerAdapter implements BrokerAdapter {
  readonly name = 'mock';

  private readonly logger = new Logger(MockBrokerAdapter.name);
  private config: MockBrokerConfig;

  private health: ConnectionHealth = {
    state: ConnectionState.DISCONNECTED,
    connectedAt: null,
    reconnectAttempts: 0,
    lastError: null,
  };

  private readonly positions = new Map<string, BrokerPosition>();
  private readonly resting = new Map<string, RestingOrder>();
  /**
   * Last price supplied to `advanceMarket`, or null before any bar.
   *
   * Null is not zero: before the first bar the mock has no opinion about where
   * the market is, and treating that as 0 would make every SELL marketable.
   */
  private lastPrice: number | null = null;
  /** Timestamp of the last bar supplied to `advanceMarket`. Stamps its fills. */
  private lastTime: string | null = null;
  /**
   * Terminal-state orders, in the order they completed.
   *
   * The broker's own history, kept because the engine cannot reconstruct it:
   * a status it could not attribute at the time is exactly what this list is
   * for.
   */
  private readonly completed: CompletedOrder[] = [];
  private readonly fillHandlers = new Set<(fill: Fill) => void>();
  private readonly statusHandlers = new Set<(ack: OrderAck) => void>();
  private readonly connectionHandlers = new Set<(health: ConnectionHealth) => void>();

  /** Monotonic counters — determinism requires ids not derived from a clock. */
  private orderSequence = 0;
  private fillSequence = 0;

  /** Every fill emitted this session, for `replayFill`. */
  private readonly emitted: Fill[] = [];

  /** Every order ever accepted, for field-by-field payload assertions. */
  private readonly submitted: BrokerOrder[] = [];

  constructor(config: Partial<MockBrokerConfig> = {}) {
    this.config = { ...DEFAULT_MOCK_BROKER_CONFIG, ...config };
  }

  configure(config: Partial<MockBrokerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  async connect(): Promise<void> {
    this.setHealth({
      state: ConnectionState.CONNECTED,
      connectedAt: '1970-01-01T00:00:00.000Z',
      reconnectAttempts: 0,
      lastError: null,
    });
  }

  async disconnect(): Promise<void> {
    this.setHealth({ ...this.health, state: ConnectionState.DISCONNECTED, connectedAt: null });
  }

  isConnected(): boolean {
    return this.health.state === ConnectionState.CONNECTED;
  }

  connectionHealth(): ConnectionHealth {
    return { ...this.health };
  }

  /**
   * Simulates an unexpected socket drop — the fault the engine must survive
   * without liquidating anything.
   */
  simulateDisconnect(reason = 'simulated socket drop'): void {
    this.setHealth({
      state: ConnectionState.DISCONNECTED,
      connectedAt: null,
      reconnectAttempts: 0,
      lastError: reason,
    });
    this.logger.warn(`connection lost: ${reason}`);
  }

  /**
   * Bounded reconnect with exponential backoff (`PRD.md:312`).
   *
   * `attemptSucceedsOn` makes the outcome deterministic: the attempt at that
   * number succeeds, and a value above `maxReconnectAttempts` exhausts the
   * retries and lands in `FAILED` — the state that halts new entries while
   * leaving positions untouched.
   *
   * Returns the backoff delays actually waited, so a test can assert the
   * doubling rather than infer it from timing.
   */
  async reconnect(attemptSucceedsOn = 1): Promise<number[]> {
    const delays: number[] = [];
    this.setHealth({ ...this.health, state: ConnectionState.CONNECTING });

    for (let attempt = 1; attempt <= this.config.maxReconnectAttempts; attempt += 1) {
      const delay = this.config.baseBackoffMs * Math.pow(2, attempt - 1);
      delays.push(delay);
      await sleep(delay);

      if (attempt >= attemptSucceedsOn) {
        this.setHealth({
          state: ConnectionState.CONNECTED,
          connectedAt: '1970-01-01T00:00:00.000Z',
          reconnectAttempts: attempt,
          lastError: null,
        });
        this.logger.log(`reconnected after ${attempt} attempt(s)`);
        return delays;
      }

      this.setHealth({ ...this.health, reconnectAttempts: attempt });
    }

    // Retries exhausted. Positions are deliberately left exactly as they were.
    this.setHealth({
      state: ConnectionState.FAILED,
      connectedAt: null,
      reconnectAttempts: this.config.maxReconnectAttempts,
      lastError: 'reconnect attempts exhausted',
    });
    this.logger.error('reconnect attempts exhausted — halting new entries');

    return delays;
  }

  /**
   * Submits an order.
   *
   * Throws when disconnected. That is the correct signal: an unreachable broker
   * is a technical fault, categorically different from a rejection, and the
   * engine handles the two differently.
   */
  async submit(order: BrokerOrder): Promise<OrderAck> {
    if (!this.isConnected()) {
      throw new Error(
        `broker not connected (${this.health.state}) — cannot submit ${order.clientOrderId}`,
      );
    }

    this.validate(order);

    this.orderSequence += 1;
    const brokerOrderId = `mock-order-${this.orderSequence}`;
    this.submitted.push({ ...order });

    if (this.config.fillMode === FillMode.REJECT) {
      const ack: OrderAck = {
        clientOrderId: order.clientOrderId,
        brokerOrderId,
        status: OrderStatus.REJECTED,
        rejectReason: this.config.rejectReason,
      };
      this.recordCompletion(
        order.clientOrderId,
        brokerOrderId,
        order.contract.symbol,
        order.side,
        order.quantity,
        0,
        OrderStatus.REJECTED,
        this.config.rejectReason ?? null,
      );
      this.emitStatus(ack);
      return ack;
    }

    this.resting.set(order.clientOrderId, { order, brokerOrderId, filledQuantity: 0 });

    const ack: OrderAck = {
      clientOrderId: order.clientOrderId,
      brokerOrderId,
      status: OrderStatus.SUBMITTED,
    };
    this.emitStatus(ack);

    if (this.config.fillMode === FillMode.IMMEDIATE) {
      this.fillResting(order.clientOrderId, order.quantity);
    } else if (this.config.fillMode === FillMode.MARKET_AWARE) {
      // A marketable order fills on arrival, exactly as an exchange would take
      // it. Anything else waits for `advanceMarket` to bring price to it.
      if (this.lastPrice !== null && this.isMarketable(order, this.lastPrice)) {
        // The order's own timestamp is correct here: it filled on arrival, on
        // the bar that placed it.
        this.fillResting(order.clientOrderId, order.quantity, this.lastPrice, order.timestamp);
      }
    } else if (this.config.fillMode === FillMode.PARTIAL) {
      const quantity = Math.max(1, Math.floor(order.quantity * this.config.partialFillRatio));
      this.fillResting(order.clientOrderId, Math.min(quantity, order.quantity));
    }

    return ack;
  }

  /**
   * Fills a resting order, wholly or partially.
   *
   * The seam a test uses to drive delayed and partial fills explicitly, and
   * what the engine calls to settle a `RESTING` order on a later bar.
   */
  fillResting(
    clientOrderId: string,
    quantity?: number,
    atPrice?: number,
    atTime?: string,
  ): Fill | null {
    const resting = this.resting.get(clientOrderId);

    if (!resting) {
      return null;
    }

    const outstanding = resting.order.quantity - resting.filledQuantity;
    const fillQuantity = Math.min(quantity ?? outstanding, outstanding);

    if (fillQuantity <= 0) {
      return null;
    }

    const price = atPrice ?? this.fillPrice(resting.order);
    this.fillSequence += 1;

    const fill: Fill = {
      clientOrderId,
      brokerOrderId: resting.brokerOrderId,
      fillId: `mock-fill-${this.fillSequence}`,
      symbol: resting.order.contract.symbol,
      side: resting.order.side,
      quantity: fillQuantity,
      price,
      commission: this.config.commissionPerOrder,
      // **When it filled, not when it was placed.** A resting order can wait
      // bars or sessions for price to reach it, and stamping the fill with the
      // order's own timestamp would backdate every lot's open and close to the
      // moment the order was submitted. The daily report walks a session's lots
      // in timestamp order to reconstruct which rungs were free when, so a
      // backdated close is reported as a rung the ladder could not have used.
      timestamp: atTime ?? resting.order.timestamp,
    };

    resting.filledQuantity += fillQuantity;
    this.applyToPosition(fill);

    const complete = resting.filledQuantity >= resting.order.quantity;

    if (complete) {
      this.resting.delete(clientOrderId);
      this.recordCompletion(
        clientOrderId,
        resting.brokerOrderId,
        resting.order.contract.symbol,
        resting.order.side,
        resting.order.quantity,
        resting.filledQuantity,
        OrderStatus.FILLED,
        null,
      );
    }

    this.emitted.push({ ...fill });
    this.fillHandlers.forEach((handler) => handler(fill));
    this.emitStatus({
      clientOrderId,
      brokerOrderId: resting.brokerOrderId,
      status: complete ? OrderStatus.FILLED : OrderStatus.PARTIALLY_FILLED,
    });

    return fill;
  }

  /**
   * Delivers an arbitrary execution to current subscribers.
   *
   * IB reports executions for orders this process never placed — a manual
   * trade in TWS, or an order that outlived the strategy that created it — and
   * `fillResting` cannot express those, because it requires an order the mock
   * itself is holding. The engine must decline them rather than attribute them
   * to a rung, and only a seam that bypasses the resting book can prove it
   * does.
   */
  deliverFill(fill: Fill): void {
    this.emitted.push({ ...fill });
    this.fillHandlers.forEach((handler) => handler({ ...fill }));
  }

  /**
   * Drops every fill and status subscriber, modelling a daemon that is no
   * longer running.
   *
   * A test seam, and the only way to express "the process was down when this
   * filled" against an in-process broker: `disconnect()` will not do, because
   * it models a broker that went away while the engine kept running, which is
   * the opposite arrangement. Fills emitted after this are still recorded in
   * `emitted`, so `replayFill` can deliver them to whatever subscribes next —
   * exactly as IB replays a session's executions to a reconnecting client.
   */
  detachHandlers(): void {
    this.fillHandlers.clear();
    this.statusHandlers.clear();
  }

  /**
   * Re-delivers fills already emitted for an order, as IB does on reconnect.
   *
   * IB pushes executions only to a client that has subscribed, and replays the
   * session's executions each time one does — so every reconnect re-delivers
   * fills the engine has already turned into lots. The seam exists because
   * nothing else offline can produce a duplicate fill, and a consumer that
   * opens a second lot for one execution would otherwise look correct.
   */
  replayFill(clientOrderId: string): void {
    this.emitted
      .filter((fill) => fill.clientOrderId === clientOrderId)
      .forEach((fill) => this.fillHandlers.forEach((handler) => handler({ ...fill })));
  }

  async cancel(clientOrderId: string): Promise<OrderAck> {
    const resting = this.resting.get(clientOrderId);

    if (!resting) {
      throw new Error(`no resting order ${clientOrderId} to cancel`);
    }

    this.resting.delete(clientOrderId);
    this.recordCompletion(
      clientOrderId,
      resting.brokerOrderId,
      resting.order.contract.symbol,
      resting.order.side,
      resting.order.quantity,
      resting.filledQuantity,
      OrderStatus.CANCELLED,
      null,
    );

    const ack: OrderAck = {
      clientOrderId,
      brokerOrderId: resting.brokerOrderId,
      status: OrderStatus.CANCELLED,
    };
    this.emitStatus(ack);

    return ack;
  }

  /**
   * Ends a resting order **without telling the engine** — the way IB expiring a
   * DAY order overnight, or an operator cancelling in TWS, actually behaves
   * from this process's point of view.
   *
   * Deliberately silent: no `emitStatus`. A status the engine receives is the
   * easy case it already handles. The case worth testing is the one where the
   * order is gone at the broker and the engine still believes it is working,
   * which is only reachable if nothing is emitted here.
   */
  expireOrder(clientOrderId: string, reason = 'expired at the close'): void {
    const resting = this.resting.get(clientOrderId);

    if (!resting) {
      throw new Error(`no resting order ${clientOrderId} to expire`);
    }

    this.resting.delete(clientOrderId);
    this.recordCompletion(
      clientOrderId,
      resting.brokerOrderId,
      resting.order.contract.symbol,
      resting.order.side,
      resting.order.quantity,
      resting.filledQuantity,
      OrderStatus.CANCELLED,
      reason,
    );
  }

  private recordCompletion(
    clientOrderId: string,
    brokerOrderId: string,
    symbol: string,
    side: OrderSide,
    quantity: number,
    filledQuantity: number,
    status: OrderStatus.FILLED | OrderStatus.CANCELLED | OrderStatus.REJECTED,
    reason: string | null,
  ): void {
    this.completed.push({
      clientOrderId,
      brokerOrderId,
      symbol,
      side,
      quantity,
      filledQuantity,
      status,
      reason,
    });
  }

  async getOpenOrders(): Promise<OpenOrder[]> {
    if (!this.isConnected()) {
      // Matches the IB adapter: an unreachable broker must throw, because
      // "no open orders" and "cannot tell" lead to opposite decisions on boot.
      throw new Error(`broker not connected (${this.health.state}) — cannot list open orders`);
    }

    return [...this.resting.entries()].map(([clientOrderId, resting]) => ({
      clientOrderId,
      brokerOrderId: resting.brokerOrderId,
      symbol: resting.order.contract.symbol,
      side: resting.order.side,
      quantity: resting.order.quantity,
      filledQuantity: resting.filledQuantity,
      limitPrice: resting.order.limitPrice,
    }));
  }

  /**
   * Terminal-state orders this broker has seen.
   *
   * Recorded as they complete rather than derived from `orders`, so a test can
   * assert the history the engine reads back is the history the broker
   * actually produced.
   */
  async getCompletedOrders(): Promise<CompletedOrder[]> {
    if (!this.isConnected()) {
      throw new Error(`broker not connected (${this.health.state}) — cannot list completed orders`);
    }

    return this.completed.map((order) => ({ ...order }));
  }

  async getPositions(): Promise<BrokerPosition[]> {
    return [...this.positions.values()].map((position) => ({ ...position }));
  }

  async getAccountSummary(): Promise<AccountSummary> {
    return { equity: this.config.equity, availableFunds: this.config.equity, currency: 'USD' };
  }

  onFill(handler: (fill: Fill) => void): () => void {
    this.fillHandlers.add(handler);
    return () => this.fillHandlers.delete(handler);
  }

  onOrderStatus(handler: (ack: OrderAck) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  onConnectionChange(handler: (health: ConnectionHealth) => void): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  /** Every order accepted, in submission order — for payload assertions. */
  submittedOrders(): BrokerOrder[] {
    return this.submitted.map((order) => ({ ...order }));
  }

  restingOrders(): BrokerOrder[] {
    return [...this.resting.values()].map((entry) => ({ ...entry.order }));
  }

  /**
   * Seeds a position without a fill — used by Story 9 to inject the
   * broker/database mismatch that must halt a symbol.
   */
  seedPosition(position: BrokerPosition): void {
    this.positions.set(position.symbol, { ...position });
  }

  reset(): void {
    this.positions.clear();
    this.resting.clear();
    this.submitted.length = 0;
    this.orderSequence = 0;
    this.fillSequence = 0;
    this.lastPrice = null;
    this.lastTime = null;
  }

  /**
   * Rejects malformed orders the way a real broker would, rather than
   * accepting them and producing a nonsense fill. A zero-quantity or
   * zero-price order reaching this point is an engine bug, and it should
   * surface here rather than in a position report.
   */
  private validate(order: BrokerOrder): void {
    if (!Number.isFinite(order.quantity) || order.quantity <= 0) {
      throw new Error(`invalid order quantity ${order.quantity} for ${order.clientOrderId}`);
    }

    if (
      order.orderType === 'LMT' &&
      (!Number.isFinite(order.limitPrice) || order.limitPrice <= 0)
    ) {
      throw new Error(`invalid limit price ${order.limitPrice} for ${order.clientOrderId}`);
    }
  }

  /** Slippage works against the order, which is the only honest direction. */
  /**
   * True when `price` has reached this order's limit.
   *
   * A BUY limit is executable at or below its limit, a SELL at or above — the
   * inclusive comparison matching an exchange taking an order the moment price
   * touches the level, which is the intra-bar fill a resting order exists to
   * capture.
   */
  private isMarketable(order: BrokerOrder, price: number): boolean {
    return order.side === 'BUY' ? price <= order.limitPrice : price >= order.limitPrice;
  }

  /**
   * Moves the simulated market, filling every resting order price has reached.
   *
   * The seam that makes `MARKET_AWARE` usable: the mock has no clock and no feed
   * of its own, so the caller — the engine's replay loop, or a test — supplies
   * the price per bar and the mock settles whatever that price crossed.
   *
   * **Fills at the limit price, not at `price`.** A resting order is filled by
   * the exchange *at its limit* when the market reaches it; filling at the bar's
   * close would hand a lot a basis better or worse than the level it was placed
   * at, and every downstream target is derived from that basis.
   *
   * Iterates a snapshot because `fillResting` mutates the resting map.
   */
  advanceMarket(price: number, at?: string): Fill[] {
    this.lastPrice = price;
    this.lastTime = at ?? this.lastTime;

    const fills: Fill[] = [];

    for (const [clientOrderId, resting] of [...this.resting]) {
      if (!this.isMarketable(resting.order, price)) {
        continue;
      }

      const fill = this.fillResting(
        clientOrderId,
        undefined,
        undefined,
        this.lastTime ?? undefined,
      );

      if (fill) {
        fills.push(fill);
      }
    }

    return fills;
  }

  private fillPrice(order: BrokerOrder): number {
    const slip = this.config.slippagePerShare;
    const price = order.side === 'BUY' ? order.limitPrice + slip : order.limitPrice - slip;

    return Math.round(price * 100) / 100;
  }

  /**
   * Maintains net position and average cost — the only two things a broker
   * reports. A SELL reduces quantity and **leaves average cost unchanged**,
   * matching how IB reports a partial disposal.
   */
  private applyToPosition(fill: Fill): void {
    const existing = this.positions.get(fill.symbol) ?? {
      symbol: fill.symbol,
      quantity: 0,
      averageCost: 0,
    };

    if (fill.side === 'BUY') {
      const totalCost = existing.quantity * existing.averageCost + fill.quantity * fill.price;
      const quantity = existing.quantity + fill.quantity;

      this.positions.set(fill.symbol, {
        symbol: fill.symbol,
        quantity,
        averageCost: quantity === 0 ? 0 : Math.round((totalCost / quantity) * 100) / 100,
      });
      return;
    }

    const quantity = existing.quantity - fill.quantity;

    if (quantity <= 0) {
      this.positions.delete(fill.symbol);
      return;
    }

    this.positions.set(fill.symbol, { ...existing, quantity });
  }

  private setHealth(health: ConnectionHealth): void {
    this.health = health;
    this.connectionHandlers.forEach((handler) => handler({ ...health }));
  }

  private emitStatus(ack: OrderAck): void {
    this.statusHandlers.forEach((handler) => handler({ ...ack }));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
