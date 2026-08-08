import { flatBar, trapContext } from './contract-test-suite';
import { ScaffoldStrategy } from './scaffold';
import { StrategyContext } from './types';

/**
 * Covers `ScaffoldStrategy`'s own defaults, distinct from the three concrete
 * scaffolds — each of those overrides `initialData`, so the base class's empty
 * default is only reachable through a subclass that does not.
 */
class BareScaffold extends ScaffoldStrategy {
  readonly id = 'bare';
}

const NOW = '2025-01-02T10:00:00.000-05:00';

function context(): StrategyContext {
  return trapContext({
    strategyId: 'bare',
    symbols: ['TQQQ'],
    now: NOW,
    parameters: {},
  });
}

describe('ScaffoldStrategy defaults', () => {
  it('seeds empty state when a subclass supplies no initial data', async () => {
    const state = await new BareScaffold().initialize(context());

    expect(state.data).toEqual({});
    expect(state.strategyId).toBe('bare');
    expect(state.version).toBe(1);
    expect(state.symbols).toEqual(['TQQQ']);
  });

  it('emits nothing from any hook', async () => {
    const strategy = new BareScaffold();
    const ctx = context();
    const state = await strategy.initialize(ctx);

    expect(strategy.onBar(flatBar('TQQQ', NOW), state)).toEqual([]);
    expect(strategy.onTick({ symbol: 'TQQQ', timestamp: NOW, price: 100, size: 1 }, state)).toEqual(
      [],
    );
    expect(strategy.evaluate(ctx, state)).toEqual([]);
  });

  it('terminate resolves and is idempotent', async () => {
    const strategy = new BareScaffold();
    const state = await strategy.initialize(context());

    await expect(strategy.terminate(state)).resolves.toBeUndefined();
    await expect(strategy.terminate(state)).resolves.toBeUndefined();
  });
});
