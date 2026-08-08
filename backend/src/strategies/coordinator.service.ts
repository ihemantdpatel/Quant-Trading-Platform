/**
 * The multi-strategy coordinator.
 *
 * Owns registration, lifecycle dispatch, and per-instance state. Deliberately
 * knows nothing about any individual strategy: it holds `Strategy` references
 * and opaque `StrategyState` blobs, so adding the Wheel at Story 16 requires no
 * change here. That is the plugin rule from `CLAUDE.md` — "new strategies should
 * be added as plugins implementing that interface, never as special cases
 * inside the coordinator".
 *
 * **It does not submit anything.** `dispatchBar` returns the intents it
 * collected; the engine hands them to the risk manager. The coordinator holds
 * no broker reference, which is what keeps `architecture.spec.ts` green.
 *
 * ## State isolation
 *
 * Each registration gets its own `StrategyState`, keyed by strategy id, and a
 * strategy only ever sees its own. Two strategies on different symbols cannot
 * bleed state into one another because neither is handed a reference to the
 * other's — asserted directly in the spec.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Bar, Tick } from '../market-data/types';
import { Strategy, StrategyRegistration } from './strategy.interface';
import { JsonValue, OrderIntent, StrategyContext, StrategyState } from './types';

export interface RegisterParams {
  strategy: Strategy;
  /** Disabled registrations receive zero hook calls. */
  enabled: boolean;
  symbols: string[];
  parameters?: Record<string, JsonValue>;
}

/** A registration plus its live state, as the engine and API read it. */
export interface StrategySnapshot {
  id: string;
  enabled: boolean;
  symbols: string[];
  initialized: boolean;
  state: StrategyState | null;
}

@Injectable()
export class CoordinatorService {
  private readonly logger = new Logger(CoordinatorService.name);
  private readonly registrations = new Map<string, StrategyRegistration>();
  private readonly states = new Map<string, StrategyState>();

  /**
   * Registers a plugin. Ids are unique — a duplicate is a wiring mistake, and
   * silently replacing the first would drop its state on the floor.
   */
  register(params: RegisterParams): void {
    if (this.registrations.has(params.strategy.id)) {
      throw new Error(`strategy "${params.strategy.id}" is already registered`);
    }

    this.registrations.set(params.strategy.id, {
      strategy: params.strategy,
      enabled: params.enabled,
      symbols: [...params.symbols],
      parameters: { ...(params.parameters ?? {}) },
    });
  }

  /**
   * Initializes every **enabled** strategy.
   *
   * Disabled ones are deliberately not initialized: `initialize` is a hook, and
   * "disabled strategies receive no hook calls" (`stories.md:197`) has no
   * exception for this one. Enabling later initializes on demand.
   */
  async initializeAll(now: string): Promise<void> {
    for (const [id, registration] of this.registrations) {
      if (registration.enabled) {
        await this.initializeOne(id, registration, now);
      }
    }
  }

  private async initializeOne(
    id: string,
    registration: StrategyRegistration,
    now: string,
  ): Promise<void> {
    const state = await registration.strategy.initialize(this.buildContext(id, registration, now));
    this.states.set(id, state);
    this.logger.log(`initialized strategy "${id}" on ${registration.symbols.join(', ')}`);
  }

  /**
   * Dispatches a bar to every enabled strategy responsible for its symbol.
   *
   * Symbol filtering is the coordinator's job, not the strategy's: a plugin
   * should never have to defend against being handed a symbol it does not
   * trade, and centralizing it means the rule holds for every strategy ever
   * written rather than for each one that remembers to check.
   */
  dispatchBar(bar: Bar): OrderIntent[] {
    return this.collect(bar.symbol, (strategy, state) => strategy.onBar(bar, state));
  }

  dispatchTick(tick: Tick): OrderIntent[] {
    return this.collect(tick.symbol, (strategy, state) => strategy.onTick(tick, state));
  }

  /**
   * Dispatches the context-driven hook to every enabled strategy.
   *
   * Not symbol-filtered — `evaluate` is the time-based hook and a strategy
   * spanning several symbols evaluates them together.
   */
  dispatchEvaluate(now: string): OrderIntent[] {
    const intents: OrderIntent[] = [];

    for (const [id, registration] of this.registrations) {
      const state = this.states.get(id);

      if (!registration.enabled || !state) {
        continue;
      }

      intents.push(
        ...registration.strategy.evaluate(this.buildContext(id, registration, now), state),
      );
    }

    return intents;
  }

  private collect(
    symbol: string,
    invoke: (strategy: Strategy, state: StrategyState) => OrderIntent[],
  ): OrderIntent[] {
    const intents: OrderIntent[] = [];

    for (const [id, registration] of this.registrations) {
      const state = this.states.get(id);

      // An enabled-but-uninitialized strategy is skipped rather than throwing:
      // `initializeAll` may not have run yet in a partially wired test, and a
      // missing state is not a reason to abort a live bar.
      if (!registration.enabled || !state || !registration.symbols.includes(symbol)) {
        continue;
      }

      intents.push(...invoke(registration.strategy, state));
    }

    return intents;
  }

  /**
   * Builds the immutable context for a strategy.
   *
   * Frozen, and the arrays are copies. A strategy that tried to mutate its
   * context — appending to `history`, rewriting a parameter — would fail rather
   * than silently corrupting what the next strategy sees.
   */
  private buildContext(
    id: string,
    registration: StrategyRegistration,
    now: string,
    history: Bar[] = [],
  ): StrategyContext {
    return Object.freeze({
      strategyId: id,
      symbols: Object.freeze([...registration.symbols]),
      now,
      parameters: Object.freeze({ ...registration.parameters }),
      history: Object.freeze([...history]),
    });
  }

  /**
   * Enables a strategy, initializing it if it has never run.
   *
   * Returns false when the id is unknown, so the HTTP layer can answer 404
   * rather than reporting success for a strategy that does not exist.
   */
  async enable(id: string, now: string): Promise<boolean> {
    const registration = this.registrations.get(id);

    if (!registration) {
      return false;
    }

    registration.enabled = true;

    if (!this.states.has(id)) {
      await this.initializeOne(id, registration, now);
    }

    return true;
  }

  /**
   * Disables a strategy. **State is retained**, not discarded — a disabled
   * ladder still holds real lots, and dropping their composition would leave
   * Story 9's reconciliation nothing to reconcile against.
   */
  disable(id: string): boolean {
    const registration = this.registrations.get(id);

    if (!registration) {
      return false;
    }

    registration.enabled = false;
    return true;
  }

  isEnabled(id: string): boolean {
    return this.registrations.get(id)?.enabled ?? false;
  }

  getState(id: string): StrategyState | null {
    return this.states.get(id) ?? null;
  }

  /** Replaces a strategy's state — the seam Story 8 restores a snapshot through. */
  setState(id: string, state: StrategyState): void {
    this.states.set(id, state);
  }

  getStrategy(id: string): Strategy | null {
    return this.registrations.get(id)?.strategy ?? null;
  }

  snapshots(): StrategySnapshot[] {
    return [...this.registrations.entries()].map(([id, registration]) => ({
      id,
      enabled: registration.enabled,
      symbols: [...registration.symbols],
      initialized: this.states.has(id),
      state: this.states.get(id) ?? null,
    }));
  }

  registeredIds(): string[] {
    return [...this.registrations.keys()];
  }

  /**
   * Terminates every initialized strategy.
   *
   * Failures are logged and swallowed so one misbehaving plugin cannot prevent
   * the others from shutting down cleanly. `terminate` is required to be
   * idempotent, so this is safe to call more than once.
   */
  async terminateAll(): Promise<void> {
    for (const [id, registration] of this.registrations) {
      const state = this.states.get(id);

      if (!state) {
        continue;
      }

      try {
        await registration.strategy.terminate(state);
      } catch (error) {
        this.logger.error(`strategy "${id}" failed to terminate: ${String(error)}`);
      }
    }
  }

  /** Test and restart support — drops all registrations and state. */
  reset(): void {
    this.registrations.clear();
    this.states.clear();
  }
}
