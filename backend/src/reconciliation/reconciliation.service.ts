/**
 * Startup reconciliation — **IB is truth for positions, the DB is truth for lot
 * composition** (`PRD.md:321`).
 *
 * This runs the four ordered steps from `PRD.md:323`, once per strategy, before
 * any strategy hook fires:
 *
 * 1. query the broker for actual positions
 * 2. load persisted state from the database
 * 3. reconcile — the lot-sum assertion
 * 4. on discrepancy: log, alert, refuse to trade that symbol
 *
 * ## Why restore is not a separate step
 *
 * A restore that happened before reconciliation would put lots into live
 * strategy state and *then* ask whether they are correct — and a bar arriving
 * in that window would trade on unverified state. So state is loaded into a
 * local, checked, and only written into the coordinator once the assertion
 * passes. A symbol that fails reconciliation resumes with an **empty ladder and
 * a halt**, not with the suspect lots: halted means no intents either way, and
 * leaving the unverified composition in place would be the guess `PRD.md:347`
 * forbids.
 *
 * ## What a failure never does
 *
 * It never liquidates, never adjusts lots to fit the broker's number, and never
 * releases itself. Halting is the whole response. `CLAUDE.md` is explicit that
 * a technical fault must not become a realized loss, and a reconciliation
 * mismatch is the case where "fixing it automatically" is most tempting and
 * most dangerous.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BROKER_ADAPTER,
  BrokerAdapter,
  BrokerPosition,
  CompletedOrder,
  OpenOrder,
  OrderStatus,
} from '../broker/broker-adapter.interface';
import {
  LOT_REPOSITORY,
  LotRepository,
  ORDER_REPOSITORY,
  OrderRepository,
  RUNG_REPOSITORY,
  RungRepository,
  STRATEGY_STATE_SNAPSHOT_REPOSITORY,
  StrategyStateSnapshotRepository,
} from '../repositories/repository.interfaces';
import { CoordinatorService } from '../strategies/coordinator.service';
import {
  DIP_LADDER_ID_PREFIX,
  DIP_LADDER_STATE_VERSION,
  DipLadderStateData,
  DipLadderStrategy,
} from '../strategies/dip-ladder/dip-ladder.strategy';
import { Lot } from '../strategies/dip-ladder/lot';
import { Rung } from '../strategies/dip-ladder/rung';
import { JsonValue } from '../strategies/types';
import { assertLotSum, LotSumVerdict, ReconciliationStatus } from './lot-sum-assertion';
import { SymbolHaltService } from './symbol-halt.service';

/** Halt codes, so the dashboard can distinguish causes without parsing prose. */
export const HALT_LOT_SUM_MISMATCH = 'LOT_SUM_MISMATCH';
export const HALT_STATE_VERSION_MISMATCH = 'STATE_VERSION_MISMATCH';
export const HALT_BROKER_UNAVAILABLE = 'BROKER_UNAVAILABLE';

export interface SymbolReconciliation {
  strategyId: string;
  symbol: string;
  verdict: LotSumVerdict;
  /** True when persisted state was loaded into the live strategy. */
  resumed: boolean;
  /** How many held lots were restored. Zero on a halt. */
  restoredLots: number;
  restoredRungs: number;
  /** Set when the snapshot's version was not the one this build understands. */
  snapshotVersion: number | null;
}

export interface ReconciliationReport {
  ranAt: string;
  /** True only when every symbol reconciled. */
  clean: boolean;
  symbols: SymbolReconciliation[];
  haltedSymbols: string[];
  /**
   * `Order` rows brought to their true terminal state from the broker's own
   * history.
   *
   * Reporting only, and separate from `clean` on purpose: an order this engine
   * never learned had been cancelled is a stale *record*, not a divergence in
   * position or exposure. Folding it into `clean` would report a halt-worthy
   * condition for something that costs nothing and is now fixed.
   */
  ordersUpdated: number;
}

/**
 * The result of an orders-only reconciliation.
 *
 * Deliberately not a `ReconciliationReport`: that type carries `clean` and
 * `haltedSymbols`, which are verdicts about *positions*. This run does not
 * assert anything about positions, and reporting `clean: true` from it would
 * claim a check that never ran.
 */
export interface OrderReconciliationReport {
  ranAt: string;
  symbols: string[];
  /** False when the broker could not be asked; the ledger is then untouched. */
  brokerReachable: boolean;
  ordersUpdated: number;
}

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  private lastReport: ReconciliationReport | null = null;
  private lastOrderReconciliation: OrderReconciliationReport | null = null;

  constructor(
    private readonly coordinator: CoordinatorService,
    private readonly halts: SymbolHaltService,
    @Inject(BROKER_ADAPTER) private readonly broker: BrokerAdapter,
    @Inject(LOT_REPOSITORY) private readonly lots: LotRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(RUNG_REPOSITORY) private readonly rungs: RungRepository,
    @Inject(STRATEGY_STATE_SNAPSHOT_REPOSITORY)
    private readonly snapshots: StrategyStateSnapshotRepository,
  ) {}

  /**
   * Reconciles every registered ladder and restores the ones that pass.
   *
   * Runs to completion across all symbols even when one halts: a mismatch on
   * TQQQ is not a reason to leave SOXL unreconciled and therefore unable to
   * trade (`stories.md:558`).
   */
  async reconcileAll(now: string): Promise<ReconciliationReport> {
    // Step 1 — the broker is asked *first*, before any state is loaded. If it
    // cannot answer, nothing is trustworthy and every symbol halts; resuming a
    // ladder against an unknown position is the failure this whole story exists
    // to prevent.
    const positions = await this.brokerPositions();

    // `null` means the broker could not be asked, which is **not** the same as
    // "nothing is resting" and must not be collapsed into it. Treating an
    // unanswered query as an empty list would release every WORKING rung and
    // the next bar would place a duplicate order beside one still live at IB —
    // precisely the failure open-order reconciliation exists to prevent. When
    // it is null the ledger is left exactly as persisted.
    const openOrders = await this.brokerOpenOrders();

    const results: SymbolReconciliation[] = [];

    for (const snapshot of this.coordinator.snapshots()) {
      if (!snapshot.id.startsWith(DIP_LADDER_ID_PREFIX)) {
        // Scaffolds hold no lots. Nothing to reconcile until Story 16 gives
        // them real behaviour, and inventing a verdict for them would put
        // meaningless rows on the dashboard.
        continue;
      }

      const symbol = snapshot.symbols[0];

      if (!symbol) {
        continue;
      }

      results.push(await this.reconcileSymbol(snapshot.id, symbol, positions, openOrders, now));
    }

    // Runs after every symbol is reconciled, and deliberately cannot affect any
    // of it: rung release is decided by `getOpenOrders` alone, because a level
    // is free when nothing is working at it — a fact that holds whether or not
    // the history query succeeds.
    const ordersUpdated = await this.reconcileOrderHistory();

    const report: ReconciliationReport = {
      ranAt: now,
      clean: results.every((result) => result.verdict.reconciled),
      symbols: results,
      haltedSymbols: this.halts.haltedSymbols(),
      ordersUpdated,
    };

    this.lastReport = report;

    this.logger.log(
      report.clean
        ? `reconciliation clean across ${results.length} symbol(s) — ladders resumed`
        : `reconciliation FAILED for ${report.haltedSymbols.join(', ')} — those symbols are halted`,
    );

    return report;
  }

  /**
   * Reconciles **orders only** — resting orders and stale `Order` rows — for
   * every registered ladder, leaving positions untouched.
   *
   * **Why this exists separately from `reconcileAll`.** The full sequence
   * re-runs the lot-sum assertion and can halt a symbol. That is the right
   * behaviour for a boot, and acceptable for a button an operator presses and
   * watches. It is the wrong behaviour for an unattended job: a broker that is
   * briefly unreachable at 16:10 returns `null` positions, every symbol halts,
   * and the operator finds a dead ladder the next morning with nobody having
   * seen the cause. The failure a scheduled run must not have is one that
   * stops trading while nobody is looking.
   *
   * The order half has no such mode. `getOpenOrders` throwing leaves the ledger
   * exactly as persisted, and a failed history query updates nothing — both
   * degrade to "changed nothing", which is safe to discover the next morning.
   *
   * It also **does not restore state from the database**. Mid-session, or after
   * a session, live in-memory state is at least as current as the persisted
   * copy; overwriting it here would discard the day for no benefit, since this
   * job answers a question about orders, not about composition.
   */
  async reconcileOrders(now: string): Promise<OrderReconciliationReport> {
    const openOrders = await this.brokerOpenOrders();
    const symbols: string[] = [];

    for (const snapshot of this.coordinator.snapshots()) {
      if (!snapshot.id.startsWith(DIP_LADDER_ID_PREFIX)) {
        continue;
      }

      const symbol = snapshot.symbols[0];

      if (!symbol) {
        continue;
      }

      // A halted symbol is deliberately included. Releasing a rung whose order
      // expired changes nothing about the halt — the symbol still trades
      // neither way — and leaving its ledger stale would mean the operator
      // resolving the halt inherits a second, unrelated discrepancy.
      await this.reconcileOpenOrders(snapshot.id, symbol, openOrders);
      symbols.push(symbol);
    }

    const ordersUpdated = await this.reconcileOrderHistory();

    const report: OrderReconciliationReport = {
      ranAt: now,
      symbols,
      // Distinguished from "nothing was resting": an unreachable broker leaves
      // the ledger untouched, and a report that looked clean would hide that
      // the check did not happen.
      brokerReachable: openOrders !== null,
      ordersUpdated,
    };

    this.lastOrderReconciliation = report;

    this.logger.log(
      openOrders === null
        ? 'order reconciliation skipped — broker unreachable, ledger left as persisted'
        : `order reconciliation complete across ${symbols.length} symbol(s) — ` +
            `${ordersUpdated} stale order row(s) corrected`,
    );

    return report;
  }

  lastOrderReconcile(): OrderReconciliationReport | null {
    return this.lastOrderReconciliation;
  }

  /**
   * Brings `Order` rows into agreement with the broker's terminal-order history.
   *
   * **The gap this closes.** A terminal status reaches the engine through
   * `onOrderStatus`, which resolves IB's numeric order id through an in-memory
   * map populated at submission. An order placed before a restart and then
   * cancelled — in TWS, or by IB expiring it at the close — produces a status
   * this process cannot attribute, so it is dropped. Open-order reconciliation
   * then releases the rung correctly, but nothing ever moves the `Order` row off
   * `SUBMITTED`: the ladder recovers while `GET /orders` keeps showing a live
   * order that exists nowhere.
   *
   * **Only rows in a non-terminal state are touched.** A row already `FILLED`
   * or `CANCELLED` is left alone even if the broker says the same thing —
   * rewriting it would churn the audit trail to no effect. And an order the
   * database has no row for is skipped rather than created: this reconciles
   * records the engine owns, and manufacturing rows for orders placed by hand
   * in TWS would put entries in the ledger the engine never decided to make.
   *
   * **A failure here is logged, never fatal.** The history is diagnostic; the
   * assertions that gate trading have already run. Throwing would turn a
   * cosmetic staleness into a failed reconciliation.
   */
  private async reconcileOrderHistory(): Promise<number> {
    let completed: CompletedOrder[];

    try {
      completed = await this.broker.getCompletedOrders();
    } catch (error) {
      this.logger.warn(
        `completed-order history unavailable — Order rows may still show a stale status: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }

    let updated = 0;

    for (const order of completed) {
      const record = await this.orders.findByClientOrderId(order.clientOrderId);

      if (!record) {
        continue;
      }

      if (record.status === order.status) {
        continue;
      }

      // A row that already reached a terminal state is not re-stamped. The
      // engine saw the outcome live, which is the more direct evidence.
      if (
        record.status === OrderStatus.FILLED ||
        record.status === OrderStatus.CANCELLED ||
        record.status === OrderStatus.REJECTED
      ) {
        continue;
      }

      await this.orders.updateStatus(order.clientOrderId, order.status, order.reason ?? undefined);
      updated += 1;

      this.logger.log(
        `order ${order.clientOrderId} corrected to ${order.status} from the broker's history` +
          `${order.reason ? ` — ${order.reason}` : ''}`,
      );
    }

    return updated;
  }

  private async reconcileSymbol(
    strategyId: string,
    symbol: string,
    positions: BrokerPosition[] | null,
    openOrders: OpenOrder[] | null,
    now: string,
  ): Promise<SymbolReconciliation> {
    // Step 2 — load persisted state. Lots and rungs come from their own tables
    // (authoritative on composition); the snapshot supplies only the anchor
    // scalars that live nowhere else.
    const persistedLots = await this.lots.findBySymbol(symbol);
    const persistedRungs = await this.rungs.findBySymbol(symbol);
    const snapshot = await this.snapshots.findLatest(strategyId);

    if (positions === null) {
      return this.haltWith(
        strategyId,
        symbol,
        HALT_BROKER_UNAVAILABLE,
        {
          symbol,
          status: ReconciliationStatus.UNTRACKED_AT_BROKER,
          lotQuantity: persistedLots.reduce(
            (sum, lot) => (lot.status === 'HELD' ? sum + lot.quantity : sum),
            0,
          ),
          brokerQuantity: 0,
          heldLotCount: persistedLots.filter((lot) => lot.status === 'HELD').length,
          reconciled: false,
          reason: `${symbol}: broker unreachable at startup — cannot verify the position, halted`,
        },
        now,
        snapshot?.version ?? null,
      );
    }

    // A symbol the broker does not list is flat, which is a real answer and not
    // missing data.
    const brokerQuantity = positions.find((p) => p.symbol === symbol)?.quantity ?? 0;

    // **Version is checked before the state is trusted** (`stories.md:514`).
    // Rejected rather than coerced: a snapshot written by a different schema
    // may have fields that no longer mean what they used to, and a misread
    // anchor prices every future rung wrong.
    if (snapshot !== null && snapshot.version !== DIP_LADDER_STATE_VERSION) {
      return this.haltWith(
        strategyId,
        symbol,
        HALT_STATE_VERSION_MISMATCH,
        {
          ...assertLotSum(symbol, persistedLots, brokerQuantity),
          reconciled: false,
          reason:
            `${symbol}: snapshot version ${snapshot.version} is not the supported ` +
            `version ${DIP_LADDER_STATE_VERSION} — refusing to load state that may not mean ` +
            'what this build assumes',
        },
        now,
        snapshot.version,
      );
    }

    // Step 3 — the assertion itself.
    const verdict = assertLotSum(symbol, persistedLots, brokerQuantity);

    if (!verdict.reconciled) {
      // Step 4 — log, alert, refuse to trade this symbol.
      return this.haltWith(
        strategyId,
        symbol,
        HALT_LOT_SUM_MISMATCH,
        verdict,
        now,
        snapshot?.version ?? null,
      );
    }

    // Reconciled. Only now is state written into the live strategy.
    const restored = this.restore(
      strategyId,
      persistedLots,
      persistedRungs,
      snapshot?.data ?? null,
    );

    // Resting orders are reconciled *after* the lot-sum assertion passes, not
    // instead of it: the two answer different questions. The assertion is about
    // shares that exist; this is about orders that might yet create some.
    await this.reconcileOpenOrders(strategyId, symbol, openOrders);

    this.logger.log(
      `${symbol}: reconciled — ${verdict.reason}. ` +
        `Restored ${restored.lots} lot(s) and ${restored.rungs} rung(s).`,
    );

    return {
      strategyId,
      symbol,
      verdict,
      resumed: true,
      restoredLots: restored.lots,
      restoredRungs: restored.rungs,
      snapshotVersion: snapshot?.version ?? null,
    };
  }

  /**
   * Reconciles the rung ledger against orders actually resting at the broker.
   *
   * **This is what makes a restart safe.** The ladder's `WORKING` rungs are a
   * record of orders this engine placed; the broker's open-order list is the
   * record of which of them still exist. They diverge in both directions, and
   * each direction is dangerous in its own way:
   *
   * - **A `WORKING` rung with no order at IB** — the DAY order expired
   *   overnight, or was cancelled in TWS. Left as-is the level is blocked
   *   forever and the ladder silently stops laddering. Released to fireable.
   * - **An order at IB with no `WORKING` rung** — the crash window: the order
   *   reached IB but the process died before persisting the rung. Adopted, so
   *   the ladder knows the level is taken. Without this the next bar places a
   *   *second* order at the same price and both fill.
   *
   * Orders are never cancelled here. An order the engine cannot explain is
   * reported, not destroyed — cancelling an order an operator placed by hand
   * would be the system overruling a human decision it does not understand.
   */
  private async reconcileOpenOrders(
    strategyId: string,
    symbol: string,
    openOrders: OpenOrder[] | null,
  ): Promise<void> {
    const state = this.coordinator.getState(strategyId);

    // `null` is "could not ask", not "nothing resting" — see `reconcileAll`.
    // The persisted ledger stands unchanged, which keeps WORKING rungs blocked
    // rather than risking a duplicate order at a level already taken.
    if (!state || openOrders === null) {
      if (openOrders === null) {
        this.logger.warn(
          `${symbol}: open orders could not be read from the broker — resting-order state ` +
            'left as persisted. A rung whose order expired will stay blocked until the next ' +
            'successful reconciliation.',
        );
      }

      return;
    }

    const rungs = DipLadderStrategy.rungsOf(state) ?? [];
    const restingForSymbol = openOrders.filter(
      (order) => order.symbol === symbol && order.side === 'BUY',
    );
    const restingIds = new Set(restingForSymbol.map((order) => order.clientOrderId));

    let released = 0;

    for (const rung of rungs) {
      if (rung.workingOrderId && !restingIds.has(rung.workingOrderId)) {
        DipLadderStrategy.clearWorkingOrder(state, rung.workingOrderId);
        released += 1;
      }
    }

    const knownIds = new Set(
      rungs.map((rung) => rung.workingOrderId).filter((id): id is string => Boolean(id)),
    );
    const orphans = restingForSymbol.filter((order) => !knownIds.has(order.clientOrderId));

    for (const orphan of orphans) {
      DipLadderStrategy.recordWorkingOrder(state, orphan.limitPrice, orphan.clientOrderId);
    }

    if (released > 0 || orphans.length > 0) {
      this.logger.log(
        `${symbol}: open-order reconciliation — released ${released} rung(s) whose order is ` +
          `no longer at the broker, adopted ${orphans.length} resting order(s) the ladder ` +
          'had no record of',
      );
    }

    // The engine's in-memory working-order registry is rebuilt from what the
    // broker actually holds, so a fill on an adopted order finds its rung.
    this.onOpenOrdersReconciled?.(strategyId, symbol, restingForSymbol);
  }

  /**
   * Writes persisted state into the coordinator's live strategy state.
   *
   * Called **only** after the assertion passes. Lots and rungs come from their
   * own tables rather than from the snapshot's copy, so there is exactly one
   * authority per fact and a stale duplicate inside the snapshot cannot win.
   */
  private restore(
    strategyId: string,
    lots: Lot[],
    rungs: Rung[],
    snapshotData: Record<string, unknown> | null,
  ): { lots: number; rungs: number } {
    const state = this.coordinator.getState(strategyId);

    if (!state) {
      // The strategy is registered but was never initialized — nothing to
      // restore into. Not an error: `initializeAll` runs before this in the
      // startup sequence, so this is only reachable for a disabled strategy.
      return { lots: 0, rungs: 0 };
    }

    const data = state.data as unknown as DipLadderStateData;

    data.lots = lots as DipLadderStateData['lots'];
    data.rungs = rungs as DipLadderStateData['rungs'];

    if (snapshotData) {
      // The anchor scalars. Restored individually rather than by replacing
      // `state.data` wholesale, because lots and rungs have already been set
      // from their authoritative tables above and must not be overwritten by
      // the snapshot's possibly-older copy.
      data.firstEntryPrice = numberOrNull(snapshotData.firstEntryPrice);
      data.lotSequence =
        typeof snapshotData.lotSequence === 'number' ? snapshotData.lotSequence : 0;
      data.previousSessionClose = numberOrNull(snapshotData.previousSessionClose);
      data.runningClose = numberOrNull(snapshotData.runningClose);
      data.sessionOpen = numberOrNull(snapshotData.sessionOpen);
      data.sessionDate =
        typeof snapshotData.sessionDate === 'string' ? snapshotData.sessionDate : null;
    }

    this.coordinator.setState(strategyId, state);

    return { lots: lots.length, rungs: rungs.length };
  }

  private haltWith(
    strategyId: string,
    symbol: string,
    code: string,
    verdict: LotSumVerdict,
    now: string,
    snapshotVersion: number | null,
  ): SymbolReconciliation {
    this.halts.halt(symbol, code, verdict.reason, now);

    return {
      strategyId,
      symbol,
      verdict,
      // Deliberately not resumed and deliberately nothing restored: a halted
      // symbol trades neither way, and loading unverified lots would leave the
      // exit path reading composition nobody confirmed.
      resumed: false,
      restoredLots: 0,
      restoredRungs: 0,
      snapshotVersion,
    };
  }

  /**
   * Broker positions, or null when the broker cannot answer.
   *
   * Null rather than an empty array — those mean opposite things. An empty
   * array is "the account is flat", which reconciles against an empty ladder;
   * a failed query is "unknown", which must halt. Collapsing them would let an
   * unreachable broker look like a clean flat account and resume trading.
   */
  private async brokerPositions(): Promise<BrokerPosition[] | null> {
    try {
      return await this.broker.getPositions();
    } catch (error) {
      this.logger.error(
        `broker position query failed at startup: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /**
   * Open orders from the broker, or `null` when it could not answer.
   *
   * The null/empty distinction is the same one `brokerPositions` makes, and for
   * the same reason: "flat" and "unknown" must lead to different decisions.
   */
  private async brokerOpenOrders(): Promise<OpenOrder[] | null> {
    try {
      return await this.broker.getOpenOrders();
    } catch (error) {
      this.logger.error(
        `broker open-order query failed at startup: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /**
   * Set by the engine so it can rebuild its in-memory working-order registry
   * from what the broker actually holds.
   *
   * A callback rather than an engine reference, because the reconciliation
   * service must not depend on `EngineService` — the engine already depends on
   * reconciliation through `StartupSequence`, and the reverse edge would close
   * a cycle.
   */
  onOpenOrdersReconciled:
    ((strategyId: string, symbol: string, orders: OpenOrder[]) => void) | null = null;

  lastReconciliation(): ReconciliationReport | null {
    return this.lastReport;
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

/** Re-exported so callers building a snapshot record do not import the strategy. */
export type LadderSnapshotData = Record<string, JsonValue>;
