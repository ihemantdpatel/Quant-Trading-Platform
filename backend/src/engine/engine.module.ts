/**
 * Wires the engine: broker, repositories, strategy registration, HTTP API.
 *
 * **This is the only module that decides which strategies run.** The
 * coordinator is a neutral registry and the strategies module provides no
 * registrations, so enabling the Wheel at Story 16 is a change here rather
 * than anywhere in the strategy layer.
 *
 * **Current operator choice: the grid strategy trades TQQQ; the dip ladder,
 * Wheel, and Leaps are all disabled.** This inverts the Story 2 default (the
 * ladder enabled, everything else off) — see `ladderEnabled`/`gridEnabled`
 * below for the reasoning and the same-symbol guard that keeps the two from
 * ever running together.
 */

import { AccountsController } from '../api/accounts.controller';
import { Inject, Logger, Module, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { BacktestController } from '../api/backtest.controller';
import { BacktestService } from '../backtest/backtest.service';
import { EngineController } from '../api/engine.controller';
import { ParametersController } from '../api/parameters.controller';
import { BROKER_ADAPTER, BrokerAdapter, ConnectionState } from '../broker/broker-adapter.interface';
import { equityContract } from '../domain/contract';
import { IBBrokerAdapter } from '../broker/ib/ib-broker.adapter';
import { StoqeyIbSocket } from '../broker/ib/stoqey-ib-socket';
import { FillMode, MockBrokerAdapter } from '../broker/mock/mock-broker.adapter';
import { AppConfigModule } from '../config/config.module';
import { AppConfigService } from '../config/app-config.service';
import { MarketDataModule } from '../market-data/market-data.module';
import { BackfillService } from '../market-data/history/backfill.service';
import {
  HISTORICAL_SOURCE,
  HistoricalSource,
  HistoryCacheService,
} from '../market-data/history/cache.service';
import { LiveFeedService } from '../market-data/live/live-feed.service';
import { BarSize } from '../market-data/types';
import { OrderPollService } from '../reconciliation/order-poll.service';
import { PostCloseReconcileService } from '../reconciliation/post-close-reconcile.service';
import { DisabledStrategyProtectionService } from '../reconciliation/disabled-strategy-protection.service';
import { ReplayService } from '../market-data/mock/replay.service';
import { GridReconciliationService } from '../reconciliation/grid-reconciliation.service';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
// Declared alongside `ReconciliationService` for the same reason: both depend
// on `BROKER_ADAPTER`, and diagnosing against a different broker instance than
// the engine trades through would compare the ladder to the wrong account.
import {
  DuplicateOrderService,
  OrderDiagnosisService,
} from '../reconciliation/order-diagnosis.service';
import { LotRebuildService } from '../reconciliation/lot-rebuild.service';
import { SymbolHaltService } from '../reconciliation/symbol-halt.service';
import { AccountRegistrationService } from '../repositories/prisma/account-registration.service';
import { RepositoriesModule } from '../repositories/repositories.module';
import {
  BAR_REPOSITORY,
  BarRepository,
  FILL_REPOSITORY,
  FillRepository,
  GRID_LOT_REPOSITORY,
  GridLotRepository,
  LOT_REBUILD_EVENT_REPOSITORY,
  LOT_REPOSITORY,
  LotRebuildEventRepository,
  LotRepository,
  ORDER_INTENT_REPOSITORY,
  ORDER_REPOSITORY,
  OrderIntentRepository,
  OrderRepository,
  RISK_EVENT_REPOSITORY,
  RiskEventRepository,
  RUNG_REPOSITORY,
  RungRepository,
  STRATEGY_STATE_SNAPSHOT_REPOSITORY,
  StrategyStateSnapshotRepository,
} from '../repositories/repository.interfaces';

/** A sink that can forward events on — see the wiring note in `onModuleInit`. */
interface ForwardableSink extends RiskEventSink {
  subscribe(listener: (event: RiskEvent) => void): () => void;
}

function isForwardableSink(sink: RiskEventSink): sink is ForwardableSink {
  return typeof (sink as ForwardableSink).subscribe === 'function';
}
import { RiskEvent, RiskEventSink } from '../risk/risk-event';
import { RiskManagerService } from '../risk/risk-manager.service';
import { RiskParameterService } from '../risk/risk-parameter.service';
import { RISK_EVENT_SINK, RiskModule } from '../risk/risk.module';
import { CoordinatorService } from '../strategies/coordinator.service';
import { DipLadderStrategy } from '../strategies/dip-ladder/dip-ladder.strategy';
import { DipLadderConfig } from '../strategies/dip-ladder/config';
import { GridConfig } from '../strategies/grid/config';
import { GridStrategy } from '../strategies/grid/grid.strategy';
import { GridParameterService } from '../strategies/grid/parameter.service';
import { LeapsStrategy } from '../strategies/leaps/leaps.strategy';
import { WheelStrategy } from '../strategies/wheel/wheel.strategy';
import { ParameterService } from '../strategies/dip-ladder/parameter.service';
import { DIP_LADDER_CONFIG, GRID_CONFIG, StrategiesModule } from '../strategies/strategies.module';
import { EngineService } from './engine.service';
import { RiskParametersController } from '../api/risk-parameters.controller';
import { StartupSequence } from './startup.sequence';

@Module({
  // `RepositoriesModule` binds the repository tokens to either the Prisma or
  // the in-memory implementations, decided by the presence of `DATABASE_URL`.
  // Nothing in this module knows which it got — that is the Story 8 swap.
  imports: [
    AppConfigModule,
    MarketDataModule,
    ReconciliationModule,
    RepositoriesModule,
    RiskModule,
    StrategiesModule,
  ],
  controllers: [
    AccountsController,
    BacktestController,
    EngineController,
    ParametersController,
    RiskParametersController,
  ],
  providers: [
    ParameterService,
    GridParameterService,
    RiskParameterService,
    // A factory rather than a bare class: `gridReconciliation` is typed
    // `GridReconciliationService | null` on the constructor (nullable so the
    // two spec files that construct a `StartupSequence` directly need not
    // supply one), and a union type defeats Nest's reflection-based
    // constructor injection — `design:paramtypes` emits a bare `Object` for a
    // union, which Nest cannot resolve to a token. A factory sidesteps that
    // by supplying the argument explicitly rather than asking Nest to infer
    // it from the parameter's static type.
    {
      provide: StartupSequence,
      useFactory: (
        coordinator: CoordinatorService,
        reconciliation: ReconciliationService,
        broker: BrokerAdapter,
        gridReconciliation: GridReconciliationService,
      ) => new StartupSequence(coordinator, reconciliation, broker, gridReconciliation),
      inject: [
        CoordinatorService,
        ReconciliationService,
        BROKER_ADAPTER,
        GridReconciliationService,
      ],
    },
    // Story 11. Depends only on the bar cache and the backtest repository — it
    // holds no broker, so no request to `/backtest` can reach IB, and it reads
    // history only from the cache so a sweep cannot breach IB's pacing limits.
    BacktestService,
    // Declared here rather than in `ReconciliationModule` because it depends on
    // `BROKER_ADAPTER`, which this module provides — reconciling against a
    // different broker instance than the engine trades through would compare
    // the database to the wrong account.
    //
    // A factory rather than a bare class: `ReconciliationService` needs the
    // running `ExecutionMode` (see `docs/decisions/auto-lot-rebuild.md` — its
    // auto-rebuild path is gated to `PAPER`), and Nest cannot resolve a raw
    // enum value from a token the way it resolves a class or an `@Inject`
    // symbol. `EngineService`'s own factory below reads `appConfig.executionMode`
    // the same way, for the same reason.
    {
      provide: ReconciliationService,
      useFactory: (
        coordinator: CoordinatorService,
        symbolHalts: SymbolHaltService,
        broker: BrokerAdapter,
        lots: LotRepository,
        orders: OrderRepository,
        rungs: RungRepository,
        snapshots: StrategyStateSnapshotRepository,
        fills: FillRepository,
        rebuild: LotRebuildService,
        rebuildEvents: LotRebuildEventRepository,
        ladderConfig: DipLadderConfig,
        appConfig: AppConfigService,
        gridLots: GridLotRepository,
      ) =>
        new ReconciliationService(
          coordinator,
          symbolHalts,
          broker,
          lots,
          orders,
          rungs,
          snapshots,
          fills,
          rebuild,
          rebuildEvents,
          ladderConfig,
          appConfig.executionMode,
          gridLots,
        ),
      inject: [
        CoordinatorService,
        SymbolHaltService,
        BROKER_ADAPTER,
        LOT_REPOSITORY,
        ORDER_REPOSITORY,
        RUNG_REPOSITORY,
        STRATEGY_STATE_SNAPSHOT_REPOSITORY,
        FILL_REPOSITORY,
        LotRebuildService,
        LOT_REBUILD_EVENT_REPOSITORY,
        DIP_LADDER_CONFIG,
        AppConfigService,
        GRID_LOT_REPOSITORY,
      ],
    },
    // Pure computation plus one repository read (`ORDER_REPOSITORY`) — see its
    // own header comment. Provided here, not in `ReconciliationModule`, for the
    // same reason `ReconciliationService` is: it exists only to be called from
    // that service.
    LotRebuildService,
    OrderDiagnosisService,
    DuplicateOrderService,
    // The grid strategy's own, parallel restart-safety service — see its file
    // header for why this is strictly additive rather than sharing
    // `ReconciliationService`. No factory needed: every dependency is a plain
    // injectable class or a token already bound by an imported module.
    GridReconciliationService,
    // A single broker instance shared by the engine and the API, so a
    // simulated disconnect in a test is visible to both.
    //
    // **`IB_HOST` selects the broker** (Story 10), mirroring how `DATABASE_URL`
    // selects storage: one variable, no separate flag that could disagree with
    // the connection settings. Unset keeps the mock, which is what preserves
    // the zero-dependency test and dev path.
    //
    // Selecting IB does *not* enable submission — `EXECUTION_MODE` governs
    // that, and `SHADOW` submits nothing whichever broker is bound.
    {
      provide: BROKER_ADAPTER,
      useFactory: (config: AppConfigService) => {
        if (!config.usesIbBroker) {
          // **`MARKET_AWARE`, not the `IMMEDIATE` default.** With exits resting
          // (Story 14a) a take-profit sell sits *above* the market by
          // construction, and a mock that fills every order on submission would
          // close each lot on the bar that opened it — a cycle no exchange
          // could produce. The engine drives it per bar from `processBar`.
          return new MockBrokerAdapter({ fillMode: FillMode.MARKET_AWARE });
        }

        return new IBBrokerAdapter(
          new StoqeyIbSocket({
            host: config.ibHost!,
            port: config.ibPort,
            clientId: config.ibClientId,
            // Validated as present whenever IB_HOST is set (`config.schema.ts`).
            accountId: config.ibAccountId!,
          }),
        );
      },
      inject: [AppConfigService],
    },
    // Cached-history stack. Bound unconditionally: the cache is useful with any
    // historical source, and the source itself is whichever broker was
    // selected above.
    {
      provide: HISTORICAL_SOURCE,
      useFactory: (broker: BrokerAdapter): HistoricalSource =>
        broker instanceof IBBrokerAdapter
          ? broker
          : // The mock broker serves no history. An empty source keeps the cache
            // constructible in the zero-dependency path; every range reads as a
            // gap that yields nothing, which is honest — there is no history
            // here — rather than a crash at wiring time.
            { getHistoricalBars: async () => [] },
      inject: [BROKER_ADAPTER],
    },
    // Both built by factory rather than `useClass`: their third constructor
    // parameter is a plain config object with a default, which Nest would
    // otherwise try to resolve as a provider and fail on.
    {
      provide: HistoryCacheService,
      useFactory: (bars: BarRepository, source: HistoricalSource) =>
        new HistoryCacheService(bars, source),
      inject: [BAR_REPOSITORY, HISTORICAL_SOURCE],
    },
    {
      provide: BackfillService,
      useFactory: (bars: BarRepository, source: HistoricalSource) =>
        new BackfillService(bars, source),
      inject: [BAR_REPOSITORY, HISTORICAL_SOURCE],
    },
    {
      provide: EngineService,
      useFactory: (
        replay: ReplayService,
        coordinator: CoordinatorService,
        riskManager: RiskManagerService,
        // The **interface**, not a concrete adapter: Story 10 binds this token
        // to `IBBrokerAdapter` when `IB_HOST` is set, and the engine must not
        // be able to tell the difference.
        broker: BrokerAdapter,
        // Declared as **interfaces**, not concrete classes. The factory
        // resolves whichever implementation the tokens are bound to, so this
        // signature does not change when MySQL arrives.
        intents: OrderIntentRepository,
        orders: OrderRepository,
        fills: FillRepository,
        lots: LotRepository,
        rungs: RungRepository,
        appConfig: AppConfigService,
        symbolHalts: SymbolHaltService,
        snapshots: StrategyStateSnapshotRepository,
        gridLots: GridLotRepository,
      ) =>
        new EngineService(
          replay,
          coordinator,
          riskManager,
          broker,
          intents,
          orders,
          fills,
          lots,
          rungs,
          appConfig.executionMode,
          // The *same* instance reconciliation raises halts on, so a halted
          // symbol is halted everywhere.
          symbolHalts,
          snapshots,
          gridLots,
          appConfig.accountAlias,
        ),
      inject: [
        ReplayService,
        CoordinatorService,
        RiskManagerService,
        BROKER_ADAPTER,
        ORDER_INTENT_REPOSITORY,
        ORDER_REPOSITORY,
        FILL_REPOSITORY,
        LOT_REPOSITORY,
        RUNG_REPOSITORY,
        AppConfigService,
        SymbolHaltService,
        STRATEGY_STATE_SNAPSHOT_REPOSITORY,
        GRID_LOT_REPOSITORY,
      ],
    },
  ],
  exports: [
    BacktestService,
    EngineService,
    BROKER_ADAPTER,
    ParameterService,
    GridParameterService,
    RiskParameterService,
    StartupSequence,
    ReconciliationService,
    GridReconciliationService,
    OrderDiagnosisService,
    DuplicateOrderService,
    HistoryCacheService,
    BackfillService,
  ],
})
export class EngineModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EngineModule.name);
  private liveFeed: LiveFeedService | null = null;
  private postClose: PostCloseReconcileService | null = null;
  private orderPoll: OrderPollService | null = null;
  // The grid strategy's own instances — see `startLiveFeed` for why these
  // are separate from the ladder's rather than one job serving both.
  private gridPostClose: PostCloseReconcileService | null = null;
  private gridOrderPoll: OrderPollService | null = null;
  // Places protective sells for a disabled strategy's real leftover lots,
  // which nothing else re-rests once its DAY orders expire at each close —
  // see the class's own header for the full rationale.
  private disabledStrategyProtection: DisabledStrategyProtectionService | null = null;

  /**
   * Whether the dip ladder is wired to trade.
   *
   * **Operator decision: disabled**, so the grid strategy can trade TQQQ
   * instead — the two must never both be enabled on one symbol (see the
   * same-symbol guard below). Kept as a named flag rather than a bare
   * `enabled: false` at the registration call, so a future re-enable is a
   * one-line, legible change and the guard stays meaningful in both
   * directions.
   *
   * **Consequence worth knowing before flipping this back on while Grid
   * stays enabled too**: reconciliation still protects a disabled ladder's
   * real broker position (the lot-sum assertion runs for every registered
   * ladder-prefixed snapshot regardless of `enabled`), and `GET /lots`, the
   * order diagnosis, and `DisabledStrategyProtectionService` all fall back to
   * the database for a disabled strategy's real lots (`CoordinatorService.
   * initializeAll` only initializes enabled ones, so live strategy state is
   * never populated for it) — so a disabled ladder holding real shares is
   * both visible on the dashboard and kept protected by a fresh sell every
   * session, without being re-enabled. What it does *not* get is anything
   * bar-driven: no new entries, no rung re-arming, no dip-buys — a disabled
   * strategy still makes no trading decisions of its own.
   */
  private readonly ladderEnabled = false;

  /**
   * Whether the grid strategy is wired to trade.
   *
   * **Operator decision: enabled**, trading the same TQQQ symbol the ladder
   * used to. Safe only because `ladderEnabled` is `false` above — the
   * same-symbol guard below refuses to boot otherwise.
   */
  private readonly gridEnabled = true;

  constructor(
    private readonly coordinator: CoordinatorService,
    @Inject(DIP_LADDER_CONFIG) private readonly ladderConfig: DipLadderConfig,
    @Inject(GRID_CONFIG) private readonly gridConfig: GridConfig,
    @Inject(BROKER_ADAPTER) private readonly broker: BrokerAdapter,
    @Inject(RISK_EVENT_SINK) private readonly riskEventSink: RiskEventSink,
    @Inject(RISK_EVENT_REPOSITORY) private readonly riskEvents: RiskEventRepository,
    private readonly parameters: ParameterService,
    private readonly gridParameters: GridParameterService,
    private readonly riskParameters: RiskParameterService,
    private readonly startup: StartupSequence,
    private readonly engine: EngineService,
    private readonly reconciliation: ReconciliationService,
    private readonly gridReconciliation: GridReconciliationService,
    private readonly orderDiagnosis: OrderDiagnosisService,
    private readonly appConfig: AppConfigService,
    // Present only with durable storage (`repositories.module.ts`).
    @Optional() private readonly accountRegistration?: AccountRegistrationService,
  ) {}

  async onModuleInit(): Promise<void> {
    // **The IB account id is pinned only once IB has confirmed it.** A
    // `CONNECTED` from the IB adapter means `connect()` resolved, which the
    // socket allows only after `checkManagedAccount` passed — so this is the
    // first moment the configured id is known to be real. Every CONNECTED
    // re-runs it; after the first it is a no-op. A failure is logged, never
    // thrown: the process is already running, and boot has already refused
    // every contradiction with an existing pin.
    if (this.accountRegistration && this.appConfig.usesIbBroker) {
      const registration = this.accountRegistration;

      this.broker.onConnectionChange((health) => {
        if (health.state === ConnectionState.CONNECTED) {
          registration
            .confirmBrokerAccount()
            .catch((error: unknown) =>
              this.logger.error(
                `could not record the IB-confirmed account: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ),
            );
        }
      });
    }

    // Forward every risk event into the repository the API serves.
    //
    // Wired here rather than by rebinding `RISK_EVENT_SINK` to the repository:
    // the repository layer imports strategy types, and making the risk module
    // depend on it would drag a strategy dependency into the chokepoint that
    // must sit above every strategy (`architecture.spec.ts`). A forwarding
    // subscription keeps the dependency pointing the right way.
    if (isForwardableSink(this.riskEventSink)) {
      this.riskEventSink.subscribe((event) => void this.riskEvents.save(event));
    }

    // **Same-symbol guard.** The grid strategy and the dip ladder cannot
    // safely hold live positions in the same symbol at once — each one's
    // reconciliation is blind to the other's shares, so both enabled here
    // would make each halt on the other's exposure as a spurious mismatch
    // the moment either holds a position. Refusing to boot turns an operator
    // mistake into a legible startup error instead of two confusing halts,
    // mirroring `assertSingleCurrency`'s "refuse rather than silently
    // misbehave" precedent. Checked against **both** enabled flags — a
    // disabled ladder holding a stale position is not the unsafe case this
    // guards against; two strategies actively trading it at once is.
    if (
      this.gridEnabled &&
      this.ladderEnabled &&
      this.gridConfig.symbol === this.ladderConfig.symbol
    ) {
      throw new Error(
        `refusing to start: GridStrategy and DipLadderStrategy are both enabled on ` +
          `${this.gridConfig.symbol} — each strategy's reconciliation is blind to the other's ` +
          'shares and would halt on a spurious mismatch. Enable at most one of them per symbol.',
      );
    }

    // Registration order is display order on the dashboard; the ladder first
    // for historical continuity even though it is disabled by the current
    // operator choice above.
    const ladder = new DipLadderStrategy(this.ladderConfig);

    this.coordinator.register({
      strategy: ladder,
      enabled: this.ladderEnabled,
      symbols: [this.ladderConfig.symbol],
    });

    // The **same object instance** the strategy holds, so a live edit is
    // visible to the next bar's `evaluateBar`. Registering a copy would let
    // edits apply to nothing (`parameter.service.ts:24`).
    this.parameters.register(ladder.id, this.ladderConfig);

    // Rebuilds the engine's in-memory working-order registry from the orders
    // reconciliation found still resting at the broker. A callback rather than
    // a direct reference so `ReconciliationService` does not depend on
    // `EngineService`, which already depends on it via `StartupSequence`.
    this.reconciliation.onOpenOrdersReconciled = (strategyId, symbol, orders) => {
      this.engine.adoptWorkingOrders(strategyId, symbol, orders);
    };

    // Rebuilds the engine's in-memory working-order registry from the grid
    // strategy's resting orders found still at the broker — the grid
    // counterpart to the ladder's wiring just above. Safe now that
    // `EngineService.adoptWorkingOrders` branches on the `grid:` id prefix
    // (the Phase C dispatch surgery); without this, a sell that filled while
    // the daemon was down would arrive with no working-order entry to
    // resolve against and be silently dropped, surfacing only later as a
    // lot-sum mismatch.
    this.gridReconciliation.onOpenOrdersReconciled = (strategyId, symbol, orders) => {
      this.engine.adoptWorkingOrders(strategyId, symbol, orders);
    };

    const grid = new GridStrategy(this.gridConfig);

    this.coordinator.register({
      strategy: grid,
      enabled: this.gridEnabled,
      symbols: [this.gridConfig.symbol],
    });

    // The same object instance the strategy holds — see the identical note
    // on `this.parameters.register` above.
    this.gridParameters.register(grid.id, this.gridConfig);

    for (const strategy of [new WheelStrategy(), new LeapsStrategy()]) {
      this.coordinator.register({
        strategy,
        // Disabled with no live wiring until Story 16.
        enabled: false,
        symbols: [this.ladderConfig.symbol],
      });
    }

    // **The Story 9 startup sequence replaces the bare initialize-and-connect.**
    //
    // It connects the broker, initializes strategies, and reconciles persisted
    // lots against the broker's net position *before* any bar can be processed
    // (`PRD.md:323`). A symbol whose lot sum does not match is halted here and
    // never trades this session.
    //
    // **Deliberately not awaited.** `onModuleInit` runs before `app.listen()`,
    // so awaiting a sequence that talks to a broker makes the HTTP server's
    // availability depend on IB being reachable — and an unreachable IB is
    // exactly when an operator most needs the dashboard. Worse, a Gateway that
    // accepts a socket but never handshakes makes those calls hang rather than
    // fail, and a hang here leaves the process with nothing holding the event
    // loop open: it exits 0, restarts, and loops forever.
    //
    // Not awaiting does **not** weaken the Story 9 guarantee, because that
    // guarantee was never "startup finished before listen" — it is
    // `StartupSequence.hasReconciled()`, which the engine checks before
    // dispatching any bar, and the live feed below only starts once the
    // sequence resolves. A bar arriving early is dropped, not evaluated.
    // **Before the gate opens, so no bar can submit under a colliding id.**
    // The `Order` table survives a restart while the engine's `co-N` counter
    // does not, and both repositories upsert on `clientOrderId` — so a reused
    // id overwrites the earlier order's row instead of erroring, and a fill for
    // either order then resolves to the wrong one. Chained ahead of `run`
    // rather than injected into `StartupSequence`, which would close a cycle:
    // `EngineService` already depends on the sequence.
    //
    // **Risk-limit restore runs before ladder parameter restore, which runs
    // before everything else in the chain.** A runtime edit to a per-symbol
    // risk limit or a ladder parameter, made before the last restart, must be
    // back in force before a single bar can reach the risk manager or
    // `evaluateBar`. `RiskParameterService.restore` reads its own audit table
    // (`findAll`), which can genuinely fail against an unreachable database —
    // unlike `ParameterService.restore`, whose non-fatal internals never
    // throw — so it gets its own `.catch` here, leaving the compiled
    // `capital.config.ts` defaults in force rather than blocking the boot.
    void this.riskParameters
      .restore()
      .catch((error: unknown) => {
        this.logger.error(
          `could not restore per-symbol risk limits: ${
            error instanceof Error ? error.message : String(error)
          }. Compiled defaults remain in force.`,
        );
      })
      .then(() =>
        this.parameters
          .restore(ladder.id)
          // The grid strategy's own parameter restore, alongside the ladder's —
          // both must be back in force before a single bar or fill can reach
          // either strategy. Non-fatal internally, matching `ParameterService.restore`,
          // so no separate `.catch` is needed here either.
          .then(() => this.gridParameters.restore(grid.id))
          .then(() => this.engine.restoreClientOrderSequence())
          .catch((error: unknown) => {
            // Non-fatal. A failed read leaves the counter at zero, which is the
            // pre-existing behaviour — the collision risk returns, but refusing to
            // boot would take the operator's only view of the ladder down with it.
            this.logger.error(
              `could not restore the client order sequence: ${
                error instanceof Error ? error.message : String(error)
              }. Order ids may repeat those of a previous run.`,
            );
          })
          .then(() => this.startup.run(new Date().toISOString()))
          .then(() => this.startLiveFeed())
          .catch((error: unknown) => {
            // `run` already absorbs an unreachable broker (every symbol halts and
            // the reason is on `GET /status`). Reaching here means something else
            // failed — log it and keep serving, so the failure is visible rather
            // than silent.
            this.logger.error(
              `startup sequence failed: ${
                error instanceof Error ? error.message : String(error)
              }. The API is up; no bars will be processed until reconciliation succeeds.`,
            );
          }),
      );
  }

  /**
   * Streams live IB bars into the engine (Story 10).
   *
   * Started **after** `startup.run`, never before: reconciliation must complete
   * before any bar reaches a strategy (`PRD.md:323`), and a bar arriving
   * mid-reconciliation would advance ladder state that has not yet been checked
   * against the broker.
   *
   * Only with IB bound. Under the mock there is no live feed to subscribe to and
   * `POST /engine/replay` remains the bar source, exactly as in Stories 6–9.
   */
  private startLiveFeed(): void {
    if (!(this.broker instanceof IBBrokerAdapter)) {
      return;
    }

    const ib = this.broker;

    this.liveFeed = new LiveFeedService(
      {
        subscribeBars: (contract, barSize, handler) => ib.subscribeBars(contract, barSize, handler),
        isDataStale: () => ib.isDataStale(),
        // Lets the stale halt name IB's own reason for the silence.
        dataErrors: () => ib.dataErrorList(),
        // A bar subscription does not survive the socket it was made on, and
        // IB Gateway logs itself out daily. Without this the feed ends at the
        // first logout and never returns. See `LiveFeedService.start`.
        onConnectionChange: (handler) =>
          ib.onConnectionChange((health) => handler(health.state === ConnectionState.CONNECTED)),
      },
      this.engine,
    );

    // 1-minute bars: faster re-evaluation than the 5-minute default, since
    // resting orders already capture intra-bar fills — this changes how often
    // the active strategy re-evaluates and places new orders, not fill
    // mechanics.
    //
    // **Whichever strategy is actually enabled**, not unconditionally the
    // ladder's symbol. Both happen to be TQQQ today, so this was silently
    // correct before — but hard-coding `ladderConfig.symbol` here would have
    // subscribed to the wrong instrument entirely the moment an operator
    // pointed the grid strategy at a different symbol while leaving the
    // ladder's compiled default alone, leaving the enabled strategy fed no
    // bars at all with nothing in the logs to explain why.
    const liveSymbol = this.gridEnabled ? this.gridConfig.symbol : this.ladderConfig.symbol;
    this.liveFeed.start(equityContract(liveSymbol), BarSize.ONE_MIN);
    this.liveFeed.startWatchdog();

    // **Started alongside the live feed, and gated on the same condition.**
    //
    // Under the mock broker there is no session and no resting order that
    // outlives one: `POST /engine/replay` drives everything, and a nightly job
    // would reconcile a ledger nothing had changed. Against IB the opposite is
    // true — DAY orders expire at the close whether or not this process was
    // watching, which is exactly what the job exists to notice.
    this.postClose = new PostCloseReconcileService(this.reconciliation);
    this.postClose.start();

    // **Same gating, different cadence.** The post-close job closes the gap
    // at the *end* of a session; nothing previously closed it *during* one —
    // an order resized or cancelled in TWS mid-session was invisible to this
    // engine until the next boot, operator-triggered `POST /reconcile`, or the
    // nightly job. See `order-poll.service.ts` for the concrete stranding risk
    // that leaves open.
    this.orderPoll = new OrderPollService(this.reconciliation);
    this.orderPoll.start();

    // **The grid strategy's own pair, not a shared instance.** Each job holds
    // exactly one reconciler and calls its `reconcileOrders` on its own
    // schedule — `GridReconciliationService` and `ReconciliationService` are
    // deliberately separate services (see the former's file header), so
    // giving the grid strategy the same DAY-expiry and mid-session order
    // coverage the ladder has means a second pair of jobs, not a shared one.
    // Started unconditionally alongside the ladder's — both are cheap,
    // read-only, and harmless against a symbol nothing is resting for.
    this.gridPostClose = new PostCloseReconcileService(this.gridReconciliation);
    this.gridPostClose.start();

    this.gridOrderPoll = new OrderPollService(this.gridReconciliation);
    this.gridOrderPoll.start();

    // **Writes real orders, unlike every job above it.** Gated on the same
    // IB-bound condition for the same reason: under the mock broker there is
    // no session and no DAY order that outlives one. See the class's own
    // header for why this needs to be a separate service from
    // `PostCloseReconcileService` rather than an extension of it.
    this.disabledStrategyProtection = new DisabledStrategyProtectionService(
      this.reconciliation,
      this.gridReconciliation,
      this.orderDiagnosis,
      this.coordinator,
      this.engine,
    );
    this.disabledStrategyProtection.start();
  }

  onModuleDestroy(): void {
    this.liveFeed?.stop();
    this.postClose?.stop();
    this.orderPoll?.stop();
    this.gridPostClose?.stop();
    this.gridOrderPoll?.stop();
    this.disabledStrategyProtection?.stop();
  }
}
