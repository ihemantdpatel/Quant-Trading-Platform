import { runStrategyContractSuite } from './contract-test-suite';
import { GridStrategy } from './grid/grid.strategy';
import { LeapsStrategy } from './leaps/leaps.strategy';
import { WheelPhase, WheelStrategy } from './wheel/wheel.strategy';
import { flatBar } from './contract-test-suite';
import { StrategyContext } from './types';

/**
 * The Story 2 exit criterion: **all three scaffolds pass the shared contract
 * suite** (`stories.md:196`). Each calls the same exported suite, so the rules
 * cannot drift per plugin — a strategy either passes the one definition or
 * visibly does not run it.
 */
runStrategyContractSuite({ name: 'GridStrategy', create: () => new GridStrategy() });
runStrategyContractSuite({ name: 'WheelStrategy', create: () => new WheelStrategy() });
runStrategyContractSuite({ name: 'LeapsStrategy', create: () => new LeapsStrategy() });

const NOW = '2025-01-02T10:00:00.000-05:00';

function context(strategyId: string, symbols = ['TQQQ']): StrategyContext {
  return {
    strategyId,
    symbols,
    now: NOW,
    parameters: {},
    history: [],
  };
}

describe('scaffolded strategies are inert', () => {
  const scaffolds = [
    { name: 'grid', create: () => new GridStrategy() },
    { name: 'wheel', create: () => new WheelStrategy() },
    { name: 'leaps', create: () => new LeapsStrategy() },
  ];

  it.each(scaffolds)('$name emits no intents from any hook', async ({ create }) => {
    // Inert is the specification, not an omission (`PRD.md:229`): these are
    // wired into the same coordinator the dip ladder runs in, so a placeholder
    // intent would be a strategy that trades.
    const strategy = create();
    const ctx = context(strategy.id);
    const state = await strategy.initialize(ctx);

    expect(strategy.onBar(flatBar('TQQQ', NOW), state)).toEqual([]);
    expect(strategy.onTick({ symbol: 'TQQQ', timestamp: NOW, price: 100, size: 1 }, state)).toEqual(
      [],
    );
    expect(strategy.evaluate(ctx, state)).toEqual([]);
  });

  it.each(scaffolds)('$name reports a stable, non-empty id', ({ create }) => {
    expect(create().id).toMatch(/^[a-z-]+$/);
  });

  it('the three scaffolds have distinct ids', () => {
    const ids = scaffolds.map(({ create }) => create().id);

    expect(new Set(ids).size).toBe(3);
  });

  it('carries the context symbols into initial state', async () => {
    const strategy = new GridStrategy();
    const state = await strategy.initialize(context(strategy.id, ['TQQQ', 'SPY']));

    expect(state.symbols).toEqual(['TQQQ', 'SPY']);
    expect(state.version).toBe(1);
  });
});

describe('scaffold seed state names what Story 16 will implement', () => {
  it('the wheel starts in the cash-secured-put phase holding no shares', async () => {
    // The put-assigned → covered-call transition is the wheel's core state
    // machine; naming it now means Story 16 adds behaviour, not structure.
    const strategy = new WheelStrategy();
    const state = await strategy.initialize(context(strategy.id));

    expect(state.data).toEqual({ phase: WheelPhase.CASH_SECURED_PUT, assignedShares: 0 });
  });

  it('the grid starts with no levels', async () => {
    const strategy = new GridStrategy();
    const state = await strategy.initialize(context(strategy.id));

    expect(state.data).toEqual({ gridLevels: [] });
  });

  it('leaps starts with no positions and no evaluation timestamp', async () => {
    const strategy = new LeapsStrategy();
    const state = await strategy.initialize(context(strategy.id));

    expect(state.data).toEqual({ openPositions: [], lastEvaluatedAt: null });
  });
});
