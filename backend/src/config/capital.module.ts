/**
 * Supplies per-symbol capital allocations to the risk layer.
 *
 * A separate global module rather than a provider inside `RiskModule` or
 * `StrategiesModule`, because it is the one place both layers can meet without
 * either importing the other: the risk layer must not depend on any individual
 * strategy (`startup-assertions.ts:18`), and the strategy layer must not
 * import risk at all (`architecture.spec.ts`). This module reads the ladder's
 * configured allocation and publishes it under a neutral token that
 * `RiskModule` resolves optionally.
 *
 * Story 13 set the allocation (`capital.config.ts`), so every mode reports the
 * real figure. The SHADOW branch that used to report `{ TQQQ: null }` went with
 * SHADOW itself (`execution-mode.ts`).
 *
 * `null` is still the value for a symbol with no configured allocation — rather
 * than an empty map — because both fail the startup assertion but only this one
 * names the symbol whose allocation is missing.
 */

import { Global, Module } from '@nestjs/common';
import { INSTRUMENT_CURRENCY_SOURCE, SYMBOL_CAPITAL_SOURCE } from '../risk/risk.module';
import { SymbolCapital } from '../risk/startup-assertions';
import {
  DIP_LADDER_CURRENCY,
  DIP_LADDER_SYMBOL,
  StrategiesModule,
} from '../strategies/strategies.module';
import { PAPER_SYMBOL_CAPITAL } from './capital.config';
import { AppConfigModule } from './config.module';

@Global()
@Module({
  imports: [StrategiesModule, AppConfigModule],
  providers: [
    {
      /**
       * Deliberately **not** derived from the ladder's configured
       * `symbolCapital`.
       *
       * That value carries a SHADOW-only display notional
       * (`strategies.module.ts:shadowNotional`), and reading it here would let
       * that placeholder satisfy the startup assertion — the assertion whose
       * entire job is to refuse PAPER/LIVE until a *real* allocation is chosen
       * (`PRD.md:503`). Reporting `null` keeps the two concerns separate: the
       * ladder may have a number to size a shadow display with, and the risk
       * layer still correctly sees no allocation decision has been made.
       *
       * Story 13 supplies the real figure from `capital.config.ts` — still not
       * from the ladder's own `symbolCapital`, for the same reason: the two must
       * not be able to satisfy each other.
       */
      provide: SYMBOL_CAPITAL_SOURCE,
      useFactory: (): SymbolCapital => ({
        [DIP_LADDER_SYMBOL]: PAPER_SYMBOL_CAPITAL[DIP_LADDER_SYMBOL] ?? null,
      }),
    },
    {
      /**
       * The currency of each instrument the ladder trades, for the startup
       * currency check.
       *
       * Published from here for the same reason as the allocation above: this
       * module is the one place the strategy and risk layers may meet. The
       * ladder trades a single equity symbol, and `equityContract` defaults to
       * USD, so this is USD — which deliberately *disagrees* with the CAD paper
       * account and is exactly what the check reports.
       */
      provide: INSTRUMENT_CURRENCY_SOURCE,
      useFactory: (): string[] => [DIP_LADDER_CURRENCY],
    },
  ],
  exports: [SYMBOL_CAPITAL_SOURCE, INSTRUMENT_CURRENCY_SOURCE],
})
export class CapitalModule {}
