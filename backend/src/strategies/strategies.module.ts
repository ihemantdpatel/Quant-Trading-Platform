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
import { PAPER_SYMBOL_CAPITAL } from '../config/capital.config';
import { ExecutionMode } from '../config/execution-mode';
import { NullSentimentProvider } from '../sentiment/null-sentiment.provider';
import { CoordinatorService } from './coordinator.service';
import { buildDipLadderConfig, DipLadderConfig, OrderPlacement } from './dip-ladder/config';

export const DIP_LADDER_CONFIG = Symbol('DIP_LADDER_CONFIG');
export const SENTIMENT_PROVIDER = Symbol('SENTIMENT_PROVIDER');

/**
 * The symbol the Phase 1 ladder trades (`PRD.md:61`). A named constant rather
 * than an env var: changing which instrument this system trades is a decision
 * that belongs in a reviewed diff, not in a deployment variable.
 */
export const DIP_LADDER_SYMBOL = 'TQQQ';

/**
 * The currency `DIP_LADDER_SYMBOL` trades in, matching `equityContract`'s
 * default.
 *
 * Named alongside the symbol because the two travel together: the risk layer
 * compares position notional against account equity, and that comparison is
 * only sound when it knows both currencies. TQQQ is a US-listed ETF, so USD —
 * which differs from the CAD paper account, and `assertSingleCurrency` is what
 * makes that difference loud instead of silently mis-scaling the cap.
 */
export const DIP_LADDER_CURRENCY = 'USD';

/**
 * The capital the ladder sizes rungs from.
 *
 * Reads the real Story 13 allocation for every mode. There is no longer a
 * per-mode branch: the SHADOW display notional it used to return existed only
 * so a mode that submitted nothing still produced non-zero quantities to look
 * at, and SHADOW is retired (`execution-mode.ts`).
 *
 * `null` for a symbol absent from `PAPER_SYMBOL_CAPITAL`, so a missing
 * allocation sizes every rung to zero shares (`ladder.ts:47`) **and** trips the
 * startup assertion, rather than silently borrowing another symbol's figure.
 */
export function ladderCapital(_mode: ExecutionMode, symbol: string): number | null {
  return PAPER_SYMBOL_CAPITAL[symbol] ?? null;
}

@Module({
  imports: [AppConfigModule],
  providers: [
    CoordinatorService,
    {
      provide: DIP_LADDER_CONFIG,
      useFactory: (appConfig: AppConfigService): DipLadderConfig =>
        buildDipLadderConfig(DIP_LADDER_SYMBOL, {
          symbolCapital: ladderCapital(appConfig.executionMode, DIP_LADDER_SYMBOL),
          // **The live engine rests its entries at the broker.**
          //
          // The bar-close rule only creates an order once a 5-minute bar has
          // *closed* at or below the rung, so a dip that touches the level
          // intra-bar and recovers fires nothing at all. A resting limit order
          // is filled by the exchange on the way through, which is what a
          // predetermined-level ladder is supposed to do.
          //
          // `DEFAULT_DIP_LADDER_CONFIG` stays `IMMEDIATE` so the committed
          // fixtures keep testing the rule their expected intents were computed
          // under; this is the one place the live behaviour is selected.
          orderPlacement: OrderPlacement.RESTING,
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
