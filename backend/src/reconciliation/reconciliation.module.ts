/**
 * Provides the per-symbol halt registry.
 *
 * ## Why only the halt service lives here
 *
 * `SymbolHaltService` is `@Global()` because three consumers must share the
 * *same instance*: `ReconciliationService` raises halts, `EngineService`
 * enforces them, and `EngineController` surfaces and releases them. A second
 * instance anywhere would mean a symbol halted in one place and freely traded
 * in another — the exact failure this story exists to prevent, reintroduced by
 * a wiring accident.
 *
 * `ReconciliationService` is deliberately **not** here. It needs
 * `BROKER_ADAPTER`, which `EngineModule` provides so that the engine and the
 * API share one broker instance; a module that provided its own would reconcile
 * against a different broker than the one the engine trades through. So it is
 * declared in `EngineModule` alongside the broker it depends on, and this module
 * stays a single-purpose registry with no dependencies of its own.
 */

import { Global, Module } from '@nestjs/common';
import { SymbolHaltService } from './symbol-halt.service';

@Global()
@Module({
  providers: [SymbolHaltService],
  exports: [SymbolHaltService],
})
export class ReconciliationModule {}
