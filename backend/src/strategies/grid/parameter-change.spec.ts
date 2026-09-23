import { buildGridConfig } from './config';
import {
  buildGridParameterChanges,
  editableGridParametersOf,
  EDITABLE_GRID_PARAMETERS,
  isEditableGridParameter,
} from './parameter-change';

describe('isEditableGridParameter', () => {
  it.each(EDITABLE_GRID_PARAMETERS)('accepts %s', (name) => {
    expect(isEditableGridParameter(name)).toBe(true);
  });

  it.each(['symbol', 'entryBuffer', 'lots', 'sellTarget'])('rejects %s', (name) => {
    expect(isEditableGridParameter(name)).toBe(false);
  });
});

describe('editableGridParametersOf', () => {
  it('projects only the editable fields', () => {
    const config = buildGridConfig('TQQQ', { gap: 0.75, quantity: 25 });

    expect(editableGridParametersOf(config)).toEqual({
      gap: 0.75,
      quantity: 25,
      maxBuyLevels: config.maxBuyLevels,
      maxSellOrders: config.maxSellOrders,
    });
  });
});

describe('buildGridParameterChanges', () => {
  const current = editableGridParametersOf(buildGridConfig('TQQQ'));

  it('produces one record per changed field, sharing a changeId', () => {
    const changes = buildGridParameterChanges({
      changeId: 'change-1',
      strategyId: 'grid:TQQQ',
      current,
      requested: { gap: 1, quantity: 25 },
      timestamp: '2025-01-02T10:00:00.000-05:00',
      stateAtChange: null,
    });

    expect(changes).toHaveLength(2);
    expect(changes.every((c) => c.changeId === 'change-1')).toBe(true);
    expect(changes.map((c) => c.parameter).sort()).toEqual(['gap', 'quantity']);
    expect(changes.find((c) => c.parameter === 'gap')).toMatchObject({
      oldValue: current.gap,
      newValue: 1,
    });
  });

  it('produces no record for a field resubmitted unchanged', () => {
    const changes = buildGridParameterChanges({
      changeId: 'change-2',
      strategyId: 'grid:TQQQ',
      current,
      requested: { gap: current.gap },
      timestamp: '2025-01-02T10:00:00.000-05:00',
      stateAtChange: null,
    });

    expect(changes).toEqual([]);
  });

  it('ignores a field not present in the request', () => {
    const changes = buildGridParameterChanges({
      changeId: 'change-3',
      strategyId: 'grid:TQQQ',
      current,
      requested: {},
      timestamp: '2025-01-02T10:00:00.000-05:00',
      stateAtChange: null,
    });

    expect(changes).toEqual([]);
  });
});
