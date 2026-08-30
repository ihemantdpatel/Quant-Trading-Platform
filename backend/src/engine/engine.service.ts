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
  OpenOrder,
  OrderAck,
  OrderStatus,
} from '../broker/broker-adapter.interface';
import { ExecutionMode } from '../config/execution-mode';
import { Contract, equityContract } from '../domain/contract';
import { ReplayService } from '../market-data/mock/replay.service';
import { Bar } from '../market-data/types';
import { AccountSnapshot, RiskManagerService } from '../risk/risk-manager.service';
import { RiskIntent, RiskOutcome } from '../risk/types';
import { CoordinatorService } from '../strategies/coordinator.service';
import { DipLadderConfig, OrderPlacement } from '../strategies/dip-ladder/config';
import {
  DIP_LADDER_ID_PREFIX,
  DipLadderStrategy,
} from '../strategies/dip-ladder/dip-ladder.strategy';
import { isRestable, isRestableExit } from '../strategies/dip-ladder/ladder';
import { Lot } from '../strategies/dip-ladder/lot';
import { Rung } from '../strategies/dip-ladder/rung';
import { OrderIntent, OrderType, StrategyState, TimeInForce } from '../strategies/types';
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

/**
 * A gap an operator asked to be filled.
 *
 * Deliberately not the diagnosis type: this carries only what is needed to
 * build an intent, so nothing about the *finding* (which rung was unbacked,
 * which order was orphaned) can leak into a decision to trade. The placement
 * path re-derives its own candidates and never trusts a caller's quantity for
 * an entry — see `placeMissingOrders`.
 */
export interface MissingOrderCandidate {
  strategyId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  limitPrice: number;
  reason: string;
  lotId: string | null;
}

export interface PlacementResult {
  placed: {
    candidate: MissingOrderCandidate;
    /** What the risk manager approved, which may be less than requested. */
    quantity: number;
    resized: boolean;
  }[];
  /** Every candidate not placed, each with the reason it was refused. */
  declined: { candidate: MissingOrderCandidate; reason: string }[];
}

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

/**
 * An alert an operator must see — surfaced on `GET /status` and the dashboard.
 *
 * ## Why `resolvedAt` exists
 *
 * Alerts divide into two kinds, and conflating them made a recovered engine
 * look permanently broken. A rejection (`ORDER_REJECTED`) is a point-in-time
 * event: it happened, it is over, and there is nothing left to recover from.
 * An `ENTRY_HALT` reports an *ongoing condition* — and that condition ends,
 * either because a bar proved the feed recovered or because an operator
 * cleared it.
 *
 * Without a way to express "this ended", the halt alert outlived the halt.
 * `entryHalt.halted` went back to `false` while the alert row stayed in the
 * list forever, so the dashboard rendered three nights of long-since-recovered
 * staleness halts as though the engine were still down. That also broke the
 * standing rule that no fault may latch with no way out: the halt had an exit,
 * its alert did not, and the only thing that emptied the list was
 * `engine.reset()` — which discards ladder state and is not a way to dismiss a
 * banner.
 *
 * `null` means still active. A timestamp means the condition ended at that
 * point, and the row survives as history rather than as a live warning.
 */
export interface EngineAlert {
  severity: 'WARNING' | 'CRITICAL';
  code: string;
  detail: string;
  timestamp: string;
  /**
   * When the reported condition ended, or `null` while it still holds.
   *
   * Only alerts that *track* a condition are ever resolved. A point-in-time
   * event is born with this `null` and keeps it: there is no moment at which a
   * past rejection stops having happened, and stamping one "resolved" would
   * claim a recovery nothing observed.
   */
  resolvedAt: string | null;
}

/**
 * Why new entries are halted.
 *
 * The distinction that matters is **which faults can prove themselves over**.
 * `STALE_DATA` can: a bar arriving is direct positive evidence that the exact
 * condition — no bars — has ended. Nothing else here has an equivalent. A
 * broker that reconnects has not shown its positions still reconcile, and a
 * submission that failed once says nothing about the next one. Those stay
 * latched until an operator says otherwise.
 */
export enum EntryHaltCode {
  /** Market data stopped arriving. Self-clears when it resumes. */
  STALE_DATA = 'STALE_DATA',
  /** The broker connection failed. Operator-cleared only. */
  BROKER_CONNECTION = 'BROKER_CONNECTION',
  /** An order could not be submitted or cancelled. Operator-cleared only. */
  ORDER_FAULT = 'ORDER_FAULT',
}

/**
 * A resting entry order this engine is waiting on, keyed by `clientOrderId`.
 *
 * `rungPrice` is the reason this exists: a fill carries only broker vocabulary
 * and nothing identifying which rung placed the order, so the link between the
 * two is kept here between placement and fill.
 */
/**
 * An order resting at the broker that this engine placed.
 *
 * `kind` discriminates the two directions, because a fill means opposite things
 * for each: an ENTRY fill opens a lot at `rungPrice`, an EXIT fill closes the
 * lot named by `lotId`. Without the discriminant a sell fill would be routed
 * into `openLotFromFill` and *double* the position it was meant to reduce.
 */
type WorkingOrder = {
  strategyId: string;
  rungPrice: number;
  quantity: number;
  symbol: string;
} & ({ kind: 'ENTRY'; lotId?: undefined } | { kind: 'EXIT'; lotId: string });

/**
 * What the broker says is already resting, resolved once per bar.
 *
 * `UNAVAILABLE` is a distinct state rather than an empty set on purpose: "the
 * broker could not be asked" and "nothing is resting" lead to opposite actions,
 * and collapsing them would place an order at a level that may already hold one.
 * The same distinction `getOpenOrders()` throwing carries in reconciliation.
 */
type RestingOrderSnapshot =
  | {
      status: 'OK';
      /** Prices of resting BUYs — the levels an entry must not duplicate. */
      limitPrices: Set<number>;
      /**
       * Resting SELLs, as the broker reports them.
       *
       * Carried in full rather than as a set of ids because the exit guard
       * matches on price *and* quantity: the in-memory `Lot.workingOrderId` is
       * precisely the fact that can be stale when a duplicate arises, so it
       * cannot be the thing the guard consults.
       */
      sells: { clientOrderId: string; limitPrice: number; quantity: number }[];
    }
  | { status: 'UNAVAILABLE'; reason: string };

/**
 * How many alerts are retained.
 *
 * Generous enough to cover a soak week's worth of overnight staleness halts,
 * bounded so a daemon left running for months cannot grow this without limit.
 * Only ever trims *resolved* alerts — see `raiseAlert`.
 */
const MAX_ALERT_HISTORY = 200;

/**
 * Rounds to cents, so a price from the broker and one from the ladder compare
 * equal. Both are cent-denominated already; this only removes the float noise
 * that would make `73.91 !== 73.910000000000004` and defeat the whole check.
 */
function roundPrice(value: number): number {
  return Math.round(value * 100) / 100;
}

@Injectable()
export class EngineService {
  private readonly logger = new Logger(EngineService.name);

  /**
   * Set when a technical fault halts new entries.
   *
   * Sticky until an operator clears it, with **one exception**: a halt raised
   * because market data went stale clears itself when a bar actually arrives.
   * See `clearStaleHalt`. Every other cause stays latched — a fault that
   * silently un-halted would resume trading on a connection nobody confirmed
   * was healthy.
   *
   * `code` is what makes that distinction expressible. Without it the only
   * thing distinguishing a stale-data halt from a broker-failure halt was
   * English prose in `reason`, and self-clearing on a substring match would be
   * one reworded log line away from resuming trading against a dead broker.
   */
  private entryHalt: { reason: string; at: string; code: EntryHaltCode } | null = null;
  /**
   * Every alert raised this process, newest last — active and resolved alike.
   *
   * Bounded by `MAX_ALERT_HISTORY`. This is a long-lived daemon and an
   * unbounded array that only `reset()` empties is a slow leak; resolved rows
   * are evicted first so a trimmed history never drops an alert that is still
   * reporting a live condition.
   */
  private readonly alerts: EngineAlert[] = [];
  /**
   * High-water mark behind `co-N` client order ids.
   *
   * **Restored from persisted orders at startup, never assumed to be zero.** A
   * restart leaves the `Order` table intact while this counter restarts, so a
   * fresh process re-issues `co-1` for an id the previous one already used.
   * Both repositories *upsert* on `clientOrderId`, so the collision does not
   * error — it silently overwrites the earlier order's row, and a fill arriving
   * for either order then resolves to the wrong one. That is how a 69.00 limit
   * came to carry a 73.18 fill and open a phantom lot the lot-sum assertion
   * later halted on.
   *
   * `reset()` may still return this to zero: it clears the order table in the
   * same call, so there is nothing left to collide with.
   */
  private clientOrderSequence = 0;
  private lastBarTimestamp: string | null = null;

  /**
   * Distinguishes operator-placed intent records from bar-placed ones.
   *
   * Separate from `clientOrderSequence` because these records are created
   * outside a bar and their ids must not collide with `intent-<barTs>-<i>`,
   * which is unique only within one bar.
   */
  private operatorIntentSequence = 0;

  /**
   * Close of the most recent bar, or null before any has arrived.
   *
   * Held for the operator placement path (`placeMissingOrders`), which has no
   * bar of its own and still must honour `isRestable`/`isRestableExit` — a
   * limit placed on the wrong side of the market is marketable, and a
   * marketable order into a 3x ETF book is a fill price the ladder must then
   * hold with no stop underneath it. A null close means *no* placement is
   * allowed rather than an unguarded one: with no reference price there is
   * nothing to prove the order would rest.
   */
  private lastBarClose: number | null = null;

  /**
   * Orders currently resting at the broker, keyed by `clientOrderId`.
   *
   * Needed because a fill arrives carrying only broker vocabulary — symbol,
   * price, quantity — and nothing that identifies which rung placed it. The
   * ladder's `rungPrice` is the missing link, and this is where it is kept
   * between placement and fill.
   *
   * In-memory, and deliberately not the source of truth: the durable record is
   * `Rung.workingOrderId`, which survives a restart. This map is rebuilt from
   * the rung ledger during reconciliation, so a crash between placement and
   * fill does not orphan the order.
   */
  private readonly workingOrders = new Map<string, WorkingOrder>();

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
    private readonly mode: ExecutionMode = ExecutionMode.PAPER,
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
        this.haltEntries(
          `broker connection failed: ${health.lastError ?? 'unknown'}`,
          EntryHaltCode.BROKER_CONNECTION,
        );
      }
    });

    // **Subscribed once, for the life of the process.**
    //
    // `submitOrder` also subscribes for the duration of a single `submit()`
    // call, which suffices only while every order fills immediately. A resting
    // limit order fills minutes or hours later, long after that subscription
    // was torn down in its `finally` — so without this router the fill would
    // arrive with no listener, the lot would never open, and the ladder would
    // believe a level it actually owns is still empty.
    this.broker.onFill((fill) => {
      void this.routeFill(fill);
    });

    // Cancellations, rejections, and DAY expiries all arrive here. A rung whose
    // order went away without filling must be released, or the level stays
    // blocked forever and the ladder never places another order there.
    this.broker.onOrderStatus((ack) => {
      void this.routeOrderStatus(ack);
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
    this.lastBarClose = bar.close;

    // Before the outcome is snapshotted below, so the bar that proves the feed
    // recovered is itself allowed to trade. Deferring to the *next* bar would
    // discard a live evaluation for no added safety — this bar is the evidence.
    // No-op unless the halt was raised by staleness; see `clearStaleHalt`.
    this.clearStaleHalt();

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

    // **Resting orders settle before the strategy sees the bar.**
    //
    // An order placed on an earlier bar is filled by the exchange the moment
    // price reaches it, so by the time the ladder evaluates this bar those
    // fills have already happened. Advancing afterwards would let the strategy
    // decide against a position it does not yet know it holds — and would let a
    // lot be re-selected for an exit whose order had in fact already filled.
    //
    // Only the mock needs telling; a real broker has its own market. The check
    // is structural rather than a mode flag: an adapter that models a market is
    // the one that exposes a way to move it.
    this.advanceSimulatedMarket(bar.close, bar.timestamp);

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

    // Resolved lazily on the first resting entry this bar, then reused. A bar
    // that places nothing must not pay an IB round trip.
    let restingSnapshot: RestingOrderSnapshot | null = null;

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

      // **Duplicate guard: ask the broker what is already resting.**
      //
      // `workingOrders` is in-memory and can disagree with IB — a crash between
      // placement and persistence, an order adopted by reconciliation, a fill
      // router that has not yet run. Placing a second order at a price that
      // already holds one is the failure that costs real money, because both
      // can fill. Resolved once per bar and reused across its intents, so a bar
      // firing several rungs pays one round trip rather than one per rung.
      if (this.isRestingEntry(intent)) {
        const resting = await this.restingOrdersThisBar(restingSnapshot);
        restingSnapshot = resting;

        if (resting.status === 'UNAVAILABLE') {
          // "Cannot ask" is not "nothing is resting" — the same rule that stops
          // reconciliation releasing every WORKING rung when `getOpenOrders`
          // throws. Skipping costs one rung this bar; assuming the level is
          // clear risks a duplicate order at a price that already has one. The
          // next bar retries, so a transient hiccup self-heals.
          this.logger.warn(
            `skipping entry at ${intent.limitPrice.toFixed(2)} — cannot read open orders: ${resting.reason}`,
          );
          continue;
        }

        if (resting.limitPrices.has(roundPrice(intent.limitPrice))) {
          this.logger.debug(
            `skipping entry at ${intent.limitPrice.toFixed(2)} — an order already rests there`,
          );
          continue;
        }
      }

      // **The same duplicate guard, for exits.**
      //
      // `Lot.workingOrderId` is the in-memory answer to "is this lot already
      // covered", and `selectRestingExits` filters on it — but it can disagree
      // with IB in exactly the ways the entry guard exists for: a crash between
      // placement and persistence, an order adopted by reconciliation, a fill
      // router that has not yet run. A second sell against a lot that already
      // has one resting is the failure that costs real money here, because both
      // can fill and the position is sold twice.
      if (this.isRestingExit(intent)) {
        const resting = await this.restingOrdersThisBar(restingSnapshot);
        restingSnapshot = resting;

        if (resting.status === 'UNAVAILABLE') {
          this.logger.warn(
            `skipping exit for lot ${String(intent.metadata?.lotId)} — cannot read open orders: ` +
              resting.reason,
          );
          continue;
        }

        const covered = this.restingSellIdFor(intent, decision.approvedQuantity, resting.sells);

        if (covered) {
          this.logger.debug(
            `skipping exit for lot ${String(intent.metadata?.lotId)} — order ${covered} already rests`,
          );
          continue;
        }
      }

      const submission = await this.submitOrder(intent, decision.approvedQuantity, recordId);
      outcome.submitted += submission.submitted ? 1 : 0;
      outcome.fills += submission.fills;

      // The order just placed is now resting too. Recording it keeps a later
      // intent on this same bar from stacking a second order at that price
      // without re-querying IB.
      if (submission.submitted && restingSnapshot?.status === 'OK') {
        restingSnapshot.limitPrices.add(roundPrice(intent.limitPrice));
      }
    }

    // **Persist after submission, because a working-order id is durable state.**
    //
    // `Lot.workingOrderId` and `Rung.workingOrderId` are written by the submit
    // path, and nothing else on this bar writes them: fills and order statuses
    // persist, but a bar that merely *places* orders did not. A crash in that
    // window left the database holding a lot with no working order while a live
    // sell rested at IB — so on restart the lot looked unprotected, a second
    // sell was placed against it, and both could fill. That is the crash window
    // Story 13 closed for entries, and it was reopened on the exit side.
    if (outcome.submitted > 0) {
      await this.persistLadderState();
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

    // A resting order is registered *before* submission so a fill arriving
    // between the broker's ack and this bookkeeping still finds its rung. The
    // router ignores ids it does not know, and an order that fails to submit is
    // unregistered below, so registering early cannot leave a phantom.
    const resting = this.isRestingOrder(intent);
    const exitLotId = intent.metadata?.lotId as string | undefined;

    if (resting && intent.side === 'SELL' && exitLotId) {
      this.workingOrders.set(clientOrderId, {
        kind: 'EXIT',
        lotId: exitLotId,
        strategyId: intent.strategyId,
        rungPrice: intent.metadata?.rungPrice as number,
        quantity,
        symbol: intent.contract.symbol,
      });

      // Marked before `submit()` for the same reason a rung is: a marketable
      // sell can fill *during* the call, and marking afterwards would let the
      // fill land first, close the lot, and then be overwritten by a working-id
      // for an order that had already completed. Rejection and submission
      // failure both undo it below.
      const state = this.coordinator.getState(intent.strategyId);

      if (state) {
        DipLadderStrategy.recordWorkingExit(state, exitLotId, clientOrderId);
      }
    } else if (resting && intent.side === 'BUY') {
      this.workingOrders.set(clientOrderId, {
        kind: 'ENTRY',
        strategyId: intent.strategyId,
        rungPrice: intent.limitPrice,
        quantity,
        symbol: intent.contract.symbol,
      });

      // **The rung is marked WORKING before `submit()`, not after.**
      //
      // A marketable limit order can fill *during* the submit call — the mock
      // broker does exactly this, and IB will too when price is already through
      // the level. Marking afterwards would let the fill arrive first, find no
      // rung to attach its lot to, and then be overwritten by a WORKING mark
      // for an order that had already completed.
      //
      // Rejection and submission failure both undo this below, so a rung is
      // never left blocked for an order that does not exist.
      const state = this.coordinator.getState(intent.strategyId);

      if (state) {
        DipLadderStrategy.recordWorkingOrder(state, intent.limitPrice, clientOrderId);
      }
    }

    let fills = 0;
    const unsubscribe = resting
      ? // A resting order's fills belong to the persistent router, which lives
        // beyond this call. Subscribing here as well would open the lot twice.
        (): void => undefined
      : this.broker.onFill((fill) => {
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
        // Nothing is resting, so release the rung the pre-submit mark blocked.
        this.releaseRestingOrder(clientOrderId, intent.strategyId, resting);

        this.raiseAlert(
          'WARNING',
          'ORDER_REJECTED',
          `broker rejected ${clientOrderId}: ${ack.rejectReason ?? 'no reason given'}`,
          intent.timestamp,
        );

        return { submitted: true, fills };
      }

      return { submitted: true, fills };
    } catch (error) {
      // Technical fault. Halt new entries; liquidate nothing.
      const detail = error instanceof Error ? error.message : String(error);
      this.haltEntries(
        `order submission failed: ${detail}`,
        EntryHaltCode.ORDER_FAULT,
        intent.timestamp,
      );
      await this.orders.updateStatus(clientOrderId, OrderStatus.CANCELLED, detail);

      // The order never reached the broker, so nothing is resting — drop the
      // registration and unblock the rung rather than leaving a level reserved
      // for an order that does not exist.
      this.releaseRestingOrder(clientOrderId, intent.strategyId, resting);

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
   * The prices at which orders are already resting at the broker, this bar.
   *
   * Fetched once and reused: the answer cannot change between two intents on
   * the same bar in any way this engine could act on, and a round trip per rung
   * would put IB's latency on the critical path five times over.
   *
   * A failure is returned rather than thrown so the caller can decline the
   * entry without halting — an unreadable broker is a reason to place nothing
   * this bar, not a technical fault that stops the session.
   */
  private async restingOrdersThisBar(
    cached: RestingOrderSnapshot | null,
  ): Promise<RestingOrderSnapshot> {
    if (cached) {
      return cached;
    }

    try {
      const open = await this.broker.getOpenOrders();

      return {
        status: 'OK',
        // Buys only: a resting sell is an exit against a lot the ladder already
        // holds, and it sits at a take-profit target that has nothing to do with
        // whether an entry rung is free. Matching one would block a legitimate
        // entry at a coincidentally equal price.
        limitPrices: new Set(
          open.filter((order) => order.side === 'BUY').map((order) => roundPrice(order.limitPrice)),
        ),
        sells: open
          .filter((order) => order.side === 'SELL')
          .map((order) => ({
            clientOrderId: order.clientOrderId,
            limitPrice: order.limitPrice,
            // The *outstanding* quantity: a partially filled sell still resting
            // covers only what is left of it.
            quantity: order.quantity - order.filledQuantity,
          })),
      };
    } catch (error) {
      return {
        status: 'UNAVAILABLE',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Rebuilds the working-order registry from orders the broker actually holds.
   *
   * Called by reconciliation at startup. The registry is in-memory and empty
   * after a restart, so without this a fill on an order placed *before* the
   * restart would arrive with no rung to attach it to — the shares would exist
   * at the broker and the ladder would never open a lot for them.
   */
  adoptWorkingOrders(strategyId: string, symbol: string, orders: OpenOrder[]): void {
    const state = this.coordinator.getState(strategyId);
    const lots = state ? (DipLadderStrategy.lotsOf(state) ?? []) : [];

    for (const order of orders) {
      // The *outstanding* quantity, not the original: a partially-filled order
      // that survives a restart has only its remainder still working, and the
      // partial-fill rule must compare against what can still fill.
      const quantity = order.quantity - order.filledQuantity;

      if (order.side === 'SELL') {
        // A resting sell is keyed to the lot it disposes, not to a price level,
        // and `Lot.workingOrderId` is the durable record of that pairing. An
        // order no lot claims is left unadopted rather than guessed at: it is
        // not something this ladder placed as an exit, and attaching it to a
        // lot chosen by price would sell shares against the wrong basis.
        const lot = lots.find((candidate) => candidate.workingOrderId === order.clientOrderId);

        if (lot) {
          this.workingOrders.set(order.clientOrderId, {
            kind: 'EXIT',
            lotId: lot.id,
            strategyId,
            rungPrice: lot.rungPrice,
            quantity,
            symbol,
          });
        }

        continue;
      }

      this.workingOrders.set(order.clientOrderId, {
        kind: 'ENTRY',
        strategyId,
        rungPrice: order.limitPrice,
        quantity,
        symbol,
      });
    }
  }

  /**
   * Rebuilds one working-order entry from durable records when the in-memory
   * map has no answer.
   *
   * **The map is not the source of truth, and this is the case that proves it.**
   * `adoptWorkingOrders` repopulates it at startup from `getOpenOrders()` — but
   * an order that filled *while the process was down* is no longer an open
   * order, so it is absent from that list. The fill then arrives on IB's
   * execution replay, finds nothing in the map, and `routeFill` drops it: the
   * shares exist at the broker and no lot is ever opened for them. The next
   * reconciliation compares zero lots against a real position and halts the
   * symbol, which is how a recoverable gap became an operator's problem.
   *
   * The durable record is sufficient to close it. `Order` carries the strategy,
   * symbol, and limit price; `Rung.workingOrderId` ties that order to the level
   * that placed it. The rung is consulted rather than trusting the order alone,
   * because `rungPrice` is what the lot must be keyed to and only the ladder
   * knows it — the order's limit price is the placement price, which is the
   * same value but arrived at from the side that owns the fact.
   *
   * Deliberately narrow: BUY entries only, and only for an order the ladder
   * still has a `WORKING` rung for. A SELL, or an order no rung claims, is not
   * something this engine placed as an entry, and inventing a rung for it would
   * attach a lot to a level the ladder never chose.
   */
  private async recoverWorkingOrder(clientOrderId: string): Promise<WorkingOrder | null> {
    const order = await this.orders.findByClientOrderId(clientOrderId);

    if (!order || order.side !== 'BUY') {
      return null;
    }

    const state = this.coordinator.getState(order.strategyId);

    if (!state) {
      return null;
    }

    const rung = DipLadderStrategy.rungsOf(state).find(
      (candidate) => candidate.workingOrderId === clientOrderId,
    );

    if (!rung) {
      return null;
    }

    const recovered: WorkingOrder = {
      kind: 'ENTRY',
      strategyId: order.strategyId,
      rungPrice: rung.price,
      quantity: order.quantity,
      symbol: order.symbol,
    };

    // Registered so the rest of the fill path — and a partial fill's cancel —
    // behave exactly as they would for an order placed in this process.
    this.workingOrders.set(clientOrderId, recovered);

    this.logger.warn(
      `recovered working order ${clientOrderId} for rung ${rung.price.toFixed(2)} from persisted ` +
        'state — the fill arrived with no in-memory record, which happens when an order fills ' +
        'while the daemon is down and IB replays the execution on reconnect',
    );

    return recovered;
  }

  /**
   * Undoes a pre-submit resting-order reservation.
   *
   * Used when the order turns out not to exist — rejected, or never reached the
   * broker. Skips a rung the fill router has already turned into a lot: an
   * order that filled during `submit()` is no longer working, and clearing it
   * would reopen a level that now holds shares.
   */
  private releaseRestingOrder(clientOrderId: string, strategyId: string, resting: boolean): void {
    this.workingOrders.delete(clientOrderId);

    if (!resting) {
      return;
    }

    const state = this.coordinator.getState(strategyId);

    if (state) {
      DipLadderStrategy.clearWorkingOrder(state, clientOrderId);
    }
  }

  /**
   * True when this intent should rest at the broker rather than be correlated
   * inside the submit call.
   *
   * Both sides now, which is the Story 14a change. Entries were moved to
   * resting orders in Story 13 and exits were left behind — so a sell was
   * submitted with no working-order registration, no persistent fill routing,
   * and a lot closed optimistically before the broker confirmed anything.
   */
  private isRestingOrder(intent: OrderIntent): boolean {
    return this.ladderConfigFor(intent.strategyId)?.orderPlacement === OrderPlacement.RESTING;
  }

  /**
   * True when this intent is a ladder *entry* resting at the broker.
   *
   * Narrower than `isRestingOrder` and kept separate because the rung
   * bookkeeping — the duplicate-price guard, the `WORKING` mark — is meaningful
   * only for entries. Two sells at one price would be a duplicate; a sell and a
   * buy at the same price are not, and an exit is keyed to its lot rather than
   * to a level.
   */
  private isRestingEntry(intent: OrderIntent): boolean {
    return intent.side === 'BUY' && this.isRestingOrder(intent);
  }

  /** True when this intent is a ladder *exit* resting at the broker. */
  private isRestingExit(intent: OrderIntent): boolean {
    return intent.side === 'SELL' && this.isRestingOrder(intent);
  }

  /**
   * The resting sell already covering the shares this exit would sell, if any.
   *
   * **Deliberately does not consult `Lot.workingOrderId`.** That field is the
   * in-memory answer, and `selectRestingExits` has already filtered on it — so
   * a duplicate can only arise when it is *wrong*: state restored from a
   * database written before the mark was persisted, an order adopted by
   * reconciliation, a fill router that has not yet run. A guard that re-read
   * the same stale field would agree with it and pass the duplicate through,
   * which is exactly what it did before this comment was written.
   *
   * The broker is the authority, and the matchable fact is **price and
   * quantity**: a resting sell for the same quantity at the same limit is
   * either this lot's own order or an indistinguishable duplicate of it, and
   * placing a second one is unsafe in both readings. This is coarser than the
   * entry guard's price match — two lots at one rung across cycles can share a
   * target — and the cost of the collision is a declined exit that the next bar
   * retries once the first order clears. Selling a position twice is not
   * recoverable in the same way.
   */
  private restingSellIdFor(
    intent: OrderIntent,
    quantity: number,
    sells: { clientOrderId: string; limitPrice: number; quantity: number }[],
  ): string | null {
    const target = roundPrice(intent.limitPrice);

    const match = sells.find(
      (order) => roundPrice(order.limitPrice) === target && order.quantity === quantity,
    );

    return match?.clientOrderId ?? null;
  }

  /**
   * Routes a fill on a **resting** order back into ladder state.
   *
   * Only handles orders this engine placed and is still tracking. Fills for
   * immediately-submitted orders are correlated by `submitOrder`'s own
   * subscription and are ignored here, so the two paths cannot both open a lot
   * for the same fill.
   *
   * **Partial fills: the remainder is cancelled and a lot is opened for the
   * shares that actually filled.** A resting order that fills 40 of 100 shares
   * and then sits is a position the ladder is carrying without having decided
   * to; cancelling makes the rung's exposure final and knowable, and the lot's
   * exit target is computed from the real fill price for the real quantity.
   * The cost is a smaller position than the rung intended, which is the safe
   * direction.
   *
   * **A fill already recorded is ignored.** IB replays the day's executions to
   * every subscribing client, so a reconnect — including the routine daily
   * logout — re-delivers fills this engine has already turned into lots. The
   * working-order map is no defence: reconciliation repopulates it at startup
   * so a pre-restart order can still find its rung, which is exactly when the
   * replay arrives. Persisted `fillId` is the only durable evidence, and
   * without the check one execution would open a second lot and double a
   * position the broker holds once.
   */
  private async routeFill(fill: Fill): Promise<void> {
    const working =
      this.workingOrders.get(fill.clientOrderId) ??
      (await this.recoverWorkingOrder(fill.clientOrderId));

    if (!working) {
      return;
    }

    if (await this.fills.findByFillId(fill.fillId)) {
      this.logger.debug(`ignoring already-recorded fill ${fill.fillId}`);
      return;
    }

    const state = this.coordinator.getState(working.strategyId);

    if (!state) {
      return;
    }

    await this.fills.save(fill);

    const partial = fill.quantity < working.quantity;

    // Cancel before touching the lot: if the cancel throws, the entry halt it
    // raises should happen while the ladder still reflects a working order,
    // not after it has been marked filled.
    if (partial) {
      await this.cancelRemainder(fill.clientOrderId, working, fill.quantity);
    }

    if (working.kind === 'EXIT') {
      await this.routeExitFill(fill, working, partial);
      return;
    }

    const config = this.ladderConfigFor(working.strategyId);

    if (!config) {
      return;
    }

    const lot = DipLadderStrategy.openLotFromFill(state, config, {
      rungPrice: working.rungPrice,
      price: fill.price,
      quantity: fill.quantity,
      at: fill.timestamp,
    });

    this.workingOrders.delete(fill.clientOrderId);

    await this.orders.updateStatus(
      fill.clientOrderId,
      partial ? OrderStatus.PARTIALLY_FILLED : OrderStatus.FILLED,
    );

    this.logger.log(
      `rung ${working.rungPrice.toFixed(2)} filled ${fill.quantity}${
        partial ? ` of ${working.quantity} (remainder cancelled)` : ''
      } @ ${fill.price.toFixed(2)} — lot ${lot.id} exits at ${lot.exitTarget.toFixed(2)}`,
    );

    await this.persistLadderState();
  }

  /**
   * Moves the simulated market, if the bound broker has one.
   *
   * `MockBrokerAdapter` in `MARKET_AWARE` mode has no feed of its own and fills
   * a resting order only when told price reached it. A real adapter has a real
   * market and exposes no such method, so the capability check is what keeps
   * this a no-op against IB rather than a mode flag that could disagree with
   * the adapter actually bound.
   */
  private advanceSimulatedMarket(price: number, at: string): void {
    const broker = this.broker as Partial<{
      advanceMarket: (price: number, at: string) => unknown;
    }>;

    if (typeof broker.advanceMarket === 'function') {
      broker.advanceMarket(price, at);
    }
  }

  /**
   * Routes a fill on a resting **SELL** back into ladder state.
   *
   * The counterpart to `openLotFromFill`, and the reason Story 14a exists: the
   * lot closes **at the broker's fill price** and its rung re-arms **only now**,
   * when the shares have genuinely been sold. The pre-14a path closed the lot
   * and re-armed the rung when the *intent* was created, so a rejected or
   * expired sell left the ladder believing it was flat at a level it still
   * held — and re-armed that level for a fresh entry against exposure it had
   * never released.
   *
   * A partial fill splits the lot rather than shrinking it; `splitLot` carries
   * the reasoning. The rung deliberately does not re-arm in that case, since it
   * still holds the remainder.
   */
  private async routeExitFill(
    fill: Fill,
    working: WorkingOrder & { kind: 'EXIT' },
    partial: boolean,
  ): Promise<void> {
    const state = this.coordinator.getState(working.strategyId);

    if (!state) {
      return;
    }

    const result = DipLadderStrategy.closeLotFromFill(state, {
      lotId: working.lotId,
      price: fill.price,
      quantity: fill.quantity,
      at: fill.timestamp,
    });

    this.workingOrders.delete(fill.clientOrderId);

    await this.orders.updateStatus(
      fill.clientOrderId,
      partial ? OrderStatus.PARTIALLY_FILLED : OrderStatus.FILLED,
    );

    if (!result) {
      // The lot named by this order is gone or already closed — another path
      // resolved it first. The fill is recorded and the order marked, but there
      // is nothing left to close. Reported rather than silently dropped: the
      // shares moved at the broker, so a divergence here is exactly what
      // reconciliation must be able to see the cause of.
      this.raiseAlert(
        'WARNING',
        'EXIT_FILL_UNATTRIBUTED',
        `fill ${fill.fillId} closed no lot — ${working.lotId} is missing or already closed`,
        fill.timestamp,
      );

      await this.persistLadderState();
      return;
    }

    this.logger.log(
      `lot ${result.closed.id} at rung ${working.rungPrice.toFixed(2)} sold ` +
        `${fill.quantity}${partial ? ` of ${working.quantity} (remainder cancelled)` : ''} ` +
        `@ ${fill.price.toFixed(2)}` +
        (result.remainder
          ? ` — ${result.remainder.quantity} still held as ${result.remainder.id}`
          : ''),
    );

    await this.persistLadderState();
  }

  /**
   * Cancels the unfilled remainder of a partially-filled resting order.
   *
   * A failure here is a technical fault, not a rejection: the remainder may
   * still be working at the broker, and the ladder would then hold a rung whose
   * true exposure it cannot state. Halting new entries is the correct response —
   * positions are untouched, as everywhere else.
   */
  private async cancelRemainder(
    clientOrderId: string,
    working: { rungPrice: number; quantity: number },
    filled: number,
  ): Promise<void> {
    try {
      await this.broker.cancel(clientOrderId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      this.haltEntries(
        `failed to cancel the remainder of ${clientOrderId} (${filled}/${working.quantity} filled ` +
          `at rung ${working.rungPrice.toFixed(2)}): ${detail}`,
        EntryHaltCode.ORDER_FAULT,
      );
    }
  }

  /**
   * Releases a rung whose resting order went away without filling.
   *
   * Cancelled, rejected, and DAY-expired orders all surface here. The rung must
   * become fireable again — a `WORKING` rung whose order no longer exists would
   * block that level permanently.
   */
  private async routeOrderStatus(ack: OrderAck): Promise<void> {
    const working = this.workingOrders.get(ack.clientOrderId);

    if (!working) {
      return;
    }

    if (ack.status !== OrderStatus.CANCELLED && ack.status !== OrderStatus.REJECTED) {
      return;
    }

    const state = this.coordinator.getState(working.strategyId);

    if (state) {
      DipLadderStrategy.clearWorkingOrder(state, ack.clientOrderId);
    }

    this.workingOrders.delete(ack.clientOrderId);

    await this.orders.updateStatus(ack.clientOrderId, ack.status, ack.rejectReason);

    if (ack.status === OrderStatus.REJECTED) {
      this.raiseAlert(
        'WARNING',
        'RESTING_ORDER_REJECTED',
        `broker rejected resting order ${ack.clientOrderId} at rung ` +
          `${working.rungPrice.toFixed(2)}: ${ack.rejectReason ?? 'no reason given'}`,
        this.lastBarTimestamp ?? working.symbol,
      );
    }

    await this.persistLadderState();
  }

  /**
   * The ladder config for a strategy id, or null when the id is not a ladder.
   *
   * Read from the live strategy instance rather than a copy, so a runtime
   * parameter edit is reflected — `ParameterService` mutates the same object
   * in place, which is what freezes a held lot's target while letting future
   * rungs use the new values.
   */
  private ladderConfigFor(strategyId: string): DipLadderConfig | null {
    if (!strategyId.startsWith(DIP_LADDER_ID_PREFIX)) {
      return null;
    }

    const strategy = this.coordinator.getStrategy(strategyId);

    return strategy instanceof DipLadderStrategy ? strategy.parameters : null;
  }

  /**
   * Writes ladder state after a live bar (`BarConsumer.persistState`).
   *
   * The replay path persists once at the end of `replayFixture`, which suits a
   * batch that completes. A live session is interrupted rather than finished,
   * so the same write has to happen per bar or a live-only session leaves the
   * `Lot`, `Rung`, and `StrategyStateSnapshot` tables empty — a restart then
   * restores nothing and every daily report skips its rung check.
   *
   * A thin delegate rather than making `persistLadderState` public: the replay
   * path's single end-of-run write is a different guarantee from this one, and
   * keeping the names distinct stops the two being conflated later.
   */
  async persistState(): Promise<void> {
    await this.persistLadderState();
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

  /**
   * Places orders for gaps an operator has reviewed, on demand.
   *
   * ## This is a new way into the broker, and it is deliberately narrow
   *
   * Every other order this system places originates from a bar. This one
   * originates from a click, which removes the two things a bar supplies: a
   * strategy decision, and a current price. Both are replaced rather than
   * skipped.
   *
   * - **The decision** is replaced by a diagnosis the caller already ran and
   *   the operator already read. Candidates are re-derived here rather than
   *   trusted from the request, so a stale preview cannot place an order the
   *   ladder no longer wants — the diagnosis is re-run inside this call and
   *   only its *current* findings are acted on.
   * - **The price** is replaced by `lastBarClose`. With no bar to reference,
   *   `isRestable`/`isRestableExit` cannot be evaluated, and an order that
   *   cannot be proven non-marketable is not placed. A null close refuses
   *   everything.
   *
   * ## What it does not bypass
   *
   * Nothing. Each candidate becomes an `OrderIntent` and crosses
   * `RiskManagerService.evaluate()` exactly as a bar-generated intent does, so
   * the capital caps, the loss breaker, and the kill switch all still apply —
   * `evaluateBatch` is used so several candidates are measured against one
   * running capital total rather than each against the starting figure. The
   * entry halt still blocks BUYs. A rejected or resized candidate is reported,
   * not forced.
   *
   * The exit side deliberately remains permitted under an entry halt, matching
   * `processBar`: halting a sell would trap a position the ladder has already
   * decided to close.
   */
  async placeMissingOrders(candidates: MissingOrderCandidate[]): Promise<PlacementResult> {
    const result: PlacementResult = { placed: [], declined: [] };

    if (candidates.length === 0) {
      return result;
    }

    // No reference price means no way to prove an order would rest rather than
    // cross the spread. Refusing everything is the safe direction: the cost is
    // a placement the operator retries after the next bar.
    if (this.lastBarClose === null) {
      for (const candidate of candidates) {
        result.declined.push({
          candidate,
          reason:
            'no bar has been seen yet, so no reference price exists to prove the order would rest',
        });
      }

      return result;
    }

    const close = this.lastBarClose;
    const timestamp = this.lastBarTimestamp ?? new Date().toISOString();

    if (!this.riskManager.canSubmit()) {
      for (const candidate of candidates) {
        result.declined.push({
          candidate,
          reason: 'submission is blocked — kill switch, breaker halt, or a non-submitting mode',
        });
      }

      return result;
    }

    const eligible: { candidate: MissingOrderCandidate; intent: OrderIntent }[] = [];

    for (const candidate of candidates) {
      if (candidate.side === 'BUY' && this.entryHalt) {
        result.declined.push({
          candidate,
          reason: `new entries are halted — ${this.entryHalt.reason}`,
        });
        continue;
      }

      // The rest guard, and the reason this method needs a price at all. A BUY
      // must sit at or below the market and a SELL at or above it; anything
      // else is marketable on arrival.
      const rests =
        candidate.side === 'BUY'
          ? isRestable(candidate.limitPrice, close)
          : isRestableExit(candidate.limitPrice, close);

      if (!rests) {
        result.declined.push({
          candidate,
          reason:
            `a ${candidate.side} limit at ${candidate.limitPrice.toFixed(2)} would be marketable ` +
            `against the last close of ${close.toFixed(2)} — refusing to cross the spread`,
        });
        continue;
      }

      const contract = this.contractFor(candidate.strategyId, candidate.symbol);

      if (!contract) {
        result.declined.push({
          candidate,
          reason: `no contract is registered for ${candidate.symbol}`,
        });
        continue;
      }

      eligible.push({
        candidate,
        intent: {
          strategyId: candidate.strategyId,
          contract,
          side: candidate.side,
          quantity: candidate.quantity,
          orderType: OrderType.LIMIT,
          limitPrice: candidate.limitPrice,
          timeInForce: TimeInForce.DAY,
          timestamp,
          reason: `operator placement — ${candidate.reason}`,
          ...(candidate.lotId ? { metadata: { lotId: candidate.lotId } } : {}),
        },
      });
    }

    if (eligible.length === 0) {
      return result;
    }

    const account = await this.accountSnapshot();
    const decisions = this.riskManager.evaluateBatch(
      eligible.map((e) => toRiskIntent(e.intent)),
      account,
    );

    for (let i = 0; i < eligible.length; i += 1) {
      const { candidate, intent } = eligible[i];
      const decision = decisions[i];

      if (decision.approvedQuantity <= 0) {
        result.declined.push({
          candidate,
          reason: `risk manager ${decision.outcome} — ${decision.reason}`,
        });
        continue;
      }

      // Persisted before submission, exactly as the bar path does — the intent
      // record is what makes an order traceable to the decision behind it.
      this.operatorIntentSequence += 1;
      const recordId = `operator-intent-${timestamp}-${this.operatorIntentSequence}`;

      await this.intents.save({
        id: recordId,
        intent,
        decision,
        submitted: false,
        clientOrderId: null,
        createdAt: timestamp,
      });

      try {
        const submission = await this.submitOrder(intent, decision.approvedQuantity, recordId);

        if (submission.submitted) {
          result.placed.push({
            candidate,
            quantity: decision.approvedQuantity,
            resized: decision.approvedQuantity !== candidate.quantity,
          });
        } else {
          result.declined.push({ candidate, reason: 'the broker did not accept the order' });
        }
      } catch (error) {
        result.declined.push({
          candidate,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // The submit path writes `Lot.workingOrderId` and `Rung.workingOrderId`,
    // and nothing else here does. Without persisting, a crash before the next
    // bar would leave a live order at IB with no durable record of it — the
    // same crash window `processBar` closes after its own submissions.
    if (result.placed.length > 0) {
      await this.persistLadderState();
    }

    return result;
  }

  /**
   * The contract a registered ladder trades.
   *
   * Read from the strategy's own registration rather than constructed here, so
   * an operator placement uses the identical contract the bar path would — a
   * hand-built contract that differed in exchange or currency would be a
   * different instrument wearing the same symbol.
   */
  private contractFor(strategyId: string, symbol: string): Contract | null {
    const config = this.ladderConfigFor(strategyId);

    // `equityContract` is the same helper the strategy itself uses to build an
    // intent's contract, so an operator placement and a bar placement describe
    // the identical instrument. Constructing one by hand here would risk a
    // different exchange or currency wearing the same symbol.
    return config && config.symbol === symbol ? equityContract(symbol) : null;
  }

  private haltEntries(reason: string, code: EntryHaltCode, at?: string): void {
    if (this.entryHalt) {
      return;
    }

    const timestamp = at ?? this.lastBarTimestamp ?? '1970-01-01T00:00:00.000Z';
    this.entryHalt = { reason, at: timestamp, code };

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
    this.alerts.push({ severity, code, detail, timestamp, resolvedAt: null });
    this.trimAlerts();
  }

  /**
   * Evicts the oldest **resolved** alerts once the history exceeds its cap.
   *
   * Resolved-only on purpose: an active alert reports a condition that still
   * holds, and dropping one to make room would hide a live fault behind a
   * retention policy. If every retained alert is active the list is allowed to
   * exceed the cap — 200 simultaneously unresolved faults is itself the thing
   * an operator needs to see, not something to quietly truncate.
   */
  private trimAlerts(): void {
    let excess = this.alerts.length - MAX_ALERT_HISTORY;

    for (let i = 0; excess > 0 && i < this.alerts.length;) {
      if (this.alerts[i].resolvedAt === null) {
        i += 1;
        continue;
      }

      this.alerts.splice(i, 1);
      excess -= 1;
    }
  }

  /**
   * Marks every unresolved alert with `code` as ended.
   *
   * Called where a *condition* stops holding, never where an event merely
   * finishes being handled. The timestamp is the moment the condition ended,
   * supplied by the caller so it reads in the same clock as the alert it
   * resolves — a bar's timestamp when a bar is the evidence, rather than
   * wall-clock time that would sit oddly next to a replayed session.
   *
   * Idempotent: an already-resolved alert keeps its original `resolvedAt`, so
   * repeated clears cannot walk a resolution time forward.
   */
  private resolveAlerts(code: string, at: string): void {
    for (const alert of this.alerts) {
      if (alert.code === code && alert.resolvedAt === null) {
        alert.resolvedAt = at;
      }
    }
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
  haltEntriesForFault(reason: string, code: EntryHaltCode = EntryHaltCode.STALE_DATA): void {
    this.haltEntries(reason, code);
  }

  /**
   * Clears a **staleness** halt once bars are arriving again.
   *
   * Called from `processBar`, so the trigger is a bar that actually reached the
   * engine — direct positive evidence that the fault condition ("no bars") has
   * ended. That is the whole justification for this being automatic, and it is
   * why the check is on `code` rather than on anything about the connection:
   * a socket reporting healthy is not evidence that data flows, which is
   * precisely the failure the staleness watchdog exists to catch.
   *
   * **Every other halt code is left alone.** A broker fault is not disproved by
   * a bar (bars and orders travel different paths, and a feed can recover while
   * submission stays broken), and a failed submission is not disproved by
   * anything except trying again. Those stay latched for an operator.
   *
   * Without this, a feed that went quiet and then simply resumed — a data-farm
   * blip, a pacing throttle, no socket drop anywhere — left entries halted for
   * the life of the process. Bars flowed, the ladder evaluated, and every BUY
   * was silently dropped until someone restarted the daemon.
   */
  private clearStaleHalt(): void {
    if (this.entryHalt?.code !== EntryHaltCode.STALE_DATA) {
      return;
    }

    const previous = this.entryHalt;
    this.entryHalt = null;

    // The alert reported the halt, so it ends when the halt does. The bar's
    // own timestamp is the resolution time: it is the evidence, and it reads in
    // the same clock as the `at` the alert was raised with.
    this.resolveAlerts('ENTRY_HALT', this.lastBarTimestamp ?? previous.at);

    this.logger.log(
      `market data resumed — entry halt raised at ${previous.at} cleared automatically. ` +
        'Only a staleness halt clears this way; every other fault waits for an operator.',
    );
  }

  /** Operator action: clears a technical halt. Never happens on a timer. */
  clearHalt(): void {
    const previous = this.entryHalt;
    this.entryHalt = null;

    // Resolved even when nothing was halted: an operator clearing a halt is
    // saying the condition is over, and leaving a stale ENTRY_HALT banner up
    // after they acted is the exact failure this whole change fixes.
    this.resolveAlerts(
      'ENTRY_HALT',
      this.lastBarTimestamp ?? previous?.at ?? new Date().toISOString(),
    );
  }

  isHalted(): boolean {
    return this.entryHalt !== null;
  }

  haltReason(): string | null {
    return this.entryHalt?.reason ?? null;
  }

  /**
   * Alerts whose condition still holds.
   *
   * This is what `GET /status` reports and what the dashboard banners, so it
   * must mean what its name says. It previously returned the entire history,
   * which is why a recovered engine kept rendering halts it had already
   * cleared. Use `alertHistory()` for the full record.
   */
  activeAlerts(): EngineAlert[] {
    return this.alerts.filter((alert) => alert.resolvedAt === null);
  }

  /**
   * Every alert raised this process, resolved ones included.
   *
   * Kept separate from `activeAlerts()` so the soak retains its evidence —
   * "the feed went stale at 19:55 and recovered at 09:35" is exactly the record
   * a soak day is signed off against, and filtering it out of existence to fix
   * the banner would have destroyed that.
   */
  alertHistory(): EngineAlert[] {
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
    return this.ladderStates().flatMap(({ state }) => DipLadderStrategy.lotsOf(state) ?? []);
  }

  ladderRungs(): Rung[] {
    return this.ladderStates().flatMap(({ state }) => DipLadderStrategy.rungsOf(state) ?? []);
  }

  /**
   * Ladder rungs paired with the symbol whose ladder they belong to.
   *
   * A `Rung` carries only a price — the symbol lives on the strategy
   * registration, not the rung — so a caller that must treat one symbol
   * differently from another (the API, which serves a halted symbol from the
   * database instead) cannot derive it from the rungs alone.
   *
   * Lots need no equivalent: a lot id is `${symbol}-lot-N`, so the symbol is
   * recoverable from the record itself.
   */
  ladderRungsBySymbol(): { symbol: string; rungs: Rung[] }[] {
    return this.ladderStates().map(({ symbols, state }) => ({
      // One ladder instance trades one symbol — the id carries it, and
      // `strategies.module.ts` registers one instance per symbol.
      symbol: symbols[0] ?? '',
      rungs: DipLadderStrategy.rungsOf(state) ?? [],
    }));
  }

  private ladderStates(): { symbols: string[]; state: StrategyState }[] {
    return this.coordinator
      .snapshots()
      .filter((snapshot) => snapshot.id.startsWith(DIP_LADDER_ID_PREFIX) && snapshot.state)
      .map((snapshot) => ({ symbols: [...snapshot.symbols], state: snapshot.state! }));
  }

  /** True when a reconciliation mismatch has halted this symbol (Story 9). */
  isSymbolHalted(symbol: string): boolean {
    return this.symbolHalts.isHalted(symbol);
  }

  /**
   * Advances the client-order sequence past every id already persisted.
   *
   * Called once from `StartupSequence`, before the gate opens and therefore
   * before any bar can submit. Ids are never reused across a restart, so the
   * fill router cannot resolve an execution to a superseded order.
   *
   * **The maximum is taken, not the row count.** Counting rows would repeat an
   * id whenever the table has been pruned or a submission failed after
   * incrementing, which is precisely the collision this closes.
   *
   * Ids that do not match `co-N` are ignored rather than rejected: orders
   * recovered from IB or written by hand carry the broker's own vocabulary, and
   * refusing to boot over one would take the dashboard down for a row that
   * cannot collide with this generator anyway.
   */
  async restoreClientOrderSequence(): Promise<void> {
    const orders = await this.orders.findAll();
    let highest = 0;

    for (const order of orders) {
      const match = /^co-(\d+)$/.exec(order.clientOrderId);

      if (match) {
        highest = Math.max(highest, Number(match[1]));
      }
    }

    // Only ever moves forward. A restore that lowered the counter would hand
    // out ids the running process had already issued.
    if (highest > this.clientOrderSequence) {
      this.clientOrderSequence = highest;
      this.logger.log(
        `client order sequence resumed at co-${highest} — ${orders.length} persisted order(s)`,
      );
    }
  }

  async reset(): Promise<void> {
    this.entryHalt = null;
    this.alerts.length = 0;
    this.clientOrderSequence = 0;
    // Resting-order tracking goes with the orders it refers to. Left behind, a
    // stale entry would let a fill from a previous replay open a lot in the
    // next one — and `clientOrderSequence` restarts from zero, so the ids
    // genuinely would collide.
    this.workingOrders.clear();
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
