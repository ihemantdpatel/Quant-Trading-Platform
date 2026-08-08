/**
 * Wires the strategy layer.
 *
 * Registration itself happens in `EngineModule`, not here: the coordinator is
 * provided as an empty registry, and the engine populates it from config at
 * startup. That keeps this module free of any decision about *which* strategies
 * run, so enabling the Wheel at Story 16 is a config change rather than a
 * module change.
 *
 * The dip-ladder config is provided by token so Story 13 can supply the
 * now-set `symbolCapital` without touching a call site, and Story 7's
 * parameter editor has one place to write through.
 */

import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { AppConfigService } from '../config/app-config.service';
import { ExecutionMode } from '../config/execution-mode';
import { NullSentimentProvider } from '../sentiment/null-sentiment.provider';
import { CoordinatorService } from './coordinator.service';
import { buildDipLadderConfig, DipLadderConfig } from './dip-ladder/config';

export const DIP_LADDER_CONFIG = Symbol('DIP_LADDER_CONFIG');
export const SENTIMENT_PROVIDER = Symbol('SENTIMENT_PROVIDER');

/**
 * The symbol the Phase 1 ladder trades (`PRD.md:61`). A named constant rather
 * than an env var: changing which instrument this system trades is a decision
 * that belongs in a reviewed diff, not in a deployment variable.
 */
export const DIP_LADDER_SYMBOL = 'TQQQ';

/**
 * A nominal figure used **only** to size intents in `SHADOW`.
 *
 * The problem this solves: the real per-symbol allocation is deliberately unset
 * until Story 13 (`PRD.md:503`), and unset sizes every rung at zero shares. The
 * risk manager then rejects every intent as malformed, so a SHADOW replay
 * produces an empty ladder and verifies nothing — which defeats the purpose of
 * the mode that exists to be verified.
 *
 * So SHADOW gets a stated, arbitrary notional and PAPER/LIVE get `null`.
 * Structurally, not by convention: this function returns `null` for any mode
 * other than SHADOW, so the placeholder cannot reach a mode that submits. If it
 * ever did, the Story 5 startup assertion would still refuse to boot, because
 * `SYMBOL_CAPITAL` is derived from this same value.
 *
 * This is **not** the Story 13 decision and must not be mistaken for it. It is
 * a display scale for a mode that submits nothing.
 */
export const SHADOW_NOMINAL_CAPITAL = 100_000;

export function shadowNotional(mode: ExecutionMode): number | null {
  return mode === ExecutionMode.SHADOW ? SHADOW_NOMINAL_CAPITAL : null;
}

@Module({
  imports: [AppConfigModule],
  providers: [
    CoordinatorService,
    {
      provide: DIP_LADDER_CONFIG,
      useFactory: (appConfig: AppConfigService): DipLadderConfig =>
        buildDipLadderConfig(DIP_LADDER_SYMBOL, {
          symbolCapital: shadowNotional(appConfig.executionMode),
        }),
      inject: [AppConfigService],
    },
    {
      // Null until a paid feed is acquired (`PRD.md:199`). Provided by token so
      // acquiring one is a binding change, not a call-site change.
      provide: SENTIMENT_PROVIDER,
      useClass: NullSentimentProvider,
    },
  ],
  exports: [CoordinatorService, DIP_LADDER_CONFIG, SENTIMENT_PROVIDER],
})
export class StrategiesModule {}
