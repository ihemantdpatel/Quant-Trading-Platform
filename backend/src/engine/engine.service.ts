/**
 * `EngineService` — the single execution path.
 *
 * Replay fixture → coordinator → strategies → **risk manager** → broker. The
 * ordering is the architecture: strategies emit intents and cannot submit,
 * the risk manager is the only component holding a broker reference, and
 * `architecture.spec.ts` asserts that over module imports.
 *
 * Three behaviours here are load-bearing and easy to get subtly wrong:
 *
 * 1. **Intents are persisted before submission** (`PRD.md:366`). The write
 *    happens before `broker.submit()`, so a crash in between leaves a record
 *    Story 9 can recover from rather than a silent gap.
 * 2. **A technical fault is not a rejection.** A broker that throws (socket
 *    down) halts new entries and raises an alert; **existing positions are
 *    never liquidated** (`PRD.md:316`). A broker that *rejects* an order is
 *    answering, and the engine carries on.
 * 3. **`SHADOW` submits nothing.** `riskManager.canSubmit()` gates every
 *    submission, and in SHADOW it is false by definition — the intent is
 *    logged with its full payload and goes no further.
 *
 * Fills are reconciled back into strategy state, so a resized or rejected
 * order does not leave a phantom lot. The strategy opens lots optimistically
 * at its own limit price because it has no broker to ask; this is the layer
 * that has one.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BROKER_ADAPTER,
  BrokerAdapter,
  BrokerOrder,
  ConnectionState,
  Fill,
  OrderStatus,
} from '../broker/broker-adapter.interface';
import { ExecutionMode } from '../config/execution-mode';
import { ReplayService } from '../market-data/mock/replay.service';
import { Bar } from '../market-data/types';
import { AccountSnapshot, RiskManagerService } from '../risk/risk-manager.service';
import { RiskIntent, RiskOutcome } from '../risk/types';
import { CoordinatorService } from '../strategies/coordinator.service';
import {
  DIP_LADDER_ID_PREFIX,
  DipLadderStrategy,
} from '../strategies/dip-ladder/dip-ladder.strategy';
import { Lot } from '../strategies/dip-ladder/lot';
import { Rung } from '../strategies/dip-ladder/rung';
import { OrderIntent, StrategyState } from '../strategies/types';
import {
  FILL_REPOSITORY,
  FillRepository,
  LOT_REPOSITORY,
  LotRepository,
  ORDER_INTENT_REPOSITORY,
  ORDER_REPOSITORY,
  OrderIntentRepository,
  OrderRepository,
  RUNG_REPOSITORY,
  RungRepository,
  StrategyStateSnapshotRepository,
} from '../repositories/repository.interfaces';
import { SymbolHaltService } from '../reconciliation/symbol-halt.service';

export interface ReplayResult {
  fixture: string;
  barsProcessed: number;
  intentsGenerated: number;
  approved: number;
  resized: number;
  rejected: number;
  /** Orders actually handed to the broker. Always 0 in SHADOW. */
  submitted: number;
  fills: number;
  /** True when a broker fault halted new entries mid-replay. */
  halted: boolean;
  haltReason: string | null;
}

/** An alert an operator must see — surfaced on `GET /status` and the dashboard. */
export interface EngineAlert {
  severity: 'WARNING' | 'CRITICAL';
  code: string;
  detail: string;
  timestamp: string;
}

@Injectable()
export class EngineService {
  private readonly logger = new Logger(EngineService.name);

  /**
   * Set when a technical fault halts new entries. Sticky until an operator
   * clears it — a fault that silently un-halted would resume trading on a
   * connection nobody confirmed was healthy.
   */
  private entryHalt: { reason: string; at: string } | null = null;
  private readonly alerts: EngineAlert[] = [];
  private clientOrderSequence = 0;
  private lastBarTimestamp: string | null = null;

  constructor(
    private readonly replay: ReplayService,
    private readonly coordinator: CoordinatorService,
    private readonly riskManager: RiskManagerService,
    @Inject(BROKER_ADAPTER) private readonly broker: BrokerAdapter,
    @Inject(ORDER_INTENT_REPOSITORY) private readonly intents: OrderIntentRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(FILL_REPOSITORY) private readonly fills: FillRepository,
    @Inject(LOT_REPOSITORY) private readonly lots: LotRepository,
    @Inject(RUNG_REPOSITORY) private readonly rungs: RungRepository,
    private readonly mode: ExecutionMode = ExecutionMode.SHADOW,
    /**
     * Story 9's per-symbol halts. Optional so the many tests that construct an
     * engine directly need not supply one; absent, no symbol is halted, which
     * is the pre-Story-9 behaviour those tests were written against.
     */
    private readonly symbolHalts: SymbolHaltService = new SymbolHaltService(),
    /**
     * Optional for the same reason. When absent the ladder's anchor is not
     * snapshotted — acceptable for a test that never restarts, and the
     * reconciliation suite supplies a real one.
     */
    private readonly snapshots: StrategyStateSnapshotRepository | null = null,
  ) {
    // A broker fault must reach the engine even when no order is in flight —
    // a socket dropping between bars is exactly as significant as one dropping
    // mid-submission.
    this.broker.onConnectionChange((health) => {
      if (health.state === ConnectionState.FAILED) {
        this.haltEntries(`broker connection failed: ${health.lastError ?? 'unknown'}`);
      }
    });
  }

  /**
   * Replays a fixture through the full path.
   *
   * Sequential rather than concurrent by design: bars are ordered and each
   * decision depends on the state the previous bar left. Racing them would make
   * the ladder nondeterministic, which would break every scenario assertion.
   */
  async replayFixture(fixtureName: string): Promise<ReplayResult> {
    const bars = this.replay.getBars(fixtureName);

    const result: ReplayResult = {
      fixture: fixtureName,
      barsProcessed: 0,
      intentsGenerated: 0,
      approved: 0,
      resized: 0,
      rejected: 0,
      submitted: 0,
      fills: 0,
      halted: false,
      haltReason: null,
    };

    for (const bar of bars) {
      const barResult = await this.processBar(bar);

      result.barsProcessed += 1;
      result.intentsGenerated += barResult.intentsGenerated;
      result.approved += barResult.approved;
      result.resized += barResult.resized;
      result.rejected += barResult.rejected;
      result.submitted += barResult.submitted;
      result.fills += barResult.fills;
    }

    await this.persistLadderState();

    result.halted = this.entryHalt !== null;
    result.haltReason = this.entryHalt?.reason ?? null;

    return result;
  }

  /**
   * One bar through the whole path. The unit Story 10 will call from a live
   * bar subscription instead of from a fixture loop.
   */
  async processBar(bar: Bar): Promise<Omit<ReplayResult, 'fixture' | 'barsProcessed'>> {
    this.lastBarTimestamp = bar.timestamp;

    const outcome = {
      intentsGenerated: 0,
      approved: 0,
      resized: 0,
      rejected: 0,
      submitted: 0,
      fills: 0,
      halted: this.entryHalt !== null,
      haltReason: this.entryHalt?.reason ?? null,
    };

    // **A reconciliation halt blocks the symbol entirely — before the strategy
    // is even asked** (`PRD.md:329`).
    //
    // Returning here rather than filtering intents afterwards is deliberate:
    // `onBar` mutates ladder state as a side effect of deciding (it opens lots
    // and re-arms rungs), so dispatching and then discarding would advance the
    // ladder's own view of a position nobody has verified. The halted symbol
    // must be *not evaluated*, not merely not submitted.
    //
    // This is stricter than `entryHalt`, which still permits exits. Here exits
    // are exactly the danger: FIFO would pick a lot from records that disagree
    // with the broker, selling the wrong lot at the wrong target
    // (`PRD.md:347`). Positions are held, untouched, until an operator resolves
    // the mismatch — never liquidated to make the numbers agree.
    if (this.symbolHalts.isHalted(bar.symbol)) {
      return outcome;
    }

    const intents = this.coordinator.dispatchBar(bar);
    outcome.intentsGenerated = intents.length;

    if (intents.length === 0) {
      return outcome;
    }

    const account = await this.accountSnapshot();

    // Evaluated as a batch against a *running* capital total: five rungs firing
    // on one bar must not each be measured against the same starting headroom
    // (`risk-manager.service.ts:107`).
    const decisions = this.riskManager.evaluateBatch(intents.map(toRiskIntent), account);

    for (let i = 0; i < decisions.length; i += 1) {
      const decision = decisions[i];
      const intent = intents[i];

      if (decision.outcome === RiskOutcome.APPROVED) outcome.approved += 1;
      if (decision.outcome === RiskOutcome.RESIZED) outcome.resized += 1;
      if (decision.outcome === RiskOutcome.REJECTED) outcome.rejected += 1;

      // Persisted *before* any submission attempt (`PRD.md:366`).
      const recordId = `intent-${bar.timestamp}-${i}`;
      await this.intents.save({
        id: recordId,
        intent,
        decision,
        submitted: false,
        clientOrderId: null,
        createdAt: bar.timestamp,
      });

      if (decision.approvedQuantity <= 0) {
        continue;
      }

      if (!this.riskManager.canSubmit()) {
        // SHADOW, kill switch, or breaker halt. The payload was already logged
        // by the risk manager; nothing goes to a broker.
        continue;
      }

      if (this.entryHalt && intent.side === 'BUY') {
        // A technical fault halts *new entries*. Exits are deliberately still
        // permitted — halting a sell would trap a position the strategy has
        // already decided to close.
        continue;
      }

      const submission = await this.submitOrder(intent, decision.approvedQuantity, recordId);
      outcome.submitted += submission.submitted ? 1 : 0;
      outcome.fills += submission.fills;
    }

    outcome.halted = this.entryHalt !== null;
    outcome.haltReason = this.entryHalt?.reason ?? null;

    return outcome;
  }

  /**
   * Submits one approved intent.
   *
   * Distinguishes the two failure kinds that matter:
   * - **throw** → technical fault → halt new entries, alert, positions untouched
   * - **REJECTED ack** → the broker answered → record it and carry on
   */
  private async submitOrder(
    intent: OrderIntent,
    quantity: number,
    recordId: string,
  ): Promise<{ submitted: boolean; fills: number }> {
    this.clientOrderSequence += 1;
    const clientOrderId = `co-${this.clientOrderSequence}`;

    const order: BrokerOrder = {
      clientOrderId,
      contract: intent.contract,
      side: intent.side,
      quantity,
      orderType: intent.orderType,
      limitPrice: intent.limitPrice,
      timeInForce: intent.timeInForce,
      timestamp: intent.timestamp,
    };

    await this.orders.save({
      clientOrderId,
      brokerOrderId: null,
      symbol: intent.contract.symbol,
      side: intent.side,
      quantity,
      limitPrice: intent.limitPrice,
      status: OrderStatus.SUBMITTED,
      rejectReason: null,
      strategyId: intent.strategyId,
      createdAt: intent.timestamp,
    });
    await this.intents.markSubmitted(recordId, clientOrderId);

    let fills = 0;
    const unsubscribe = this.broker.onFill((fill) => {
      if (fill.clientOrderId === clientOrderId) {
        fills += 1;
        void this.fills.save(fill);
        void this.applyFill(fill, intent);
      }
    });

    try {
      const ack = await this.broker.submit(order);

      await this.orders.updateStatus(clientOrderId, ack.status, ack.rejectReason);

      if (ack.status === OrderStatus.REJECTED) {
        this.raiseAlert(
          'WARNING',
          'ORDER_REJECTED',
          `broker rejected ${clientOrderId}: ${ack.rejectReason ?? 'no reason given'}`,
          intent.timestamp,
        );
      }

      return { submitted: true, fills };
    } catch (error) {
      // Technical fault. Halt new entries; liquidate nothing.
      const detail = error instanceof Error ? error.message : String(error);
      this.haltEntries(`order submission failed: ${detail}`, intent.timestamp);
      await this.orders.updateStatus(clientOrderId, OrderStatus.CANCELLED, detail);

      return { submitted: false, fills };
    } finally {
      unsubscribe();
    }
  }

  /**
   * Reconciles a broker fill back into strategy state.
   *
   * The strategy opened its lot optimistically at the rung price; the broker
   * decides the real fill price and quantity. Correcting it here is what keeps
   * a resized order from leaving a lot claiming shares that were never bought.
   *
   * **The exit target is recomputed from the corrected fill price**, because a
   * lot's target is defined as a percentage of what *that lot actually paid*
   * (`PRD.md:129`), and a lot filled at a different price has a different
   * target.
   */
  private async applyFill(fill: Fill, intent: OrderIntent): Promise<void> {
    const strategyId = intent.strategyId;
    const state = this.coordinator.getState(strategyId);

    // Only the ladder keeps lots. A fill for any other strategy is recorded in
    // the fill repository and needs no lot correction.
    if (!state || !strategyId.startsWith(DIP_LADDER_ID_PREFIX)) {
      return;
    }

    const lots = DipLadderStrategy.lotsOf(state) ?? [];

    if (fill.side === 'BUY') {
      // The most recently opened lot at this rung is the one this fill belongs
      // to — the strategy opened it on the bar that produced this intent.
      const rungPrice = intent.metadata?.rungPrice as number | undefined;
      const lot = [...lots]
        .reverse()
        .find((candidate) => candidate.rungPrice === rungPrice && candidate.status === 'HELD');

      if (lot) {
        const takeProfit = (lot.exitTarget - lot.fillPrice) / lot.fillPrice;
        lot.fillPrice = fill.price;
        lot.quantity = fill.quantity;
        lot.exitTarget = Math.round(fill.price * (1 + takeProfit) * 100) / 100;
      }

      return;
    }

    const lotId = intent.metadata?.lotId as string | undefined;
    const lot = lots.find((candidate) => candidate.id === lotId);

    if (lot) {
      lot.exitPrice = fill.price;
    }
  }

  /**
   * Persists the ladder's state to the repositories the API reads from.
   *
   * Ladder instances only — a scaffold carries no lots or rungs, and writing
   * its `undefined` state would clear the ladder's own records for the symbol.
   */
  private async persistLadderState(): Promise<void> {
    for (const snapshot of this.coordinator.snapshots()) {
      if (!snapshot.state || !snapshot.id.startsWith(DIP_LADDER_ID_PREFIX)) {
        continue;
      }

      const symbol = snapshot.symbols[0];

      if (!symbol) {
        continue;
      }

      // A halted symbol's live state was never restored and its ladder is
      // empty; writing that over the persisted lots would destroy the very
      // records an operator needs to resolve the mismatch.
      if (this.symbolHalts.isHalted(symbol)) {
        continue;
      }

      await this.lots.saveAll(DipLadderStrategy.lotsOf(snapshot.state) ?? [], symbol);
      await this.rungs.saveAll(DipLadderStrategy.rungsOf(snapshot.state) ?? [], symbol);

      // The anchor scalars, which lots and rungs do not carry. Written after
      // them so a crash between the two leaves the authoritative composition
      // saved and only the anchor stale — recoverable, where the reverse would
      // leave an anchor describing lots that were never written.
      await this.snapshots?.save({
        strategyId: snapshot.id,
        version: snapshot.state.version,
        symbols: snapshot.symbols,
        data: snapshot.state.data as unknown as Record<string, unknown>,
        capturedAt: this.lastBarTimestamp ?? new Date().toISOString(),
      });
    }
  }

  /**
   * The account state the risk controls are evaluated against.
   *
   * Sourced fresh from the broker rather than cached, so the 60% global cap is
   * measured against real equity. Falls back to a zero snapshot when the broker
   * is unreachable — with equity unknown, the cap rejects everything, which is
   * the safe direction.
   */
  private async accountSnapshot(): Promise<AccountSnapshot> {
    const deployed = { total: 0, bySymbol: {}, byStrategy: {} };

    try {
      const positions = await this.broker.getPositions();

      for (const position of positions) {
        const notional = position.quantity * position.averageCost;
        deployed.total += notional;
        (deployed.bySymbol as Record<string, number>)[position.symbol] = notional;
      }
    } catch {
      // Unreachable broker: report nothing deployed rather than guessing. The
      // entry halt raised elsewhere is what actually stops submission.
    }

    return { deployed, pnl: { realized: 0, unrealized: 0 } };
  }

  private haltEntries(reason: string, at?: string): void {
    if (this.entryHalt) {
      return;
    }

    const timestamp = at ?? this.lastBarTimestamp ?? '1970-01-01T00:00:00.000Z';
    this.entryHalt = { reason, at: timestamp };

    this.raiseAlert('CRITICAL', 'ENTRY_HALT', reason, timestamp);
    this.logger.error(
      `new entries halted — ${reason}. Existing positions are held, not liquidated.`,
    );
  }

  private raiseAlert(
    severity: EngineAlert['severity'],
    code: string,
    detail: string,
    timestamp: string,
  ): void {
    this.alerts.push({ severity, code, detail, timestamp });
  }

  /**
   * Halts new entries on a technical fault raised outside the submission path.
   *
   * Story 10's live feed calls this when market data goes stale — a fault the
   * engine cannot detect for itself, because it only ever sees bars that *did*
   * arrive (`live-feed.service.ts`). Exits stay permitted, exactly as with a
   * broker fault: halting a sell would trap a position the strategy has already
   * decided to close, and **nothing here liquidates anything**.
   */
  haltEntriesForFault(reason: string): void {
    this.haltEntries(reason);
  }

  /** Operator action: clears a technical halt. Never happens on a timer. */
  clearHalt(): void {
    this.entryHalt = null;
  }

  isHalted(): boolean {
    return this.entryHalt !== null;
  }

  haltReason(): string | null {
    return this.entryHalt?.reason ?? null;
  }

  activeAlerts(): EngineAlert[] {
    return [...this.alerts];
  }

  currentMode(): ExecutionMode {
    return this.mode;
  }

  /**
   * Ladder state as the API serves it, read from strategy state.
   *
   * Filtered to ladder instances. Every registered strategy has a
   * `StrategyState`, but only the ladder's `data` carries lots and rungs — a
   * scaffold's is `{ gridLevels: [] }`. Reading `lots` off one of those yields
   * `undefined`, so enabling a scaffold would otherwise break `GET /lots` for
   * the ladder too.
   */
  ladderLots(): Lot[] {
    return this.ladderStates().flatMap((state) => DipLadderStrategy.lotsOf(state) ?? []);
  }

  ladderRungs(): Rung[] {
    return this.ladderStates().flatMap((state) => DipLadderStrategy.rungsOf(state) ?? []);
  }

  private ladderStates(): StrategyState[] {
    return this.coordinator
      .snapshots()
      .filter((snapshot) => snapshot.id.startsWith(DIP_LADDER_ID_PREFIX) && snapshot.state)
      .map((snapshot) => snapshot.state!);
  }

  /** True when a reconciliation mismatch has halted this symbol (Story 9). */
  isSymbolHalted(symbol: string): boolean {
    return this.symbolHalts.isHalted(symbol);
  }

  async reset(): Promise<void> {
    this.entryHalt = null;
    this.alerts.length = 0;
    this.clientOrderSequence = 0;
    await this.intents.clear();
    await this.orders.clear();
    await this.fills.clear();
    await this.lots.clear();
    await this.rungs.clear();
    await this.snapshots?.clear();
    // Symbol halts are deliberately **not** cleared here. `POST /engine/reset`
    // returns the engine to a known state for the next replay; it is not a way
    // to dismiss an unresolved reconciliation mismatch. Releasing a halt is a
    // separate, explicit operator action.
  }
}

/**
 * Maps the shared `OrderIntent` onto the risk layer's `RiskIntent`.
 *
 * The two types are deliberately separate: the risk manager sits above every
 * strategy and must not depend on the strategy vocabulary (`risk/types.ts:5`).
 * This mapping is the seam, and it is mechanical exactly as planned.
 */
export function toRiskIntent(intent: OrderIntent): RiskIntent {
  return {
    strategyId: intent.strategyId,
    symbol: intent.contract.symbol,
    side: intent.side,
    quantity: intent.quantity,
    limitPrice: intent.limitPrice,
    timestamp: intent.timestamp,
    reason: intent.reason,
  };
}
