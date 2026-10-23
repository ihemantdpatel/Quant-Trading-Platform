/**
 * Registers the retired dip ladder into an assembled test app.
 *
 * Production no longer registers the ladder at all (`EngineModule`), so
 * nothing in a running daemon can enable, reconcile, or display it. The
 * suites that exercise the ladder's own HTTP surface still drive it through
 * the assembled app, and they opt in here explicitly. That keeps their
 * coverage without a production path that could bring the ladder back.
 *
 * Registers with the same `DIP_LADDER_CONFIG` instance the app provides, so a
 * suite overriding that provider still gets its own config, and registers it
 * with `ParameterService` so the parameter editor can reach it, as
 * `EngineModule` used to.
 */

import { INestApplication } from '@nestjs/common';
import { CoordinatorService } from '../../strategies/coordinator.service';
import { DipLadderConfig } from '../../strategies/dip-ladder/config';
import { DipLadderStrategy } from '../../strategies/dip-ladder/dip-ladder.strategy';
import { ParameterService } from '../../strategies/dip-ladder/parameter.service';
import { DIP_LADDER_CONFIG } from '../../strategies/strategies.module';

export async function registerRetiredLadderForTest(
  app: INestApplication,
  options: { enabled: boolean } = { enabled: true },
): Promise<DipLadderStrategy> {
  const coordinator = app.get(CoordinatorService);
  const config = app.get<DipLadderConfig>(DIP_LADDER_CONFIG);
  const ladder = new DipLadderStrategy(config);

  coordinator.register({ strategy: ladder, enabled: false, symbols: [config.symbol] });
  app.get(ParameterService).register(ladder.id, config);

  // `enable` initializes on demand, which `register` alone does not.
  if (options.enabled) {
    await coordinator.enable(ladder.id, new Date().toISOString());
  }

  return ladder;
}
