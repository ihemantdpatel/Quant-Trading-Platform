/**
 * Live parameter editing, with the frozen-target rule enforced structurally.
 *
 * ## The rule
 *
 * **A parameter edit applies to future rungs only** (`PRD.md:386`). Each held
 * lot's exit target is frozen at the parameters in force when that lot filled;
 * new values affect only rungs not currently holding a lot, including re-armed
 * rungs, which pick up current parameters on their next fire. Full recompute —
 * retargeting filled rungs — is **not permitted**, because a single edit could
 * then move a live position into or out of an exit condition instantly.
 *
 * ## Why this file mutates the config object in place
 *
 * That looks unusual, and the alternatives are worse:
 *
 * - **Rebuilding the strategy** with a new config would discard its
 *   `StrategyState` — every lot, rung, and anchor. An edit must not flatten the
 *   ladder.
 * - **Recomputing targets** from the new config is the forbidden full recompute.
 *
 * Mutating the shared `DipLadderConfig` gives exactly the required semantics
 * for free, because of how the layers below already work: `openLot` **stores**
 * `exitTarget` on the lot at fill time (`lot.ts:41`) rather than deriving it,
 * and `evaluateBar` reads config **fresh on every bar** (`ladder.ts:102`). So a
 * held lot keeps the target it was born with, while the next fire — from a
 * pending or re-armed rung alike — uses whatever is current. The frozen-target
 * rule is a property of the data model, not a check this service performs.
 *
 * This service therefore does three things and no more: validate, record, apply.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  PARAMETER_CHANGE_REPOSITORY,
  ParameterChangeRepository,
} from '../../repositories/repository.interfaces';
import { CoordinatorService } from '../coordinator.service';
import { StrategyState } from '../types';
import { buildDipLadderConfig, DipLadderConfig } from './config';
import { Lot, LotStatus } from './lot';
import {
  buildParameterChanges,
  EditableParameters,
  editableParametersOf,
  isEditableParameter,
  ParameterChange,
} from './parameter-change';

export class ParameterEditError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ParameterEditError';
  }
}

export interface ParameterEditResult {
  strategyId: string;
  parameters: EditableParameters;
  changes: ParameterChange[];
  /**
   * Targets of lots held at the time of the edit, reported back **unchanged**.
   *
   * Returned so the caller — and the dashboard — can see that the edit left
   * live positions alone, rather than having to trust that it did.
   */
  frozenLotTargets: { lotId: string; exitTarget: number }[];
}

@Injectable()
export class ParameterService {
  private readonly logger = new Logger(ParameterService.name);
  private changeSequence = 0;

  constructor(
    private readonly coordinator: CoordinatorService,
    @Inject(PARAMETER_CHANGE_REPOSITORY)
    private readonly changes: ParameterChangeRepository,
  ) {}

  /**
   * The live config objects, keyed by strategy id.
   *
   * Registered by `EngineModule` rather than injected: the same object instance
   * the strategy holds must be the one edited here, or an edit would write to a
   * copy the strategy never reads.
   */
  private readonly configs = new Map<string, DipLadderConfig>();

  register(strategyId: string, config: DipLadderConfig): void {
    this.configs.set(strategyId, config);
  }

  parametersOf(strategyId: string): EditableParameters | null {
    const config = this.configs.get(strategyId);
    return config ? editableParametersOf(config) : null;
  }

  configOf(strategyId: string): DipLadderConfig | null {
    return this.configs.get(strategyId) ?? null;
  }

  editableStrategyIds(): string[] {
    return [...this.configs.keys()];
  }

  /**
   * Applies an edit and returns what changed.
   *
   * Order is deliberate: validate everything first, then record, then apply.
   * A rejected edit must leave no trace in the audit log and no partial write
   * in the config — a config half-updated with a rung count from the new values
   * and a spacing from the old is a state nobody reasoned about.
   */
  async edit(params: {
    strategyId: string;
    requested: Record<string, unknown>;
    timestamp: string;
    reason?: string | null;
  }): Promise<ParameterEditResult> {
    const config = this.configs.get(params.strategyId);

    if (!config) {
      throw new ParameterEditError(`unknown or non-editable strategy "${params.strategyId}"`);
    }

    const requested = this.validateRequest(params.requested);
    const state = this.coordinator.getState(params.strategyId);
    const heldLots = this.heldLotsOf(state);

    // Validate the *resulting* config as a whole, through the same builder the
    // startup path uses. Reusing it means an edit cannot produce a config that
    // boot would have refused — one definition of "valid", not two.
    const candidate = buildDipLadderConfig(config.symbol, {
      ...editableParametersOf(config),
      ...requested,
      symbolCapital: config.symbolCapital,
    });

    const changes = buildParameterChanges({
      changeId: `param-change-${(this.changeSequence += 1)}`,
      strategyId: params.strategyId,
      current: editableParametersOf(config),
      requested,
      timestamp: params.timestamp,
      // Deep-copied so later mutation of live state cannot rewrite the record.
      stateAtChange: state ? (JSON.parse(JSON.stringify(state)) as StrategyState) : null,
      reason: params.reason ?? null,
    });

    for (const change of changes) {
      await this.changes.append(change);
    }

    // Apply by mutating the object the strategy holds. Only editable fields are
    // copied across; `symbol` and `symbolCapital` are untouched by construction.
    for (const name of Object.keys(requested) as (keyof EditableParameters)[]) {
      Object.assign(config, { [name]: candidate[name] });
    }

    if (changes.length > 0) {
      this.logger.log(
        `parameters updated for ${params.strategyId}: ` +
          changes.map((c) => `${c.parameter} ${c.oldValue} → ${c.newValue}`).join(', ') +
          `. ${heldLots.length} held lot(s) keep their existing targets.`,
      );
    }

    return {
      strategyId: params.strategyId,
      parameters: editableParametersOf(config),
      changes,
      // Read *after* applying: these are the live lots, and their targets are
      // unchanged because nothing here touches them.
      frozenLotTargets: this.heldLotsOf(this.coordinator.getState(params.strategyId)).map(
        (lot) => ({
          lotId: lot.id,
          exitTarget: lot.exitTarget,
        }),
      ),
    };
  }

  /**
   * Rejects anything that is not an editable parameter.
   *
   * Unknown keys are an error rather than being ignored. Silently dropping
   * `symbolCapital` would let an operator believe they had set the figure the
   * Story 5 assertion is waiting on, and a request for a full recompute would
   * appear to succeed while doing nothing.
   */
  private validateRequest(requested: Record<string, unknown>): Partial<EditableParameters> {
    if (!requested || typeof requested !== 'object' || Array.isArray(requested)) {
      throw new ParameterEditError('parameters must be an object');
    }

    const entries = Object.entries(requested);

    if (entries.length === 0) {
      throw new ParameterEditError('no parameters supplied');
    }

    const rejected: string[] = [];
    const accepted: Record<string, unknown> = {};

    for (const [name, value] of entries) {
      if (!isEditableParameter(name)) {
        rejected.push(name);
        continue;
      }

      accepted[name] = value;
    }

    if (rejected.length > 0) {
      throw new ParameterEditError(
        `not editable at runtime: ${rejected.join(', ')}`,
        this.explainRejections(rejected),
      );
    }

    return accepted as Partial<EditableParameters>;
  }

  /**
   * Explains *why* a field was refused. An operator staring at a blocked edit
   * needs the reason, not just the refusal — and for `symbolCapital` the reason
   * is a recorded PRD decision they should not work around.
   */
  private explainRejections(rejected: string[]): Record<string, string> {
    const reasons: Record<string, string> = {};

    for (const name of rejected) {
      if (name === 'symbolCapital') {
        reasons[name] =
          'per-symbol capital is a deliberately-unset open item (PRD.md:500) and is set at ' +
          'Story 13, not over HTTP — an endpoint that set it would defeat the startup ' +
          'assertion that refuses PAPER/LIVE while it is null';
      } else if (name === 'symbol') {
        reasons[name] =
          'changing the traded instrument would orphan every lot the ladder currently holds';
      } else if (RECOMPUTE_KEYS.includes(name)) {
        reasons[name] =
          'full recompute is not permitted (PRD.md:386): a held lot’s exit target is frozen ' +
          'at the parameters in force when it filled, so no endpoint may retarget a filled rung';
      } else {
        reasons[name] = 'not a dip-ladder parameter';
      }
    }

    return reasons;
  }

  private heldLotsOf(state: StrategyState | null): Lot[] {
    if (!state) {
      return [];
    }

    const lots = (state.data as { lots?: Lot[] }).lots;

    return (lots ?? []).filter((lot) => lot.status === LotStatus.HELD);
  }
}

/**
 * Field names a caller might reach for when attempting a full recompute.
 *
 * These are not editable parameters — they are *outputs* of the ladder, stored
 * per lot or per rung. Naming them explicitly turns "unknown field" into an
 * error message that says why the operation is forbidden rather than merely
 * unrecognized.
 */
const RECOMPUTE_KEYS = [
  'exitTarget',
  'exitTargets',
  'lots',
  'rungs',
  'recompute',
  'recomputeTargets',
  'fillPrice',
  'rungPrice',
];
