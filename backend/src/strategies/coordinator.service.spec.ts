import { Bar, BarSize, Tick } from '../market-data/types';
import { CoordinatorService } from './coordinator.service';
import { GridStrategy } from './grid/grid.strategy';
import { LeapsStrategy } from './leaps/leaps.strategy';
import { Strategy } from './strategy.interface';
import { WheelStrategy } from './wheel/wheel.strategy';
import {
  equityContract,
  JsonValue,
  OrderIntent,
  OrderType,
  StrategyContext,
  StrategyState,
  TimeInForce,
} from './types';

const NOW = '2025-01-02T10:00:00.000-05:00';

function bar(symbol: string, close = 100, timestamp = NOW): Bar {
  return {
    symbol,
    barSize: BarSize.FIVE_MIN,
    timestamp,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
  };
}

/**
 * A strategy that records every hook call, so "disabled strategies receive no
 * hook calls" can be asserted by counting rather than inferred from output.
 */
class RecordingStrategy implements Strategy {
  readonly calls: string[] = [];

  constructor(
    readonly id: string,
    private readonly emitOnBar = false,
  ) {}

  async initialize(ctx: StrategyContext): Promise<StrategyState> {
    this.calls.push('initialize');
    return {
      strategyId: this.id,
      version: 1,
      symbols: [...ctx.symbols],
      data: { seen: [] as JsonValue },
    };
  }

  onTick(_tick: Tick, _state: StrategyState): OrderIntent[] {
    this.calls.push('onTick');
    return [];
  }

  onBar(b: Bar, state: StrategyState): OrderIntent[] {
    this.calls.push('onBar');
    (state.data.seen as string[]).push(`${this.id}:${b.symbol}`);

    if (!this.emitOnBar) {
      return [];
    }

    return [
      {
        strategyId: this.id,
        contract: equityContract(b.symbol),
        side: 'BUY',
        quantity: 1,
        orderType: OrderType.LIMIT,
        limitPrice: b.close,
        timeInForce: TimeInForce.DAY,
        timestamp: b.timestamp,
        reason: 'test',
      },
    ];
  }

  evaluate(_ctx: StrategyContext, _state: StrategyState): OrderIntent[] {
    this.calls.push('evaluate');
    return [];
  }

  async terminate(_state: StrategyState): Promise<void> {
    this.calls.push('terminate');
  }
}

describe('CoordinatorService', () => {
  let coordinator: CoordinatorService;

  beforeEach(() => {
    coordinator = new CoordinatorService();
  });

  describe('registration', () => {
    it('registers all four strategies with three disabled', async () => {
      // The Story 2 exit criterion (`stories.md:204`): 4 registered, 3 disabled.
      const ladder = new RecordingStrategy('dip-ladder:TQQQ');

      coordinator.register({ strategy: ladder, enabled: true, symbols: ['TQQQ'] });
      coordinator.register({ strategy: new GridStrategy(), enabled: false, symbols: ['TQQQ'] });
      coordinator.register({ strategy: new WheelStrategy(), enabled: false, symbols: ['TQQQ'] });
      coordinator.register({ strategy: new LeapsStrategy(), enabled: false, symbols: ['TQQQ'] });

      await coordinator.initializeAll(NOW);

      const snapshots = coordinator.snapshots();
      expect(snapshots).toHaveLength(4);
      expect(snapshots.filter((s) => s.enabled)).toHaveLength(1);
      expect(snapshots.filter((s) => !s.enabled)).toHaveLength(3);
    });

    it('refuses a duplicate strategy id rather than silently replacing it', () => {
      coordinator.register({
        strategy: new RecordingStrategy('dup'),
        enabled: true,
        symbols: ['TQQQ'],
      });

      expect(() =>
        coordinator.register({
          strategy: new RecordingStrategy('dup'),
          enabled: true,
          symbols: ['TQQQ'],
        }),
      ).toThrow(/already registered/);
    });
  });

  describe('disabled strategies receive zero hook invocations', () => {
    it('never calls initialize, onBar, onTick, or evaluate on a disabled strategy', async () => {
      const disabled = new RecordingStrategy('disabled');
      const enabled = new RecordingStrategy('enabled');

      coordinator.register({ strategy: disabled, enabled: false, symbols: ['TQQQ'] });
      coordinator.register({ strategy: enabled, enabled: true, symbols: ['TQQQ'] });

      await coordinator.initializeAll(NOW);
      coordinator.dispatchBar(bar('TQQQ'));
      coordinator.dispatchTick({ symbol: 'TQQQ', timestamp: NOW, price: 100, size: 1 });
      coordinator.dispatchEvaluate(NOW);

      expect(disabled.calls).toEqual([]);
      expect(enabled.calls).toEqual(['initialize', 'onBar', 'onTick', 'evaluate']);
    });

    it('stops dispatching to a strategy disabled mid-session', async () => {
      const strategy = new RecordingStrategy('toggle');
      coordinator.register({ strategy, enabled: true, symbols: ['TQQQ'] });
      await coordinator.initializeAll(NOW);

      coordinator.dispatchBar(bar('TQQQ'));
      expect(strategy.calls.filter((c) => c === 'onBar')).toHaveLength(1);

      coordinator.disable('toggle');
      coordinator.dispatchBar(bar('TQQQ'));

      expect(strategy.calls.filter((c) => c === 'onBar')).toHaveLength(1);
    });

    it('retains state when disabled — a disabled ladder still holds real lots', async () => {
      const strategy = new RecordingStrategy('holder');
      coordinator.register({ strategy, enabled: true, symbols: ['TQQQ'] });
      await coordinator.initializeAll(NOW);
      coordinator.dispatchBar(bar('TQQQ'));

      coordinator.disable('holder');

      expect(coordinator.getState('holder')?.data.seen).toEqual(['holder:TQQQ']);
    });

    it('initializes a strategy that is enabled after registration', async () => {
      const strategy = new RecordingStrategy('late');
      coordinator.register({ strategy, enabled: false, symbols: ['TQQQ'] });
      await coordinator.initializeAll(NOW);

      expect(strategy.calls).toEqual([]);

      await coordinator.enable('late', NOW);

      expect(strategy.calls).toEqual(['initialize']);
      expect(coordinator.isEnabled('late')).toBe(true);
    });

    it('does not re-initialize an already initialized strategy on re-enable', async () => {
      const strategy = new RecordingStrategy('cycle');
      coordinator.register({ strategy, enabled: true, symbols: ['TQQQ'] });
      await coordinator.initializeAll(NOW);
      coordinator.disable('cycle');

      await coordinator.enable('cycle', NOW);

      expect(strategy.calls.filter((c) => c === 'initialize')).toHaveLength(1);
    });

    it('reports false for enable/disable of an unknown id', async () => {
      await expect(coordinator.enable('nope', NOW)).resolves.toBe(false);
      expect(coordinator.disable('nope')).toBe(false);
      expect(coordinator.isEnabled('nope')).toBe(false);
      expect(coordinator.getStrategy('nope')).toBeNull();
      expect(coordinator.getState('nope')).toBeNull();
    });
  });

  describe('concurrent strategies across symbols', () => {
    it('routes each bar only to strategies registered for that symbol', async () => {
      const tqqq = new RecordingStrategy('on-tqqq');
      const spy = new RecordingStrategy('on-spy');

      coordinator.register({ strategy: tqqq, enabled: true, symbols: ['TQQQ'] });
      coordinator.register({ strategy: spy, enabled: true, symbols: ['SPY'] });
      await coordinator.initializeAll(NOW);

      coordinator.dispatchBar(bar('TQQQ'));
      coordinator.dispatchBar(bar('SPY'));

      expect(coordinator.getState('on-tqqq')?.data.seen).toEqual(['on-tqqq:TQQQ']);
      expect(coordinator.getState('on-spy')?.data.seen).toEqual(['on-spy:SPY']);
    });

    it('runs multiple strategies on different symbols with no state bleed', async () => {
      // Each strategy must see only its own state. Sharing a reference here is
      // the bug this test exists to catch — it would make one ladder's lots
      // visible to another and corrupt reconciliation at Story 9.
      const a = new RecordingStrategy('a');
      const b = new RecordingStrategy('b');

      coordinator.register({ strategy: a, enabled: true, symbols: ['TQQQ'] });
      coordinator.register({ strategy: b, enabled: true, symbols: ['SPY'] });
      await coordinator.initializeAll(NOW);

      coordinator.dispatchBar(bar('TQQQ'));
      coordinator.dispatchBar(bar('TQQQ'));
      coordinator.dispatchBar(bar('SPY'));

      const stateA = coordinator.getState('a')!;
      const stateB = coordinator.getState('b')!;

      expect(stateA.data.seen).toHaveLength(2);
      expect(stateB.data.seen).toHaveLength(1);
      expect(stateA.data).not.toBe(stateB.data);
    });

    it('runs two strategies on the same symbol independently', async () => {
      const first = new RecordingStrategy('first');
      const second = new RecordingStrategy('second');

      coordinator.register({ strategy: first, enabled: true, symbols: ['TQQQ'] });
      coordinator.register({ strategy: second, enabled: true, symbols: ['TQQQ'] });
      await coordinator.initializeAll(NOW);

      coordinator.dispatchBar(bar('TQQQ'));

      expect(coordinator.getState('first')?.data.seen).toEqual(['first:TQQQ']);
      expect(coordinator.getState('second')?.data.seen).toEqual(['second:TQQQ']);
    });

    it('collects intents from every enabled strategy on the bar', async () => {
      coordinator.register({
        strategy: new RecordingStrategy('emit-a', true),
        enabled: true,
        symbols: ['TQQQ'],
      });
      coordinator.register({
        strategy: new RecordingStrategy('emit-b', true),
        enabled: true,
        symbols: ['TQQQ'],
      });
      await coordinator.initializeAll(NOW);

      const intents = coordinator.dispatchBar(bar('TQQQ'));

      expect(intents.map((i) => i.strategyId).sort()).toEqual(['emit-a', 'emit-b']);
    });

    it('skips an enabled strategy that has not been initialized', () => {
      const strategy = new RecordingStrategy('uninit');
      coordinator.register({ strategy, enabled: true, symbols: ['TQQQ'] });

      // initializeAll deliberately not called.
      expect(coordinator.dispatchBar(bar('TQQQ'))).toEqual([]);
      expect(coordinator.dispatchEvaluate(NOW)).toEqual([]);
      expect(strategy.calls).toEqual([]);
    });
  });

  describe('context immutability', () => {
    it('hands strategies a frozen context they cannot mutate', async () => {
      let captured: StrategyContext | null = null;

      class CapturingStrategy extends RecordingStrategy {
        async initialize(ctx: StrategyContext): Promise<StrategyState> {
          captured = ctx;
          return super.initialize(ctx);
        }
      }

      coordinator.register({
        strategy: new CapturingStrategy('capture'),
        enabled: true,
        symbols: ['TQQQ'],
        parameters: { spacingPercent: 0.05 },
      });
      await coordinator.initializeAll(NOW);

      expect(Object.isFrozen(captured!)).toBe(true);
      expect(Object.isFrozen(captured!.parameters)).toBe(true);
      expect(Object.isFrozen(captured!.symbols)).toBe(true);
      expect(captured!.parameters.spacingPercent).toBe(0.05);
      expect(captured!.now).toBe(NOW);
    });

    it('copies symbols so a caller mutating its array cannot affect registration', async () => {
      const symbols = ['TQQQ'];
      const strategy = new RecordingStrategy('copy');
      coordinator.register({ strategy, enabled: true, symbols });

      symbols.push('SPY');
      await coordinator.initializeAll(NOW);
      coordinator.dispatchBar(bar('SPY'));

      expect(strategy.calls).toEqual(['initialize']);
    });
  });

  describe('lifecycle', () => {
    it('terminates every initialized strategy', async () => {
      const a = new RecordingStrategy('term-a');
      const b = new RecordingStrategy('term-b');
      coordinator.register({ strategy: a, enabled: true, symbols: ['TQQQ'] });
      coordinator.register({ strategy: b, enabled: true, symbols: ['TQQQ'] });
      await coordinator.initializeAll(NOW);

      await coordinator.terminateAll();

      expect(a.calls).toContain('terminate');
      expect(b.calls).toContain('terminate');
    });

    it('does not terminate a strategy that was never initialized', async () => {
      const strategy = new RecordingStrategy('never');
      coordinator.register({ strategy, enabled: false, symbols: ['TQQQ'] });
      await coordinator.initializeAll(NOW);

      await coordinator.terminateAll();

      expect(strategy.calls).toEqual([]);
    });

    it('continues terminating others when one strategy throws', async () => {
      // One misbehaving plugin must not prevent a clean shutdown of the rest.
      class ThrowingStrategy extends RecordingStrategy {
        async terminate(): Promise<void> {
          throw new Error('boom');
        }
      }

      const survivor = new RecordingStrategy('survivor');
      coordinator.register({
        strategy: new ThrowingStrategy('thrower'),
        enabled: true,
        symbols: ['TQQQ'],
      });
      coordinator.register({ strategy: survivor, enabled: true, symbols: ['TQQQ'] });
      await coordinator.initializeAll(NOW);

      await expect(coordinator.terminateAll()).resolves.not.toThrow();
      expect(survivor.calls).toContain('terminate');
    });

    it('setState replaces state — the Story 8 snapshot restore seam', async () => {
      const strategy = new RecordingStrategy('restore');
      coordinator.register({ strategy, enabled: true, symbols: ['TQQQ'] });
      await coordinator.initializeAll(NOW);

      const restored: StrategyState = {
        strategyId: 'restore',
        version: 1,
        symbols: ['TQQQ'],
        data: { seen: ['recovered'] },
      };
      coordinator.setState('restore', restored);

      expect(coordinator.getState('restore')).toEqual(restored);
    });

    it('reset clears registrations and state', async () => {
      coordinator.register({
        strategy: new RecordingStrategy('gone'),
        enabled: true,
        symbols: ['TQQQ'],
      });
      await coordinator.initializeAll(NOW);

      coordinator.reset();

      expect(coordinator.registeredIds()).toEqual([]);
      expect(coordinator.snapshots()).toEqual([]);
    });

    it('exposes registered ids and the strategy instance', async () => {
      const strategy = new RecordingStrategy('lookup');
      coordinator.register({ strategy, enabled: true, symbols: ['TQQQ'] });

      expect(coordinator.registeredIds()).toEqual(['lookup']);
      expect(coordinator.getStrategy('lookup')).toBe(strategy);
    });
  });
});
