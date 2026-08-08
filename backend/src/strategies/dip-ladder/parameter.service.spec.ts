/**
 * `ParameterService` unit tests.
 *
 * The HTTP-level behaviour is covered by `api/parameters.integration.spec.ts`.
 * This suite exercises the paths that a well-formed request never reaches —
 * an unknown strategy, a malformed body, the individual rejection reasons —
 * because each of them is a refusal, and a refusal nobody has tested is a
 * refusal nobody knows still works.
 */

import { ParameterEditError, ParameterService } from './parameter.service';
import { InMemoryParameterChangeRepository } from '../../repositories/in-memory/in-memory.repositories';
import { CoordinatorService } from '../coordinator.service';
import { buildDipLadderConfig, DipLadderConfig } from './config';
import { StrategyState } from '../types';

const STRATEGY_ID = 'dip-ladder:TQQQ';
const AT = '2024-03-04T10:00:00.000Z';

describe('ParameterService', () => {
  let coordinator: CoordinatorService;
  let changes: InMemoryParameterChangeRepository;
  let service: ParameterService;
  let config: DipLadderConfig;

  beforeEach(() => {
    coordinator = new CoordinatorService();
    changes = new InMemoryParameterChangeRepository();
    service = new ParameterService(coordinator, changes);
    config = buildDipLadderConfig('TQQQ', { symbolCapital: 100_000 });
    service.register(STRATEGY_ID, config);
  });

  const edit = (requested: Record<string, unknown>) =>
    service.edit({ strategyId: STRATEGY_ID, requested, timestamp: AT });

  describe('unknown strategy', () => {
    it('refuses an edit for a strategy that was never registered', async () => {
      await expect(
        service.edit({ strategyId: 'grid', requested: { spacingPercent: 0.1 }, timestamp: AT }),
      ).rejects.toThrow(ParameterEditError);
    });

    it('reports null parameters rather than throwing on a read', () => {
      expect(service.parametersOf('grid')).toBeNull();
      expect(service.configOf('grid')).toBeNull();
    });

    it('lists the registered ladder', () => {
      expect(service.editableStrategyIds()).toEqual([STRATEGY_ID]);
    });
  });

  describe('malformed requests', () => {
    it.each([
      ['null', null],
      ['a string', 'takeProfitPercent=0.1'],
      ['an array', ['takeProfitPercent']],
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
    it('explains that symbolCapital is a Story 13 item, not an HTTP setting', async () => {
      await expect(edit({ symbolCapital: 250_000 })).rejects.toMatchObject({
        detail: {
          symbolCapital: expect.stringContaining('PRD.md:500'),
        },
      });
    });

    it('explains that changing the symbol would orphan held lots', async () => {
      await expect(edit({ symbol: 'SQQQ' })).rejects.toMatchObject({
        detail: { symbol: expect.stringContaining('orphan') },
      });
    });

    it('explains that a retarget is a forbidden full recompute', async () => {
      await expect(edit({ exitTarget: 120 })).rejects.toMatchObject({
        detail: { exitTarget: expect.stringContaining('full recompute is not permitted') },
      });
    });

    it('reports an unrecognized field plainly', async () => {
      await expect(edit({ nonsense: 1 })).rejects.toMatchObject({
        detail: { nonsense: 'not a dip-ladder parameter' },
      });
    });

    it('leaves the config untouched when an edit is refused', async () => {
      await expect(edit({ takeProfitPercent: 0.1, exitTarget: 120 })).rejects.toThrow();

      expect(config.takeProfitPercent).toBe(0.05);
      await expect(changes.findAll()).resolves.toEqual([]);
    });
  });

  describe('applying an edit', () => {
    it('mutates the config object the strategy holds, not a copy', async () => {
      await edit({ takeProfitPercent: 0.08 });

      // The same object reference registered at construction — this is what
      // makes the next bar's `evaluateBar` see the new value.
      expect(config.takeProfitPercent).toBe(0.08);
    });

    it('never writes symbolCapital, even across an otherwise valid edit', async () => {
      await edit({ takeProfitPercent: 0.08 });

      expect(config.symbolCapital).toBe(100_000);
      expect(config.symbol).toBe('TQQQ');
    });

    it('records a null state when the strategy has not been initialized', async () => {
      // No state registered with the coordinator: an edit before the first bar.
      const [change] = (await edit({ takeProfitPercent: 0.08 }), await changes.findAll());

      expect(change.stateAtChange).toBeNull();
      expect(change.reason).toBeNull();
    });

    it('reports no frozen targets when nothing is held', async () => {
      const result = await edit({ takeProfitPercent: 0.08 });

      expect(result.frozenLotTargets).toEqual([]);
    });

    it('reports the frozen targets of held lots', async () => {
      coordinator.setState(STRATEGY_ID, {
        strategyId: STRATEGY_ID,
        version: 1,
        symbols: ['TQQQ'],
        data: {
          lots: [
            { id: 'l1', status: 'HELD', exitTarget: 99.75, fillPrice: 95, quantity: 10 },
            { id: 'l2', status: 'CLOSED', exitTarget: 94.76, fillPrice: 90.25, quantity: 11 },
          ],
        },
      } as unknown as StrategyState);

      const result = await edit({ takeProfitPercent: 0.2 });

      // Only the held lot, and at its original target.
      expect(result.frozenLotTargets).toEqual([{ lotId: 'l1', exitTarget: 99.75 }]);
    });

    it('tolerates state whose data carries no lots array', async () => {
      coordinator.setState(STRATEGY_ID, {
        strategyId: STRATEGY_ID,
        version: 1,
        symbols: ['TQQQ'],
        data: {},
      } as unknown as StrategyState);

      await expect(edit({ takeProfitPercent: 0.08 })).resolves.toMatchObject({
        frozenLotTargets: [],
      });
    });

    it('records the operator reason when one is supplied', async () => {
      await service.edit({
        strategyId: STRATEGY_ID,
        requested: { takeProfitPercent: 0.08 },
        timestamp: AT,
        reason: 'chop is tighter than modelled',
      });

      const [change] = await changes.findAll();
      expect(change.reason).toBe('chop is tighter than modelled');
    });

    it('propagates a range failure from the shared config builder', async () => {
      // The same validation the startup path runs — one definition of "valid".
      await expect(edit({ maxConcurrentRungs: 0 })).rejects.toThrow(/maxConcurrentRungs/);
      expect(config.maxConcurrentRungs).toBe(5);
    });
  });

  describe('the change log is queryable per strategy', () => {
    it('returns only the requested strategy changes', async () => {
      await edit({ takeProfitPercent: 0.08 });

      await expect(changes.findByStrategy(STRATEGY_ID)).resolves.toHaveLength(1);
      await expect(changes.findByStrategy('grid')).resolves.toEqual([]);
    });

    it('clears on reset', async () => {
      await edit({ takeProfitPercent: 0.08 });
      await changes.clear();

      await expect(changes.findAll()).resolves.toEqual([]);
    });
  });
});
