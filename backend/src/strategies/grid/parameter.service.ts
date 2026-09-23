/**
 * Live parameter editing for the grid strategy — parallel to
 * `dip-ladder/parameter.service.ts`'s `ParameterService`, on `GridConfig`.
 *
 * The frozen-target rule holds here the same way it does for the ladder, and
 * for the same structural reason: `openGridLot`/`GridStrategy.openLotFromFill`
 * **store** `sellTarget` on the lot at fill time (`grid/lot.ts`) rather than
 * deriving it, and `computeGridIntents` reads `config` fresh on every call. So
 * mutating the shared `GridConfig` object in place gives the same guarantee
 * `ParameterService` documents at length: a held lot keeps the target it was
 * born with, while the next recompute — on the next session's open or the
 * next fill — uses whatever gap is current.
 *
 * Reuses the **same** `ParameterChangeRepository` the ladder writes to. That
 * table is already keyed by `strategyId` and its `parameter` column is a
 * plain string, not a type narrowed to the ladder's own editable-field union
 * — nothing about it is dip-ladder-specific, so no schema or repository
 * change was needed to give the grid strategy its own audit trail in the
 * same table.
 *
 * Deliberately its own class rather than a shared base with `ParameterService`
 * — matching this codebase's existing style of small, purpose-named services
 * (e.g. `SymbolHaltService` vs. `entryHalt`). A third strategy needing this
 * shape would be the trigger to extract one; not before.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  PARAMETER_CHANGE_REPOSITORY,
  ParameterChangeRepository,
} from '../../repositories/repository.interfaces';
import { CoordinatorService } from '../coordinator.service';
import { StrategyState } from '../types';
import { buildGridConfig, GridConfig } from './config';
import { GridLot, GridLotStatus } from './lot';
import {
  buildGridParameterChanges,
  EditableGridParameter,
  EditableGridParameters,
  editableGridParametersOf,
  GridParameterChange,
  isEditableGridParameter,
} from './parameter-change';

export class GridParameterEditError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'GridParameterEditError';
  }
}

export interface GridParameterEditResult {
  strategyId: string;
  parameters: EditableGridParameters;
  changes: GridParameterChange[];
  /**
   * Sell targets of lots held at the time of the edit, reported back
   * **unchanged** — the grid counterpart to `ParameterEditResult.frozenLotTargets`,
   * so the caller can see that live positions were left alone rather than
   * having to trust that they were.
   */
  frozenLotTargets: { lotId: string; sellTarget: number }[];
}

@Injectable()
export class GridParameterService {
  private readonly logger = new Logger(GridParameterService.name);
  private changeSequence = 0;

  constructor(
    private readonly coordinator: CoordinatorService,
    @Inject(PARAMETER_CHANGE_REPOSITORY)
    private readonly changes: ParameterChangeRepository,
  ) {}

  /**
   * The live config objects, keyed by strategy id.
   *
   * Registered by `EngineModule` rather than injected: the same object
   * instance the strategy holds must be the one edited here, or an edit
   * would write to a copy the strategy never reads.
   */
  private readonly configs = new Map<string, GridConfig>();

  register(strategyId: string, config: GridConfig): void {
    this.configs.set(strategyId, config);
  }

  /**
   * Re-applies the latest recorded value of every editable field onto a
   * freshly-registered config, from the append-only audit log — the grid
   * counterpart to `ParameterService.restore`, for the identical reason: the
   * config `register()` receives is rebuilt from compiled source constants
   * on every boot, and without this an operator's tuning silently reverts on
   * restart.
   *
   * Called once at boot, after `register()` and before any bar or fill
   * reaches the strategy.
   *
   * **Deliberately does not append new `GridParameterChange` records** — this
   * restores values already on the log, and treating it as a fresh edit
   * would double the audit trail on every restart.
   *
   * **Non-fatal by design.** A parameter that was valid when recorded but is
   * rejected by today's `buildGridConfig` (a validation rule tightened since)
   * must not block the whole engine from booting — the config falls back to
   * its compiled defaults for every field involved, and the failure is only
   * logged.
   */
  async restore(strategyId: string): Promise<void> {
    const config = this.configs.get(strategyId);

    if (!config) {
      return;
    }

    const history = await this.changes.findByStrategy(strategyId);

    // Bump the in-memory changeId counter past every sequence number seen in
    // history — same reasoning as `ParameterService.restore`: a fresh edit
    // must not reuse a `grid-param-change-N` id a prior process lifetime
    // already wrote.
    for (const change of history) {
      const match = /^grid-param-change-(\d+)$/.exec(change.changeId);

      if (match) {
        this.changeSequence = Math.max(this.changeSequence, Number(match[1]));
      }
    }

    if (history.length === 0) {
      return;
    }

    const latest = new Map<EditableGridParameter, GridParameterChange>();

    for (const change of history) {
      if (!isEditableGridParameter(change.parameter)) {
        continue;
      }

      const existing = latest.get(change.parameter);

      if (!existing || change.timestamp >= existing.timestamp) {
        latest.set(change.parameter, change as GridParameterChange);
      }
    }

    if (latest.size === 0) {
      return;
    }

    const requested = {} as Record<string, unknown>;

    for (const [name, change] of latest) {
      requested[name] = change.newValue;
    }

    let candidate: GridConfig;

    try {
      candidate = buildGridConfig(config.symbol, {
        ...editableGridParametersOf(config),
        ...requested,
        entryBuffer: config.entryBuffer,
      });
    } catch (error) {
      this.logger.error(
        `could not restore parameters for ${strategyId} from history — leaving compiled ` +
          `defaults in force: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    for (const name of Object.keys(requested) as (keyof EditableGridParameters)[]) {
      Object.assign(config, { [name]: candidate[name] });
    }

    this.logger.log(
      `restored ${latest.size} parameter(s) for ${strategyId} from history: ` +
        [...latest.entries()].map(([name, change]) => `${name}=${change.newValue}`).join(', '),
    );
  }

  parametersOf(strategyId: string): EditableGridParameters | null {
    const config = this.configs.get(strategyId);
    return config ? editableGridParametersOf(config) : null;
  }

  configOf(strategyId: string): GridConfig | null {
    return this.configs.get(strategyId) ?? null;
  }

  editableStrategyIds(): string[] {
    return [...this.configs.keys()];
  }

  /**
   * Applies an edit and returns what changed.
   *
   * Order is deliberate, mirroring `ParameterService.edit`: validate
   * everything first, then record, then apply. A rejected edit must leave no
   * trace in the audit log and no partial write in the config.
   */
  async edit(params: {
    strategyId: string;
    requested: Record<string, unknown>;
    timestamp: string;
    reason?: string | null;
  }): Promise<GridParameterEditResult> {
    const config = this.configs.get(params.strategyId);

    if (!config) {
      throw new GridParameterEditError(`unknown or non-editable strategy "${params.strategyId}"`);
    }

    const requested = this.validateRequest(params.requested);
    const state = this.coordinator.getState(params.strategyId);
    const heldLots = this.heldLotsOf(state);

    // Validate the *resulting* config as a whole, through the same builder
    // the startup path uses — an edit cannot produce a config boot would
    // have refused.
    const candidate = buildGridConfig(config.symbol, {
      ...editableGridParametersOf(config),
      ...requested,
      entryBuffer: config.entryBuffer,
    });

    const changes = buildGridParameterChanges({
      changeId: `grid-param-change-${(this.changeSequence += 1)}`,
      strategyId: params.strategyId,
      current: editableGridParametersOf(config),
      requested,
      timestamp: params.timestamp,
      // Deep-copied so later mutation of live state cannot rewrite the record.
      stateAtChange: state ? (JSON.parse(JSON.stringify(state)) as StrategyState) : null,
      reason: params.reason ?? null,
    });

    for (const change of changes) {
      await this.changes.append(change);
    }

    // Apply by mutating the object the strategy holds. Only editable fields
    // are copied across; `symbol` and `entryBuffer` are untouched by
    // construction.
    for (const name of Object.keys(requested) as (keyof EditableGridParameters)[]) {
      Object.assign(config, { [name]: candidate[name] });
    }

    if (changes.length > 0) {
      this.logger.log(
        `parameters updated for ${params.strategyId}: ` +
          changes.map((c) => `${c.parameter} ${c.oldValue} → ${c.newValue}`).join(', ') +
          `. ${heldLots.length} held lot(s) keep their existing sell targets.`,
      );
    }

    return {
      strategyId: params.strategyId,
      parameters: editableGridParametersOf(config),
      changes,
      frozenLotTargets: this.heldLotsOf(this.coordinator.getState(params.strategyId)).map(
        (lot) => ({
          lotId: lot.id,
          sellTarget: lot.sellTarget,
        }),
      ),
    };
  }

  /**
   * Rejects anything that is not an editable grid parameter.
   *
   * Unknown keys are an error rather than being ignored — silently dropping
   * `symbol` would let an operator believe they had retargeted the strategy's
   * traded instrument, which no endpoint may do.
   */
  private validateRequest(requested: Record<string, unknown>): Partial<EditableGridParameters> {
    if (!requested || typeof requested !== 'object' || Array.isArray(requested)) {
      throw new GridParameterEditError('parameters must be an object');
    }

    const entries = Object.entries(requested);

    if (entries.length === 0) {
      throw new GridParameterEditError('no parameters supplied');
    }

    const rejected: string[] = [];
    const accepted: Record<string, unknown> = {};

    for (const [name, value] of entries) {
      if (!isEditableGridParameter(name)) {
        rejected.push(name);
        continue;
      }

      accepted[name] = value;
    }

    if (rejected.length > 0) {
      throw new GridParameterEditError(
        `not editable at runtime: ${rejected.join(', ')}`,
        this.explainRejections(rejected),
      );
    }

    return accepted as Partial<EditableGridParameters>;
  }

  private explainRejections(rejected: string[]): Record<string, string> {
    const reasons: Record<string, string> = {};

    for (const name of rejected) {
      if (name === 'symbol') {
        reasons[name] =
          'changing the traded instrument would orphan every lot the grid strategy currently holds';
      } else if (name === 'entryBuffer') {
        reasons[name] =
          'entryBuffer is a small, one-time fill-quality tweak rather than a strategy ' +
          'parameter an operator tunes live';
      } else if (RECOMPUTE_KEYS.includes(name)) {
        reasons[name] =
          'a held lot’s sell target is frozen at the gap in force when it filled, so no ' +
          'endpoint may retarget a filled lot';
      } else {
        reasons[name] = 'not a grid parameter';
      }
    }

    return reasons;
  }

  private heldLotsOf(state: StrategyState | null): GridLot[] {
    if (!state) {
      return [];
    }

    const lots = (state.data as { lots?: GridLot[] }).lots;

    return (lots ?? []).filter((lot) => lot.status === GridLotStatus.HELD);
  }
}

/**
 * Field names a caller might reach for when attempting a full recompute of
 * already-held lots. Naming them explicitly turns "unknown field" into an
 * error message that says why the operation is forbidden.
 */
const RECOMPUTE_KEYS = [
  'sellTarget',
  'sellTargets',
  'lots',
  'recompute',
  'recomputeTargets',
  'fillPrice',
];
