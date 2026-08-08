/**
 * Shared base for the three inert scaffolds.
 *
 * `GridStrategy`, `WheelStrategy`, and `LeapsStrategy` exist at Story 2 to
 * prove the plugin architecture holds more than one shape (`PRD.md:228`): they
 * implement the interface, register with the coordinator, pass the shared
 * contract suite, and are **disabled in config with no live wiring**. Story 16
 * gives them real behaviour.
 *
 * They share a base class because three identical no-op implementations would
 * be three places to fix when the interface changes, and the point of the
 * scaffolds is to demonstrate the interface — not to triplicate it. Each
 * subclass overrides only its id and the state its real implementation will
 * need, so the Story 16 diff is behaviour rather than plumbing.
 *
 * **Returning `[]` here is the honest implementation, not a stub.** A scaffold
 * that emitted a placeholder intent would be a strategy that trades, and these
 * are wired into the same coordinator the dip ladder runs in.
 */

import { Bar, Tick } from '../market-data/types';
import { Strategy } from './strategy.interface';
import { JsonValue, OrderIntent, StrategyContext, StrategyState } from './types';

export abstract class ScaffoldStrategy implements Strategy {
  abstract readonly id: string;

  /**
   * Bumped by a subclass when its persisted shape changes, so Story 8 can
   * reject or migrate an older snapshot rather than loading fields that moved.
   */
  protected readonly stateVersion: number = 1;

  /** Overridden by subclasses that need seed state. */
  protected initialData(): Record<string, JsonValue> {
    return {};
  }

  async initialize(ctx: StrategyContext): Promise<StrategyState> {
    return {
      strategyId: this.id,
      version: this.stateVersion,
      symbols: [...ctx.symbols],
      data: this.initialData(),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onTick(_tick: Tick, _state: StrategyState): OrderIntent[] {
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onBar(_bar: Bar, _state: StrategyState): OrderIntent[] {
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  evaluate(_ctx: StrategyContext, _state: StrategyState): OrderIntent[] {
    return [];
  }

  /**
   * Idempotent by construction — there is nothing to release, so a second call
   * does exactly what the first did. Subclasses that acquire something at
   * Story 16 must preserve that property; the contract suite checks it.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async terminate(_state: StrategyState): Promise<void> {
    return;
  }
}
