/**
 * The append-only record of every parameter edit (`PRD.md:392`).
 *
 * Live parameter editing is the one control on the dashboard that changes how
 * the strategy decides, rather than merely halting it. That makes the audit
 * trail load-bearing: when a rung fires at an unexpected price, the question is
 * always "what were the parameters at that moment", and only a record carrying
 * the **old value, the new value, and the strategy state at the time** can
 * answer it after the fact.
 *
 * ## Why the whole strategy state is captured
 *
 * `PRD.md:392` asks for the state at the time of change, not just the values.
 * The reason is the frozen-target rule: after an edit, held lots keep targets
 * computed from the *previous* parameters, so the config alone no longer
 * explains why a given lot exits where it does. The state snapshot is what
 * makes that reconstructable.
 *
 * ## Why this is append-only
 *
 * There is no update and no delete, here or in the repository interface. An
 * edit that could be rewritten is not an audit trail. Story 8 enforces the same
 * property at the database level (`stories.md:494`); this module is where the
 * shape is defined so both implementations agree.
 */

import { JsonValue, StrategyState } from '../types';
import { DipLadderConfig } from './config';

/**
 * The parameters an operator may edit at runtime.
 *
 * Deliberately a subset of `DipLadderConfig`. Two exclusions are decisions, not
 * oversights:
 *
 * - **`symbolCapital` is absent.** It is one of the two open PRD items
 *   (`PRD.md:500`), unset until Story 13, and the Story 5 startup assertion
 *   refuses PAPER/LIVE while it is null. An HTTP setter would let the dashboard
 *   paper over that assertion, which is exactly the silent default the PRD
 *   forbids.
 * - **`symbol` is absent.** Changing which instrument a ladder trades while it
 *   holds lots would orphan every one of them.
 */
export const EDITABLE_PARAMETERS = [
  'spacingMode',
  'spacingPercent',
  'atrMultiple',
  'atrPeriod',
  'spacingDollars',
  'takeProfitPercent',
  'takeProfitDollars',
  'exitMode',
  'sizePerRung',
  'fixedQuantity',
  'escalationFactor',
  'maxConcurrentRungs',
  'hardFloorPercent',
] as const;

export type EditableParameter = (typeof EDITABLE_PARAMETERS)[number];

export type EditableParameters = Pick<DipLadderConfig, EditableParameter>;

export function isEditableParameter(name: string): name is EditableParameter {
  return (EDITABLE_PARAMETERS as readonly string[]).includes(name);
}

/**
 * One field's change. An edit touching three parameters produces three of
 * these, sharing a `changeId` — so the audit reads per-field while still
 * showing which fields moved together.
 */
export interface ParameterChange {
  /** Unique per record. */
  id: string;
  /** Shared by every field in the same edit request. */
  changeId: string;
  strategyId: string;
  parameter: EditableParameter;
  oldValue: JsonValue;
  newValue: JsonValue;
  /** ISO-8601. When the edit was applied. */
  timestamp: string;
  /**
   * The strategy's full state at the moment of the edit (`PRD.md:392`).
   *
   * Deep-copied by the caller before storage, so a later mutation of live state
   * cannot retroactively rewrite what this record says was true.
   */
  stateAtChange: StrategyState | null;
  /** Free-text operator note, when supplied. */
  reason: string | null;
}

/**
 * Builds the change records for an edit, without applying it.
 *
 * Pure and non-mutating: the caller decides when to apply and when to persist.
 * Only fields whose value actually differs produce a record — re-submitting the
 * form unchanged should not manufacture audit noise that implies a change
 * nobody made.
 */
export function buildParameterChanges(params: {
  changeId: string;
  strategyId: string;
  current: EditableParameters;
  requested: Partial<EditableParameters>;
  timestamp: string;
  stateAtChange: StrategyState | null;
  reason?: string | null;
}): ParameterChange[] {
  const changes: ParameterChange[] = [];

  for (const name of EDITABLE_PARAMETERS) {
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
export function editableParametersOf(config: DipLadderConfig): EditableParameters {
  return {
    spacingMode: config.spacingMode,
    spacingPercent: config.spacingPercent,
    atrMultiple: config.atrMultiple,
    atrPeriod: config.atrPeriod,
    spacingDollars: config.spacingDollars,
    takeProfitPercent: config.takeProfitPercent,
    takeProfitDollars: config.takeProfitDollars,
    exitMode: config.exitMode,
    sizePerRung: config.sizePerRung,
    fixedQuantity: config.fixedQuantity,
    escalationFactor: config.escalationFactor,
    maxConcurrentRungs: config.maxConcurrentRungs,
    hardFloorPercent: config.hardFloorPercent,
  };
}
