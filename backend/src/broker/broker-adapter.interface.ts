/**
 * The broker boundary (`PRD.md:276`).
 *
 * One interface, three implementations: `MockBrokerAdapter` (Story 6),
 * `IBBrokerAdapter` (Story 10), `SimulatedBrokerAdapter` (Story 11). **This is
 * what makes the backtester an implementation rather than a parallel
 * codebase** — the same strategy and risk code runs against all three because
 * none of them can tell which is present.
 *
 * Design rules this interface encodes:
 *
 * - **Nothing here is strategy-aware.** No `Lot`, no rung, no ladder. A broker
 *   reports a *net* position and knows nothing of lot composition; that
 *   asymmetry is the whole reason Story 9's reconciliation exists, and letting
 *   lot vocabulary leak in here would hide it. `architecture.spec.ts` asserts
 *   no broker module imports a strategy.
 * - **Order lifecycle is event-driven, not request/response.** IB reports fills
 *   asynchronously over a socket, sometimes long after acknowledgement and
 *   sometimes partially. An interface returning a fill from `submit()` would be
 *   a lie that only the mock could tell.
 * - **Connection health is observable** (`onConnectionChange`), because
 *   "existing positions are never auto-liquidated on a technical fault"
 *   (`PRD.md:316`) requires the engine to distinguish a broker fault from a
 *   strategy decision.
 */

// From `src/domain/`, not `src/strategies/` — a broker must never import a
// strategy (`architecture.spec.ts`), and `Contract` is shared domain
// vocabulary rather than strategy logic.
import { Contract } from '../domain/contract';

export type OrderSide = 'BUY' | 'SELL';

export interface BrokerOrder {
  /** Engine-assigned id, stable across a submission's whole lifecycle. */
  clientOrderId: string;
  contract: Contract;
  side: OrderSide;
  quantity: number;
  orderType: 'LMT' | 'MKT';
  limitPrice: number;
  timeInForce: 'DAY' | 'GTC';
  /** Bar timestamp that produced this order, ISO-8601 ET. */
  timestamp: string;
}

export enum OrderStatus {
  /** Accepted by the broker, resting. */
  SUBMITTED = 'SUBMITTED',
  PARTIALLY_FILLED = 'PARTIALLY_FILLED',
  FILLED = 'FILLED',
  CANCELLED = 'CANCELLED',
  /** Refused by the broker — a rejection is not a fault, it is an answer. */
  REJECTED = 'REJECTED',
}

export interface OrderAck {
  clientOrderId: string;
  /** The broker's own id. Distinct from `clientOrderId` — IB assigns its own. */
  brokerOrderId: string;
  status: OrderStatus;
  /** Populated when the broker refused the order. */
  rejectReason?: string;
}

export interface Fill {
  clientOrderId: string;
  brokerOrderId: string;
  /** Unique per fill. One order can produce several. */
  fillId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  /** What it actually traded at — not necessarily the limit price. */
  price: number;
  /** Commission, always a positive cost. */
  commission: number;
  timestamp: string;
}

/**
 * A broker position: **net quantity and average cost, nothing more.**
 *
 * Deliberately impoverished, because this is genuinely all IB reports. Three
 * lots of 100 shares and one block of 300 are indistinguishable here
 * (`stories.md:564`), which is exactly why the database is authoritative on lot
 * composition and the broker is authoritative on the total.
 */
export interface BrokerPosition {
  symbol: string;
  quantity: number;
  averageCost: number;
}

export interface AccountSummary {
  /** Total account value — what the global 60% capital cap is measured against. */
  equity: number;
  availableFunds: number;
  currency: string;
}

export enum ConnectionState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  /** Retries exhausted — the fail-safe state (`PRD.md:313`). */
  FAILED = 'FAILED',
}

export interface ConnectionHealth {
  state: ConnectionState;
  /** ISO-8601 of the last successful connection, or null. */
  connectedAt: string | null;
  /** Consecutive failed reconnect attempts. */
  reconnectAttempts: number;
  /** Why the connection was last lost. Null when healthy. */
  lastError: string | null;
}

export interface BrokerAdapter {
  readonly name: string;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  connectionHealth(): ConnectionHealth;

  /**
   * Submits an order and returns the broker's acknowledgement.
   *
   * Fills arrive separately through `onFill` — an ack is not a fill. Throws
   * when the broker is unreachable, which the engine treats as a technical
   * fault (halt new entries, never liquidate) rather than a rejection.
   */
  submit(order: BrokerOrder): Promise<OrderAck>;

  cancel(clientOrderId: string): Promise<OrderAck>;

  getPositions(): Promise<BrokerPosition[]>;
  getAccountSummary(): Promise<AccountSummary>;

  /** Subscribes to fills. Returns an unsubscribe function. */
  onFill(handler: (fill: Fill) => void): () => void;

  /** Subscribes to order status transitions. Returns an unsubscribe function. */
  onOrderStatus(handler: (ack: OrderAck) => void): () => void;

  /** Subscribes to connection health changes. Returns an unsubscribe function. */
  onConnectionChange(handler: (health: ConnectionHealth) => void): () => void;
}

/** DI token — the engine depends on the interface, never on an implementation. */
export const BROKER_ADAPTER = Symbol('BROKER_ADAPTER');
