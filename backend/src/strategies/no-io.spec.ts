import { Bar } from '../market-data/types';
import { flatBar, forbidden, trapContext } from './contract-test-suite';
import { Strategy } from './strategy.interface';
import { OrderIntent, StrategyContext, StrategyState } from './types';

/**
 * "Strategies perform no I/O" (`PRD.md:204`) must be **enforced, not merely
 * documented** (`stories.md:200`).
 *
 * Two mechanisms enforce it, and they catch different violations:
 *
 * - `architecture.spec.ts` catches a forbidden *import* — a strategy file that
 *   references `src/broker/` at all.
 * - The trap context here catches a forbidden *access* — a strategy handed a
 *   broker at runtime, through a parameter or a context field, which no import
 *   scan would see.
 *
 * This file tests the second mechanism itself. A safety check that cannot fail
 * is worse than none, because it reports confidence it has not earned — so the
 * tests below prove the trap actually detects a violating strategy.
 */

const NOW = '2025-01-02T10:00:00.000-05:00';

function baseContext(): StrategyContext {
  return trapContext({
    strategyId: 'probe',
    symbols: ['TQQQ'],
    now: NOW,
    parameters: {},
    history: [],
  });
}

describe('the no-I/O trap detects violations', () => {
  it('throws when a strategy reaches for a broker on the context', () => {
    const ctx = baseContext() as StrategyContext & { broker: unknown };

    expect(() => ctx.broker).toThrow(/forbidden context member "broker"/);
  });

  it.each([
    'broker',
    'brokerAdapter',
    'repository',
    'repositories',
    'db',
    'prisma',
    'clock',
    'fetch',
    'http',
    'submit',
    'placeOrder',
    'riskManager',
  ])('throws on access to the forbidden member "%s"', (member) => {
    const ctx = baseContext() as unknown as Record<string, unknown>;

    expect(() => ctx[member]).toThrow(/strategy attempted I\/O/);
  });

  it('fails a strategy whose onBar touches a forbidden member', () => {
    // The violation the trap exists to catch, written out explicitly.
    class CheatingStrategy implements Strategy {
      readonly id = 'cheat';

      async initialize(ctx: StrategyContext): Promise<StrategyState> {
        return { strategyId: this.id, version: 1, symbols: [...ctx.symbols], data: {} };
      }

      onTick(): OrderIntent[] {
        return [];
      }

      onBar(_bar: Bar, _state: StrategyState): OrderIntent[] {
        // A strategy that captured a context and reached for the broker.
        const ctx = baseContext() as unknown as { broker: { submit: () => void } };
        ctx.broker.submit();
        return [];
      }

      evaluate(): OrderIntent[] {
        return [];
      }

      async terminate(): Promise<void> {
        return;
      }
    }

    const strategy = new CheatingStrategy();
    const state: StrategyState = {
      strategyId: 'cheat',
      version: 1,
      symbols: ['TQQQ'],
      data: {},
    };

    expect(() => strategy.onBar(flatBar('TQQQ', NOW), state)).toThrow(/strategy attempted I\/O/);
  });

  it('permits every legitimate context member', () => {
    const ctx = baseContext();

    expect(() => ctx.strategyId).not.toThrow();
    expect(() => ctx.symbols).not.toThrow();
    expect(() => ctx.now).not.toThrow();
    expect(() => ctx.parameters).not.toThrow();
    expect(() => ctx.history).not.toThrow();
    expect(ctx.now).toBe(NOW);
  });

  it('freezes the context and its collections', () => {
    const ctx = trapContext({
      strategyId: 'frozen',
      symbols: ['TQQQ'],
      now: NOW,
      parameters: { a: 1 },
      history: [flatBar('TQQQ', NOW)],
    });

    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.symbols)).toBe(true);
    expect(Object.isFrozen(ctx.parameters)).toBe(true);
    expect(Object.isFrozen(ctx.history)).toBe(true);
  });

  it('defaults history to empty when none is supplied', () => {
    const ctx = trapContext({
      strategyId: 'no-history',
      symbols: ['TQQQ'],
      now: NOW,
      parameters: {},
    });

    expect(ctx.history).toEqual([]);
  });

  it('copies history so a caller cannot mutate what the strategy already saw', () => {
    const history = [flatBar('TQQQ', NOW)];
    const ctx = trapContext({
      strategyId: 'copy',
      symbols: ['TQQQ'],
      now: NOW,
      parameters: {},
      history,
    });

    history.push(flatBar('TQQQ', '2025-01-02T10:05:00.000-05:00'));

    expect(ctx.history).toHaveLength(1);
  });

  it('forbidden() names the member it refused', () => {
    expect(() => forbidden('someMember')).toThrow(/"someMember"/);
  });
});
