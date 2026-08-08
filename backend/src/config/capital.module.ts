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
 * The value is `null` until Story 13, producing `{ TQQQ: null }` — the exact
 * state the startup assertion refuses for PAPER/LIVE. That is more useful than
 * an empty map, which would also fail but report "no symbols configured"
 * rather than naming the symbol whose allocation is missing.
 */

import { Global, Module } from '@nestjs/common';
import { SYMBOL_CAPITAL_SOURCE } from '../risk/risk.module';
import { SymbolCapital } from '../risk/startup-assertions';
import { DIP_LADDER_SYMBOL, StrategiesModule } from '../strategies/strategies.module';

@Global()
@Module({
  imports: [StrategiesModule],
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
       * Story 13 sets a real figure and updates this to report it.
       */
      provide: SYMBOL_CAPITAL_SOURCE,
      useFactory: (): SymbolCapital => ({ [DIP_LADDER_SYMBOL]: null }),
    },
  ],
  exports: [SYMBOL_CAPITAL_SOURCE],
})
export class CapitalModule {}
