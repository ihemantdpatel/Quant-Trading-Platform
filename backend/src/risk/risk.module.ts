/**
 * Wires the risk layer.
 *
 * `RiskConfig` and the event sink are provided by token rather than
 * constructed inside `RiskManagerService`, so Story 6 can swap the sink for a
 * persisted one and Story 13 can supply the now-set capital values without
 * touching the manager.
 *
 * The startup assertion runs at module init — before any strategy can emit an
 * intent — so a misconfigured `PAPER`/`LIVE` boot fails at startup rather than
 * at the first order.
 */

import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { AppConfigService } from '../config/app-config.service';
import {
  PAPER_ACCOUNT_EQUITY,
  PAPER_DAILY_LOSS_BASIS,
  PAPER_ACCOUNT_CURRENCY,
  PAPER_DAILY_LOSS_THRESHOLD,
  PAPER_SYMBOL_CAPITAL,
} from '../config/capital.config';
import { KillSwitchService } from './kill-switch.service';
import { RiskManagerService } from './risk-manager.service';
import { buildRiskConfig, RiskConfig } from './risk.config';
import { InMemoryRiskEventSink, RiskEventSink } from './risk-event';
import { assertStartupSafe, SymbolCapital } from './startup-assertions';

export const RISK_CONFIG = Symbol('RISK_CONFIG');
export const RISK_EVENT_SINK = Symbol('RISK_EVENT_SINK');
export const SYMBOL_CAPITAL = Symbol('SYMBOL_CAPITAL');
export const INSTRUMENT_CURRENCIES = Symbol('INSTRUMENT_CURRENCIES');

/**
 * Optional token a higher layer binds to supply per-symbol capital.
 *
 * The indirection exists so the risk layer never imports a strategy: the engine
 * knows which strategies are registered and what capital each is allocated, and
 * pushes that down here. Unbound, per-symbol capital is empty.
 */
export const SYMBOL_CAPITAL_SOURCE = Symbol('SYMBOL_CAPITAL_SOURCE');

/**
 * Optional token supplying the currency of each traded instrument, for the same
 * reason and by the same route as `SYMBOL_CAPITAL_SOURCE`: the risk layer must
 * not import a strategy to learn what it trades.
 *
 * Unbound, the currency check asserts nothing — which keeps every existing test
 * that constructs a `RiskModule` unaffected.
 */
export const INSTRUMENT_CURRENCY_SOURCE = Symbol('INSTRUMENT_CURRENCY_SOURCE');

/**
 * Nominal account equity used **only** in `SHADOW`, matching the mock broker's
 * default. Real equity comes from the broker at Story 10; this exists so the
 * 60% global cap has a non-zero denominator during shadow replay.
 */
export const SHADOW_NOMINAL_EQUITY = 100_000;

@Module({
  imports: [AppConfigModule],
  providers: [
    {
      /**
       * Story 13's capital decisions (`capital.config.ts`,
       * `docs/decisions/capital-allocation.md`).
       *
       * The per-mode split is gone with SHADOW (`execution-mode.ts`). Every
       * mode now takes the real figures, which means the loss threshold and the
       * capital limits are always enforced rather than skipped in the one mode
       * that used to be exempt.
       *
       * The guard has not become decoration: `capital.config.spec.ts` still
       * asserts that removing either value refuses PAPER, so reverting
       * `capital.config.ts` fails the boot exactly as it did before.
       *
       * `accountEquity` is static by necessity: this factory is synchronous and
       * `RiskModule.onModuleInit` asserts on its result, while the broker's
       * equity is async and arrives only after a connection the HTTP server
       * must never wait on. See the note in `capital.config.ts`.
       */
      provide: RISK_CONFIG,
      useFactory: (): RiskConfig =>
        buildRiskConfig({
          accountEquity: PAPER_ACCOUNT_EQUITY,
          accountCurrency: PAPER_ACCOUNT_CURRENCY,
          dailyLossThreshold: PAPER_DAILY_LOSS_THRESHOLD,
          dailyLossBasis: PAPER_DAILY_LOSS_BASIS,
          perSymbolLimits: PAPER_SYMBOL_CAPITAL,
        }),
    },
    {
      /**
       * The default sink. `EngineModule` overrides this binding with the
       * repository the API serves, so events the chokepoint emits are readable
       * over HTTP with no synchronization step.
       *
       * The override lives there rather than here deliberately: the repository
       * layer imports strategy types, and importing it from `risk/` would drag
       * a strategy dependency into the chokepoint that must sit above every
       * strategy (`architecture.spec.ts`).
       */
      provide: RISK_EVENT_SINK,
      useFactory: (): RiskEventSink => new InMemoryRiskEventSink(),
    },
    {
      /**
       * Per-symbol capital, keyed by symbol.
       *
       * Supplied via `SYMBOL_CAPITAL_SOURCE` rather than read from
       * `dip-ladder/config.ts` directly: the risk layer must not depend on any
       * individual strategy (`startup-assertions.ts:18`), and importing the
       * ladder's config here would invert that. `EngineModule` provides the
       * source from the strategies it registers.
       *
       * Defaults to empty, which in PAPER/LIVE is itself an assertion failure.
       */
      provide: SYMBOL_CAPITAL,
      useFactory: (source?: SymbolCapital): SymbolCapital => source ?? {},
      inject: [{ token: SYMBOL_CAPITAL_SOURCE, optional: true }],
    },
    {
      provide: INSTRUMENT_CURRENCIES,
      useFactory: (source?: string[]): string[] => source ?? [],
      inject: [{ token: INSTRUMENT_CURRENCY_SOURCE, optional: true }],
    },
    {
      provide: KillSwitchService,
      useFactory: (sink: RiskEventSink) => new KillSwitchService(sink),
      inject: [RISK_EVENT_SINK],
    },
    {
      provide: RiskManagerService,
      useFactory: (
        config: RiskConfig,
        appConfig: AppConfigService,
        killSwitch: KillSwitchService,
        sink: RiskEventSink,
      ) => new RiskManagerService(config, appConfig.executionMode, killSwitch, sink),
      inject: [RISK_CONFIG, AppConfigService, KillSwitchService, RISK_EVENT_SINK],
    },
  ],
  exports: [RiskManagerService, KillSwitchService, RISK_CONFIG, RISK_EVENT_SINK, SYMBOL_CAPITAL],
})
export class RiskModule implements OnModuleInit {
  constructor(
    private readonly appConfig: AppConfigService,
    @Inject(RISK_CONFIG) private readonly riskConfig: RiskConfig,
    @Inject(SYMBOL_CAPITAL) private readonly symbolCapital: SymbolCapital,
    @Inject(INSTRUMENT_CURRENCIES) private readonly instrumentCurrencies: string[],
  ) {}

  onModuleInit(): void {
    assertStartupSafe(
      this.appConfig.executionMode,
      this.riskConfig,
      this.symbolCapital,
      this.instrumentCurrencies,
    );
  }
}
