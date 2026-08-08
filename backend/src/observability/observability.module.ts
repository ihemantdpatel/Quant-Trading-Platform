/**
 * Observability — the soak's instrumentation (Story 12).
 *
 * Everything here **observes** and nothing acts. The daily report holds no
 * broker: it depends on `RECONCILIATION_READ_MODEL`, a one-method port, rather
 * than on `ReconciliationService` itself, which carries the broker adapter.
 * That is what makes "no report can place an order" structural rather than a
 * convention — there is no way to reach a broker from this graph.
 *
 * `EngineModule` is imported only to resolve that port, since it is the module
 * that provides `ReconciliationService` (it needs the same broker instance the
 * engine trades through). The adapter below narrows it back down on the way in.
 */

import { Module } from '@nestjs/common';
import { ReportsController } from '../api/reports.controller';
import { AppConfigModule } from '../config/config.module';
import { EngineModule } from '../engine/engine.module';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { RepositoriesModule } from '../repositories/repositories.module';
import { StrategiesModule } from '../strategies/strategies.module';
import {
  DailyReportService,
  RECONCILIATION_READ_MODEL,
  ReconciliationReadModel,
} from './daily-report.service';

@Module({
  imports: [
    AppConfigModule,
    EngineModule,
    ReconciliationModule,
    RepositoriesModule,
    StrategiesModule,
  ],
  controllers: [ReportsController],
  providers: [
    DailyReportService,
    {
      provide: RECONCILIATION_READ_MODEL,
      // Narrowed deliberately: the report receives only `lastReconciliation`,
      // so it cannot reach the broker the full service holds even by accident.
      useFactory: (reconciliation: ReconciliationService): ReconciliationReadModel => ({
        lastReconciliation: () => reconciliation.lastReconciliation(),
      }),
      inject: [ReconciliationService],
    },
  ],
  exports: [DailyReportService],
})
export class ObservabilityModule {}
