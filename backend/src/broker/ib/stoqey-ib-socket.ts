/**
 * `StoqeyIbSocket` — the real `IbSocket`, over `@stoqey/ib`'s `IBApiNext`.
 *
 * **This is the only file in the codebase that imports the IB client.**
 * Everything above it — the adapter, the cache, the backfill, the engine —
 * depends on `IbSocket`, so IB's vocabulary stops here and this codebase's
 * starts. That containment is what lets the entire Story 10 suite run without a
 * Gateway, and what makes replacing the client a one-file change.
 *
 * `IBApiNext` is chosen over the raw `IBApi` deliberately: it already models
 * requests as Promises and Observables with request-id correlation handled
 * internally. Using the event-emitter API directly would mean re-implementing
 * that correlation here, which is exactly the accidental complexity this port
 * exists to avoid.
 *
 * ## The two conversions that live here
 *
 * 1. **Timestamps.** IB speaks `yyyyMMdd HH:mm:ss` in an ambiguous local zone;
 *    this codebase speaks ISO-8601 with an explicit ET offset (`types.ts:3`).
 *    Converting at the boundary means a DST transition is a problem in one
 *    function rather than a class of bugs spread across the strategy layer.
 * 2. **Contracts and orders.** Our `Contract` carries an explicit `multiplier`
 *    and ISO expiry; IB wants `YYYYMMDD` and its own enums.
 *
 * Neither conversion is clever, and both are exhaustively tested — a
 * mis-encoded order payload is the failure mode with money attached
 * (`stories.md:413`).
 */

import { Logger } from '@nestjs/common';
import {
  BarSizeSetting,
  CommissionReport as IbCommissionReport,
  Contract as IbContract,
  EventName,
  Execution as IbExecution,
  IBApi,
  IBApiNext,
  IBApiNextError,
  WhatToShow,
} from '@stoqey/ib';
import { Observable } from 'rxjs';
import { DateTime } from 'luxon';
import { Contract } from '../../domain/contract';
import { formatEt } from '../../market-data/session';
import { Bar, BarSize, ET_ZONE } from '../../market-data/types';
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
  isReauthCode,
} from './ib-socket';
// The pure wire conversions live in their own module so they stay covered
// while this file — which cannot run without a Gateway — does not.
import {
  durationString,
  parseIbTime,
  toDomainBar,
  toIbContract,
  toIbEndDateTime,
  toIbOrder,
} from './ib-wire';

export { durationString, parseIbTime, toIbContract, toIbEndDateTime, toIbOrder } from './ib-wire';

export interface StoqeyIbSocketConfig {
  host: string;
  port: number;
  /**
   * IB requires a distinct client id per concurrent connection. Fixed rather
   * than random so a reconnect reclaims the *same* session — a new id would
   * leave IB holding the old one's subscriptions until it times out.
   */
  clientId: number;
}

/** IB's bar-size wire strings, for the two sizes this system uses. */
const BAR_SIZE_SETTING: Record<BarSize, BarSizeSetting> = {
  [BarSize.FIVE_MIN]: BarSizeSetting.MINUTES_FIVE,
  [BarSize.DAILY]: BarSizeSetting.DAYS_ONE,
};

export class StoqeyIbSocket implements IbSocket {
  private readonly logger = new Logger(StoqeyIbSocket.name);
  private readonly api: IBApiNext;
  /**
   * The lower-level client, for the one thing `IBApiNext` does not expose: a
   * **stream** of executions.
   *
   * `IBApiNext` offers only `getExecutionDetails`, which polls. Polling for
   * fills would violate the interface's central rule — "an ack is not a fill"
   * (`broker-adapter.interface.ts:17`) — by making fill latency a function of
   * how often we happen to ask, and would miss a fill that arrived and was
   * superseded between polls. `IBApiNext` wraps its own `IBApi` privately, so
   * observing executions means holding one directly.
   */
  private readonly eventApi: IBApi;
  private readonly config: StoqeyIbSocketConfig;

  private connected = false;
  private orderIdSequence = 0;

  /** `clientOrderId` → IB's numeric order id, for cancels and correlation. */
  private readonly orderIds = new Map<string, number>();

  private readonly fillHandlers = new Set<(fill: Fill) => void>();
  private readonly statusHandlers = new Set<(ack: OrderAck) => void>();
  private readonly commissionHandlers = new Set<(report: CommissionCorrection) => void>();
  private readonly disconnectHandlers = new Set<(event: DisconnectEvent) => void>();

  constructor(config: StoqeyIbSocketConfig) {
    this.config = config;
    this.api = new IBApiNext({ host: config.host, port: config.port });
    // A distinct client id: IB rejects two connections sharing one, and this
    // is a genuinely separate socket rather than a view onto the first.
    this.eventApi = new IBApi({
      host: config.host,
      port: config.port,
      clientId: config.clientId + 1,
    });

    this.wireErrorHandling();
  }

  async connect(): Promise<void> {
    this.api.connect(this.config.clientId);
    this.eventApi.connect();
    this.eventApi.reqAutoOpenOrders(true);

    // `connect()` is fire-and-forget in IBApiNext; readiness is observed on the
    // connection state stream. Awaiting it here means the adapter's reconnect
    // policy sees a rejected promise rather than a silent no-op, which is what
    // makes bounded retry meaningful.
    await this.awaitConnected();

    this.connected = true;
    this.logger.log(`connected to IB Gateway at ${this.config.host}:${this.config.port}`);
  }

  async disconnect(): Promise<void> {
    this.api.disconnect();
    this.connected = false;
    this.emitDisconnect({
      reason: DisconnectReason.REQUESTED,
      code: null,
      message: 'local disconnect',
    });
  }

  isConnected(): boolean {
    return this.connected && this.api.isConnected;
  }

  /**
   * One historical request.
   *
   * Called only by `IBBrokerAdapter` through its `PacingQueue` — see the
   * warning on `IbSocket.reqHistoricalData`. The duration string is derived
   * from the requested range rather than fixed, because IB caps duration by bar
   * size and an over-long request is rejected outright rather than truncated.
   */
  async reqHistoricalData(request: HistoricalRequest): Promise<Bar[]> {
    const bars = await this.api.getHistoricalData(
      toIbContract(request.contract),
      toIbEndDateTime(request.to),
      durationString(request.from, request.to, request.barSize),
      BAR_SIZE_SETTING[request.barSize],
      // TRADES rather than MIDPOINT: the ladder fires on traded prices, and
      // backtesting against midpoints would assume fills that never existed.
      WhatToShow.TRADES,
      request.regularHoursOnly ? 1 : 0,
      // Format 2 is epoch seconds — unambiguous. Format 1 returns a local
      // string whose zone depends on Gateway configuration, which is precisely
      // the ambiguity this boundary exists to eliminate.
      2,
    );

    return bars
      .map((bar) => toDomainBar(bar, request.contract.symbol, request.barSize))
      .filter((bar): bar is Bar => bar !== null);
  }

  subscribeBars(contract: Contract, barSize: BarSize, handler: (bar: Bar) => void): () => void {
    const subscription = this.api
      .getHistoricalDataUpdates(
        toIbContract(contract),
        BAR_SIZE_SETTING[barSize],
        WhatToShow.TRADES,
        2,
      )
      .subscribe({
        next: (bar) => {
          const domain = toDomainBar(bar, contract.symbol, barSize);

          if (domain) {
            handler(domain);
          }
        },
        error: (error: IBApiNextError) => {
          this.logger.warn(`bar subscription error for ${contract.symbol}: ${error.error.message}`);
        },
      });

    return () => subscription.unsubscribe();
  }

  async placeOrder(order: BrokerOrder): Promise<OrderAck> {
    if (!this.isConnected()) {
      throw new Error(`not connected — cannot place ${order.clientOrderId}`);
    }

    const orderId = await this.nextOrderId();
    this.orderIds.set(order.clientOrderId, orderId);

    await this.api.placeOrder(orderId, toIbContract(order.contract), toIbOrder(order));

    const ack: OrderAck = {
      clientOrderId: order.clientOrderId,
      brokerOrderId: String(orderId),
      status: OrderStatus.SUBMITTED,
    };

    this.emitStatus(ack);

    return ack;
  }

  async cancelOrder(clientOrderId: string): Promise<OrderAck> {
    const orderId = this.orderIds.get(clientOrderId);

    if (orderId === undefined) {
      throw new Error(`unknown order ${clientOrderId} — nothing to cancel`);
    }

    this.api.cancelOrder(orderId);

    const ack: OrderAck = {
      clientOrderId,
      brokerOrderId: String(orderId),
      status: OrderStatus.CANCELLED,
    };

    this.emitStatus(ack);

    return ack;
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const update = await firstValue(this.api.getPositions());
    const positions: BrokerPosition[] = [];

    for (const accountPositions of update.all.values()) {
      for (const position of accountPositions) {
        if (!position.contract.symbol || !position.pos) {
          continue;
        }

        positions.push({
          symbol: position.contract.symbol,
          quantity: position.pos,
          averageCost: position.avgCost ?? 0,
        });
      }
    }

    return positions;
  }

  async getAccountSummary(): Promise<AccountSummary> {
    const update = await firstValue(
      this.api.getAccountSummary('All', 'NetLiquidation,AvailableFunds'),
    );

    let equity = 0;
    let availableFunds = 0;
    let currency = 'USD';

    for (const values of update.all.values()) {
      for (const [tag, byCurrency] of values) {
        for (const [cur, value] of byCurrency) {
          const numeric = Number(value.value);

          if (!Number.isFinite(numeric)) {
            continue;
          }

          if (tag === 'NetLiquidation') {
            equity = numeric;
            currency = cur;
          }

          if (tag === 'AvailableFunds') {
            availableFunds = numeric;
          }
        }
      }
    }

    return { equity, availableFunds, currency };
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

  /**
   * Routes IB's error stream to the right consumer.
   *
   * The load-bearing branch is the re-auth code check: IB reports its scheduled
   * daily logout through the *same* error channel as a real socket failure, and
   * only the code distinguishes them (`reconnect.ts:14`). Getting this wrong
   * either alerts every day or silently swallows a genuine outage.
   */
  private wireErrorHandling(): void {
    this.api.errorSubject.subscribe((error: IBApiNextError) => {
      const code = typeof error.code === 'number' ? error.code : null;
      this.classifyError(code, error.error.message);
    });

    // The execution stream's client needs the same treatment. It is a second,
    // independent socket on its own client id, so it fails independently — and
    // an unobserved failure here is invisible rather than loud: fills would
    // simply stop arriving on a connection that still looks healthy, because
    // `this.api` is what `isConnected` and every status reader consult. IB
    // reports its errors on the callback channel rather than a subject.
    this.eventApi.on(EventName.error, (error: Error, code: number, reqId: number) => {
      this.classifyError(
        typeof code === 'number' ? code : null,
        `${error.message}${reqId >= 0 ? ` (reqId ${reqId})` : ''}`,
      );
    });

    this.eventApi.on(
      EventName.execDetails,
      (_reqId: number, contract: IbContract, execution: IbExecution) => {
        const clientOrderId = this.clientOrderIdFor(execution.orderId);

        if (!clientOrderId) {
          return;
        }

        this.fillHandlers.forEach((handler) =>
          handler({
            clientOrderId,
            brokerOrderId: String(execution.orderId),
            fillId: execution.execId ?? `${execution.orderId}-${execution.shares}`,
            symbol: contract.symbol ?? '',
            side: execution.side === 'SLD' ? 'SELL' : 'BUY',
            quantity: execution.shares ?? 0,
            price: execution.price ?? 0,
            // Commission arrives on a separate `commissionReport` event, keyed by
            // execId. Recorded as 0 here and corrected below when that event
            // lands — inventing a figure would corrupt realized P&L.
            commission: 0,
            // IB's own execution time, not `now()`: a fill is stamped when it
            // happened, and using arrival time would misorder FIFO disposal
            // whenever events are delivered late or out of order.
            timestamp:
              parseIbTime(execution.time ?? '') ?? formatEt(DateTime.now().setZone(ET_ZONE)),
          }),
        );
      },
    );

    // Commission arrives after the execution it belongs to, on its own event.
    // Emitted as a zero-quantity correction keyed by the same `fillId` so the
    // consumer can attribute the cost without inventing a second fill.
    this.eventApi.on(EventName.commissionReport, (report: IbCommissionReport) => {
      this.commissionHandlers.forEach((handler) =>
        handler({
          fillId: report.execId ?? '',
          commission: report.commission ?? 0,
        }),
      );
    });
  }

  /**
   * Routes one IB error to the right consumer, for either client.
   *
   * Shared rather than duplicated per socket: the re-auth/fault split is the
   * load-bearing decision, and two copies would be two things to keep in step.
   */
  private classifyError(code: number | null, message: string): void {
    if (isReauthCode(code)) {
      // 1102 means connectivity was restored *with* data retained — the
      // session is already usable again, so it is reported as routine and
      // does not mark the socket down.
      if (code === 1102) {
        this.connected = true;
        this.logger.log('IB connectivity restored with data retained');
        return;
      }

      this.connected = false;
      this.emitDisconnect({
        reason: DisconnectReason.SCHEDULED_REAUTH,
        code,
        message,
      });
      return;
    }

    // Codes below 2000 that are not re-auth are genuine faults; 2100+ are
    // IB's informational warnings and must not halt anything.
    if (code !== null && code < 2000) {
      this.connected = false;
      this.emitDisconnect({
        reason: DisconnectReason.SOCKET_DROP,
        code,
        message,
      });
      return;
    }

    this.logger.debug(`IB notice ${code ?? 'n/a'}: ${message}`);
  }

  private clientOrderIdFor(orderId: number | undefined): string | null {
    if (orderId === undefined) {
      return null;
    }

    for (const [clientOrderId, id] of this.orderIds) {
      if (id === orderId) {
        return clientOrderId;
      }
    }

    return null;
  }

  private async nextOrderId(): Promise<number> {
    if (this.orderIdSequence === 0) {
      this.orderIdSequence = await this.api.getNextValidOrderId();
      return this.orderIdSequence;
    }

    this.orderIdSequence += 1;
    return this.orderIdSequence;
  }

  private async awaitConnected(timeoutMs = 15_000): Promise<void> {
    if (this.api.isConnected) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        subscription.unsubscribe();
        reject(new Error(`IB Gateway did not connect within ${timeoutMs}ms`));
      }, timeoutMs);

      const subscription = this.api.connectionState.subscribe((state) => {
        // 2 === Connected in IBApiNext's ConnectionState enum.
        if (state === 2) {
          clearTimeout(timer);
          subscription.unsubscribe();
          resolve();
        }
      });
    });
  }

  private emitStatus(ack: OrderAck): void {
    this.statusHandlers.forEach((handler) => handler({ ...ack }));
  }

  private emitDisconnect(event: DisconnectEvent): void {
    this.disconnectHandlers.forEach((handler) => handler({ ...event }));
  }
}

/**
 * Resolves with an Observable's first emission, **or rejects on timeout**.
 *
 * `getPositions` and `getAccountSummary` are subscriptions that keep pushing
 * updates, but every caller here wants one answer: the risk manager measures
 * the capital cap against equity *at this moment*, and reconciliation compares
 * one position snapshot to the database. Unsubscribing after the first value
 * is what turns a stream into that question — and leaving it subscribed would
 * leak a subscription per call.
 *
 * ## The timeout is not optional, and this is why
 *
 * On a socket that accepted a TCP connection but never completed IB's
 * handshake, these Observables **never emit and never error** — IB simply has
 * nothing to say. Without a timeout the promise hangs forever, and because
 * `StartupSequence` awaits reconciliation inside `onModuleInit`, the hang
 * happens *before* `app.listen()`. The process then has no HTTP server holding
 * the event loop open, runs out of work, and exits 0 — which reads as a clean
 * shutdown, restarts under compose, and loops.
 *
 * A broker that will not answer must fail like a broker that refused, so the
 * fail-safe path above it can run: halt the symbols, surface the reason, keep
 * serving. Hanging is the one outcome that takes the dashboard down with it.
 */
export function firstValue<T>(observable: Observable<T>, timeoutMs = 10_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Held in a box rather than a bare binding: a cold Observable can emit
    // *synchronously* inside `subscribe()`, so `settle` may run before that
    // call returns and the subscription exists. A `const` captured directly
    // would be in its temporal dead zone at that moment and throw; the box is
    // always defined, and its `current` is simply still undefined.
    const handle: { current?: { unsubscribe(): void } } = {};
    let done = false;

    const settle = (fn: () => void) => {
      if (done) {
        return;
      }

      done = true;
      clearTimeout(timer);
      handle.current?.unsubscribe();
      fn();
    };

    const timer = setTimeout(() => {
      settle(() =>
        reject(new Error(`IB did not respond within ${timeoutMs}ms — treating as unreachable`)),
      );
    }, timeoutMs);

    handle.current = observable.subscribe({
      next: (value) => settle(() => resolve(value)),
      error: (error: unknown) =>
        settle(() => reject(error instanceof Error ? error : new Error(String(error)))),
    });

    // A synchronous emission settled before `handle.current` was assigned, so
    // its `unsubscribe` was skipped. Doing it here keeps the subscription from
    // outliving the promise.
    if (done) {
      handle.current.unsubscribe();
    }
  });
}
