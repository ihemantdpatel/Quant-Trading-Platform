/**
 * Per-symbol trading halts (`PRD.md:329`).
 *
 * ## Why this is not the engine's `entryHalt`
 *
 * `EngineService` already has a halt, and reusing it would be wrong in a way
 * that is easy to miss. The two mean different things:
 *
 * | | technical fault (`entryHalt`) | reconciliation mismatch (here) |
 * |---|---|---|
 * | Scope | the whole engine | one symbol |
 * | New entries | blocked | blocked |
 * | **Exits** | **still permitted** | **blocked** |
 *
 * The divergence is the exits row, and it is deliberate. On a broker
 * disconnect the engine deliberately keeps selling allowed
 * (`engine.service.ts:226`) — halting an exit would trap a position the
 * strategy has already decided to close. But when the lot sum does not
 * reconcile, **the system does not know which lots it holds**, and an exit is
 * precisely the dangerous operation: FIFO would pick a lot from records that
 * disagree with reality, selling the wrong lot at the wrong target
 * (`PRD.md:347`).
 *
 * Folding these into one flag would eventually let someone "simplify" the
 * exit rule and silently make one of the two cases unsafe. Two services, two
 * rules, each stated where it applies.
 *
 * ## What a halt is not
 *
 * A halt stops the system from *acting* on a symbol. It never liquidates,
 * never flattens to make the numbers agree, and never expires on a timer —
 * `CLAUDE.md` is explicit that a technical fault must not become a realized
 * loss, and an automatic release would resume trading on state nobody checked.
 * Only an operator clears it, and clearing is recorded.
 */

import { Injectable, Logger } from '@nestjs/common';

export interface SymbolHalt {
  symbol: string;
  reason: string;
  /** ISO-8601. When the halt was raised. */
  at: string;
  /** Machine-readable cause, e.g. `LOT_SUM_MISMATCH`. */
  code: string;
}

@Injectable()
export class SymbolHaltService {
  private readonly logger = new Logger(SymbolHaltService.name);
  private readonly halts = new Map<string, SymbolHalt>();

  /**
   * Halts a symbol.
   *
   * The **first** halt wins: a symbol already halted keeps its original reason
   * and timestamp, so a later, vaguer cause cannot overwrite the specific one
   * an operator needs in order to resolve it.
   */
  halt(symbol: string, code: string, reason: string, at: string): SymbolHalt {
    const existing = this.halts.get(symbol);

    if (existing) {
      return existing;
    }

    const halt: SymbolHalt = { symbol, code, reason, at };
    this.halts.set(symbol, halt);

    this.logger.error(
      `TRADING HALTED for ${symbol} [${code}] — ${reason}. ` +
        'No entries and no exits will be generated for this symbol. ' +
        'Existing positions are untouched and will NOT be liquidated.',
    );

    return halt;
  }

  isHalted(symbol: string): boolean {
    return this.halts.has(symbol);
  }

  haltFor(symbol: string): SymbolHalt | null {
    return this.halts.get(symbol) ?? null;
  }

  /**
   * Operator action: clears a halt after manual resolution.
   *
   * Returns false for a symbol that was not halted, so an HTTP caller can
   * answer 404 rather than reporting success for a halt that never existed.
   */
  release(symbol: string, at: string): boolean {
    const halt = this.halts.get(symbol);

    if (!halt) {
      return false;
    }

    this.halts.delete(symbol);
    this.logger.warn(
      `halt on ${symbol} released by operator at ${at} (was [${halt.code}] since ${halt.at})`,
    );

    return true;
  }

  active(): SymbolHalt[] {
    return [...this.halts.values()];
  }

  haltedSymbols(): string[] {
    return [...this.halts.keys()];
  }

  /** Test and replay support. Not reachable over HTTP. */
  reset(): void {
    this.halts.clear();
  }
}
