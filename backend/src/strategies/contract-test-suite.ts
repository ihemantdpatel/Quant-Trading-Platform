/**
 * The shared contract suite every strategy plugin must pass.
 *
 * Exported as a function rather than written per-plugin so the rules are
 * defined once and cannot drift: a new strategy either calls this and passes,
 * or its spec visibly does not call it.
 *
 * Four properties are asserted, and the second is the one that earns the file
 * its keep:
 *
 * 1. **Hooks return the declared types.** `onTick`/`onBar`/`evaluate` return
 *    arrays of well-formed `OrderIntent`s, `initialize` returns a state.
 * 2. **No I/O.** The strategy is handed a context whose forbidden members —
 *    broker, repository, clock, fetch — throw on *any* access. If a strategy
 *    touches one, the hook throws and the test fails. This converts "strategies
 *    perform no I/O" (`PRD.md:204`) from a documented convention into a
 *    runtime-checked property. Note this complements `architecture.spec.ts`
 *    rather than duplicating it: that test catches a forbidden *import*, this
 *    one catches a forbidden *access* through something passed in at runtime.
 * 3. **`StrategyState` survives a JSON round trip unchanged** — it is the
 *    durable recovery unit (`PRD.md:222`), so anything that does not survive
 *    `JSON.parse(JSON.stringify(...))` is state that would be silently lost or
 *    corrupted on restart.
 * 4. **`terminate` is idempotent.** The coordinator may call it on an already
 *    stopped strategy during shutdown or after a failed start.
 */

import { Bar, BarSize, Tick } from '../market-data/types';
import { Strategy } from './strategy.interface';
import { JsonValue, OrderIntent, OrderType, StrategyContext, StrategyState } from './types';

export interface ContractSuiteOptions {
  /** Display name for the describe block. */
  name: string;
  /** Fresh instance per test — the suite must not depend on call ordering. */
  create: () => Strategy;
  symbols?: string[];
  parameters?: Record<string, JsonValue>;
  /** Bars fed to `onBar`. Defaults to a single flat bar on the first symbol. */
  bars?: Bar[];
}

/**
 * A proxy that throws on every property access, used for the members a
 * `StrategyContext` must never expose.
 *
 * A throwing getter rather than `undefined`, because `undefined` would let a
 * strategy do `ctx.broker?.submit()` and silently no-op — the test would pass
 * and the violation would ship. Accessing the member at all is the failure.
 */
export function forbidden(memberName: string): never {
  throw new Error(
    `strategy attempted I/O: accessed forbidden context member "${memberName}" — ` +
      'strategies receive an immutable context and return intents (PRD.md:204)',
  );
}

/**
 * Builds a context that is valid for legitimate use and explosive for anything
 * else.
 *
 * The legitimate fields are real values. The forbidden ones are defined as
 * throwing getters, so a strategy reaching for a broker, a repository, a clock,
 * or `fetch` fails loudly at the moment it does so.
 */
export function trapContext(base: {
  strategyId: string;
  symbols: string[];
  now: string;
  parameters: Record<string, JsonValue>;
  history?: Bar[];
}): StrategyContext {
  const context = {
    strategyId: base.strategyId,
    symbols: Object.freeze([...base.symbols]),
    now: base.now,
    parameters: Object.freeze({ ...base.parameters }),
    history: Object.freeze([...(base.history ?? [])]),
  };

  const FORBIDDEN_MEMBERS = [
    'broker',
    'brokerAdapter',
    'repository',
    'repositories',
    'db',
    'prisma',
    'clock',
    'Date',
    'fetch',
    'http',
    'submit',
    'placeOrder',
    'riskManager',
  ];

  for (const member of FORBIDDEN_MEMBERS) {
    Object.defineProperty(context, member, {
      get: () => forbidden(member),
      enumerable: false,
      configurable: false,
    });
  }

  return Object.freeze(context) as StrategyContext;
}

export function flatBar(symbol: string, timestamp: string, price = 100): Bar {
  return {
    symbol,
    barSize: BarSize.FIVE_MIN,
    timestamp,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: 1_000_000,
  };
}

/** Structural validation of an intent, independent of any strategy's logic. */
export function assertWellFormedIntent(intent: OrderIntent): void {
  expect(typeof intent.strategyId).toBe('string');
  expect(intent.strategyId.length).toBeGreaterThan(0);
  expect(intent.contract).toBeDefined();
  expect(typeof intent.contract.symbol).toBe('string');
  expect(['BUY', 'SELL']).toContain(intent.side);
  expect(Number.isFinite(intent.quantity)).toBe(true);
  expect(intent.quantity).toBeGreaterThanOrEqual(0);
  expect(Object.values(OrderType)).toContain(intent.orderType);

  if (intent.orderType === OrderType.LIMIT) {
    expect(Number.isFinite(intent.limitPrice)).toBe(true);
    expect(intent.limitPrice).toBeGreaterThan(0);
  }

  expect(typeof intent.timestamp).toBe('string');
  expect(typeof intent.reason).toBe('string');
}

/**
 * Runs the shared contract suite against a strategy implementation.
 *
 * Call from a plugin's own `.spec.ts`:
 * `runStrategyContractSuite({ name: 'GridStrategy', create: () => new GridStrategy() })`
 */
export function runStrategyContractSuite(options: ContractSuiteOptions): void {
  const symbols = options.symbols ?? ['TQQQ'];
  const parameters = options.parameters ?? {};
  const now = '2025-01-02T10:00:00.000-05:00';
  const bars = options.bars ?? [flatBar(symbols[0], now)];

  describe(`strategy contract: ${options.name}`, () => {
    const buildContext = (strategy: Strategy): StrategyContext =>
      trapContext({ strategyId: strategy.id, symbols, now, parameters, history: bars });

    const initialized = async (): Promise<{ strategy: Strategy; state: StrategyState }> => {
      const strategy = options.create();
      const state = await strategy.initialize(buildContext(strategy));
      return { strategy, state };
    };

    it('exposes a non-empty string id', () => {
      const strategy = options.create();
      expect(typeof strategy.id).toBe('string');
      expect(strategy.id.length).toBeGreaterThan(0);
    });

    it('initialize returns state carrying its own id and symbols', async () => {
      const { strategy, state } = await initialized();

      expect(state.strategyId).toBe(strategy.id);
      expect(Number.isInteger(state.version)).toBe(true);
      expect(Array.isArray(state.symbols)).toBe(true);
      expect(typeof state.data).toBe('object');
      expect(state.data).not.toBeNull();
    });

    it('onBar returns an array of well-formed intents', async () => {
      const { strategy, state } = await initialized();

      for (const bar of bars) {
        const intents = strategy.onBar(bar, state);
        expect(Array.isArray(intents)).toBe(true);
        intents.forEach(assertWellFormedIntent);
      }
    });

    it('onTick returns an array of well-formed intents', async () => {
      const { strategy, state } = await initialized();
      const tick: Tick = { symbol: symbols[0], timestamp: now, price: 100, size: 100 };

      const intents = strategy.onTick(tick, state);
      expect(Array.isArray(intents)).toBe(true);
      intents.forEach(assertWellFormedIntent);
    });

    it('evaluate returns an array of well-formed intents', async () => {
      const { strategy, state } = await initialized();

      const intents = strategy.evaluate(buildContext(strategy), state);
      expect(Array.isArray(intents)).toBe(true);
      intents.forEach(assertWellFormedIntent);
    });

    /**
     * The no-I/O rule, enforced rather than documented. Every hook runs against
     * a context that throws on any forbidden access; reaching for a broker or a
     * clock fails the test here.
     */
    it('performs no I/O — touches no forbidden context member', async () => {
      const strategy = options.create();
      const context = buildContext(strategy);

      const state = await strategy.initialize(context);

      expect(() => strategy.evaluate(context, state)).not.toThrow();

      for (const bar of bars) {
        expect(() => strategy.onBar(bar, state)).not.toThrow();
      }

      expect(() =>
        strategy.onTick({ symbol: symbols[0], timestamp: now, price: 100, size: 1 }, state),
      ).not.toThrow();
    });

    it('state survives a JSON round trip unchanged', async () => {
      const { state } = await initialized();
      const roundTripped = JSON.parse(JSON.stringify(state)) as StrategyState;

      expect(roundTripped).toEqual(state);
    });

    it('state after processing bars still survives a JSON round trip', async () => {
      // The interesting case: initial state is trivially serializable, but
      // state mutated by bar processing is where a Date or a Map creeps in.
      const { strategy, state } = await initialized();
      bars.forEach((bar) => strategy.onBar(bar, state));

      expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    });

    it('terminate is idempotent', async () => {
      const { strategy, state } = await initialized();

      await expect(strategy.terminate(state)).resolves.not.toThrow();
      await expect(strategy.terminate(state)).resolves.not.toThrow();
      await expect(strategy.terminate(state)).resolves.not.toThrow();
    });

    it('emits intents only for its own registered symbols', async () => {
      const { strategy, state } = await initialized();

      const intents = bars.flatMap((bar) => strategy.onBar(bar, state));

      intents.forEach((intent) => {
        expect(symbols).toContain(intent.contract.symbol);
      });
    });

    it('tags every intent with its own strategy id', async () => {
      const { strategy, state } = await initialized();

      const intents = bars.flatMap((bar) => strategy.onBar(bar, state));

      intents.forEach((intent) => {
        expect(intent.strategyId).toBe(strategy.id);
      });
    });
  });
}
