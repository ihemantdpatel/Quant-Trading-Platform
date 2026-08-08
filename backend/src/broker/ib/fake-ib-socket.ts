/**
 * `FakeIbSocket` — a deterministic `IbSocket` for tests.
 *
 * The same reasoning as `MockBrokerAdapter` one layer down (`stories.md:385`):
 * the awkward paths are the ones that matter, and they are the ones a live
 * Gateway will not perform on request. You cannot ask IB to drop a socket at a
 * chosen moment, to force a re-auth mid-backfill, or to stop delivering bars so
 * staleness can be observed — but every one of those is a path that must work
 * correctly the first time it happens with real money behind it.
 *
 * So this fake exposes each of them as an explicit method, and records what was
 * requested so a test can assert **zero IB calls** for a fully-cached range —
 * the cache-first requirement at `PRD.md:293`, which is only meaningful if
 * something counts.
 *
 * Determinism is absolute: no clock, no randomness, no timers. Bars come from
 * what a test seeds, ids from monotonic counters.
 */

import { Contract } from '../../domain/contract';
import { Bar, BarSize } from '../../market-data/types';
import {
  AccountSummary,
  BrokerOrder,
  BrokerPosition,
  Fill,
  OrderAck,
  OrderStatus,
} from '../broker-adapter.interface';
import {
  CommissionCorrection,
  DisconnectEvent,
  DisconnectReason,
  HistoricalRequest,
  IbSocket,
} from './ib-socket';

/** A historical request as it was received, for assertions. */
export interface RecordedRequest {
  symbol: string;
  barSize: BarSize;
  from: string;
  to: string;
  regularHoursOnly: boolean;
}

export class FakeIbSocket implements IbSocket {
  /** Every historical request, in order. The cache-first assertion reads this. */
  readonly historicalRequests: RecordedRequest[] = [];
  readonly placedOrders: BrokerOrder[] = [];

  private connected = false;
  private connectAttempts = 0;

  /**
   * Attempt number on which `connect()` starts succeeding.
   *
   * Drives the backoff tests: a value above the policy's `maxAttempts`
   * exhausts retries and lands in the fail-safe state.
   */
  private succeedConnectOn = 1;
  private connectError = 'connection refused';

  /** Seeded bars, keyed by `symbol|barSize`. */
  private readonly bars = new Map<string, Bar[]>();
  private positions: BrokerPosition[] = [];
  private summary: AccountSummary = { equity: 100_000, availableFunds: 100_000, currency: 'USD' };

  /** Set to make the next historical request reject. */
  private historicalError: string | null = null;

  private readonly barHandlers = new Map<string, Set<(bar: Bar) => void>>();
  private readonly fillHandlers = new Set<(fill: Fill) => void>();
  private readonly statusHandlers = new Set<(ack: OrderAck) => void>();
  private readonly commissionHandlers = new Set<(report: CommissionCorrection) => void>();
  private readonly disconnectHandlers = new Set<(event: DisconnectEvent) => void>();

  private orderSequence = 0;

  async connect(): Promise<void> {
    this.connectAttempts += 1;

    if (this.connectAttempts < this.succeedConnectOn) {
      throw new Error(this.connectError);
    }

    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.emitDisconnect({
      reason: DisconnectReason.REQUESTED,
      code: null,
      message: 'local disconnect',
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  async reqHistoricalData(request: HistoricalRequest): Promise<Bar[]> {
    this.historicalRequests.push({
      symbol: request.contract.symbol,
      barSize: request.barSize,
      from: request.from,
      to: request.to,
      regularHoursOnly: request.regularHoursOnly,
    });

    if (this.historicalError) {
      const message = this.historicalError;
      this.historicalError = null;
      throw new Error(message);
    }

    if (!this.connected) {
      throw new Error('not connected');
    }

    const seeded = this.bars.get(key(request.contract.symbol, request.barSize)) ?? [];

    // Inclusive on both ends, matching `HistoricalRequest`'s contract. IB
    // itself is end-inclusive, and an off-by-one here would leave a
    // single-bar gap that the cache would then request forever.
    return seeded.filter((bar) => bar.timestamp >= request.from && bar.timestamp <= request.to);
  }

  subscribeBars(contract: Contract, barSize: BarSize, handler: (bar: Bar) => void): () => void {
    const id = key(contract.symbol, barSize);
    const handlers = this.barHandlers.get(id) ?? new Set();

    handlers.add(handler);
    this.barHandlers.set(id, handlers);

    return () => {
      handlers.delete(handler);
    };
  }

  async placeOrder(order: BrokerOrder): Promise<OrderAck> {
    if (!this.connected) {
      throw new Error(`not connected — cannot place ${order.clientOrderId}`);
    }

    this.orderSequence += 1;
    this.placedOrders.push({ ...order });

    const ack: OrderAck = {
      clientOrderId: order.clientOrderId,
      brokerOrderId: `ib-${this.orderSequence}`,
      status: OrderStatus.SUBMITTED,
    };

    this.statusHandlers.forEach((h) => h({ ...ack }));

    return ack;
  }

  async cancelOrder(clientOrderId: string): Promise<OrderAck> {
    const ack: OrderAck = {
      clientOrderId,
      brokerOrderId: `ib-cancel-${clientOrderId}`,
      status: OrderStatus.CANCELLED,
    };

    this.statusHandlers.forEach((h) => h({ ...ack }));

    return ack;
  }

  async getPositions(): Promise<BrokerPosition[]> {
    if (!this.connected) {
      throw new Error('not connected');
    }

    return this.positions.map((position) => ({ ...position }));
  }

  async getAccountSummary(): Promise<AccountSummary> {
    return { ...this.summary };
  }

  onFill(handler: (fill: Fill) => void): () => void {
    this.fillHandlers.add(handler);
    return () => this.fillHandlers.delete(handler);
  }

  onOrderStatus(handler: (ack: OrderAck) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  onCommission(handler: (report: CommissionCorrection) => void): () => void {
    this.commissionHandlers.add(handler);
    return () => this.commissionHandlers.delete(handler);
  }

  onDisconnect(handler: (event: DisconnectEvent) => void): () => void {
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
  }

  // ---- Test seams ----------------------------------------------------------

  /** Seeds the bars a historical request will serve from. */
  seedBars(symbol: string, barSize: BarSize, bars: Bar[]): void {
    this.bars.set(
      key(symbol, barSize),
      [...bars].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    );
  }

  seedPositions(positions: BrokerPosition[]): void {
    this.positions = positions.map((position) => ({ ...position }));
  }

  seedAccountSummary(summary: AccountSummary): void {
    this.summary = { ...summary };
  }

  /** Makes `connect()` fail until the given attempt. Drives the backoff tests. */
  failConnectUntil(attempt: number, error = 'connection refused'): void {
    this.succeedConnectOn = attempt;
    this.connectError = error;
  }

  /** Makes the next historical request reject once. */
  failNextHistorical(message = 'pacing violation'): void {
    this.historicalError = message;
  }

  /**
   * IB Gateway's scheduled logout — the routine daily event, not a fault.
   * Emitted with a re-auth code so the adapter can route it correctly.
   */
  simulateScheduledReauth(): void {
    this.connected = false;
    this.emitDisconnect({
      reason: DisconnectReason.SCHEDULED_REAUTH,
      code: 1100,
      message: 'connectivity between IB and TWS has been lost',
    });
  }

  /** An unexpected socket drop — a fault. */
  simulateSocketDrop(message = 'socket closed'): void {
    this.connected = false;
    this.emitDisconnect({ reason: DisconnectReason.SOCKET_DROP, code: 504, message });
  }

  /**
   * The connection goes away and IB says **nothing**.
   *
   * Observed against a live Gateway: the socket disappeared, no error code was
   * raised on either channel, and so no disconnect event existed to route.
   * `this.connected` went false while the adapter's health still read
   * `CONNECTED`, every API call timed out, and `ReconnectPolicy` never engaged
   * because nothing told it to.
   *
   * Deliberately does **not** call `emitDisconnect` — an event here would test
   * the path that already works and would hide the gap this reproduces.
   */
  simulateSilentDrop(): void {
    this.connected = false;
  }

  /** Pushes a live bar to subscribers. */
  emitBar(bar: Bar): void {
    this.barHandlers.get(key(bar.symbol, bar.barSize))?.forEach((handler) => handler(bar));
  }

  emitFill(fill: Fill): void {
    this.fillHandlers.forEach((handler) => handler({ ...fill }));
  }

  /** A late commission report, as IB delivers it after the execution. */
  emitCommission(report: CommissionCorrection): void {
    this.commissionHandlers.forEach((handler) => handler({ ...report }));
  }

  /** How many times `connect()` has been called, including failures. */
  connectCallCount(): number {
    return this.connectAttempts;
  }

  private emitDisconnect(event: DisconnectEvent): void {
    this.disconnectHandlers.forEach((handler) => handler({ ...event }));
  }
}

function key(symbol: string, barSize: BarSize): string {
  return `${symbol}|${barSize}`;
}
