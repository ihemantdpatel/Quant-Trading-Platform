/**
 * The engine's read and control API (`stories.md:387`).
 *
 * Read endpoints project state the engine already holds; they compute nothing
 * the engine does not, so the dashboard and a `curl` see exactly the same
 * numbers the strategy decided on.
 *
 * Control endpoints are deliberately few and deliberately explicit. Every one
 * of them is an operator action with a recorded reason — there is no endpoint
 * that liquidates, and no endpoint that can set a capital or loss-threshold
 * value (those are Story 13, and `POST /mode` refuses PAPER while they are
 * unset rather than inventing them).
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { BROKER_ADAPTER, BrokerAdapter } from '../broker/broker-adapter.interface';
import { IBBrokerAdapter } from '../broker/ib/ib-broker.adapter';
import { AppConfigService } from '../config/app-config.service';
import { ExecutionMode } from '../config/execution-mode';
import { EngineService } from '../engine/engine.service';
import { GridReconciliationService } from '../reconciliation/grid-reconciliation.service';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import {
  DuplicateOrderService,
  OrderDiagnosisService,
} from '../reconciliation/order-diagnosis.service';
import { SymbolHaltService } from '../reconciliation/symbol-halt.service';
import { KillSwitchService } from '../risk/kill-switch.service';
import { RISK_CONFIG, SYMBOL_CAPITAL } from '../risk/risk.module';
import { RiskConfig } from '../risk/risk.config';
import { evaluateStartupAssertions, SymbolCapital } from '../risk/startup-assertions';
import { CoordinatorService } from '../strategies/coordinator.service';
import { DIP_LADDER_ID_PREFIX } from '../strategies/dip-ladder/dip-ladder.strategy';
import { Rung, RungStatus } from '../strategies/dip-ladder/rung';
import { Lot, LotStatus } from '../strategies/dip-ladder/lot';
import { GRID_ID_PREFIX } from '../strategies/grid/grid.strategy';
import { GridLot, GridLotStatus } from '../strategies/grid/lot';
import {
  FILL_REPOSITORY,
  FillRepository,
  GRID_LOT_REPOSITORY,
  GridLotRepository,
  LOT_REPOSITORY,
  LotRepository,
  ORDER_INTENT_REPOSITORY,
  ORDER_REPOSITORY,
  OrderIntentRepository,
  OrderRepository,
  RISK_EVENT_REPOSITORY,
  RiskEventRepository,
  RUNG_REPOSITORY,
  RungRepository,
} from '../repositories/repository.interfaces';
import { STORAGE_MODE, StorageMode } from '../repositories/repositories.module';
import { isFixtureName } from '../market-data/mock/fixtures';

/**
 * The symbol a lot belongs to, recovered from its id (`${symbol}-lot-N`).
 *
 * A `Lot` carries no symbol field of its own — the id is the record of it —
 * so this is the only way to tell whose ladder a lot came from.
 */
function symbolOfLot(lot: Lot): string {
  return lot.id.split('-lot-')[0];
}

/**
 * Why a row was served from the database instead of live strategy state.
 *
 * `HALTED` — a reconciliation mismatch stopped this symbol; `haltWith`
 * deliberately restores nothing into strategy state, so the database is the
 * only place the position still exists.
 *
 * `DISABLED` — the strategy that traded this symbol is not currently
 * enabled, so nothing initialized its live state this boot
 * (`initializeAll` only initializes enabled strategies). A real broker
 * position it opened before being switched off does not stop existing just
 * because the strategy is off, and would otherwise render as flat — not
 * halted, so outside the halted fallback, and absent from live state, so
 * absent from the live read too.
 *
 * Either way trading is unaffected — a halt already refuses to trade, and a
 * disabled strategy processes no bars — only the *visibility* of a real
 * position differs from the "verified against the broker this boot" case.
 */
type UnverifiedReason = 'HALTED' | 'DISABLED';

/** A lot as the dashboard renders it, including derived display fields. */
interface LotView {
  id: string;
  symbol: string;
  rungPrice: number;
  fillPrice: number;
  quantity: number;
  openedAt: string;
  exitTarget: number;
  status: LotStatus;
  closedAt: string | null;
  exitPrice: number | null;
  /** Realized P&L for a closed lot, null while held. */
  realized: number | null;
  /**
   * True when this row came from the database rather than live strategy
   * state — see `UnverifiedReason`.
   *
   * Carried per row rather than as a response-level flag because both halts
   * and disablement are per-symbol: one affected symbol must not label
   * another symbol's live lots as unverified. The dashboard uses it to say
   * *why* the numbers may disagree with the broker.
   */
  unverified: boolean;
  /** Why, when `unverified` is true. Null otherwise. */
  unverifiedReason: UnverifiedReason | null;
}

/** A rung as the dashboard renders it. `unverified`/`unverifiedReason` as in `LotView`. */
interface RungView {
  price: number;
  status: RungStatus;
  lotId: string | null;
  workingOrderId: string | null;
  completedCycles: number;
  lastExitAt: string | null;
  held: boolean;
  fireable: boolean;
  unverified: boolean;
  unverifiedReason: UnverifiedReason | null;
}

/**
 * A grid lot as the dashboard renders it — deliberately shaped like `LotView`
 * (`exitTarget` rather than `sellTarget`, no `rungPrice`) so the same table
 * component can render either strategy's lots without an adapter.
 *
 * `workingOrderId` is exposed for the same reason `RungView` exposes it: it
 * joins a held lot with no resting sell to its finding in `GET
 * /orders/diagnosis`, and to its row in `GET /orders`.
 */
interface GridLotView {
  id: string;
  symbol: string;
  fillPrice: number;
  quantity: number;
  openedAt: string;
  exitTarget: number;
  status: GridLotStatus;
  closedAt: string | null;
  exitPrice: number | null;
  realized: number | null;
  workingOrderId: string | null;
  unverified: boolean;
  unverifiedReason: UnverifiedReason | null;
}

@Controller()
export class EngineController {
  constructor(
    private readonly engine: EngineService,
    private readonly coordinator: CoordinatorService,
    private readonly killSwitch: KillSwitchService,
    private readonly reconciliation: ReconciliationService,
    private readonly gridReconciliation: GridReconciliationService,
    private readonly orderDiagnosis: OrderDiagnosisService,
    private readonly duplicateOrders: DuplicateOrderService,
    private readonly symbolHalts: SymbolHaltService,
    private readonly appConfig: AppConfigService,
    @Inject(BROKER_ADAPTER) private readonly broker: BrokerAdapter,
    @Inject(ORDER_INTENT_REPOSITORY) private readonly intents: OrderIntentRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(FILL_REPOSITORY) private readonly fills: FillRepository,
    // Read-only, and only for halted symbols: a halt restores nothing into
    // strategy state, so these tables are the *only* place that symbol's lots
    // and rungs still exist. See `getLots`.
    @Inject(LOT_REPOSITORY) private readonly lotRepository: LotRepository,
    @Inject(RUNG_REPOSITORY) private readonly rungRepository: RungRepository,
    // Read-only, and only for a halted symbol — the grid counterpart to
    // `lotRepository` above. See `getGridLots`.
    @Inject(GRID_LOT_REPOSITORY) private readonly gridLotRepository: GridLotRepository,
    @Inject(RISK_EVENT_REPOSITORY) private readonly riskEvents: RiskEventRepository,
    @Inject(STORAGE_MODE) private readonly storageMode: StorageMode,
    @Inject(RISK_CONFIG) private readonly riskConfig: RiskConfig,
    @Inject(SYMBOL_CAPITAL) private readonly symbolCapital: SymbolCapital,
  ) {}

  /**
   * Runs a fixture through the full engine path.
   *
   * Explicit rather than automatic on boot: nothing should happen in a system
   * whose default posture is "submit nothing" until an operator asks for it,
   * and an explicit trigger is re-runnable and testable.
   */
  @Post('engine/replay')
  @HttpCode(HttpStatus.OK)
  async replay(@Body() body: { fixture?: string }): Promise<unknown> {
    const fixture = body?.fixture;

    if (!fixture || !isFixtureName(fixture)) {
      throw new UnprocessableEntityException(
        `unknown fixture "${fixture ?? ''}" — see market-data/mock/fixtures`,
      );
    }

    return this.engine.replayFixture(fixture);
  }

  @Post('engine/reset')
  @HttpCode(HttpStatus.OK)
  async reset(): Promise<{ reset: true }> {
    await this.engine.reset();
    return { reset: true };
  }

  @Get('intents')
  async getIntents(): Promise<unknown[]> {
    return this.intents.findAll();
  }

  @Get('orders')
  async getOrders(): Promise<unknown[]> {
    return this.orders.findAll();
  }

  @Get('fills')
  async getFills(): Promise<unknown[]> {
    return this.fills.findAll();
  }

  /**
   * Lots with their **individual** targets — the per-lot view the whole design
   * exists to make possible. Blended average cost is deliberately *not* here;
   * it is display-only and belongs on a view that can label it "reference only"
   * (`PRD.md:386`).
   */
  @Get('lots')
  async getLots(): Promise<LotView[]> {
    // A halted symbol restored from the database has an **empty** ladder in
    // memory: `haltWith` restores nothing, deliberately, so the exit path can
    // never read composition nobody verified. A *disabled* ladder is the same
    // shape of gap from a different cause — `initializeAll` only initializes
    // enabled strategies, so a symbol the ladder traded before being switched
    // off is just as absent from live state. Both are right for trading and
    // wrong for looking — either blanks the very panel an operator opens to
    // check what a symbol is actually holding.
    //
    // Serving the persisted rows is read-only and cannot reach a strategy:
    // nothing is written back into the coordinator, so `processBar` still
    // returns before `dispatchBar` and the symbol still trades in neither
    // direction (or not at all, if disabled). Only visibility changes.
    //
    // The persisted rows **replace** a fallback symbol's live rows rather
    // than adding to them — a halt raised mid-session leaves the ladder
    // populated in memory, so appending would show every lot twice. One
    // authority per symbol: halted or disabled → the database, otherwise →
    // the ladder.
    const fallback = this.fallbackSymbols(DIP_LADDER_ID_PREFIX);
    const live = this.engine
      .ladderLots()
      .filter((lot) => !fallback.has(symbolOfLot(lot)))
      .map((lot) => this.toLotView(lot, null));

    return [...live, ...(await this.fallbackLots(fallback))];
  }

  /**
   * The union of a strategy's halted symbols and its disabled ones, each
   * tagged with why — the set `getLots`/`getRungs`/`getGridLots` must read
   * from the database instead of live state.
   *
   * A symbol reaches `DISABLED` only when the matching strategy is
   * registered under `prefix` with no live state at all this boot — a
   * strategy that traded and was then halted still carries live state (it is
   * simply not used for that symbol's view), so the two sets do not overlap
   * in practice. The halted check runs first regardless, so a halt's reason
   * always wins if they ever did.
   */
  private fallbackSymbols(prefix: string): Map<string, UnverifiedReason> {
    const fallback = new Map<string, UnverifiedReason>();

    for (const symbol of this.symbolHalts.haltedSymbols()) {
      fallback.set(symbol, 'HALTED');
    }

    for (const snapshot of this.coordinator.snapshots()) {
      const symbol = snapshot.symbols[0];

      if (snapshot.id.startsWith(prefix) && !snapshot.state && symbol && !fallback.has(symbol)) {
        fallback.set(symbol, 'DISABLED');
      }
    }

    return fallback;
  }

  /**
   * Persisted lots for every fallback symbol, flagged `unverified`.
   *
   * A failed read degrades to `[]` rather than throwing. The live rows above
   * are already in hand, and a database hiccup must not blank the panel for
   * the symbols that *are* healthy — that is the coupling this whole change
   * exists to remove.
   */
  private async fallbackLots(fallback: Map<string, UnverifiedReason>): Promise<LotView[]> {
    const views: LotView[] = [];

    for (const [symbol, reason] of fallback) {
      try {
        const lots = await this.lotRepository.findBySymbol(symbol);
        views.push(...lots.map((lot) => this.toLotView(lot, reason)));
      } catch {
        // Reported by the halt banner already; an empty section is not worth
        // failing the whole read for.
      }
    }

    return views;
  }

  private toLotView(lot: Lot, unverifiedReason: UnverifiedReason | null): LotView {
    return {
      id: lot.id,
      symbol: symbolOfLot(lot),
      rungPrice: lot.rungPrice,
      fillPrice: lot.fillPrice,
      quantity: lot.quantity,
      openedAt: lot.openedAt,
      exitTarget: lot.exitTarget,
      status: lot.status,
      closedAt: lot.closedAt,
      exitPrice: lot.exitPrice,
      realized:
        lot.status === LotStatus.CLOSED && lot.exitPrice !== null
          ? Math.round((lot.exitPrice - lot.fillPrice) * lot.quantity * 100) / 100
          : null,
      unverified: unverifiedReason !== null,
      unverifiedReason,
    };
  }

  /** Rungs distinguishing held / working / re-armed / pending with their prices. */
  @Get('rungs')
  async getRungs(): Promise<RungView[]> {
    // Same reasoning as `getLots`, including the substitution: a fallback
    // symbol's rungs come from the database and its in-memory rungs are
    // dropped, so a mid-session halt (or the ladder being disabled) cannot
    // render the ladder twice.
    const fallback = this.fallbackSymbols(DIP_LADDER_ID_PREFIX);
    const live = this.engine
      .ladderRungsBySymbol()
      .filter(({ symbol }) => !fallback.has(symbol))
      .flatMap(({ rungs }) => rungs.map((rung) => this.toRungView(rung, null)));

    return [...live, ...(await this.fallbackRungs(fallback))];
  }

  private async fallbackRungs(fallback: Map<string, UnverifiedReason>): Promise<RungView[]> {
    const views: RungView[] = [];

    for (const [symbol, reason] of fallback) {
      try {
        const rungs = await this.rungRepository.findBySymbol(symbol);
        views.push(...rungs.map((rung) => this.toRungView(rung, reason)));
      } catch {
        // As in `fallbackLots` — degrade to omitting this symbol's rungs.
      }
    }

    return views;
  }

  private toRungView(rung: Rung, unverifiedReason: UnverifiedReason | null): RungView {
    return {
      price: rung.price,
      status: rung.status,
      lotId: rung.lotId,
      // The handle for the order resting at this level. Exposed so the dashboard
      // can join a working rung to its row in `GET /orders` — without it the two
      // views show the same order twice with nothing tying them together.
      workingOrderId: rung.workingOrderId,
      completedCycles: rung.completedCycles,
      lastExitAt: rung.lastExitAt,
      held: rung.status === RungStatus.HELD,
      // Mirrors `selectFireableRung`: a rung with an order resting at the broker
      // holds no lot but must not fire again. Deriving this from `status !== HELD`
      // alone would report a WORKING rung as fireable and tell an operator the
      // ladder is armed at a level where an order is already committed.
      //
      // Always false for an unverified row: the symbol is halted or the
      // ladder disabled, so no level is armed regardless of what the
      // persisted ledger says.
      fireable: unverifiedReason === null && rung.lotId === null && !rung.workingOrderId,
      unverified: unverifiedReason !== null,
      unverifiedReason,
    };
  }

  /**
   * Grid lots — the grid counterpart to `GET /lots`.
   *
   * Same fallback substitution as `getLots`: a halt, or the grid strategy
   * being disabled, restores nothing into its live state either, so an
   * affected symbol's lots are served from `GridLot` instead, flagged
   * `unverified`.
   *
   * There is no grid counterpart to `GET /rungs` — the strategy keeps no
   * persisted level ledger to project (see `GridStrategy`'s own doc comment).
   */
  @Get('grid/lots')
  async getGridLots(): Promise<GridLotView[]> {
    const fallback = this.fallbackSymbols(GRID_ID_PREFIX);
    const live = this.engine
      .gridLotsBySymbol()
      .filter(({ symbol }) => !fallback.has(symbol))
      .flatMap(({ symbol, lots }) => lots.map((lot) => this.toGridLotView(lot, symbol, null)));

    return [...live, ...(await this.fallbackGridLots(fallback))];
  }

  /**
   * Persisted grid lots for every fallback symbol, flagged `unverified`.
   *
   * `GridLotRepository` is keyed by `strategyId`, not `symbol` — reconstructed
   * here as `grid:${symbol}`, the same convention `GridStrategy`'s own
   * constructor uses, since one grid instance trades exactly one symbol.
   */
  private async fallbackGridLots(fallback: Map<string, UnverifiedReason>): Promise<GridLotView[]> {
    const views: GridLotView[] = [];

    for (const [symbol, reason] of fallback) {
      try {
        const lots = await this.gridLotRepository.findByStrategy(`${GRID_ID_PREFIX}${symbol}`);
        views.push(...lots.map((lot) => this.toGridLotView(lot, symbol, reason)));
      } catch {
        // As in `fallbackLots` — degrade to omitting this symbol's grid lots.
      }
    }

    return views;
  }

  private toGridLotView(
    lot: GridLot,
    symbol: string,
    unverifiedReason: UnverifiedReason | null,
  ): GridLotView {
    return {
      id: lot.id,
      symbol,
      fillPrice: lot.fillPrice,
      quantity: lot.quantity,
      openedAt: lot.openedAt,
      exitTarget: lot.sellTarget,
      status: lot.status,
      closedAt: lot.closedAt,
      exitPrice: lot.exitPrice,
      realized:
        lot.status === GridLotStatus.CLOSED && lot.exitPrice !== null
          ? Math.round((lot.exitPrice - lot.fillPrice) * lot.quantity * 100) / 100
          : null,
      workingOrderId: lot.workingOrderId,
      unverified: unverifiedReason !== null,
      unverifiedReason,
    };
  }

  @Get('positions')
  async getPositions(): Promise<unknown[]> {
    // Broker-reported: net quantity and average cost, nothing more. Lot
    // composition comes from `GET /lots` — the two are reconciled at Story 9.
    try {
      return await this.broker.getPositions();
    } catch (error) {
      // 503 rather than 500: "the broker cannot answer right now" is a
      // temporary upstream condition, not a bug in this endpoint, and the
      // dashboard renders it as an unavailable *panel* instead of a failed
      // page. Deliberately not `[]` — that would report a flat account during
      // an outage, which is the one answer worse than an error.
      throw new ServiceUnavailableException(
        `positions unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  @Get('risk-events')
  async getRiskEvents(): Promise<unknown[]> {
    return this.riskEvents.findAll();
  }

  @Get('strategies')
  getStrategies(): unknown[] {
    return this.coordinator.snapshots().map((snapshot) => ({
      id: snapshot.id,
      enabled: snapshot.enabled,
      symbols: snapshot.symbols,
      initialized: snapshot.initialized,
    }));
  }

  /** Mode, connection health, and every active halt in one place. */
  @Get('status')
  getStatus(): unknown {
    const health = this.broker.connectionHealth();

    return {
      mode: this.appConfig.executionMode,
      // Whether this process is writing to MySQL or to memory (Story 8).
      // Reported rather than inferred from deployment config: "will my ladder
      // state survive a restart" is not a question an operator should have to
      // answer by reading a compose file.
      storage: this.storageMode,
      broker: {
        name: this.broker.name,
        connected: this.broker.isConnected(),
        state: health.state,
        reconnectAttempts: health.reconnectAttempts,
        lastError: health.lastError,
        // Story 10 additions, present only when trading through IB. Pacing is
        // surfaced because breaching IB's limits produces no error of its own —
        // a queue that is filling up is the only early warning there is, and it
        // is invisible unless reported. Staleness is surfaced because a
        // connected socket that stopped delivering bars looks healthy in every
        // other field here (`PRD.md:314`).
        ...(this.broker instanceof IBBrokerAdapter
          ? {
              pacing: this.broker.pacingStats(),
              dataStale: this.broker.isDataStale(),
              lastBarAt: this.broker.lastBarAt(),
              // The last bar close per symbol, so the dashboard can show the
              // price the ladder is actually evaluating against. Carried on
              // `/status` rather than a route of its own because the shell
              // already fetches this on every tab and polls it — a second
              // endpoint would double the request rate to report one number.
              lastPrices: this.broker.lastPrices(),
              // Why the feed is silent, next to the fact that it is. IB rejects
              // an unentitled data request and then delivers nothing, which
              // leaves every other field here reading healthy — so without this
              // the cause was visible only in the container log.
              dataErrors: this.broker.dataErrorList(),
            }
          : {}),
      },
      halts: {
        killSwitch: this.killSwitch.snapshot(),
        dailyLossBreaker: { halted: false },
        entryHalt: {
          halted: this.engine.isHalted(),
          reason: this.engine.haltReason(),
        },
        // Per-symbol reconciliation halts (`stories.md:543`). Separate from
        // `entryHalt` because they mean something stricter: a symbol here
        // trades in neither direction until an operator resolves it.
        symbols: this.symbolHalts.active(),
      },
      // What the startup reconciliation concluded. Null before it has run —
      // which an operator should be able to see, rather than reading absence
      // as success.
      reconciliation: this.reconciliation.lastReconciliation(),
      // The post-close job's last run. Null until it has fired — an operator
      // must be able to tell "scheduled but not yet due" from "ran and found
      // nothing", which absence alone cannot express.
      orderReconciliation: this.reconciliation.lastOrderReconcile(),
      // The grid strategy's own reports, reported separately rather than
      // merged into the two fields above — its verdict shape differs from
      // the ladder's, and collapsing them would either lose which strategy a
      // finding belongs to or silently prefer one over the other.
      gridReconciliation: this.gridReconciliation.lastReconciliation(),
      gridOrderReconciliation: this.gridReconciliation.lastOrderReconcile(),
      // **Active alerts only.** A resolved alert is history, and rendering it
      // as a live banner told an operator the engine was halted when it had
      // already recovered. The full record, resolved rows included, is at
      // `GET /alerts`.
      alerts: this.engine.activeAlerts(),
      strategies: this.coordinator.snapshots().map((s) => ({ id: s.id, enabled: s.enabled })),
    };
  }

  /**
   * Engages or releases the kill switch.
   *
   * Effective within one evaluation cycle, because the risk manager reads it at
   * the top of every `evaluate()` (`PRD.md:492`). There is no queue to drain.
   */
  @Post('kill-switch')
  @HttpCode(HttpStatus.OK)
  killSwitchControl(@Body() body: { engaged?: boolean; reason?: string }): unknown {
    const reason = body?.reason ?? 'operator action via API';
    const at = new Date().toISOString();

    if (body?.engaged === false) {
      this.killSwitch.release(reason, at);
    } else {
      this.killSwitch.engage(reason, at);
    }

    return this.killSwitch.snapshot();
  }

  /** Every active reconciliation halt, for the dashboard's alert surface. */
  /**
   * Re-runs the full startup reconciliation on demand.
   *
   * **Why this exists as a manual control.** `reconcileOpenOrders` is already
   * the designated repair for a rung whose order no longer exists at the
   * broker — a DAY order that expired, or one cancelled by hand in TWS. Until
   * now the only way to reach it was to restart the daemon, because
   * `StartupSequence` was its sole caller. An operator who cancels an order in
   * TWS and then watches the dashboard keep showing the rung as `WORKING` has
   * no way to correct it short of a restart, which is a poor answer during a
   * live session.
   *
   * **This is the full sequence, not just the open-order half**, and the
   * difference matters before pressing it. It re-runs the lot-sum assertion and
   * therefore **can halt symbols**, and it restores lots and rungs from the
   * database over whatever is in memory. At startup that restore writes into an
   * empty ladder; here it can overwrite live state with the last persisted
   * copy. Since the live path persists per bar (`BarConsumer.persistState`) the
   * two are normally identical, but a symbol whose persistence is suppressed by
   * an existing halt is exactly where they are not — which is the case an
   * operator is most likely to be reaching for this control to fix.
   *
   * It deliberately does **not** connect the broker or re-initialize
   * strategies: those are boot concerns, and re-initializing would discard the
   * live ladder rather than reconcile it. An unreachable broker still halts
   * every symbol here, exactly as it does at startup, because `null` positions
   * mean "unknown" and unknown may not resume.
   *
   * No order is ever cancelled and no position is ever traded by this route —
   * `reconcileAll` has no path to either, which is what makes exposing it to a
   * button acceptable.
   *
   * **Runs the grid strategy's own `reconcileAll` too, merged into the
   * response the dashboard already reads.** `ui/app/actions.ts` parses
   * `clean`/`haltedSymbols`/`symbols`/`ordersUpdated` off the top level of
   * this response, so adding a second, differently-shaped reconciler must not
   * silently stop being reflected in the fields it already reads — merging
   * rather than nesting keeps that contract intact. The full, separately-typed
   * reports are still included under `ladder`/`grid` for a caller that wants
   * the per-strategy detail the merge cannot express (each verdict shape
   * differs). Sequential, not parallel: two independent, infrequent operator
   * actions against one broker connection, not a path where their latency is
   * worth racing.
   */
  @Post('reconcile')
  @HttpCode(HttpStatus.OK)
  async reconcile(): Promise<unknown> {
    const now = new Date().toISOString();
    const ladder = await this.reconciliation.reconcileAll(now);
    const grid = await this.gridReconciliation.reconcileAll(now);

    return {
      ranAt: now,
      clean: ladder.clean && grid.clean,
      haltedSymbols: [...ladder.haltedSymbols, ...grid.haltedSymbols],
      symbols: [...ladder.symbols, ...grid.symbols],
      ordersUpdated: ladder.ordersUpdated,
      recoveredExits: ladder.recoveredExits + grid.recoveredExits,
      rebuildsApplied: ladder.rebuildsApplied,
      ladder,
      grid,
    };
  }

  /**
   * Reports what rests at the broker against what the ladder believes rests.
   *
   * **Read-only, and deliberately separate from `POST /reconcile`.** Asking
   * reconciliation "what is wrong" changes the answer — it releases rungs,
   * adopts orphans, restores state, and can halt a symbol on the lot-sum
   * assertion. An operator deciding whether to intervene needs to see the
   * divergence *before* anything acts on it, which is what this provides.
   *
   * A GET because it has no effect: nothing here writes state, places an
   * order, or cancels one.
   */
  @Get('orders/diagnosis')
  async diagnoseOrders(): Promise<unknown> {
    return this.orderDiagnosis.diagnose(new Date().toISOString());
  }

  /**
   * Places resting orders for gaps the diagnosis identified.
   *
   * **This creates orders, and it is the only route that does.** Two properties
   * make it safe to expose:
   *
   * - **It acts only on diagnosed gaps**, never on an empty book. A ladder
   *   resting nothing is not evidence of a fault — a flat ladder with no
   *   fireable rung correctly rests nothing — so candidates come from a
   *   specific claim the ladder makes and the broker contradicts: a HELD lot
   *   with no resting sell, or a fireable rung with no resting buy. The
   *   diagnosis is re-run inside the call, so a stale preview cannot place an
   *   order the ladder no longer wants.
   * - **It bypasses nothing.** Each candidate crosses
   *   `RiskManagerService.evaluate()` exactly as a bar-generated intent does,
   *   so the capital caps, the loss breaker, and the kill switch all apply. An
   *   entry halt still blocks BUYs, and every order must pass `isRestable` —
   *   an order that cannot be proven non-marketable is refused rather than sent
   *   to cross the spread.
   *
   * Refused candidates are returned with their reasons rather than silently
   * dropped: an operator who pressed this needs to know which gaps remain.
   */
  @Post('orders/place-missing')
  @HttpCode(HttpStatus.OK)
  async placeMissingOrders(): Promise<unknown> {
    const diagnosis = await this.orderDiagnosis.diagnose(new Date().toISOString());

    if (!diagnosis.brokerReachable) {
      // "Cannot ask" is not "nothing is resting". Placing against an unreadable
      // book could duplicate an order already working at that level.
      throw new ServiceUnavailableException({
        message: 'the broker could not be reached, so no order was placed',
        reason: diagnosis.reason,
      });
    }

    const result = await this.engine.placeMissingOrders(
      diagnosis.missing.map((missing) => ({
        strategyId: missing.strategyId,
        symbol: missing.symbol,
        side: missing.side,
        quantity: missing.quantity,
        limitPrice: missing.limitPrice,
        reason: missing.reason,
        lotId: missing.lotId,
      })),
    );

    return { ranAt: diagnosis.ranAt, ...result };
  }

  /**
   * Cancels the redundant orders in each unambiguous duplicate group.
   *
   * **The one route that destroys an order.** The standing rule — an order the
   * engine cannot explain is reported, not cancelled — is preserved wherever it
   * still applies: only *untracked* extras at a price where exactly one order
   * is tied to a rung or lot are cancelled, the ladder's own claim always
   * survives, and an ambiguous group (no tracked order, or several) is skipped
   * and reported for an operator to resolve in TWS. A partially filled order is
   * never eligible, so this cannot strand a fill mid-flight.
   *
   * The justification is that two orders at one rung both fill, which is
   * surplus exposure at a level already covered — the concrete harm the
   * no-cancel rule was never protecting against.
   */
  @Post('orders/resolve-duplicates')
  @HttpCode(HttpStatus.OK)
  async resolveDuplicateOrders(): Promise<unknown> {
    return this.duplicateOrders.resolveDuplicates(new Date().toISOString());
  }

  /**
   * Every alert this process raised, resolved ones included.
   *
   * The complement to `GET /status`'s active-only list. The soak signs a day
   * off against the faults it saw *and* their recovery — "stale at 19:55,
   * resumed at 09:35" — so resolving an alert must not make it unreadable.
   * Read-only; nothing here changes engine state.
   */
  @Get('alerts')
  getAlerts(): unknown {
    return { alerts: this.engine.alertHistory() };
  }

  @Get('halts')
  getHalts(): unknown {
    return {
      // Shared across both strategies — `SymbolHaltService` is a single
      // instance both `ReconciliationService` and `GridReconciliationService`
      // halt through, so this list already reflects a grid-raised halt with
      // no change needed here.
      symbols: this.symbolHalts.active(),
      reconciliation: this.reconciliation.lastReconciliation(),
      gridReconciliation: this.gridReconciliation.lastReconciliation(),
    };
  }

  /**
   * Releases a reconciliation halt after **manual** resolution.
   *
   * There is deliberately no endpoint that resolves a mismatch by trading: an
   * operator reconciles the account by hand, then tells the system it is safe.
   * The reverse — letting the system flatten a position to make its own records
   * agree — is the guess `PRD.md:347` forbids, and no route to it exists.
   */
  @Post('halts/:symbol/release')
  @HttpCode(HttpStatus.OK)
  releaseHalt(@Param('symbol') symbol: string): unknown {
    if (!this.symbolHalts.release(symbol, new Date().toISOString())) {
      throw new NotFoundException(`no active halt for "${symbol}"`);
    }

    return { symbol, halted: false };
  }

  /**
   * Clears the engine's **technical** entry halt after operator resolution.
   *
   * The counterpart to `POST /halts/:symbol/release`, which clears a
   * *reconciliation* halt. Both exist for the same reason: a halt that only a
   * process restart can clear is not an operator control, and restarting a
   * trading daemon to clear a flag is a far blunter instrument than the flag
   * itself. `EngineService.clearHalt()` has existed since Story 6 and was
   * reachable from nothing — a stale feed, an exhausted reconnect, or a failed
   * submission latched entries off until someone killed the process.
   *
   * **This is narrower than it looks.** It clears one boolean that gates new
   * BUY intents. It does not reconnect a broker, resume a dead feed, or resolve
   * a reconciliation mismatch — those have their own routes and their own
   * evidence. Clearing a halt whose cause is still present simply means the
   * next fault re-raises it, which is the correct behaviour and not a loophole:
   * the fault detectors all still run.
   *
   * There is deliberately no path from here to a trade. Clearing the halt
   * permits the *strategy* to decide again; every intent it produces still goes
   * through the risk chokepoint, the caps, the loss breaker, and the kill
   * switch exactly as before.
   */
  @Post('engine/clear-halt')
  @HttpCode(HttpStatus.OK)
  clearHalt(): unknown {
    const reason = this.engine.haltReason();

    if (reason === null) {
      throw new NotFoundException('no active entry halt');
    }

    this.engine.clearHalt();

    return { halted: false, cleared: reason };
  }

  /**
   * Operator action: re-establish a broker connection that has given up.
   *
   * The adapter retries a `FAILED` connection on a slow poll of its own, so
   * this is not the only way back — but the poll is deliberately slow (minutes)
   * and an operator who has just restarted IB Gateway should not have to wait
   * it out. This forces the attempt immediately.
   *
   * **Reconciliation is not run from here, deliberately.** A recovered socket
   * proves the broker is reachable; it proves nothing about whether positions
   * still agree with the database, and that question has its own route
   * (`POST /reconcile`) whose answer can halt symbols. Chaining them would hide
   * a halt-raising operation behind a button labelled "reconnect". An operator
   * reconnects, reads the result, and then reconciles.
   *
   * Nothing here submits, cancels, or liquidates.
   */
  @Post('broker/reconnect')
  @HttpCode(HttpStatus.OK)
  async reconnectBroker(): Promise<unknown> {
    if (this.broker.isConnected()) {
      return { connected: true, attempted: false, state: this.brokerState() };
    }

    // Only the IB adapter has a FAILED state to recover from; the mock has no
    // notion of one, and calling `connect()` on it is the honest equivalent.
    const connected =
      this.broker instanceof IBBrokerAdapter
        ? await this.broker.retryFailedConnection()
        : await this.connectPlainBroker();

    return { connected, attempted: true, state: this.brokerState() };
  }

  /** `connect()` for an adapter with no FAILED state, reporting rather than throwing. */
  private async connectPlainBroker(): Promise<boolean> {
    try {
      await this.broker.connect();
    } catch {
      // Reported through `connected: false` — an operator pressing a reconnect
      // button on an unreachable broker is asking a question, not making a
      // mistake, and a 500 would tell them less than the state does.
      return false;
    }

    return this.broker.isConnected();
  }

  private brokerState(): string {
    return this.broker.connectionHealth().state;
  }

  @Post('strategies/:id/enable')
  @HttpCode(HttpStatus.OK)
  async enableStrategy(@Param('id') id: string): Promise<unknown> {
    const enabled = await this.coordinator.enable(id, new Date().toISOString());

    if (!enabled) {
      throw new NotFoundException(`unknown strategy "${id}"`);
    }

    return { id, enabled: true };
  }

  @Post('strategies/:id/disable')
  @HttpCode(HttpStatus.OK)
  disableStrategy(@Param('id') id: string): unknown {
    if (!this.coordinator.disable(id)) {
      throw new NotFoundException(`unknown strategy "${id}"`);
    }

    return { id, enabled: false };
  }

  /**
   * Requests a mode change.
   *
   * **Refuses `PAPER`/`LIVE` while the two open PRD items are unset**
   * (`PRD.md:500`), reusing the same assertion the startup path runs — one
   * definition, so the HTTP path cannot drift from the boot path and permit
   * what boot would refuse.
   *
   * Returns the blocking reasons rather than a bare 422, because Story 7 shows
   * them in the UI and an operator needs to know *which* value is missing.
   */
  @Post('mode')
  @HttpCode(HttpStatus.OK)
  setMode(@Body() body: { mode?: string }): unknown {
    const requested = body?.mode;

    if (!requested || !Object.values(ExecutionMode).includes(requested as ExecutionMode)) {
      throw new UnprocessableEntityException(
        `mode must be one of ${Object.values(ExecutionMode).join(', ')}`,
      );
    }

    const mode = requested as ExecutionMode;
    const assertions = evaluateStartupAssertions(mode, this.riskConfig, this.symbolCapital);

    if (!assertions.permitted) {
      throw new UnprocessableEntityException({
        message: `refusing to switch to ${mode}`,
        mode,
        permitted: false,
        failures: assertions.failures,
      });
    }

    // Reaching here means the assertions passed. Actually *applying* the mode
    // requires a restart with the new EXECUTION_MODE: the risk manager reads it
    // at construction, and mutating it live would leave in-flight decisions
    // straddling two modes. Story 13 makes this reachable.
    return {
      mode,
      permitted: true,
      applied: false,
      detail:
        `${mode} passes every startup assertion. Restart with EXECUTION_MODE=${mode} to apply — ` +
        'the mode is fixed at construction so no decision can straddle two modes.',
    };
  }
}
