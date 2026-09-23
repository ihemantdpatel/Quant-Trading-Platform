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
 * It never liquidates and never releases a halt on its own — halting (or
 * staying halted) is the whole response once the evidence runs out.
 * `CLAUDE.md` is explicit that a technical fault must not become a realized
 * loss, and a reconciliation mismatch is the case where "fixing it
 * automatically" is most tempting and most dangerous.
 *
 * **One narrow exception, and it is evidence, not adjustment.**
 * `recoverExitFills` (below, run as part of step 3) closes a HELD lot whose
 * resting exit already filled at the broker, but only from that lot's own
 * `Fill` row — real execution data this system already recorded and simply
 * failed to route live. It never redistributes a mismatch across lots, never
 * synthesizes a quantity or price to make totals agree, and does nothing at
 * all when the evidence is anything less than an exact match. That is the
 * line: reading back a fact this system already holds is not the guess
 * `PRD.md:347` forbids.
 *
 * ## The other exception: `LotRebuildService`
 *
 * `attemptRebuild` (below, run only when step 3's assertion fails) is the
 * second and only other departure from "halt is the whole response," and it
 * is a deliberate, documented one — see `docs/decisions/auto-lot-rebuild.md`.
 * Unlike `recoverExitFills`, it *can* reconstruct from broken evidence (an
 * order's own limit price, or the broker's blended average cost) rather than
 * only an exact recorded fill — which is exactly the guess this file's header
 * otherwise forbids. Two things keep it inside the line the decision doc
 * draws: it is gated to `PAPER` only, and `assertLotSum` is re-run against its
 * output exactly as it would be against any other candidate state — a rebuild
 * that does not produce an exact match still halts, with no partial
 * application, precisely like every other mismatch before this existed.
 */

import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  BROKER_ADAPTER,
  BrokerAdapter,
  BrokerPosition,
  CompletedOrder,
  ConnectionState,
  OpenOrder,
  OrderStatus,
} from '../broker/broker-adapter.interface';
import { ExecutionMode } from '../config/execution-mode';
import {
  FILL_REPOSITORY,
  FillRepository,
  GRID_LOT_REPOSITORY,
  GridLotRepository,
  LOT_REBUILD_EVENT_REPOSITORY,
  LOT_REPOSITORY,
  LotRebuildEventRepository,
  LotRepository,
  ORDER_REPOSITORY,
  OrderRepository,
  RUNG_REPOSITORY,
  RungRepository,
  STRATEGY_STATE_SNAPSHOT_REPOSITORY,
  StrategyStateSnapshotRepository,
} from '../repositories/repository.interfaces';
import { CoordinatorService } from '../strategies/coordinator.service';
import { DipLadderConfig } from '../strategies/dip-ladder/config';
import {
  DIP_LADDER_ID_PREFIX,
  DIP_LADDER_STATE_VERSION,
  DipLadderStateData,
  DipLadderStrategy,
} from '../strategies/dip-ladder/dip-ladder.strategy';
import { closeLot, Lot, LotStatus } from '../strategies/dip-ladder/lot';
import { reArm, Rung, RungStatus } from '../strategies/dip-ladder/rung';
import { GRID_ID_PREFIX } from '../strategies/grid/grid.strategy';
import { DIP_LADDER_CONFIG } from '../strategies/strategies.module';
import { JsonValue } from '../strategies/types';
import {
  assertLotSum,
  LotSumVerdict,
  ReconciliationStatus,
  sumHeldQuantity,
} from './lot-sum-assertion';
import { LotRebuildService, RebuildAction, RebuildOutcome } from './lot-rebuild.service';
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
  /**
   * HELD lots closed by `recoverExitFills` before the assertion ran, using a
   * `Fill` this system already recorded for that lot's own exit order.
   */
  recoveredExits: number;
  /**
   * Set when `LotRebuildService` produced the state this symbol resumed with
   * — see `docs/decisions/auto-lot-rebuild.md`. `null` on a symbol that never
   * needed it (the ordinary case) and on a symbol that still halted despite
   * an attempt (`rebuildOutcome` in that case has `applied: false`, which is
   * not surfaced here — a halt is a halt regardless of what was tried).
   */
  rebuildAction: RebuildAction | null;
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
  /** Sum of `SymbolReconciliation.recoveredExits` across every symbol. */
  recoveredExits: number;
  /**
   * Count of symbols resumed via `LotRebuildService` rather than an ordinary
   * clean assertion. See `docs/decisions/auto-lot-rebuild.md` — worth watching
   * over the soak: a rebuild that fires often is evidence of an upstream bug
   * this is quietly papering over, not the rare edge case it was built for.
   */
  rebuildsApplied: number;
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
export class ReconciliationService implements OnModuleInit {
  private readonly logger = new Logger(ReconciliationService.name);
  private lastReport: ReconciliationReport | null = null;
  private lastOrderReconciliation: OrderReconciliationReport | null = null;

  /** Serializes `reconcileBrokerUnavailableHalts` against overlapping `CONNECTED` events. */
  private autoReleaseInFlight = false;

  /**
   * Successful auto-rebuilds applied per symbol this process's lifetime.
   *
   * `docs/decisions/auto-lot-rebuild.md` names this explicitly under "Revisit
   * when" as not yet implemented: "halting instead if it would fire more than
   * once for the same symbol in a session." A rebuild firing once is the rare
   * edge case Tier 2 was designed for — an order placed, filled, and never
   * durably tied to a rung. A *second* one for the same symbol is evidence of
   * a live bug upstream still producing fresh mismatches, and letting the
   * auto-rebuild keep absorbing them would silently paper over it, each
   * attempt compounding on whatever the previous one guessed. Scoped to the
   * process rather than a calendar session — this system does not model
   * trading-session boundaries anywhere else reconciliation reasons about.
   */
  private readonly rebuildsAppliedBySymbol = new Map<string, number>();

  constructor(
    private readonly coordinator: CoordinatorService,
    private readonly halts: SymbolHaltService,
    @Inject(BROKER_ADAPTER) private readonly broker: BrokerAdapter,
    @Inject(LOT_REPOSITORY) private readonly lots: LotRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(RUNG_REPOSITORY) private readonly rungs: RungRepository,
    @Inject(STRATEGY_STATE_SNAPSHOT_REPOSITORY)
    private readonly snapshots: StrategyStateSnapshotRepository,
    @Inject(FILL_REPOSITORY) private readonly fills: FillRepository,
    private readonly rebuild: LotRebuildService,
    @Inject(LOT_REBUILD_EVENT_REPOSITORY)
    private readonly rebuildEvents: LotRebuildEventRepository,
    // Single shared config, mirroring `DailyReportService`'s own
    // `DIP_LADDER_CONFIG` injection — see the "revisit when" note in
    // `docs/decisions/auto-lot-rebuild.md` for what a second symbol requires.
    @Inject(DIP_LADDER_CONFIG) private readonly ladderConfig: DipLadderConfig,
    private readonly mode: ExecutionMode,
    // The grid strategy's own lots for the *same* symbol — see
    // `siblingHeldQuantity`. Both strategies are registered against
    // `GRID_SYMBOL === DIP_LADDER_SYMBOL` (`strategies.module.ts`), and a
    // symbol's holdings are a fact about the broker account, not about which
    // strategy happens to be enabled — so this reconciliation must know what
    // the grid strategy already claims before deciding what its own lots are
    // supposed to explain.
    @Inject(GRID_LOT_REPOSITORY) private readonly gridLots: GridLotRepository,
  ) {}

  /**
   * Subscribes to broker connection health for the life of the process, the
   * same pattern `EngineService` uses for `onFill`/`onOrderStatus` and
   * `LiveFeedService` uses for re-subscribing bars — nothing else re-arms this
   * after a reconnect, so it must not be torn down.
   *
   * See `reconcileBrokerUnavailableHalts` for what a `CONNECTED` event
   * triggers and, just as importantly, what it does not.
   */
  onModuleInit(): void {
    this.broker.onConnectionChange((health) => {
      if (health.state === ConnectionState.CONNECTED) {
        this.autoReleaseBrokerUnavailableHalts();
      }
    });
  }

  /**
   * Fire-and-forget wrapper around `reconcileBrokerUnavailableHalts` for the
   * connection-change handler, which cannot itself be `async`.
   *
   * `autoReleaseInFlight` guards against a burst of `CONNECTED` events (a
   * reconnect can report it more than once, the same fact `LiveFeedService`
   * guards against) starting overlapping runs against the same halts and lots.
   */
  private autoReleaseBrokerUnavailableHalts(): void {
    if (this.autoReleaseInFlight) {
      return;
    }

    this.autoReleaseInFlight = true;

    this.reconcileBrokerUnavailableHalts(new Date().toISOString())
      .catch((error: unknown) => {
        this.logger.error(
          `automatic re-check of BROKER_UNAVAILABLE halts failed: ${
            error instanceof Error ? error.message : String(error)
          }. Halts are unchanged; a later reconnect or a manual /reconcile will try again.`,
        );
      })
      .finally(() => {
        this.autoReleaseInFlight = false;
      });
  }

  /**
   * Re-checks symbols halted for `HALT_BROKER_UNAVAILABLE` and releases the
   * halt automatically when the position now reconciles exactly.
   *
   * **Why this one halt code, and no other.** `BROKER_UNAVAILABLE` means "we
   * never got to check" — the broker did not answer, so the halt carries no
   * evidence that a mismatch exists, only that none could be ruled out. Once
   * the broker answers, re-running the same lot-sum assertion `reconcileAll`
   * uses either confirms the position was fine all along or reveals a real
   * divergence. The first case is safe to resume automatically, because
   * nothing has been trusted without checking — it is not the case
   * `symbol-halt.service.ts` warns against ("an automatic release would
   * resume trading on state nobody checked"): the state *was* checked, by
   * this method, using the same assertion an operator's `POST /reconcile`
   * would use.
   *
   * A `LOT_SUM_MISMATCH` is the opposite case — the broker answered and the
   * totals disagree — and this method never produces or clears one: a symbol
   * not currently halted for `BROKER_UNAVAILABLE` is skipped entirely, and a
   * re-check that still does not reconcile leaves the existing halt exactly
   * as it was (`reconcileSymbol`'s halt path is a no-op against an already-
   * halted symbol — `SymbolHaltService.halt` keeps the first reason). That
   * case stays exactly as deliberate and operator-only as it has always been.
   *
   * Also reachable directly (not just from the `CONNECTED` handler) so a test
   * — or an operator script — can trigger the same check without waiting for
   * a real reconnect event.
   */
  async reconcileBrokerUnavailableHalts(now: string): Promise<SymbolReconciliation[]> {
    const candidates = this.halts.haltedSymbolsWithCode(HALT_BROKER_UNAVAILABLE);

    if (candidates.length === 0) {
      return [];
    }

    const positions = await this.brokerPositions();

    // Still unreachable — the halts already say exactly this, and there is
    // nothing new to check them against.
    if (positions === null) {
      return [];
    }

    const openOrders = await this.brokerOpenOrders();
    const results: SymbolReconciliation[] = [];

    for (const snapshot of this.coordinator.snapshots()) {
      if (!snapshot.id.startsWith(DIP_LADDER_ID_PREFIX)) {
        continue;
      }

      const symbol = snapshot.symbols[0];

      if (!symbol || !candidates.includes(symbol)) {
        continue;
      }

      const result = await this.reconcileSymbol(snapshot.id, symbol, positions, openOrders, now);
      results.push(result);

      if (result.verdict.reconciled) {
        this.halts.release(symbol, now);
        this.logger.warn(
          `${symbol}: broker reachable again and the position now reconciles — ` +
            `BROKER_UNAVAILABLE halt released automatically (${result.verdict.reason}). ` +
            `Restored ${result.restoredLots} lot(s) and ${result.restoredRungs} rung(s).`,
        );
      }
    }

    return results;
  }

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
      recoveredExits: results.reduce((sum, result) => sum + result.recoveredExits, 0),
      rebuildsApplied: results.filter((result) => result.rebuildAction !== null).length,
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
        0,
        null,
      );
    }

    // A symbol the broker does not list is flat, which is a real answer and not
    // missing data.
    //
    // **Adjusted for the grid strategy's own holdings on this symbol.** The
    // broker reports one net position per symbol regardless of which strategy
    // accumulated it, so the ladder's lots only need to explain the share of
    // it the grid strategy does not already claim — otherwise a real position
    // left behind by switching strategies reads as this ladder's own mismatch
    // (see `siblingHeldQuantity`).
    const rawBrokerQuantity = positions.find((p) => p.symbol === symbol)?.quantity ?? 0;
    const brokerQuantity = rawBrokerQuantity - (await this.siblingHeldQuantity(symbol));

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
        0,
        null,
      );
    }

    // Recover any HELD lot whose resting exit already filled at the broker
    // before asserting the sum — see `recoverExitFills`. A lot closed here is
    // exactly the shape of gap the assertion below would otherwise halt on,
    // and the fix is evidence this system already recorded, not a guess.
    const recovery = await this.recoverExitFills(symbol, persistedLots, persistedRungs, openOrders);

    // Step 3 — the assertion itself.
    let verdict = assertLotSum(symbol, recovery.lots, brokerQuantity);
    let finalLots = recovery.lots;
    let finalRungs = recovery.rungs;
    let rebuildOutcome: RebuildOutcome | null = null;

    if (!verdict.reconciled) {
      // See `docs/decisions/auto-lot-rebuild.md`. Only attempted on the
      // failure this assertion itself just found — never runs against a
      // clean symbol, and never runs at all outside `PAPER`.
      rebuildOutcome = await this.attemptRebuild(
        symbol,
        recovery.lots,
        recovery.rungs,
        // Adjusted the same way `brokerQuantity` above is — `attemptRebuild`
        // re-derives the broker quantity from this array itself, and it must
        // see the same grid-adjusted figure or it would reconstruct lots for
        // shares the grid strategy already accounts for.
        this.withAdjustedQuantity(positions, symbol, brokerQuantity),
        now,
      );

      if (rebuildOutcome.applied) {
        this.rebuildsAppliedBySymbol.set(
          symbol,
          (this.rebuildsAppliedBySymbol.get(symbol) ?? 0) + 1,
        );

        // Captured before `finalLots` is reassigned — the audit row records
        // what the ladder looked like *before* the rebuild acted on it.
        const priorLotQuantity = sumHeldQuantity(recovery.lots);

        finalLots = rebuildOutcome.lots;
        finalRungs = rebuildOutcome.rungs;
        verdict = rebuildOutcome.verdict;

        // Persisted immediately rather than left for the next bar's write —
        // the same reasoning `recoverExitFills` follows: a crash between this
        // reconciliation and the first bar must not lose the rebuild and
        // strand the symbol back at the same mismatch on the next restart.
        await this.lots.saveAll(finalLots, symbol);
        await this.rungs.saveAll(finalRungs, symbol);

        // The durable audit trail for the one place reconciliation is
        // permitted to guess at (or write off) lot composition instead of
        // halting — see `docs/decisions/auto-lot-rebuild.md`. Written after
        // the lots/rungs themselves, so a failure here never loses the
        // rebuild itself; only the audit row would be missing, which
        // `reconcileSymbol`'s own log line still surfaces.
        await this.rebuildEvents.save({
          symbol,
          strategyId,
          triggerCode: HALT_LOT_SUM_MISMATCH,
          action: rebuildOutcome.action!,
          brokerQuantity: positions.find((p) => p.symbol === symbol)?.quantity ?? 0,
          brokerAverageCost: positions.find((p) => p.symbol === symbol)?.averageCost ?? 0,
          priorLotQuantity,
          resultingLots: finalLots,
          detail: rebuildOutcome.detail,
          timestamp: now,
        });
      }
    }

    if (!verdict.reconciled) {
      // Step 4 — log, alert, refuse to trade this symbol. Reached whether or
      // not a rebuild was attempted: an attempt that did not produce an exact
      // match changes nothing about the outcome here.
      return this.haltWith(
        strategyId,
        symbol,
        HALT_LOT_SUM_MISMATCH,
        verdict,
        now,
        snapshot?.version ?? null,
        recovery.recovered,
        null,
      );
    }

    // A HELD lot with no matching Rung row can never re-arm its price level
    // once it exits — the ladder loses the level rather than making it
    // fireable again. This can arise from a lot that entered the ledger
    // outside the normal fill/rebuild paths, both of which already keep a
    // lot's rung in sync (see `LotRebuildService`). Checked on every
    // reconciliation, not only on a `LOT_SUM_MISMATCH` — the sum can already
    // be exactly right while this bookkeeping link is still missing.
    const rungRepair = this.ensureRungsForHeldLots(finalLots, finalRungs);

    if (rungRepair.added.length > 0) {
      finalRungs = rungRepair.rungs;
      await this.rungs.saveAll(finalRungs, symbol);
      this.logger.warn(
        `${symbol}: backfilled a Rung row for held lot(s) ${rungRepair.added.join(', ')} — ` +
          'no rung existed at the price they hold, so the level could never have re-armed',
      );
    }

    // Reconciled. Only now is state written into the live strategy.
    const restored = this.restore(strategyId, finalLots, finalRungs, snapshot?.data ?? null);

    // Resting orders are reconciled *after* the lot-sum assertion passes, not
    // instead of it: the two answer different questions. The assertion is about
    // shares that exist; this is about orders that might yet create some.
    await this.reconcileOpenOrders(strategyId, symbol, openOrders);

    if (rebuildOutcome?.applied) {
      this.logger.warn(
        `${symbol}: LOT_SUM_MISMATCH auto-resolved via ${rebuildOutcome.action} — ` +
          `${rebuildOutcome.detail}. See docs/decisions/auto-lot-rebuild.md.`,
      );
    }

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
      recoveredExits: recovery.recovered,
      rebuildAction: rebuildOutcome?.applied ? rebuildOutcome.action : null,
    };
  }

  /**
   * Attempts `LotRebuildService` against a mismatch the assertion above just
   * found. See `docs/decisions/auto-lot-rebuild.md` for why this is safe
   * enough to run automatically in `PAPER` and nowhere else.
   *
   * Returns an unapplied outcome (never throws) when the mode gate refuses,
   * so the caller's `if (rebuildOutcome.applied)` reads the same whether the
   * attempt was skipped or genuinely failed to reconcile.
   */
  private async attemptRebuild(
    symbol: string,
    lots: Lot[],
    rungs: Rung[],
    positions: BrokerPosition[],
    now: string,
  ): Promise<RebuildOutcome> {
    const skipped: RebuildOutcome = {
      applied: false,
      action: null,
      lots,
      rungs,
      verdict: assertLotSum(
        symbol,
        lots,
        positions.find((p) => p.symbol === symbol)?.quantity ?? 0,
      ),
      detail: 'auto-rebuild not attempted',
    };

    if (this.mode !== ExecutionMode.PAPER) {
      return { ...skipped, detail: `auto-rebuild skipped — mode is ${this.mode}, not PAPER` };
    }

    // See `rebuildsAppliedBySymbol` and `docs/decisions/auto-lot-rebuild.md`
    // — a second mismatch for a symbol already auto-rebuilt this session is
    // treated as evidence of a live bug, not a second instance of the rare
    // case Tier 2 exists for, and halts for an operator to look at rather
    // than compounding another guess on top of the first.
    const priorRebuilds = this.rebuildsAppliedBySymbol.get(symbol) ?? 0;

    if (priorRebuilds > 0) {
      return {
        ...skipped,
        detail:
          `auto-rebuild skipped — ${symbol} already auto-rebuilt ${priorRebuilds} time(s) ` +
          'this session; a repeat mismatch is treated as a live bug, not synthesized again',
      };
    }

    // The shared `DIP_LADDER_CONFIG` describes one ladder — see the
    // constructor comment and the decision doc's "revisit when" note for what
    // a second symbol requires.
    if (symbol !== this.ladderConfig.symbol) {
      return { ...skipped, detail: `auto-rebuild skipped — no config registered for ${symbol}` };
    }

    const brokerPosition = positions.find((p) => p.symbol === symbol);

    // A broker reporting a nonzero position with no usable average cost is
    // malformed data, not a gap this system's own records can fill — Tier 2
    // would otherwise synthesize a lot at price zero, which reconciles the
    // *count* while recording a fill price that cannot be real.
    if ((brokerPosition?.quantity ?? 0) > 0 && (brokerPosition?.averageCost ?? 0) <= 0) {
      return {
        ...skipped,
        detail: 'auto-rebuild skipped — broker reports a position with no usable average cost',
      };
    }

    return this.rebuild.attempt({
      symbol,
      persistedLots: lots,
      persistedRungs: rungs,
      brokerQuantity: brokerPosition?.quantity ?? 0,
      brokerAverageCost: brokerPosition?.averageCost ?? 0,
      takeProfitPercent: this.ladderConfig.takeProfitPercent,
      takeProfitDollars: this.ladderConfig.takeProfitDollars,
      now,
    });
  }

  /**
   * Closes a HELD lot whose resting exit already filled at the broker but was
   * never routed live — a real, recorded `Fill` this engine simply failed to
   * apply — before the lot-sum assertion runs.
   *
   * **Why this cannot wait for `reconcileOpenOrders`.** That method only runs
   * *after* the assertion passes, because it answers a different question
   * (orders that might yet create shares) from the assertion (shares that
   * already exist). A lot stranded HELD after its exit filled is exactly the
   * assertion's failure mode — the DB is missing an exit the broker already
   * executed — so recovering it has to happen first, or the symbol halts for
   * a gap this system already has the evidence to close on its own.
   *
   * **The evidence bar, and why this is not the guess this file's own header
   * comment warns against.** A lot closes only when both hold:
   *
   * 1. its `workingOrderId` names an order that is **not** currently resting
   *    at the broker (`openOrders` says so) — something happened to it, and
   * 2. this system's `Fill` table — populated only from a real IB
   *    `execDetails` event, never synthesized — holds fill(s) for that exact
   *    `clientOrderId` summing to **exactly** the lot's quantity.
   *
   * Nothing here infers a price or invents a quantity; both come from the
   * fill itself, the same data `closeLotFromFill` would have used had the
   * live router seen it. Anything short of an exact match — no fill at all,
   * or one that does not cover the whole lot (a genuine partial exit needs
   * the live path's lot-splitting, not a guess made here) — is left
   * untouched, exactly as before this method existed: `reconcileOpenOrders`
   * below still releases a `workingOrderId` the broker confirms gone
   * *without* a matching fill (cancelled, rejected, expired), which is a
   * different, safe kind of gone.
   *
   * **A missing rung is reconstructed, not left absent.** A HELD lot with no
   * `Rung` row pointing at it (`rung.lotId === lot.id`) can happen when the
   * held-lot itself survived a gap that lost its rung row; without a row to
   * re-arm, closing the lot here would leave that price level permanently
   * unable to fire again. Rebuilt fresh at `HELD` with `completedCycles: 0` —
   * any cycle history predating the gap is unrecoverable, the same trade-off
   * `dailyBars` makes on a restart that lost its own history.
   */
  private async recoverExitFills(
    symbol: string,
    lots: Lot[],
    rungs: Rung[],
    openOrders: OpenOrder[] | null,
  ): Promise<{ lots: Lot[]; rungs: Rung[]; recovered: number }> {
    // `null` is "could not ask", not "nothing resting" — the same distinction
    // `reconcileOpenOrders` makes below, for the same reason: treating it as
    // "definitely not resting" could close a lot whose exit is still working.
    if (openOrders === null) {
      return { lots, rungs, recovered: 0 };
    }

    const restingSellIds = new Set(
      openOrders
        .filter((order) => order.symbol === symbol && order.side === 'SELL')
        .map((order) => order.clientOrderId),
    );

    let nextLots = lots;
    let nextRungs = rungs;
    let recovered = 0;

    for (const lot of lots) {
      if (lot.status !== LotStatus.HELD || !lot.workingOrderId) {
        continue;
      }

      if (restingSellIds.has(lot.workingOrderId)) {
        continue;
      }

      const exitFills = await this.fills.findByClientOrderId(lot.workingOrderId);
      const filledQuantity = exitFills.reduce((sum, fill) => sum + fill.quantity, 0);

      if (exitFills.length === 0 || filledQuantity !== lot.quantity) {
        continue;
      }

      // Several rows would mean the broker filled this one order in more than
      // one print; the exact-quantity match above already rules out a true
      // partial sitting here, so the last print is the one that completed it.
      const fill = exitFills[exitFills.length - 1];

      const closed = closeLot(lot, fill.price, fill.timestamp);
      nextLots = nextLots.map((candidate) => (candidate.id === lot.id ? closed : candidate));

      const rungIndex = nextRungs.findIndex((candidate) => candidate.lotId === lot.id);
      const heldRung: Rung =
        rungIndex === -1
          ? {
              price: lot.rungPrice,
              status: RungStatus.HELD,
              lotId: lot.id,
              workingOrderId: null,
              completedCycles: 0,
              lastExitAt: null,
            }
          : nextRungs[rungIndex];

      const rearmed = reArm(heldRung, fill.timestamp);
      nextRungs =
        rungIndex === -1
          ? [...nextRungs, rearmed]
          : nextRungs.map((candidate, index) => (index === rungIndex ? rearmed : candidate));

      recovered += 1;

      this.logger.warn(
        `${symbol}: recovered exit fill for ${lot.id} — order ${lot.workingOrderId} filled ` +
          `${fill.quantity} @ ${fill.price.toFixed(2)} but was never routed live; closed with ` +
          `realized ${((fill.price - lot.fillPrice) * lot.quantity).toFixed(2)}`,
      );
    }

    if (recovered > 0) {
      await this.lots.saveAll(nextLots, symbol);
      await this.rungs.saveAll(nextRungs, symbol);
    }

    return { lots: nextLots, rungs: nextRungs, recovered };
  }

  /**
   * Reconciles the rung ledger and the held-lot exits against orders actually
   * resting at the broker.
   *
   * **This is what makes a restart safe.** The ladder's `WORKING` rungs and
   * its held lots' `workingOrderId`s are a record of orders this engine
   * placed; the broker's open-order list is the record of which of them still
   * exist. They diverge in both directions, and each direction is dangerous
   * in its own way:
   *
   * - **A `WORKING` rung, or a held lot, with no order at IB** — the DAY
   *   order expired overnight, or was cancelled in TWS. Left as-is the rung
   *   is blocked forever and the ladder silently stops laddering, or the lot
   *   is permanently unprotected: with `workingOrderId` still set it can
   *   never be diagnosed as `missing`, so `place-missing` can never rest a
   *   fresh exit for it. Released — the rung to fireable, the lot to a bare
   *   `workingOrderId: null` a future diagnosis can pick up.
   *
   *   By the time this runs, `recoverExitFills` above has already closed any
   *   held lot whose "gone" order turned out to be a fill this system had on
   *   record — so a lot reaching this branch is one whose order is gone
   *   *without* a matching fill: genuinely cancelled, rejected, or expired.
   * - **A BUY order at IB with no `WORKING` rung** — the crash window: the
   *   order reached IB but the process died before persisting the rung.
   *   Adopted, so the ladder knows the level is taken. Without this the next
   *   bar places a *second* order at the same price and both fill. The SELL
   *   equivalent is adopted separately, by `EngineService.adoptWorkingOrders`
   *   keying off the lot rather than a price — see its own doc comment.
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
    if (openOrders === null) {
      this.logger.warn(
        `${symbol}: open orders could not be read from the broker — resting-order state ` +
          'left as persisted. A rung whose order expired will stay blocked until the next ' +
          'successful reconciliation.',
      );

      return;
    }

    if (!state) {
      // Disabled, not halted. There is no rung ledger to release (nothing
      // places a BUY for a disabled strategy) and no live state to adopt an
      // orphan into — but a HELD lot's stale `workingOrderId` is exactly as
      // real a gap as it is for an enabled strategy: once its DAY sell
      // expires at the close, leaving the mark set means `diagnose()` keeps
      // reporting it `UNBACKED` forever rather than `missing`, and
      // `POST /orders/place-missing` never gets a candidate to rest a fresh
      // one against. See `DisabledStrategyProtectionService`, which depends
      // on this release having already happened before it diagnoses.
      await this.releaseStaleDisabledSells(symbol, openOrders);
      return;
    }

    const rungs = DipLadderStrategy.rungsOf(state) ?? [];
    const lots = DipLadderStrategy.lotsOf(state) ?? [];
    const restingForSymbol = openOrders.filter((order) => order.symbol === symbol);
    const restingBuyIds = new Set(
      restingForSymbol.filter((order) => order.side === 'BUY').map((order) => order.clientOrderId),
    );
    const restingSellIds = new Set(
      restingForSymbol.filter((order) => order.side === 'SELL').map((order) => order.clientOrderId),
    );

    let released = 0;

    for (const rung of rungs) {
      if (rung.workingOrderId && !restingBuyIds.has(rung.workingOrderId)) {
        DipLadderStrategy.clearWorkingOrder(state, rung.workingOrderId);
        released += 1;
      }
    }

    // The SELL-side counterpart to the rung release above. A held lot's
    // `workingOrderId` is stale in exactly the same way a rung's is — the DAY
    // order expired, or an operator cancelled it in TWS — and left unreleased
    // the lot can never again be diagnosed as `missing`, so `place-missing` can
    // never rest a fresh exit for it. See "Orders the engine could not learn
    // the fate of" — this is the gap that leaves a held lot permanently
    // unprotected once its exit is cancelled out of band.
    for (const lot of lots) {
      if (
        lot.status === LotStatus.HELD &&
        lot.workingOrderId &&
        !restingSellIds.has(lot.workingOrderId)
      ) {
        DipLadderStrategy.clearWorkingOrder(state, lot.workingOrderId);
        released += 1;
      }
    }

    const knownIds = new Set(
      rungs.map((rung) => rung.workingOrderId).filter((id): id is string => Boolean(id)),
    );
    const orphans = restingForSymbol.filter(
      (order) => order.side === 'BUY' && !knownIds.has(order.clientOrderId),
    );

    for (const orphan of orphans) {
      DipLadderStrategy.recordWorkingOrder(state, orphan.limitPrice, orphan.clientOrderId);
    }

    if (released > 0 || orphans.length > 0) {
      this.logger.log(
        `${symbol}: open-order reconciliation — released ${released} rung/lot working-order ` +
          `mark(s) whose order is no longer at the broker, adopted ${orphans.length} resting ` +
          'order(s) the ladder had no record of',
      );
    }

    // The engine's in-memory working-order registry is rebuilt from what the
    // broker actually holds, so a fill on an adopted order finds its rung.
    this.onOpenOrdersReconciled?.(strategyId, symbol, restingForSymbol);
  }

  /**
   * The disabled-strategy counterpart to the SELL-side release above —
   * operates on the persisted `Lot` row directly since there is no live
   * state to mutate. Never adopts an orphan BUY (a disabled strategy places
   * none) and never touches rungs (bar-driven bookkeeping with no meaning
   * for a strategy nothing is running — see `OrderDiagnosisService`'s
   * "diagnosed from the database" section for the same reasoning applied to
   * reads rather than writes).
   */
  private async releaseStaleDisabledSells(symbol: string, openOrders: OpenOrder[]): Promise<void> {
    const lots = await this.lots.findBySymbol(symbol);
    const restingSellIds = new Set(
      openOrders
        .filter((order) => order.symbol === symbol && order.side === 'SELL')
        .map((order) => order.clientOrderId),
    );

    let released = 0;
    const updated = lots.map((lot) => {
      if (
        lot.status === LotStatus.HELD &&
        lot.workingOrderId &&
        !restingSellIds.has(lot.workingOrderId)
      ) {
        released += 1;
        return { ...lot, workingOrderId: null };
      }

      return lot;
    });

    if (released > 0) {
      await this.lots.saveAll(updated, symbol);
      this.logger.log(
        `${symbol}: released ${released} disabled-strategy lot working-order mark(s) whose sell ` +
          'is no longer at the broker',
      );
    }
  }

  /**
   * Backfills a `HELD` rung for any lot whose `rungPrice` has no matching
   * `Rung` row, and returns the untouched array (same reference) when there
   * is nothing to add — so a caller can skip the persist/log entirely on the
   * ordinary case.
   *
   * Deliberately narrower than `LotRebuildService`: it never invents a
   * quantity, a price, or a lot — every fact used here (`lot.rungPrice`,
   * `lot.id`) is already trusted, sourced from a lot this reconciliation just
   * accepted as correct. That is what makes it safe to run in every mode,
   * unlike the Tier 1/Tier 2 rebuild, which is gated to `PAPER`
   * (`docs/decisions/auto-lot-rebuild.md`) precisely because it *does* guess
   * at composition.
   *
   * A rung that exists at the price but disagrees with the lot (wrong
   * `lotId`, or a status other than `HELD`) is left alone rather than
   * overwritten — that is a genuine conflict between two records that both
   * claim to be authoritative, and guessing which one is stale is exactly the
   * kind of silent correction this reconciliation path refuses to make
   * elsewhere.
   */
  private ensureRungsForHeldLots(lots: Lot[], rungs: Rung[]): { rungs: Rung[]; added: string[] } {
    const byPrice = new Map(rungs.map((rung) => [rung.price, rung]));
    const added: string[] = [];

    for (const lot of lots) {
      if (lot.status !== LotStatus.HELD || byPrice.has(lot.rungPrice)) {
        continue;
      }

      byPrice.set(lot.rungPrice, {
        price: lot.rungPrice,
        status: RungStatus.HELD,
        lotId: lot.id,
        workingOrderId: null,
        completedCycles: 0,
        lastExitAt: null,
      });
      added.push(lot.id);
    }

    return added.length > 0 ? { rungs: [...byPrice.values()], added } : { rungs, added };
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
      data.sessionHigh = numberOrNull(snapshotData.sessionHigh);
      data.sessionLow = numberOrNull(snapshotData.sessionLow);
      data.sessionCloseAt =
        typeof snapshotData.sessionCloseAt === 'string' ? snapshotData.sessionCloseAt : null;
      // ATR's daily-bar history, restored the same lightweight way as every
      // other scalar here: not deeply validated (nothing else in this method
      // is either), just type-checked well enough that a malformed or missing
      // value degrades to empty rather than crashing the first ATR lookup. An
      // empty result is not a fault — it is the same "insufficient history"
      // fallback a cold start already produces (`spacing.ts`), so a restart
      // that loses this array trades a warm-up period, not a failure.
      data.dailyBars = (
        Array.isArray(snapshotData.dailyBars) ? snapshotData.dailyBars : []
      ) as DipLadderStateData['dailyBars'];
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
    recoveredExits: number,
    rebuildAction: RebuildAction | null,
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
      // Reported even on a halt: `verdict` above was computed from the
      // post-recovery lots, so a symbol that still does not reconcile after
      // recovery genuinely has a second, different problem — this says
      // recovery was not silently skipped.
      recoveredExits,
      // Always null here: `haltWith` is only reached when nothing reconciled,
      // and `RebuildOutcome.applied` is what would have made it reconcile.
      rebuildAction,
    };
  }

  /**
   * Shares of `symbol` already claimed by the grid strategy's own held lots —
   * the ladder's lot sum only has to explain what remains.
   *
   * **Why this must not fail open.** A read that threw and was swallowed to
   * `0` would let the ladder treat every grid-held share as its own to
   * explain, which can silently produce a false `MATCHED` verdict — the exact
   * "unknown must halt, not resume" failure the lot-sum assertion otherwise
   * refuses to make (`lot-sum-assertion.ts`'s own header comment). The grid
   * lot table is a plain database read, not a broker call, so it is not
   * wrapped the way `brokerPositions`/`brokerOpenOrders` are — a failure here
   * propagates and fails the whole reconciliation loudly, the same way a
   * failed `this.lots.findBySymbol` read already does above.
   */
  private async siblingHeldQuantity(symbol: string): Promise<number> {
    const held = await this.gridLots.findHeld(`${GRID_ID_PREFIX}${symbol}`);
    return held.reduce((sum, lot) => sum + lot.quantity, 0);
  }

  /**
   * Substitutes `symbol`'s reported quantity in a broker position list —
   * used to carry the grid-adjusted figure into `attemptRebuild`, which
   * re-derives its own broker quantity from the array rather than accepting
   * one directly.
   */
  private withAdjustedQuantity(
    positions: BrokerPosition[],
    symbol: string,
    quantity: number,
  ): BrokerPosition[] {
    if (!positions.some((p) => p.symbol === symbol)) {
      // No entry to adjust. Only reachable when the grid strategy claims
      // shares the broker does not report for this symbol at all — already a
      // genuine divergence the assertion above will halt on regardless, so a
      // placeholder entry is only there to keep `attemptRebuild`'s own lookup
      // consistent with the mismatch just found, not to fabricate a position.
      return quantity === 0 ? positions : [...positions, { symbol, quantity, averageCost: 0 }];
    }

    return positions.map((p) => (p.symbol === symbol ? { ...p, quantity } : p));
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
