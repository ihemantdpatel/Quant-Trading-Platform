import { Module } from '@nestjs/common';
import { ReplayService } from './mock/replay.service';

/**
 * Exports the mock replay source. Story 10 adds the IB-backed historical
 * service alongside it, behind the same consumer-facing shape.
 */
@Module({
  providers: [ReplayService],
  exports: [ReplayService],
})
export class MarketDataModule {}
