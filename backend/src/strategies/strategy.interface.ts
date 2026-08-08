/**
 * The strategy plugin interface — exactly the five hooks at `PRD.md:210`.
 *
 * The binding constraint is not in any signature here but in what the
 * signatures *cannot express*: every hook receives values and returns
 * `OrderIntent[]` or `void`. None receives a broker, a repository, or a clock,
 * and none returns anything that could submit an order. **Strategies perform no
 * I/O** (`PRD.md:204`) is therefore a property of the type, and
 * `contract-test-suite.ts` proves each implementation honours it at runtime
 * too, by injecting a context whose forbidden members throw.
 *
 * `onTick` and `onBar` are synchronous *by design*. An async hook could await a
 * fetch, and that is exactly the I/O this interface exists to preclude — the
 * signature makes the forbidden thing unwritable rather than merely discouraged.
 * `initialize` and `terminate` are async because the coordinator awaits them at
 * lifecycle boundaries where a plugin may legitimately need to yield.
 */

import { Bar, Tick } from '../market-data/types';
import { OrderIntent, StrategyContext, StrategyState } from './types';

export interface Strategy {
  /** Stable identity. Used for registration, per-strategy risk limits, and state keys. */
  readonly id: string;

  /**
   * Builds the strategy's initial durable state.
   *
   * Called once before any other hook. Returns state rather than storing it
   * internally, so the coordinator owns persistence and a restart restores a
   * plugin without the plugin knowing it was ever stopped.
   */
  initialize(ctx: StrategyContext): Promise<StrategyState>;

  /**
   * Per-tick evaluation. Unused in Phase 1 — the mock pipeline is bar-driven
   * and ticks arrive with the IB adapter at Story 10 — but declared from day
   * one so a tick-driven strategy needs no interface change.
   */
  onTick(tick: Tick, state: StrategyState): OrderIntent[];

  /**
   * Per-bar evaluation. The dip ladder's firing decision lives here.
   *
   * **Pure**: given the same bar and state it must return the same intents.
   * The coordinator may call it during replay, backtest, or live, and
   * `stories.md:660` depends on those producing identical output.
   */
  onBar(bar: Bar, state: StrategyState): OrderIntent[];

  /**
   * Context-driven evaluation independent of a specific bar or tick — the hook
   * for time-based decisions such as the LEAPs schedule or an expiry roll.
   */
  evaluate(ctx: StrategyContext, state: StrategyState): OrderIntent[];

  /**
   * Releases whatever the strategy holds.
   *
   * **Must be idempotent** — asserted by the contract suite. The coordinator
   * may terminate a strategy that is already stopped during shutdown or after
   * a failed start, and a second call must not throw or double-release.
   */
  terminate(state: StrategyState): Promise<void>;
}

/**
 * Registration record: the plugin plus whether it is wired to receive hooks.
 *
 * `enabled` lives here rather than on the strategy so the coordinator can
 * disable a plugin without the plugin participating in the decision — a
 * strategy cannot re-enable itself.
 */
export interface StrategyRegistration {
  strategy: Strategy;
  enabled: boolean;
  symbols: string[];
  /** Parameters handed to the strategy through its immutable context. */
  parameters: Record<string, import('./types').JsonValue>;
}
