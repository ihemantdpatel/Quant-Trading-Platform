/**
 * The parameter edit endpoint (`stories.md:455`).
 *
 * Thin by design: every rule lives in `ParameterService`/`GridParameterService`,
 * which is where each strategy's own frozen-target semantics are enforced and
 * where the audit record is written. This controller maps HTTP onto whichever
 * service owns the strategy id, and turns a `ParameterEditError`/
 * `GridParameterEditError` into a 422 that names the offending field.
 *
 * **There is no endpoint here that can retarget a filled rung or lot**
 * (`PRD.md:386`, and the grid strategy's own equivalent). That is not achieved
 * by a guard clause — it is achieved by each edit surface containing only
 * that strategy's own parameters, with lot/rung fields absent from the
 * editable set entirely.
 *
 * **Dispatch, not a merged type.** The two services are deliberately separate
 * classes over disjoint config shapes (`ParameterService` on `DipLadderConfig`,
 * `GridParameterService` on `GridConfig`) — this controller tries the ladder
 * service first, then the grid one, by strategy id, rather than assuming
 * either owns a given id. `configOf` returning non-null is what "owns" means
 * here; a strategy id neither recognizes falls through to 404.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  PARAMETER_CHANGE_REPOSITORY,
  ParameterChangeRepository,
} from '../repositories/repository.interfaces';
import { ParameterChange } from '../strategies/dip-ladder/parameter-change';
import { ParameterEditError, ParameterService } from '../strategies/dip-ladder/parameter.service';
import { GridParameterEditError, GridParameterService } from '../strategies/grid/parameter.service';

interface EditBody {
  parameters?: Record<string, unknown>;
  reason?: string;
}

@Controller('parameters')
export class ParametersController {
  constructor(
    private readonly parameters: ParameterService,
    private readonly gridParameters: GridParameterService,
    @Inject(PARAMETER_CHANGE_REPOSITORY)
    private readonly changes: ParameterChangeRepository,
  ) {}

  /**
   * Current editable parameters for every registered instance — ladder and
   * grid alike.
   *
   * `symbol` is included alongside `strategyId` so the dashboard can join an
   * instance to its risk-layer per-symbol limit (`GET /risk-limits`) without
   * parsing the id string.
   */
  @Get()
  getAll(): unknown[] {
    const ladderEntries = this.parameters.editableStrategyIds().map((strategyId) => ({
      strategyId,
      symbol: this.parameters.configOf(strategyId)?.symbol ?? null,
      parameters: this.parameters.parametersOf(strategyId),
    }));

    const gridEntries = this.gridParameters.editableStrategyIds().map((strategyId) => ({
      strategyId,
      symbol: this.gridParameters.configOf(strategyId)?.symbol ?? null,
      parameters: this.gridParameters.parametersOf(strategyId),
    }));

    return [...ladderEntries, ...gridEntries];
  }

  /**
   * The append-only change log (`PRD.md:392`), shared by every strategy's
   * editor — see `ParameterChange.parameter`'s own comment for why the table
   * is not ladder-specific.
   *
   * Served before the `:strategyId` route so the literal path wins — Nest
   * matches in declaration order, and `changes` would otherwise be read as a
   * strategy id.
   */
  @Get('changes')
  async getChanges(): Promise<ParameterChange[]> {
    return this.changes.findAll();
  }

  @Get(':strategyId')
  getOne(@Param('strategyId') strategyId: string): unknown {
    const ladderParameters = this.parameters.parametersOf(strategyId);

    if (ladderParameters) {
      return {
        strategyId,
        symbol: this.parameters.configOf(strategyId)?.symbol ?? null,
        parameters: ladderParameters,
      };
    }

    const gridParameters = this.gridParameters.parametersOf(strategyId);

    if (gridParameters) {
      return {
        strategyId,
        symbol: this.gridParameters.configOf(strategyId)?.symbol ?? null,
        parameters: gridParameters,
      };
    }

    throw new NotFoundException(`unknown or non-editable strategy "${strategyId}"`);
  }

  /**
   * Applies an edit.
   *
   * Returns the frozen targets of currently-held lots alongside the new
   * parameters, so the caller can *see* that live positions were untouched
   * rather than having to take it on faith.
   */
  @Post(':strategyId')
  @HttpCode(HttpStatus.OK)
  async edit(@Param('strategyId') strategyId: string, @Body() body: EditBody): Promise<unknown> {
    const isLadder = this.parameters.configOf(strategyId) !== null;
    const isGrid = !isLadder && this.gridParameters.configOf(strategyId) !== null;

    if (!isLadder && !isGrid) {
      throw new NotFoundException(`unknown or non-editable strategy "${strategyId}"`);
    }

    try {
      const result = isLadder
        ? await this.parameters.edit({
            strategyId,
            requested: body?.parameters ?? {},
            timestamp: new Date().toISOString(),
            reason: body?.reason ?? null,
          })
        : await this.gridParameters.edit({
            strategyId,
            requested: body?.parameters ?? {},
            timestamp: new Date().toISOString(),
            reason: body?.reason ?? null,
          });

      return {
        ...result,
        appliesTo: isLadder
          ? 'future rungs only — held lots keep the targets they filled with'
          : 'future buy levels and future lots only — held lots keep the sell targets they filled with',
      };
    } catch (error) {
      if (error instanceof ParameterEditError || error instanceof GridParameterEditError) {
        throw new UnprocessableEntityException({
          message: error.message,
          detail: error.detail ?? null,
        });
      }

      if (error instanceof Error) {
        throw new UnprocessableEntityException({ message: error.message, detail: null });
      }

      throw error;
    }
  }
}
