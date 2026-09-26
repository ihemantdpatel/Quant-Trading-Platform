/**
 * Binds the repository tokens to **one** implementation set.
 *
 * This module is where the Story 8 swap actually happens, and it is deliberately
 * the only place that knows two implementations exist. Everything downstream —
 * `EngineService`, the controllers, `ParameterService` — injects an interface
 * through a token and cannot tell which one it received. That is the "no
 * call-site changes" property (`stories.md:487`) expressed as code rather than
 * as a claim in a comment.
 *
 * ## Why presence of `DATABASE_URL` is the switch
 *
 * Not a separate `USE_PRISMA` flag, which could disagree with the DSN and leave
 * the engine believing it persists to a database it was never given. One
 * variable cannot contradict itself.
 *
 * Keeping the in-memory path alive is not a fallback for production — it is
 * what preserves the Story 0 property that the stack runs and tests green with
 * zero external dependencies (`stories.md:8`), which every mock-data story
 * still depends on. `GET /status` reports which one is live, so "is this
 * durable?" is answerable at runtime rather than inferred from deployment
 * config.
 */

import { Global, Module, Provider } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { AppConfigService } from '../config/app-config.service';
import {
  InMemoryAccountDefinitionRepository,
  InMemoryBacktestRepository,
  InMemoryBarRepository,
  InMemoryFillRepository,
  InMemoryGridLotRepository,
  InMemoryLotRebuildEventRepository,
  InMemoryLotRepository,
  InMemoryOrderIntentRepository,
  InMemoryOrderRepository,
  InMemoryParameterChangeRepository,
  InMemoryPerSymbolLimitChangeRepository,
  InMemoryRiskEventRepository,
  InMemoryRungRepository,
  InMemoryStrategyStateSnapshotRepository,
} from './in-memory/in-memory.repositories';
import {
  PrismaBacktestRepository,
  PrismaBarRepository,
  PrismaFillRepository,
  PrismaGridLotRepository,
  PrismaLotRebuildEventRepository,
  PrismaLotRepository,
  PrismaOrderIntentRepository,
  PrismaOrderRepository,
  PrismaParameterChangeRepository,
  PrismaPerSymbolLimitChangeRepository,
  PrismaRiskEventRepository,
  PrismaRungRepository,
  PrismaStrategyStateSnapshotRepository,
} from './prisma/prisma.repositories';
import { PrismaAccountDefinitionRepository } from './prisma/prisma-account-definition.repository';
import { AccountRegistrationService } from './prisma/account-registration.service';
import { PrismaService } from './prisma/prisma.service';
import { ACCOUNT_ID } from './account-scope';
import {
  ACCOUNT_DEFINITION_REPOSITORY,
  BACKTEST_REPOSITORY,
  BAR_REPOSITORY,
  FILL_REPOSITORY,
  GRID_LOT_REPOSITORY,
  LOT_REBUILD_EVENT_REPOSITORY,
  LOT_REPOSITORY,
  ORDER_INTENT_REPOSITORY,
  ORDER_REPOSITORY,
  PARAMETER_CHANGE_REPOSITORY,
  PER_SYMBOL_LIMIT_CHANGE_REPOSITORY,
  RISK_EVENT_REPOSITORY,
  RUNG_REPOSITORY,
  STRATEGY_STATE_SNAPSHOT_REPOSITORY,
} from './repository.interfaces';

/**
 * True when durable storage is configured.
 *
 * Read from the environment rather than injected, because Nest needs the
 * provider list at class-decoration time — before any DI container exists to
 * resolve `AppConfigService` from. `AppConfigService.hasDurableStorage` reads
 * the same variable and is what the rest of the app should use.
 */
const useDatabase = Boolean(process.env.DATABASE_URL);

/**
 * `PrismaService` is provided only when a database is configured.
 *
 * Providing it unconditionally would construct a `PrismaClient` with no URL and
 * fail at `onModuleInit` in exactly the zero-dependency setup that is supposed
 * to work.
 */
const prismaProviders: Provider[] = useDatabase ? [PrismaService, AccountRegistrationService] : [];

const repositoryProviders: Provider[] = useDatabase
  ? [
      { provide: BAR_REPOSITORY, useClass: PrismaBarRepository },
      { provide: ORDER_INTENT_REPOSITORY, useClass: PrismaOrderIntentRepository },
      { provide: ORDER_REPOSITORY, useClass: PrismaOrderRepository },
      { provide: FILL_REPOSITORY, useClass: PrismaFillRepository },
      { provide: LOT_REPOSITORY, useClass: PrismaLotRepository },
      { provide: RUNG_REPOSITORY, useClass: PrismaRungRepository },
      { provide: GRID_LOT_REPOSITORY, useClass: PrismaGridLotRepository },
      { provide: RISK_EVENT_REPOSITORY, useClass: PrismaRiskEventRepository },
      { provide: LOT_REBUILD_EVENT_REPOSITORY, useClass: PrismaLotRebuildEventRepository },
      { provide: PARAMETER_CHANGE_REPOSITORY, useClass: PrismaParameterChangeRepository },
      {
        provide: PER_SYMBOL_LIMIT_CHANGE_REPOSITORY,
        useClass: PrismaPerSymbolLimitChangeRepository,
      },
      {
        provide: STRATEGY_STATE_SNAPSHOT_REPOSITORY,
        useClass: PrismaStrategyStateSnapshotRepository,
      },
      { provide: BACKTEST_REPOSITORY, useClass: PrismaBacktestRepository },
      { provide: ACCOUNT_DEFINITION_REPOSITORY, useClass: PrismaAccountDefinitionRepository },
    ]
  : [
      { provide: BAR_REPOSITORY, useClass: InMemoryBarRepository },
      { provide: ORDER_INTENT_REPOSITORY, useClass: InMemoryOrderIntentRepository },
      { provide: ORDER_REPOSITORY, useClass: InMemoryOrderRepository },
      { provide: FILL_REPOSITORY, useClass: InMemoryFillRepository },
      { provide: LOT_REPOSITORY, useClass: InMemoryLotRepository },
      { provide: RUNG_REPOSITORY, useClass: InMemoryRungRepository },
      { provide: GRID_LOT_REPOSITORY, useClass: InMemoryGridLotRepository },
      { provide: RISK_EVENT_REPOSITORY, useClass: InMemoryRiskEventRepository },
      { provide: LOT_REBUILD_EVENT_REPOSITORY, useClass: InMemoryLotRebuildEventRepository },
      { provide: PARAMETER_CHANGE_REPOSITORY, useClass: InMemoryParameterChangeRepository },
      {
        provide: PER_SYMBOL_LIMIT_CHANGE_REPOSITORY,
        useClass: InMemoryPerSymbolLimitChangeRepository,
      },
      {
        provide: STRATEGY_STATE_SNAPSHOT_REPOSITORY,
        useClass: InMemoryStrategyStateSnapshotRepository,
      },
      { provide: BACKTEST_REPOSITORY, useClass: InMemoryBacktestRepository },
      { provide: ACCOUNT_DEFINITION_REPOSITORY, useClass: InMemoryAccountDefinitionRepository },
    ];

/** Whether the process is running against durable storage. Reported on `GET /status`. */
export const STORAGE_MODE = Symbol('STORAGE_MODE');

export type StorageMode = 'DURABLE' | 'IN_MEMORY';

@Global()
@Module({
  imports: [AppConfigModule],
  providers: [
    ...prismaProviders,
    ...repositoryProviders,
    {
      // The one place the process's account becomes the repositories' scope.
      // Every Prisma repository injects it, so no query can run unscoped.
      provide: ACCOUNT_ID,
      useFactory: (config: AppConfigService): string => config.accountAlias,
      inject: [AppConfigService],
    },
    {
      provide: STORAGE_MODE,
      useFactory: (config: AppConfigService): StorageMode =>
        config.hasDurableStorage ? 'DURABLE' : 'IN_MEMORY',
      inject: [AppConfigService],
    },
  ],
  exports: [
    ...prismaProviders,
    ACCOUNT_ID,
    BAR_REPOSITORY,
    ORDER_INTENT_REPOSITORY,
    ORDER_REPOSITORY,
    FILL_REPOSITORY,
    LOT_REPOSITORY,
    RUNG_REPOSITORY,
    GRID_LOT_REPOSITORY,
    RISK_EVENT_REPOSITORY,
    LOT_REBUILD_EVENT_REPOSITORY,
    PARAMETER_CHANGE_REPOSITORY,
    PER_SYMBOL_LIMIT_CHANGE_REPOSITORY,
    STRATEGY_STATE_SNAPSHOT_REPOSITORY,
    BACKTEST_REPOSITORY,
    ACCOUNT_DEFINITION_REPOSITORY,
    STORAGE_MODE,
  ],
})
export class RepositoriesModule {}
