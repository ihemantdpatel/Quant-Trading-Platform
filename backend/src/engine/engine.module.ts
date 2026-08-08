/**
 * Wires the engine: broker, repositories, strategy registration, HTTP API.
 *
 * **This is the only module that decides which strategies run.** The
 * coordinator is a neutral registry and the strategies module provides no
 * registrations, so enabling the Wheel at Story 16 is a change here rather
 * than anywhere in the strategy layer.
 *
 * The dip ladder is registered **enabled**; Grid, Wheel, and Leaps are
 * registered **disabled** with no live wiring (`PRD.md:229`). Four registered,
 * three disabled — the Story 2 exit criterion, asserted in the module spec.
 */

import { Inject, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { BacktestController } from '../api/backtest.controller';
import { BacktestService } from '../backtest/backtest.service';
import { EngineController } from '../api/engine.controller';
import { ParametersController } from '../api/parameters.controller';
import { BROKER_ADAPTER, BrokerAdapter } from '../broker/broker-adapter.interface';
import { equityContract } from '../domain/contract';
import { IBBrokerAdapter } from '../broker/ib/ib-broker.adapter';
import { StoqeyIbSocket } from '../broker/ib/stoqey-ib-socket';
import { MockBrokerAdapter } from '../broker/mock/mock-broker.adapter';
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
import { ReplayService } from '../market-data/mock/replay.service';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { SymbolHaltService } from '../reconciliation/symbol-halt.service';
import { RepositoriesModule } from '../repositories/repositories.module';
import {
  BAR_REPOSITORY,
  BarRepository,
  FILL_REPOSITORY,
  FillRepository,
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
import { RISK_EVENT_SINK, RiskModule } from '../risk/risk.module';
import { CoordinatorService } from '../strategies/coordinator.service';
import { DipLadderStrategy } from '../strategies/dip-ladder/dip-ladder.strategy';
import { DipLadderConfig } from '../strategies/dip-ladder/config';
import { GridStrategy } from '../strategies/grid/grid.strategy';
import { LeapsStrategy } from '../strategies/leaps/leaps.strategy';
import { WheelStrategy } from '../strategies/wheel/wheel.strategy';
import { ParameterService } from '../strategies/dip-ladder/parameter.service';
import { DIP_LADDER_CONFIG, StrategiesModule } from '../strategies/strategies.module';
import { EngineService } from './engine.service';
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
  controllers: [BacktestController, EngineController, ParametersController],
  providers: [
    ParameterService,
    StartupSequence,
    // Story 11. Depends only on the bar cache and the backtest repository — it
    // holds no broker, so no request to `/backtest` can reach IB, and it reads
    // history only from the cache so a sweep cannot breach IB's pacing limits.
    BacktestService,
    // Declared here rather than in `ReconciliationModule` because it depends on
    // `BROKER_ADAPTER`, which this module provides — reconciling against a
    // different broker instance than the engine trades through would compare
    // the database to the wrong account.
    ReconciliationService,
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
          return new MockBrokerAdapter();
        }

        return new IBBrokerAdapter(
          new StoqeyIbSocket({
            host: config.ibHost!,
            port: config.ibPort,
            clientId: config.ibClientId,
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
      ],
    },
  ],
  exports: [
    BacktestService,
    EngineService,
    BROKER_ADAPTER,
    ParameterService,
    StartupSequence,
    ReconciliationService,
    HistoryCacheService,
    BackfillService,
  ],
})
export class EngineModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EngineModule.name);
  private liveFeed: LiveFeedService | null = null;

  constructor(
    private readonly coordinator: CoordinatorService,
    @Inject(DIP_LADDER_CONFIG) private readonly ladderConfig: DipLadderConfig,
    @Inject(BROKER_ADAPTER) private readonly broker: BrokerAdapter,
    @Inject(RISK_EVENT_SINK) private readonly riskEventSink: RiskEventSink,
    @Inject(RISK_EVENT_REPOSITORY) private readonly riskEvents: RiskEventRepository,
    private readonly parameters: ParameterService,
    private readonly startup: StartupSequence,
    private readonly engine: EngineService,
    private readonly appConfig: AppConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
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

    // Registration order is display order on the dashboard; the ladder first
    // because it is the only strategy that trades in Phase 1.
    const ladder = new DipLadderStrategy(this.ladderConfig);

    this.coordinator.register({
      strategy: ladder,
      enabled: true,
      symbols: [this.ladderConfig.symbol],
    });

    // The **same object instance** the strategy holds, so a live edit is
    // visible to the next bar's `evaluateBar`. Registering a copy would let
    // edits apply to nothing (`parameter.service.ts:24`).
    this.parameters.register(ladder.id, this.ladderConfig);

    for (const strategy of [new GridStrategy(), new WheelStrategy(), new LeapsStrategy()]) {
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
    void this.startup
      .run(new Date().toISOString())
      .then(() => this.startLiveFeed())
      .catch((error: unknown) => {
        // `run` already absorbs an unreachable broker (every symbol halts and
        // the reason is on `GET /status`). Reaching here means something else
        // failed — log it and keep serving, so the failure is visible rather
        // than silent.
        this.logger.error(
          `startup sequence failed: ${error instanceof Error ? error.message : String(error)}. ` +
            'The API is up; no bars will be processed until reconciliation succeeds.',
        );
      });
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
      },
      this.engine,
    );

    this.liveFeed.start(equityContract(this.ladderConfig.symbol));
    this.liveFeed.startWatchdog();
  }

  onModuleDestroy(): void {
    this.liveFeed?.stop();
  }
}
