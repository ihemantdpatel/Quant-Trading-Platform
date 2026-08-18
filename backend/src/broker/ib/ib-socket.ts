/**
 * `IbSocket` — the narrow port between this codebase and IB's API client.
 *
 * `@stoqey/ib` is a faithful port of IB's Java client, which means it inherits
 * IB's shape: request ids the caller allocates, results arriving as events or
 * Observables long after the call, and a `Contract` type that is not ours. That
 * shape is fine at the wire, and wrong everywhere else.
 *
 * So this interface exists to state **what the engine actually needs from a
 * broker socket**, in this codebase's own vocabulary, and nothing more:
 *
 * - Promises rather than Observables — every caller here awaits a complete
 *   result. Streaming is expressed as an explicit subscription with an
 *   unsubscribe, matching `BrokerAdapter.onFill`.
 * - Our `Bar`, our `Contract`, our ISO-8601-with-offset timestamps. IB's
 *   `yyyyMMdd HH:mm:ss` format is a wire detail and is converted at this
 *   boundary, not carried inward.
 * - No request ids. Correlating a response to its request is the adapter's
 *   problem, not its caller's.
 *
 * ## Why the indirection earns its keep
 *
 * **The whole Story 10 suite runs offline.** Pacing, cache-first reads,
 * gap-fill, backoff, forced re-auth, and the stale-data fail-safe are all
 * driven through `FakeIbSocket` with a virtual clock, so they are asserted
 * exactly rather than approximately — none of them would be reliably testable
 * against a live Gateway, because you cannot ask IB to drop a socket on cue.
 *
 * It also keeps the dependency swappable. If `@stoqey/ib` is abandoned, the
 * replacement implements this file and nothing above it changes.
 */

import { Contract } from '../../domain/contract';
import { Bar, BarSize } from '../../market-data/types';
import {
  BrokerOrder,
  BrokerPosition,
  CompletedOrder,
  OpenOrder,
  AccountSummary,
  Fill,
  OrderAck,
} from '../broker-adapter.interface';

/** A historical bar request, in this codebase's vocabulary. */
export interface HistoricalRequest {
  contract: Contract;
  barSize: BarSize;
  /** Inclusive start, ISO-8601 with ET offset. */
  from: string;
  /** Inclusive end, ISO-8601 with ET offset. */
  to: string;
  /**
   * Regular trading hours only.
   *
   * True for 5-minute bars: the ladder fires 09:45–16:00 ET and pre/post-market
   * prints are explicitly excluded from the strategy (`session-window.ts`), so
   * ingesting them would cache bars no rule may act on.
   */
  regularHoursOnly: boolean;
}

/**
 * Why a connection was lost.
 *
 * The discriminator behind `reconnect.ts`'s central distinction: IB Gateway's
 * scheduled logout is a routine daily event, and treating it as a fault would
 * raise a critical alert every day until an operator learns to ignore alerts.
 * Derived from IB's own error codes at the implementation, never guessed.
 */
export enum DisconnectReason {
  /** IB Gateway's scheduled re-authentication (codes 1100/1101/1102). */
  SCHEDULED_REAUTH = 'SCHEDULED_REAUTH',
  /** An unexpected socket drop. A fault. */
  SOCKET_DROP = 'SOCKET_DROP',
  /** A deliberate local `disconnect()`. Neither fault nor routine. */
  REQUESTED = 'REQUESTED',
}

export interface DisconnectEvent {
  reason: DisconnectReason;
  /** IB's numeric error code where one exists, for the log. */
  code: number | null;
  message: string;
}

/**
 * The socket surface the adapter depends on.
 *
 * Deliberately not `BrokerAdapter`: that interface is the engine's view of a
 * broker (health, alerts, lifecycle), while this is the transport beneath it.
 * Collapsing the two would leave nothing to fake in a test but the thing under
 * test.
 */
export interface IbSocket {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  /**
   * One historical request, already paced.
   *
   * **Callers must not invoke this directly** — `IBBrokerAdapter` routes every
   * call through `PacingQueue`, because an unpaced request is the failure that
   * reads as a bug in your own code for days (`PRD.md:289`).
   */
  reqHistoricalData(request: HistoricalRequest): Promise<Bar[]>;

  /**
   * Subscribes to live bars for a symbol. Returns an unsubscribe function.
   *
   * Bars arrive on close, which is the cadence the ladder evaluates on
   * (`stories.md:226`).
   */
  subscribeBars(contract: Contract, barSize: BarSize, handler: (bar: Bar) => void): () => void;

  placeOrder(order: BrokerOrder): Promise<OrderAck>;
  cancelOrder(clientOrderId: string): Promise<OrderAck>;

  /**
   * Orders working at IB, unfilled. Backed by `reqOpenOrders`.
   *
   * Bounded by a timeout like every other IB call — an unauthenticated Gateway
   * accepts the socket and then says nothing, so an unbounded wait here would
   * hang the boot path (`first-value.spec.ts`).
   */
  getOpenOrders(): Promise<OpenOrder[]>;

  /**
   * Orders that reached a terminal state today, from IB's own history.
   *
   * Event-based rather than promise-based: `reqCompletedOrders` streams
   * `completedOrder` events terminated by `completedOrdersEnd`, so the
   * implementation collects until the terminator and is bounded by a timeout
   * like every other IB call.
   */
  getCompletedOrders(): Promise<CompletedOrder[]>;

  getPositions(): Promise<BrokerPosition[]>;
  getAccountSummary(): Promise<AccountSummary>;

  onFill(handler: (fill: Fill) => void): () => void;
  onOrderStatus(handler: (ack: OrderAck) => void): () => void;

  /**
   * Commission for an already-reported fill.
   *
   * Separate from `onFill` because IB reports it separately and *later*: the
   * execution arrives first with no cost attached, and the commission report
   * follows keyed by `execId`. Folding it into `Fill` would mean either
   * delaying every fill until its cost arrived — losing the latency that makes
   * event-driven fills worth having — or reporting a commission of zero as if
   * it were final, which understates cost on every realized lot.
   */
  onCommission(handler: (report: CommissionCorrection) => void): () => void;

  onDisconnect(handler: (event: DisconnectEvent) => void): () => void;

  /**
   * A market-data subscription error, reported rather than only logged.
   *
   * IB rejects an unentitled or malformed data request on the subscription's
   * error channel and then simply delivers nothing. The socket stays connected
   * and every field on `GET /status` keeps reading healthy, so the failure that
   * matters most to an operator — no bars are arriving — was visible only as a
   * single `warn` line in the container log.
   *
   * Optional so existing fakes and any future socket need not implement it;
   * a socket that omits it behaves exactly as before.
   */
  onDataError?(handler: (event: DataErrorEvent) => void): () => void;
}

/** A market-data subscription error, in this codebase's vocabulary. */
export interface DataErrorEvent {
  /** The symbol whose subscription failed. */
  symbol: string;
  /** IB's numeric code where one exists — 354 is "not subscribed". */
  code: number | null;
  message: string;
}

/** A late-arriving commission, matched to its fill by `fillId` (IB's `execId`). */
export interface CommissionCorrection {
  fillId: string;
  commission: number;
}

/** DI token, so the adapter never names a concrete socket implementation. */
export const IB_SOCKET = Symbol('IB_SOCKET');

/**
 * IB error codes that mean "the connection went away on purpose".
 *
 * 1100 is a lost connection, 1101/1102 are restores with and without retained
 * subscriptions. Gateway raises these on its scheduled daily logout, and
 * `reconnect.ts` routes them to `reconnectAfterReauth` so the event is logged
 * rather than alerted (`stories.md:596`).
 */
export const REAUTH_ERROR_CODES = new Set([1100, 1101, 1102]);

export function isReauthCode(code: number | null): boolean {
  return code !== null && REAUTH_ERROR_CODES.has(code);
}
