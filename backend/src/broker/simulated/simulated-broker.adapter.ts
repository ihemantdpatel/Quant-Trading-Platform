/**
 * `SimulatedBrokerAdapter` — **an implementation, not a parallel engine**
 * (`stories.md:636`).
 *
 * This is the whole architectural claim of Story 11: the backtester is a third
 * `BrokerAdapter` alongside the mock and IB, so the identical strategy and risk
 * code runs against it. There is no backtest-specific strategy, no backtest
 * branch inside `EngineService`, and nothing here that a strategy could detect.
 * `simulated-broker.adapter.spec.ts` asserts that directly by running the same
 * bars through both this and the mock and comparing the intents.
 *
 * ## How it differs from `MockBrokerAdapter`, and why both exist
 *
 * The mock is a *configurable test double*: it fills how a test tells it to,
 * because integration tests need to force a partial fill or a rejection on
 * demand. This one is a *market simulator*: it fills according to what the bar
 * actually did, because a backtest's job is to find out.
 *
 * Concretely, this adapter needs something the interface deliberately does not
 * carry — **the bar currently being evaluated**. `submit()` cannot decide
 * whether a limit order filled without knowing the bar's high and low, and
 * `BrokerAdapter` has no bar parameter because IB's socket has no such concept.
 * The harness resolves this by calling `setCurrentBar()` before each
 * `processBar`, which is a property of the *driver*, not of the interface. A
 * strategy still cannot reach it: strategies receive a `StrategyContext` and
 * hold no broker reference at all (`architecture.spec.ts`).
 *
 * ## Resting orders across bars
 *
 * An order that does not trade through on its own bar **rests** and is retried
 * against each subsequent bar until it fills or the run ends. This matters more
 * than it looks: the ladder fires a rung when a bar *closes* at or below the
 * rung price, so on a gap-down the close is often well below the limit and the
 * order fills immediately — but on a slow drift the bar that triggers the
 * decision may not be the bar that trades through it. Cancelling unfilled
 * orders at the bar boundary would silently discard those fires and understate
 * ladder extension in exactly the sustained declines this strategy targets.
 *
 * Determinism is absolute: no clock, no randomness. Every id is a monotonic
 * counter and every timestamp comes from a bar, so a run is byte-identical
 * across executions — which is what makes a parameter sweep's comparisons mean
 * anything.
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
  OrderAck,
  OrderStatus,
} from '../broker-adapter.interface';
import {
  DEFAULT_FILL_MODEL_CONFIG,
  evaluateFill,
  FillModelConfig,
} from '../../backtest/fill-model';
import { Bar } from '../../market-data/types';

export interface SimulatedBrokerConfig {
  /** Starting account equity — what the global 60% capital cap measures against. */
  equity: number;
  /**
   * Fill assumptions. Partial: the constructor merges over
   * `DEFAULT_FILL_MODEL_CONFIG`, so overriding slippage alone does not silently
   * drop `requireTouch` and turn every limit order into a guaranteed fill.
   */
  fillModel: Partial<FillModelConfig>;
}

export const DEFAULT_SIMULATED_BROKER_CONFIG: SimulatedBrokerConfig = {
  equity: 100_000,
  fillModel: DEFAULT_FILL_MODEL_CONFIG,
};

/** An order the simulator still holds, waiting for a bar to trade through it. */
interface RestingOrder {
  order: BrokerOrder;
  brokerOrderId: string;
}

@Injectable()
export class SimulatedBrokerAdapter implements BrokerAdapter {
  readonly name = 'simulated';

  private readonly logger = new Logger(SimulatedBrokerAdapter.name);
  /** Resolved, not partial: every fill assumption has a value by here. */
  private readonly config: { equity: number; fillModel: FillModelConfig };

  private health: ConnectionHealth = {
    state: ConnectionState.DISCONNECTED,
    connectedAt: null,
    reconnectAttempts: 0,
    lastError: null,
  };

  /**
   * The bar orders are currently evaluated against.
   *
   * Null before the first bar. An order submitted with no bar set cannot be
   * priced, and is rejected rather than filled at a guess — a silent fill there
   * would be the backtest inventing a trade.
   */
  private currentBar: Bar | null = null;

  private readonly positions = new Map<string, BrokerPosition>();
  private readonly resting = new Map<string, RestingOrder>();
  private readonly fillHandlers = new Set<(fill: Fill) => void>();
  private readonly statusHandlers = new Set<(ack: OrderAck) => void>();
  private readonly connectionHandlers = new Set<(health: ConnectionHealth) => void>();

  private orderSequence = 0;
  private fillSequence = 0;

  /** Every fill produced, in order — the raw material for the statistics. */
  private readonly fills: Fill[] = [];
  /** Cumulative realized cash flow and commission, for equity-curve reporting. */
  private realizedProceeds = 0;
  private totalCommission = 0;

  constructor(config: Partial<SimulatedBrokerConfig> = {}) {
    this.config = {
      ...DEFAULT_SIMULATED_BROKER_CONFIG,
      ...config,
      fillModel: { ...DEFAULT_FILL_MODEL_CONFIG, ...(config.fillModel ?? {}) },
    };
  }

  async connect(): Promise<void> {
    this.setHealth({
      state: ConnectionState.CONNECTED,
      // A fixed epoch rather than `new Date()` — a backtest must not vary with
      // when it was run.
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
   * Advances the simulated market to a bar.
   *
   * Called by the replay harness **before** the bar reaches the strategy, so an
   * order submitted on this bar is evaluated against this bar's range. Resting
   * orders from earlier bars are retried here, before the strategy runs, which
   * matches reality: a resting order fills the moment the market reaches it,
   * not after the next decision is made.
   */
  setCurrentBar(bar: Bar): void {
    this.currentBar = bar;
    this.fillResting(bar);
  }

  /**
   * Submits an order against the current bar.
   *
   * Throws when disconnected — a technical fault, categorically different from
   * a rejection, exactly as with every other adapter. The engine's fault
   * handling is therefore exercised by the backtest too rather than being
   * mock-only.
   */
  async submit(order: BrokerOrder): Promise<OrderAck> {
    if (!this.isConnected()) {
      throw new Error(
        `simulated broker not connected (${this.health.state}) — cannot submit ${order.clientOrderId}`,
      );
    }

    this.orderSequence += 1;
    const brokerOrderId = `sim-order-${this.orderSequence}`;

    if (!this.currentBar) {
      const ack: OrderAck = {
        clientOrderId: order.clientOrderId,
        brokerOrderId,
        status: OrderStatus.REJECTED,
        rejectReason: 'no bar to price against',
      };
      this.emitStatus(ack);
      return ack;
    }

    const ack: OrderAck = {
      clientOrderId: order.clientOrderId,
      brokerOrderId,
      status: OrderStatus.SUBMITTED,
    };
    this.emitStatus(ack);

    const decision = evaluateFill(order, this.currentBar, this.config.fillModel);

    if (decision.filled && decision.price !== null) {
      this.emitFill(order, brokerOrderId, decision.price, decision.commission);
      return ack;
    }

    // Did not trade through. Rests and is retried on subsequent bars.
    this.resting.set(order.clientOrderId, { order, brokerOrderId });

    return ack;
  }

  /**
   * Retries every resting order against a new bar.
   *
   * Iterates a snapshot of the entries because a fill mutates the map.
   */
  private fillResting(bar: Bar): void {
    for (const [clientOrderId, entry] of [...this.resting.entries()]) {
      const decision = evaluateFill(entry.order, bar, this.config.fillModel);

      if (!decision.filled || decision.price === null) {
        continue;
      }

      this.resting.delete(clientOrderId);
      // Stamped with the bar that actually filled it, not the bar that
      // submitted it — holding period statistics depend on this being the
      // execution time rather than the decision time.
      this.emitFill(entry.order, entry.brokerOrderId, decision.price, decision.commission, bar);
    }
  }

  private emitFill(
    order: BrokerOrder,
    brokerOrderId: string,
    price: number,
    commission: number,
    bar?: Bar,
  ): void {
    this.fillSequence += 1;

    const fill: Fill = {
      clientOrderId: order.clientOrderId,
      brokerOrderId,
      fillId: `sim-fill-${this.fillSequence}`,
      symbol: order.contract.symbol,
      side: order.side,
      quantity: order.quantity,
      price,
      commission,
      timestamp: bar?.timestamp ?? order.timestamp,
    };

    this.fills.push(fill);
    this.totalCommission += commission;
    this.realizedProceeds +=
      (order.side === 'SELL' ? price * order.quantity : -price * order.quantity) - commission;

    this.applyToPosition(fill);
    this.fillHandlers.forEach((handler) => handler(fill));
    this.emitStatus({
      clientOrderId: order.clientOrderId,
      brokerOrderId,
      status: OrderStatus.FILLED,
    });
  }

  async cancel(clientOrderId: string): Promise<OrderAck> {
    const resting = this.resting.get(clientOrderId);

    if (!resting) {
      throw new Error(`no resting order ${clientOrderId} to cancel`);
    }

    this.resting.delete(clientOrderId);

    const ack: OrderAck = {
      clientOrderId,
      brokerOrderId: resting.brokerOrderId,
      status: OrderStatus.CANCELLED,
    };
    this.emitStatus(ack);

    return ack;
  }

  /**
   * Always empty: this adapter fills or rejects every order within `submit`,
   * so no order is ever left working.
   *
   * That is a property of the simulation rather than a stub — a backtest has no
   * restart to reconcile across, and modelling a resting queue here would
   * invent state the replay harness never observes.
   */
  async getOpenOrders(): Promise<OpenOrder[]> {
    return [];
  }

  /**
   * Always empty: the backtest broker fills or rejects within the call, so no
   * order ever reaches a terminal state the caller did not already observe as
   * the return value.
   */
  async getCompletedOrders(): Promise<CompletedOrder[]> {
    return [];
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

  /** Every fill produced, in execution order — input to the statistics. */
  executedFills(): Fill[] {
    return this.fills.map((fill) => ({ ...fill }));
  }

  /** Orders still waiting for the market to reach them. */
  restingOrders(): BrokerOrder[] {
    return [...this.resting.values()].map((entry) => ({ ...entry.order }));
  }

  /** Net realized cash flow, commissions already deducted. */
  realizedCash(): number {
    return roundToCents(this.realizedProceeds);
  }

  commissionPaid(): number {
    return roundToCents(this.totalCommission);
  }

  reset(): void {
    this.positions.clear();
    this.resting.clear();
    this.fills.length = 0;
    this.orderSequence = 0;
    this.fillSequence = 0;
    this.realizedProceeds = 0;
    this.totalCommission = 0;
    this.currentBar = null;
  }

  /**
   * Net position and average cost — the only two things a broker reports.
   *
   * A SELL reduces quantity and **leaves average cost unchanged**, matching how
   * IB reports a partial disposal. Story 9's reconciliation compares the lot sum
   * against this quantity, so it must behave identically to the other adapters
   * or a backtest would reconcile differently from live.
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
        averageCost: quantity === 0 ? 0 : roundToCents(totalCost / quantity),
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

function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}
