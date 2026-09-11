/**
 * `GridParameterService` unit tests — parallel to
 * `dip-ladder/parameter.service.spec.ts`, scoped to the grid strategy's much
 * smaller editable set.
 *
 * The HTTP-level behaviour is covered by `api/parameters.integration.spec.ts`.
 * This suite exercises the paths a well-formed request never reaches — an
 * unknown strategy, a malformed body, the individual rejection reasons,
 * restore across a restart — because each is a refusal, and a refusal
 * nobody has tested is a refusal nobody knows still works.
 */

import { InMemoryParameterChangeRepository } from '../../repositories/in-memory/in-memory.repositories';
import { CoordinatorService } from '../coordinator.service';
import { StrategyState } from '../types';
import { buildGridConfig, GridConfig } from './config';
import { GridParameterEditError, GridParameterService } from './parameter.service';

const STRATEGY_ID = 'grid:TQQQ';
const AT = '2024-03-04T10:00:00.000Z';

describe('GridParameterService', () => {
  let coordinator: CoordinatorService;
  let changes: InMemoryParameterChangeRepository;
  let service: GridParameterService;
  let config: GridConfig;

  beforeEach(() => {
    coordinator = new CoordinatorService();
    changes = new InMemoryParameterChangeRepository();
    service = new GridParameterService(coordinator, changes);
    config = buildGridConfig('TQQQ');
    service.register(STRATEGY_ID, config);
  });

  const edit = (requested: Record<string, unknown>) =>
    service.edit({ strategyId: STRATEGY_ID, requested, timestamp: AT });

  describe('unknown strategy', () => {
    it('refuses an edit for a strategy that was never registered', async () => {
      await expect(
        service.edit({ strategyId: 'grid:SOXL', requested: { gap: 1 }, timestamp: AT }),
      ).rejects.toThrow(GridParameterEditError);
    });

    it('reports null parameters rather than throwing on a read', () => {
      expect(service.parametersOf('grid:SOXL')).toBeNull();
      expect(service.configOf('grid:SOXL')).toBeNull();
    });

    it('lists the registered grid instance', () => {
      expect(service.editableStrategyIds()).toEqual([STRATEGY_ID]);
    });
  });

  describe('malformed requests', () => {
    it.each([
      ['null', null],
      ['a string', 'gap=1'],
      ['an array', ['gap']],
    ])('refuses %s as a parameter payload', async (_label, payload) => {
      await expect(edit(payload as unknown as Record<string, unknown>)).rejects.toThrow(
        'parameters must be an object',
      );
    });

    it('refuses an empty payload rather than recording a no-op change', async () => {
      await expect(edit({})).rejects.toThrow('no parameters supplied');
      await expect(changes.findAll()).resolves.toEqual([]);
    });
  });

  describe('rejection reasons', () => {
    it('explains that changing the symbol would orphan held lots', async () => {
      await expect(edit({ symbol: 'SOXL' })).rejects.toMatchObject({
        detail: { symbol: expect.stringContaining('orphan') },
      });
    });

    it('explains that entryBuffer is not a live-tunable parameter', async () => {
      await expect(edit({ entryBuffer: 0.1 })).rejects.toMatchObject({
        detail: { entryBuffer: expect.stringContaining('fill-quality') },
      });
    });

    it('explains that a retarget is a forbidden full recompute', async () => {
      await expect(edit({ sellTarget: 120 })).rejects.toMatchObject({
        detail: { sellTarget: expect.stringContaining('frozen') },
      });
    });

    it('reports an unrecognized field plainly', async () => {
      await expect(edit({ nonsense: 1 })).rejects.toMatchObject({
        detail: { nonsense: 'not a grid parameter' },
      });
    });

    it('leaves the config untouched when an edit is refused', async () => {
      await expect(edit({ gap: 2, sellTarget: 120 })).rejects.toThrow();

      expect(config.gap).toBe(0.5);
      await expect(changes.findAll()).resolves.toEqual([]);
    });
  });

  describe('applying an edit', () => {
    it('mutates the config object the strategy holds, not a copy', async () => {
      await edit({ gap: 0.75 });

      expect(config.gap).toBe(0.75);
    });

    it('never writes symbol or entryBuffer, even across an otherwise valid edit', async () => {
      await edit({ gap: 0.75 });

      expect(config.symbol).toBe('TQQQ');
      expect(config.entryBuffer).toBe(0.05);
    });

    it('records a null state when the strategy has not been initialized', async () => {
      await edit({ gap: 0.75 });
      const [change] = await changes.findAll();

      expect(change.stateAtChange).toBeNull();
      expect(change.reason).toBeNull();
    });

    it('reports no frozen targets when nothing is held', async () => {
      const result = await edit({ gap: 0.75 });

      expect(result.frozenLotTargets).toEqual([]);
    });

    it('reports the frozen sell targets of held lots', async () => {
      coordinator.setState(STRATEGY_ID, {
        strategyId: STRATEGY_ID,
        version: 1,
        symbols: ['TQQQ'],
        data: {
          lots: [
            { id: 'l1', status: 'HELD', sellTarget: 100.5, fillPrice: 100, quantity: 10 },
            { id: 'l2', status: 'CLOSED', sellTarget: 95.5, fillPrice: 95, quantity: 10 },
          ],
        },
      } as unknown as StrategyState);

      const result = await edit({ gap: 2 });

      // Only the held lot, and at its original, frozen target.
      expect(result.frozenLotTargets).toEqual([{ lotId: 'l1', sellTarget: 100.5 }]);
    });

    it('tolerates state whose data carries no lots array', async () => {
      coordinator.setState(STRATEGY_ID, {
        strategyId: STRATEGY_ID,
        version: 1,
        symbols: ['TQQQ'],
        data: {},
      } as unknown as StrategyState);

      await expect(edit({ gap: 0.75 })).resolves.toMatchObject({ frozenLotTargets: [] });
    });

    it('records the operator reason when one is supplied', async () => {
      await service.edit({
        strategyId: STRATEGY_ID,
        requested: { gap: 0.75 },
        timestamp: AT,
        reason: 'tighter chop than modelled',
      });

      const [change] = await changes.findAll();
      expect(change.reason).toBe('tighter chop than modelled');
    });

    it('propagates a range failure from the shared config builder', async () => {
      await expect(edit({ maxBuyLevels: 0 })).rejects.toThrow(/maxBuyLevels/);
      expect(config.maxBuyLevels).toBe(2);
    });
  });

  describe('the change log is queryable per strategy, and shared with the ladder’s table', () => {
    it('returns only the requested strategy changes', async () => {
      await edit({ gap: 0.75 });

      await expect(changes.findByStrategy(STRATEGY_ID)).resolves.toHaveLength(1);
      await expect(changes.findByStrategy('dip-ladder:TQQQ')).resolves.toEqual([]);
    });

    it('clears on reset', async () => {
      await edit({ gap: 0.75 });
      await changes.clear();

      await expect(changes.findAll()).resolves.toEqual([]);
    });
  });

  /**
   * `restore` is what makes an edit survive a restart, mirroring
   * `ParameterService.restore` exactly — these simulate a restart by
   * registering a *fresh* config against the *same* change repository, as
   * `EngineModule.onModuleInit` does.
   */
  describe('restore', () => {
    const reboot = (overrides = {}) => {
      const restarted = new GridParameterService(coordinator, changes);
      const restartedConfig = buildGridConfig('TQQQ', overrides);
      restarted.register(STRATEGY_ID, restartedConfig);
      return { restarted, restartedConfig };
    };

    it('re-applies the latest edit onto a config rebuilt from compiled defaults', async () => {
      await edit({ maxBuyLevels: 1 });

      const { restarted, restartedConfig } = reboot();
      await restarted.restore(STRATEGY_ID);

      expect(restartedConfig.maxBuyLevels).toBe(1);
    });

    it('keeps only the latest value per field across several edits', async () => {
      await edit({ gap: 0.5 });
      await edit({ gap: 0.75 });

      const { restarted, restartedConfig } = reboot();
      await restarted.restore(STRATEGY_ID);

      expect(restartedConfig.gap).toBe(0.75);
    });

    it('does not append a new GridParameterChange record', async () => {
      await edit({ maxBuyLevels: 1 });

      const { restarted } = reboot();
      await restarted.restore(STRATEGY_ID);

      await expect(changes.findByStrategy(STRATEGY_ID)).resolves.toHaveLength(1);
    });

    it('is a no-op for a strategy with no edit history', async () => {
      const { restarted, restartedConfig } = reboot();
      await restarted.restore(STRATEGY_ID);

      expect(restartedConfig).toEqual(buildGridConfig('TQQQ'));
    });

    it('is a no-op for an unregistered strategy id', async () => {
      await edit({ maxBuyLevels: 1 });

      const restarted = new GridParameterService(coordinator, changes);
      await expect(restarted.restore('grid:never-registered')).resolves.toBeUndefined();
    });

    it('ignores a history record for a parameter that is not editable', async () => {
      await changes.append({
        id: 'grid-param-change-symbol:symbol',
        changeId: 'grid-param-change-symbol',
        strategyId: STRATEGY_ID,
        parameter: 'symbol',
        oldValue: 'TQQQ',
        newValue: 'SOXL',
        timestamp: AT,
        stateAtChange: null,
        reason: null,
      });

      const { restarted, restartedConfig } = reboot();
      await restarted.restore(STRATEGY_ID);

      expect(restartedConfig).toEqual(buildGridConfig('TQQQ'));
    });

    it('leaves compiled defaults in force when a restored value fails validation', async () => {
      await changes.append({
        id: 'grid-param-change-bad:maxBuyLevels',
        changeId: 'grid-param-change-bad',
        strategyId: STRATEGY_ID,
        parameter: 'maxBuyLevels',
        oldValue: 2,
        newValue: 0,
        timestamp: AT,
        stateAtChange: null,
        reason: null,
      });

      const { restarted, restartedConfig } = reboot();
      await expect(restarted.restore(STRATEGY_ID)).resolves.toBeUndefined();
      expect(restartedConfig.maxBuyLevels).toBe(2);
    });
  });
});
