import { Module } from '@nestjs/common';
import { CapitalModule } from './config/capital.module';
import { AppConfigModule } from './config/config.module';
import { EngineModule } from './engine/engine.module';
import { HealthModule } from './health/health.module';
import { MarketDataModule } from './market-data/market-data.module';
import { ObservabilityModule } from './observability/observability.module';
import { RepositoriesModule } from './repositories/repositories.module';
import { RiskModule } from './risk/risk.module';
import { StrategiesModule } from './strategies/strategies.module';

@Module({
  imports: [
    AppConfigModule,
    // Before RiskModule: publishes per-symbol capital under the neutral token
    // the risk layer's startup assertion resolves.
    StrategiesModule,
    CapitalModule,
    HealthModule,
    MarketDataModule,
    // Binds the repository tokens to Prisma or in-memory, decided by the
    // presence of DATABASE_URL (Story 8). Global, so no consumer re-imports it.
    RepositoriesModule,
    RiskModule,
    EngineModule,
    // Story 12's soak instrumentation. After EngineModule so the report reads
    // the same repository bindings the engine writes through; it observes only,
    // and holds no broker.
    ObservabilityModule,
  ],
})
export class AppModule {}
