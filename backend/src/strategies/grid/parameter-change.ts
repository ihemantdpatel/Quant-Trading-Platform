/**
 * The editable-parameter set for the grid strategy, mirroring
 * `dip-ladder/parameter-change.ts`'s shape but scoped to Grid's much smaller
 * config. Reuses the existing generic `ParameterChange` type and repository —
 * that table is already keyed by `strategyId` and carries no dip-ladder-
 * specific meaning, so no schema change is needed for the audit trail itself.
 */

import { JsonValue, StrategyState } from '../types';
import { GridConfig } from './config';

/**
 * The parameters an operator may edit at runtime.
 *
 * `symbol` is absent — mirroring the dip ladder's own exclusion — because
 * retargeting which instrument a live grid strategy trades while it holds
 * lots would orphan every one of them. `entryBuffer` is also excluded: it is
 * a small, one-time fill-quality tweak rather than a strategy parameter an
 * operator tunes live, and leaving it out keeps the editable set to exactly
 * the fields that shape ongoing behaviour.
 */
export const EDITABLE_GRID_PARAMETERS = [
  'gap',
  'quantity',
  'maxBuyLevels',
  'maxSellOrders',
] as const;

export type EditableGridParameter = (typeof EDITABLE_GRID_PARAMETERS)[number];

export type EditableGridParameters = Pick<GridConfig, EditableGridParameter>;

export function isEditableGridParameter(name: string): name is EditableGridParameter {
  return (EDITABLE_GRID_PARAMETERS as readonly string[]).includes(name);
}

/**
 * One field's change. An edit touching several parameters produces several of
 * these, sharing a `changeId` — identical shape to the dip ladder's
 * `ParameterChange`, and stored in the same repository.
 */
export interface GridParameterChange {
  id: string;
  changeId: string;
  strategyId: string;
  parameter: EditableGridParameter;
  oldValue: JsonValue;
  newValue: JsonValue;
  timestamp: string;
  stateAtChange: StrategyState | null;
  reason: string | null;
}

/**
 * Builds the change records for an edit, without applying it. Pure and
 * non-mutating, matching `buildParameterChanges`'s contract exactly.
 */
export function buildGridParameterChanges(params: {
  changeId: string;
  strategyId: string;
  current: EditableGridParameters;
  requested: Partial<EditableGridParameters>;
  timestamp: string;
  stateAtChange: StrategyState | null;
  reason?: string | null;
}): GridParameterChange[] {
  const changes: GridParameterChange[] = [];

  for (const name of EDITABLE_GRID_PARAMETERS) {
    if (!(name in params.requested)) {
      continue;
    }

    const oldValue = params.current[name];
    const newValue = params.requested[name];

    if (newValue === undefined || newValue === oldValue) {
      continue;
    }

    changes.push({
      id: `${params.changeId}:${name}`,
      changeId: params.changeId,
      strategyId: params.strategyId,
      parameter: name,
      oldValue: oldValue as JsonValue,
      newValue: newValue as JsonValue,
      timestamp: params.timestamp,
      stateAtChange: params.stateAtChange,
      reason: params.reason ?? null,
    });
  }

  return changes;
}

/** The editable subset of a full config, for diffing and display. */
export function editableGridParametersOf(config: GridConfig): EditableGridParameters {
  return {
    gap: config.gap,
    quantity: config.quantity,
    maxBuyLevels: config.maxBuyLevels,
    maxSellOrders: config.maxSellOrders,
  };
}
