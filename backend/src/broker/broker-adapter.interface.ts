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
 * An order working at the broker, unfilled.
 *
 * Carries `clientOrderId` because that is the only field the engine can match
 * against its own records — IB's `brokerOrderId` is assigned by IB and is not
 * what the rung ledger stores. `filledQuantity` distinguishes a partially
 * filled resting order from an untouched one, which reconciliation must treat
 * differently: the former already has shares the ladder may not know about.
 */
export interface OpenOrder {
  clientOrderId: string;
  brokerOrderId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  /** Shares already filled on this order. 0 for an untouched resting order. */
  filledQuantity: number;
  limitPrice: number;
}

/**
 * An order that has reached a **terminal state** at the broker — filled,
 * cancelled, or expired.
 *
 * The complement to `OpenOrder`, and the distinction is the whole point.
 * `getOpenOrders` answers "what is still working", so an order that went away
 * is simply *absent* from it. Absence is enough to release a rung — the ladder
 * only needs to know the level is free — but it cannot say whether the order
 * expired at the close, was cancelled by hand in TWS, or was rejected, and it
 * carries no time. So the `Order` row stayed `SUBMITTED` forever while the rung
 * moved on, and the dashboard kept showing a live-looking order that no longer
 * existed anywhere.
 *
 * `status` is deliberately narrowed to the terminal set rather than reusing the
 * full `OrderStatus`: a completed order is by definition not `SUBMITTED`, and
 * allowing that value would let a caller write a non-terminal status from a
 * source that cannot produce one.
 */
export interface CompletedOrder {
  clientOrderId: string;
  brokerOrderId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  filledQuantity: number;
  status: OrderStatus.FILLED | OrderStatus.CANCELLED | OrderStatus.REJECTED;
  /**
   * The broker's own explanation, when it gave one.
   *
   * Null rather than a manufactured string: "cancelled" with no reason is an
   * honest report, whereas inventing "cancelled by user" would assert a cause
   * nobody established.
   */
  reason: string | null;
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

  /**
   * Orders currently working at the broker, unfilled.
   *
   * **The restart-safety primitive for resting orders.** An order placed before
   * a restart is still live at the broker afterwards, and nothing in the
   * database can confirm it survived — only the broker knows. Without this the
   * engine would place a second order at the same rung on every boot, and the
   * duplicates would fill together.
   *
   * The same authority split as `getPositions`: the broker is authoritative on
   * *what exists*, the database on *what it means* (which rung placed it). An
   * unreachable broker must throw rather than return `[]` — "no open orders"
   * and "cannot tell" lead to opposite decisions, and only one of them is safe.
   */
  getOpenOrders(): Promise<OpenOrder[]>;

  /**
   * Orders that reached a terminal state at the broker, for the current day.
   *
   * **Why the engine cannot answer this from its own records.** A terminal
   * status arrives on `onOrderStatus`, which can only attribute it to an order
   * whose broker id this process holds in memory — and that map is populated by
   * `submit`. An order placed before a restart, then cancelled in TWS, produces
   * a status this process cannot attribute and silently drops. Only the broker
   * retains the outcome.
   *
   * Reporting only. Nothing here releases a rung or opens a lot: `getOpenOrders`
   * remains the authority on which levels are free, because a level is free when
   * no order is working at it — a fact that stands whether or not the history
   * query succeeds.
   *
   * Throws when the broker cannot answer, for the same reason as
   * `getOpenOrders`: an empty history and an unanswered query are different
   * facts and must not collapse into one.
   */
  getCompletedOrders(): Promise<CompletedOrder[]>;

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
