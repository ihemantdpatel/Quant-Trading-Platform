/**
 * `IBBrokerAdapter` — the live broker (`stories.md:581`).
 *
 * Implements the same `BrokerAdapter` the engine has used since Story 6, so the
 * strategy and risk layers cannot tell it apart from `MockBrokerAdapter`. That
 * indistinguishability is the point: every safety control was written and
 * tested against the mock, and none of them changes because a real socket
 * arrived.
 *
 * What this class adds over the socket beneath it is **policy**:
 *
 * | Concern | Policy | Why here |
 * |---|---|---|
 * | Historical requests | every one through `PacingQueue` | one queue per connection, and the adapter owns the connection |
 * | Socket drops | `ReconnectPolicy`, bounded | the adapter is what knows a drop happened |
 * | Scheduled re-auth | routine, no alert | distinguished by IB's own codes at the socket |
 * | Retries exhausted | `FAILED` → engine halts entries | **never liquidates** (`PRD.md:316`) |
 *
 * ## The rule that governs every decision in this file
 *
 * **A technical fault must never become a realized loss.** There is no code
 * path here that sells anything, and none may be added. When the connection is
 * gone, `submit()` throws — the engine reads that as a fault, halts *new
 * entries*, and leaves positions exactly where they are until a human decides
 * otherwise. Failing loudly and doing nothing is the correct behaviour.
 *
 * ## `SHADOW` and the order path
 *
 * `placeOrder` is implemented and its payload is asserted field-by-field
 * (`stories.md:413`), but Story 10 ships in `SHADOW`, where
 * `RiskManagerService.canSubmit()` is false by definition. So this path is
 * built and tested but unreachable at runtime until Story 13 — deliberately, so
 * the first real order meets code that has already been exercised.
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Contract } from '../../domain/contract';
import { Bar, BarSize } from '../../market-data/types';
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
} from '../broker-adapter.interface';
import {
  CommissionCorrection,
  DataErrorEvent,
  DisconnectEvent,
  DisconnectReason,
  IbSocket,
} from './ib-socket';
import { PacingConfig, PacingQueue, PacingStats, historicalRequestKey } from './pacing-queue';
import {
  DEFAULT_STALE_THRESHOLD_MS,
  ReconnectConfig,
  ReconnectOutcome,
  ReconnectPolicy,
  isStale,
} from './reconnect';

export interface IbBrokerConfig {
  pacing: Partial<PacingConfig>;
  reconnect: Partial<ReconnectConfig>;
  /** How long without a bar before the feed is considered stale. */
  staleThresholdMs: number;
  /**
   * How often to check that the socket is still there.
   *
   * Every recovery path below is driven by a disconnect *event*, and IB does
   * not always raise one — see `checkLiveness`. This poll is what turns a
   * silent loss into an event the rest of the file already knows how to handle.
   */
  livenessProbeMs: number;
  /**
   * How often to retry a connection that has already reached `FAILED`.
   *
   * `ReconnectPolicy` is a *bounded* budget, and reaching its end used to be
   * the end of the story: the liveness probe stopped, no disconnect event could
   * fire again, and nothing in the process ever attempted another connection.
   * A Gateway that came back a minute later was never noticed, so the only
   * recovery from any exhausted reconnect was restarting the daemon — including
   * for IB Gateway's own daily restart, which routinely outlasts the ~3.5
   * minutes six exponential attempts cover.
   *
   * This is deliberately a **slow, fixed, unbounded** poll rather than a second
   * backoff. The fast budget exists to ride out a blip without disturbing a
   * live session; this exists to notice, eventually, that a long outage ended.
   * Different jobs, different cadences.
   *
   * Zero disables it, for tests that drive `retryFailedConnection` directly.
   */
  failedRetryMs: number;
}

/**
 * 15s: fast enough that a silent loss is caught within one bar interval (the
 * ladder evaluates on 5-minute closes), slow enough to be free. The check is a
 * boolean read on an already-held object, not a network call.
 */
export const DEFAULT_LIVENESS_PROBE_MS = 15_000;

/**
 * 5 minutes between attempts to revive a `FAILED` connection.
 *
 * Long enough that a Gateway which is genuinely gone costs one log line per
 * five minutes rather than a flood, short enough that an outage ending between
 * sessions is picked up well before the next open. It is also one ladder bar
 * interval, so at worst a single evaluation is missed after the Gateway
 * returns.
 */
export const DEFAULT_FAILED_RETRY_MS = 5 * 60 * 1000;

export const DEFAULT_IB_BROKER_CONFIG: IbBrokerConfig = {
  pacing: {},
  reconnect: {},
  staleThresholdMs: DEFAULT_STALE_THRESHOLD_MS,
  livenessProbeMs: DEFAULT_LIVENESS_PROBE_MS,
  failedRetryMs: DEFAULT_FAILED_RETRY_MS,
};

/** A historical request as callers of this adapter express it. */
export interface HistoricalBarsRequest {
  contract: Contract;
  barSize: BarSize;
  from: string;
  to: string;
  regularHoursOnly?: boolean;
}

@Injectable()
export class IBBrokerAdapter implements BrokerAdapter, OnModuleDestroy {
  readonly name = 'ib';

  private readonly logger = new Logger(IBBrokerAdapter.name);
  private readonly pacing: PacingQueue;
  private readonly reconnectPolicy: ReconnectPolicy;
  private readonly config: IbBrokerConfig;

  private health: ConnectionHealth = {
    state: ConnectionState.DISCONNECTED,
    connectedAt: null,
    reconnectAttempts: 0,
    lastError: null,
  };

  private readonly connectionHandlers = new Set<(health: ConnectionHealth) => void>();

  /** Commission corrections, keyed by fillId, for consumers that want them. */
  private readonly commissionHandlers = new Set<(report: CommissionCorrection) => void>();

  /** Epoch ms of the most recent bar seen on any subscription. */
  private lastBarAtMs: number | null = null;

  /**
   * The most recent market-data error per symbol, for `GET /status`.
   *
   * Keyed by symbol rather than appended, because IB repeats a rejection on
   * every re-subscription attempt: an unbounded list would grow for as long as
   * the fault lasts, and the newest one is the only one an operator acts on.
   */
  private readonly dataErrors = new Map<string, DataErrorEvent & { at: string }>();

  /**
   * Epoch ms from which bars were expected but none has yet arrived.
   *
   * Set when a subscription opens and re-set on a reconnect, so "connected but
   * never delivered" is distinguishable from "has not started yet". Without it
   * a reconnect that silently fails to resume the feed stays invisible: the
   * reconnect clears `lastBarAtMs`, and a null last-bar reads as startup
   * forever. Cleared once a bar actually arrives.
   */
  private dataExpectedSinceMs: number | null = null;

  /** Guards against two overlapping reconnect loops on a flapping socket. */
  private reconnecting = false;

  /** The liveness poll, running only while the adapter believes it is connected. */
  private livenessTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * The slow retry poll, running only while the connection is `FAILED`.
   *
   * Mutually exclusive with `livenessTimer` by construction: one watches a
   * connection we believe exists, the other tries to rebuild one we know does
   * not. Both are cleared on `disconnect()` and on shutdown.
   */
  private failedRetryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly socket: IbSocket,
    config: Partial<IbBrokerConfig> = {},
    private readonly now: () => number = () => Date.now(),
    pacing?: PacingQueue,
    reconnectPolicy?: ReconnectPolicy,
  ) {
    this.config = { ...DEFAULT_IB_BROKER_CONFIG, ...config };
    this.pacing = pacing ?? new PacingQueue(this.config.pacing);
    this.reconnectPolicy = reconnectPolicy ?? new ReconnectPolicy(this.config.reconnect);

    this.socket.onDisconnect((event) => void this.handleDisconnect(event));
    this.socket.onCommission((report) =>
      this.commissionHandlers.forEach((handler) => handler(report)),
    );

    // Optional on the port, so a socket that does not report data errors keeps
    // its existing behaviour rather than failing to construct.
    this.socket.onDataError?.((event) => this.recordDataError(event));
  }

  /**
   * Records a market-data error for `GET /status`.
   *
   * Reporting only — this deliberately does **not** halt entries. IB uses this
   * channel for benign notices as well as real rejections, and a halt that can
   * fire on an informational message would be cleared by hand often enough to
   * train an operator to clear it without reading it. The staleness watchdog
   * remains the mechanism that acts, on the evidence that actually matters:
   * bars stopped arriving. This makes the *cause* visible next to that effect.
   */
  private recordDataError(event: DataErrorEvent): void {
    this.dataErrors.set(event.symbol, {
      ...event,
      at: new Date(this.now()).toISOString(),
    });
  }

  async connect(): Promise<void> {
    // An explicit connect supersedes the slow poll — otherwise a timer firing
    // mid-connect would open a second socket against the same Gateway.
    this.stopFailedRetry();

    this.setHealth({ ...this.health, state: ConnectionState.CONNECTING });

    try {
      await this.socket.connect();
      this.setHealth({
        state: ConnectionState.CONNECTED,
        connectedAt: new Date(this.now()).toISOString(),
        reconnectAttempts: 0,
        lastError: null,
      });
      this.startLivenessProbe();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Reported as FAILED, which is a change: this used to be DISCONNECTED on
      // the grounds that no retry budget had been spent. But DISCONNECTED is
      // also what a *requested* disconnect reports, and the two need telling
      // apart now that one of them is being retried and the other must not be.
      // FAILED is the state that means "not connected, not by choice, and being
      // worked on" — which is exactly this. `reconnectAttempts` stays 0, so the
      // distinction the old comment cared about is still legible on
      // `GET /status`.
      this.setHealth({
        state: ConnectionState.FAILED,
        connectedAt: null,
        reconnectAttempts: 0,
        lastError: message,
      });

      // **The caller is told, and the adapter keeps trying anyway.**
      //
      // `StartupSequence` catches this and boots regardless, which is right —
      // the dashboard must come up so an operator can see *why* nothing is
      // trading. But nothing then re-attempted the connection: no disconnect
      // event can fire for a socket that never opened, and the liveness probe
      // only runs once connected. A Gateway that was merely slow to start left
      // the daemon permanently disconnected with every symbol halted, and a
      // restart was the only way back.
      //
      // The slow poll makes a boot-time outage recoverable on exactly the same
      // terms as a mid-session one. `retryFailedConnection` gates on FAILED, so
      // this is the state that expresses "gave up, still watching".
      this.startFailedRetry();

      throw error;
    }
  }

  async disconnect(): Promise<void> {
    // Both polls: a requested disconnect is deliberate, and reviving the socket
    // behind the caller's back would be the adapter overruling it.
    this.stopLivenessProbe();
    this.stopFailedRetry();
    await this.socket.disconnect();
    this.setHealth({ ...this.health, state: ConnectionState.DISCONNECTED, connectedAt: null });
  }

  isConnected(): boolean {
    return this.health.state === ConnectionState.CONNECTED && this.socket.isConnected();
  }

  connectionHealth(): ConnectionHealth {
    // `CONNECTED` is only reported when the socket agrees. Between a silent
    // loss and the next probe the two disagree, and surfacing `CONNECTED`
    // beside `connected: false` on `GET /status` invites an operator reading
    // the state field to conclude the broker is fine. Reported as CONNECTING
    // because that is what happens next: the probe turns it into a reconnect.
    if (this.health.state === ConnectionState.CONNECTED && !this.socket.isConnected()) {
      return { ...this.health, state: ConnectionState.CONNECTING, connectedAt: null };
    }

    return { ...this.health };
  }

  /**
   * Detects a connection that went away **without IB reporting anything**.
   *
   * Every other recovery path in this file is driven by a disconnect event, and
   * `StoqeyIbSocket.classifyError` only emits one when IB supplies an error
   * code. Observed against a live Gateway: the socket vanished with no code on
   * either channel, so no event was emitted, `health.state` stayed `CONNECTED`,
   * `ReconnectPolicy` never engaged, and every API call timed out for hours
   * with `reconnectAttempts` still reading 0.
   *
   * The disagreement is detectable without IB's help: `health.state` says
   * `CONNECTED` while `socket.isConnected()` says otherwise. This turns that
   * into the `SOCKET_DROP` the rest of the file already handles — bounded
   * retry, then `FAILED`, which halts new entries. It adds no new recovery
   * policy and, like every path here, **never liquidates**.
   *
   * Public so a caller can force a check; the interval calls it too.
   */
  checkLiveness(): void {
    // Only meaningful while we *believe* we are connected. During CONNECTING a
    // reconnect is already in flight, and in DISCONNECTED/FAILED the loss is
    // known — re-reporting it would spend the retry budget twice.
    if (this.health.state !== ConnectionState.CONNECTED) {
      return;
    }

    if (this.socket.isConnected()) {
      return;
    }

    this.logger.warn(
      'IB socket lost with no error from IB — treating as a socket drop and reconnecting',
    );

    void this.handleDisconnect({
      reason: DisconnectReason.SOCKET_DROP,
      code: null,
      message: 'socket closed without an IB error code',
    });
  }

  /**
   * One attempt to revive a connection that has reached `FAILED`.
   *
   * The counterpart to `checkLiveness`: that one notices a connection we
   * believe in has gone, this one notices a connection we have given up on has
   * become possible again. Between them there is no state the adapter can
   * settle into where nothing is watching.
   *
   * On success the adapter re-enters `CONNECTED` through the same path a
   * reconnect takes — pacing window reset, staleness clock restarted, liveness
   * probe running — and emits the health change the engine and live feed are
   * already subscribed to. It does **not** clear the engine's entry halt: this
   * proves the socket is back, not that positions still reconcile. That
   * decision belongs to reconciliation and to the operator.
   *
   * Public so a test can drive it without a timer, and so an operator route can
   * force an immediate attempt rather than waiting out the poll.
   */
  async retryFailedConnection(): Promise<boolean> {
    if (this.health.state !== ConnectionState.FAILED) {
      // Only meaningful from FAILED. A connection that recovered by any other
      // route has already stopped this poll; racing it would risk a second
      // socket.
      return this.health.state === ConnectionState.CONNECTED;
    }

    try {
      await this.socket.connect();
    } catch (error) {
      // Stays FAILED and stays polling. Logged at warn, not error: the outage
      // was already reported as critical when the budget ran out, and repeating
      // that every five minutes is how an operator learns to filter the alert
      // that matters.
      this.logger.warn(
        `IB retry from FAILED did not connect: ${
          error instanceof Error ? error.message : String(error)
        }. Still retrying every ${Math.round(this.config.failedRetryMs / 1000)}s.`,
      );

      return false;
    }

    this.stopFailedRetry();

    this.setHealth({
      state: ConnectionState.CONNECTED,
      connectedAt: new Date(this.now()).toISOString(),
      reconnectAttempts: 0,
      lastError: null,
    });

    // The same session bookkeeping a successful reconnect does — IB counts
    // pacing per session, and a new session starts with an empty budget.
    this.pacing.reset();

    // A fresh session has delivered no bar. Restarting the expectation clock is
    // what keeps a socket that reconnects but never resumes its feed visible to
    // the staleness watchdog rather than reading as startup forever.
    this.lastBarAtMs = null;
    this.dataExpectedSinceMs = this.now();

    this.startLivenessProbe();

    this.logger.log(
      'IB connection recovered from FAILED. New entries remain halted until an ' +
        'operator clears the halt or reconciliation confirms positions.',
    );

    return true;
  }

  /**
   * Stops both polls.
   *
   * Nest calls this on shutdown; without it an interval keeps the event loop
   * alive and the process never exits.
   */
  onModuleDestroy(): void {
    this.stopLivenessProbe();
    this.stopFailedRetry();
  }

  private startFailedRetry(): void {
    this.stopFailedRetry();

    if (this.config.failedRetryMs <= 0) {
      // Opt-out for tests that drive `retryFailedConnection` directly.
      return;
    }

    this.logger.warn(
      `IB connection FAILED — retrying every ${Math.round(
        this.config.failedRetryMs / 1000,
      )}s until it returns. No further alert will be raised for this outage.`,
    );

    this.failedRetryTimer = setInterval(() => {
      void this.retryFailedConnection();
    }, this.config.failedRetryMs);

    // Like the liveness probe: never the reason the daemon cannot exit.
    this.failedRetryTimer.unref?.();
  }

  private stopFailedRetry(): void {
    if (this.failedRetryTimer !== null) {
      clearInterval(this.failedRetryTimer);
      this.failedRetryTimer = null;
    }
  }

  private startLivenessProbe(): void {
    this.stopLivenessProbe();

    if (this.config.livenessProbeMs <= 0) {
      // Opt-out for tests that drive `checkLiveness` directly rather than
      // waiting on a timer.
      return;
    }

    this.livenessTimer = setInterval(() => this.checkLiveness(), this.config.livenessProbeMs);

    // Must not hold the process open on its own: the daemon's lifetime is the
    // HTTP server's, not this poll's.
    this.livenessTimer.unref?.();
  }

  private stopLivenessProbe(): void {
    if (this.livenessTimer !== null) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  /**
   * Historical bars, **always through the pacing queue**.
   *
   * This is the only route from this codebase to IB's historical endpoint. A
   * caller that bypassed it would breach IB's limits silently — no error, just
   * throttling or a dropped connection that reads as a bug elsewhere for days
   * (`PRD.md:289`). `HistoryCacheService` calls this only for genuine gaps, so
   * in steady state it is barely used.
   */
  async getHistoricalBars(request: HistoricalBarsRequest): Promise<Bar[]> {
    const key = historicalRequestKey(
      request.contract.symbol,
      request.barSize,
      request.from,
      request.to,
    );

    return this.pacing.enqueue(key, () =>
      this.socket.reqHistoricalData({
        contract: request.contract,
        barSize: request.barSize,
        from: request.from,
        to: request.to,
        // 5-minute bars default to RTH only: the ladder cannot fire outside
        // 09:45–16:00 ET, so caching pre/post-market prints would store bars
        // no rule may act on. Daily bars are unaffected by the flag.
        regularHoursOnly: request.regularHoursOnly ?? request.barSize === BarSize.FIVE_MIN,
      }),
    );
  }

  /**
   * Subscribes to live bars, tracking arrival time for staleness.
   *
   * The timestamp recorded is **arrival**, not the bar's own — staleness asks
   * "is the feed still delivering?", and a bar's embedded timestamp would keep
   * looking recent long after delivery stopped.
   */
  subscribeBars(contract: Contract, barSize: BarSize, handler: (bar: Bar) => void): () => void {
    // Bars are expected from the moment a subscription exists. Recorded only
    // when nothing has arrived yet, so a second subscription cannot push the
    // reference point forward and mask a feed that is already silent.
    if (this.lastBarAtMs === null && this.dataExpectedSinceMs === null) {
      this.dataExpectedSinceMs = this.now();
    }

    return this.socket.subscribeBars(contract, barSize, (bar) => {
      this.lastBarAtMs = this.now();
      this.dataExpectedSinceMs = null;

      // A bar is proof the subscription recovered, so a stale rejection must
      // not linger on `/status` describing a feed that is now working.
      this.dataErrors.delete(bar.symbol);

      handler(bar);
    });
  }

  /**
   * True when the feed has gone quiet past the threshold.
   *
   * A connected socket that stopped delivering is more dangerous than a dropped
   * one, because nothing looks wrong: the ladder keeps evaluating against the
   * last price it saw while the market moves away from it (`reconnect.ts:177`).
   */
  isDataStale(): boolean {
    return isStale(
      this.lastBarAtMs,
      this.now(),
      this.config.staleThresholdMs,
      this.dataExpectedSinceMs,
    );
  }

  /** Epoch ms of the last bar received, or null before the first. */
  lastBarAt(): number | null {
    return this.lastBarAtMs;
  }

  /** The most recent market-data error per symbol, newest state only. */
  dataErrorList(): Array<DataErrorEvent & { at: string }> {
    return [...this.dataErrors.values()];
  }

  async submit(order: BrokerOrder): Promise<OrderAck> {
    if (!this.isConnected()) {
      // A technical fault, not a rejection. The engine halts new entries and
      // leaves positions untouched; it does not treat this as IB declining.
      throw new Error(
        `IB not connected (${this.health.state}) — cannot submit ${order.clientOrderId}`,
      );
    }

    return this.socket.placeOrder(order);
  }

  async cancel(clientOrderId: string): Promise<OrderAck> {
    if (!this.isConnected()) {
      throw new Error(`IB not connected — cannot cancel ${clientOrderId}`);
    }

    return this.socket.cancelOrder(clientOrderId);
  }

  async getOpenOrders(): Promise<OpenOrder[]> {
    if (!this.isConnected()) {
      // Throws rather than returning empty: reconciliation must be able to tell
      // "IB reports nothing working" from "IB could not be asked".
      throw new Error('IB not connected — cannot list open orders');
    }

    return this.socket.getOpenOrders();
  }

  async getCompletedOrders(): Promise<CompletedOrder[]> {
    if (!this.isConnected()) {
      // Same distinction as `getOpenOrders`: an empty history and an
      // unanswerable query must not look alike to the caller.
      throw new Error('IB not connected — cannot list completed orders');
    }

    return this.socket.getCompletedOrders();
  }

  async getPositions(): Promise<BrokerPosition[]> {
    return this.socket.getPositions();
  }

  async getAccountSummary(): Promise<AccountSummary> {
    return this.socket.getAccountSummary();
  }

  onFill(handler: (fill: Fill) => void): () => void {
    return this.socket.onFill(handler);
  }

  onOrderStatus(handler: (ack: OrderAck) => void): () => void {
    return this.socket.onOrderStatus(handler);
  }

  onConnectionChange(handler: (health: ConnectionHealth) => void): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  onCommission(handler: (report: CommissionCorrection) => void): () => void {
    this.commissionHandlers.add(handler);
    return () => this.commissionHandlers.delete(handler);
  }

  pacingStats(): PacingStats {
    return this.pacing.stats();
  }

  /**
   * Routes a disconnect to the right recovery path.
   *
   * The branch that matters: IB Gateway's scheduled logout is a **daily,
   * expected** event and must not raise a critical alert, while an unexpected
   * drop must. Both retry identically; only the reporting differs
   * (`stories.md:596`). A system that alerted on both would train its operator
   * to ignore the alert that matters.
   */
  private async handleDisconnect(event: DisconnectEvent): Promise<void> {
    if (event.reason === DisconnectReason.REQUESTED) {
      // A local `disconnect()` — already reflected in health, nothing to retry.
      return;
    }

    if (this.reconnecting) {
      // A flapping socket can emit several drops; one reconnect loop is enough,
      // and a second would spend the retry budget twice as fast.
      return;
    }

    this.reconnecting = true;
    this.setHealth({
      state: ConnectionState.CONNECTING,
      connectedAt: null,
      reconnectAttempts: 0,
      lastError: event.message,
    });

    const scheduled = event.reason === DisconnectReason.SCHEDULED_REAUTH;
    const attempt = () => this.socket.connect();

    try {
      const result = scheduled
        ? await this.reconnectPolicy.reconnectAfterReauth(attempt)
        : await this.reconnectPolicy.reconnect(attempt);

      if (result.outcome === ReconnectOutcome.RECONNECTED) {
        this.setHealth({
          state: ConnectionState.CONNECTED,
          connectedAt: new Date(this.now()).toISOString(),
          reconnectAttempts: result.attempts,
          lastError: null,
        });

        // The pacing window is per-connection: IB counts requests against the
        // session, and a new session starts with an empty budget. Carrying the
        // old window forward would throttle needlessly for ten minutes.
        this.pacing.reset();

        // Staleness is measured from the last bar *received*; a fresh session
        // has not delivered one yet, and keeping the old timestamp would trip
        // the stale check immediately on a reconnect that actually worked.
        const hadDelivered = this.lastBarAtMs !== null;
        this.lastBarAtMs = null;

        // The clock has to keep running from here, or a reconnect that resumes
        // the socket without resuming the feed becomes permanently invisible —
        // a null last-bar would read as startup indefinitely.
        //
        // But it restarts **only for a feed that had actually delivered**. A
        // socket that never produced a bar keeps its original expectation
        // point, because otherwise a socket flapping faster than the threshold
        // resets the deadline on every reconnect and the stale halt is deferred
        // forever — the exact "connected, never delivered, indefinitely" case
        // this timestamp exists to catch. Observed as a feed that reconnected
        // every ~13 minutes against a 15-minute threshold and never tripped.
        if (hadDelivered || this.dataExpectedSinceMs === null) {
          this.dataExpectedSinceMs = this.now();
        }

        // The new session can be lost as silently as the old one was.
        this.startLivenessProbe();

        return;
      }

      // Exhausted. FAILED is what the engine watches for: it halts new entries
      // and raises a critical alert. **Nothing is liquidated** (`PRD.md:316`).
      // The liveness probe stops: it watches a connection we believed in, and
      // we no longer do — re-detecting the same loss would spend a fresh retry
      // budget every tick.
      this.stopLivenessProbe();
      this.setHealth({
        state: ConnectionState.FAILED,
        connectedAt: null,
        reconnectAttempts: result.attempts,
        lastError: result.lastError ?? event.message,
      });

      this.logger.error(
        'IB reconnect exhausted — new entries halted. Existing positions are held, NOT liquidated.',
      );

      // **But FAILED is not the end.** The slow poll takes over from the fast
      // budget, so an outage that outlasts six exponential attempts — IB
      // Gateway's daily restart is routinely one — is still recovered from
      // without an operator restarting the daemon. Entries stay halted until a
      // connection actually returns; this only restores the *ability* to notice.
      this.startFailedRetry();
    } finally {
      this.reconnecting = false;
    }
  }

  private setHealth(health: ConnectionHealth): void {
    this.health = health;
    this.connectionHandlers.forEach((handler) => handler({ ...health }));
  }
}
