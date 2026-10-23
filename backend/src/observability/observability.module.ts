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
 *
 * The position snapshots and commission recorder behind average-cost P&L do
 * need the broker, and get it the same way: `BROKER_POSITION_READER` exposes
 * `getPositions`, `isConnected`, and two subscriptions — nothing that submits,
 * cancels, or routes.
 */

import { Module } from '@nestjs/common';
import { BROKER_ADAPTER, BrokerAdapter, ConnectionState } from '../broker/broker-adapter.interface';
import { CommissionCorrection } from '../broker/ib/ib-socket';
import { ReportsController } from '../api/reports.controller';
import { AppConfigService } from '../config/app-config.service';
import { AppConfigModule } from '../config/config.module';
import { EngineModule } from '../engine/engine.module';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { RepositoriesModule } from '../repositories/repositories.module';
import { GridConfig } from '../strategies/grid/config';
import { GRID_CONFIG, StrategiesModule } from '../strategies/strategies.module';
import {
  DailyReportService,
  RECONCILIATION_READ_MODEL,
  ReconciliationReadModel,
} from './daily-report.service';
import { MAILER, Mailer, NodemailerMailer } from './mailer';
import { PnlEmailScheduler, PnlEmailService } from './pnl-email.service';
import {
  BROKER_POSITION_READER,
  CommissionRecorderService,
  PositionReader,
  PositionSnapshotService,
  SNAPSHOT_SYMBOLS,
} from './position-snapshot.service';

/** IB's adapter reports commissions; the mock and simulated brokers stamp them on the fill. */
interface CommissionSource {
  onCommission(handler: (report: CommissionCorrection) => void): () => void;
}

function hasCommissions(broker: BrokerAdapter): broker is BrokerAdapter & CommissionSource {
  return typeof (broker as Partial<CommissionSource>).onCommission === 'function';
}

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
    PnlEmailService,
    PnlEmailScheduler,
    PositionSnapshotService,
    CommissionRecorderService,
    {
      provide: BROKER_POSITION_READER,
      useFactory: (broker: BrokerAdapter): PositionReader => ({
        isConnected: () => broker.isConnected(),
        getPositions: () => broker.getPositions(),
        onConnected: (handler) =>
          broker.onConnectionChange((health) => {
            if (health.state === ConnectionState.CONNECTED) {
              handler();
            }
          }),
        onCommission: (handler) =>
          hasCommissions(broker) ? broker.onCommission(handler) : () => undefined,
      }),
      inject: [BROKER_ADAPTER],
    },
    {
      provide: SNAPSHOT_SYMBOLS,
      useFactory: (grid: GridConfig): string[] => [grid.symbol],
      inject: [GRID_CONFIG],
    },
    {
      provide: MAILER,
      // `null` when SMTP is not configured: the manual routes then answer 503
      // and the scheduler never starts.
      useFactory: (config: AppConfigService): Mailer | null =>
        config.email === null ? null : new NodemailerMailer(config.email),
      inject: [AppConfigService],
    },
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
  exports: [DailyReportService, PnlEmailService],
})
export class ObservabilityModule {}
