/**
 * The parameter edit endpoint (`stories.md:455`).
 *
 * Thin by design: every rule lives in `ParameterService`, which is where the
 * frozen-target semantics are enforced and where the audit record is written.
 * This controller maps HTTP onto that service and turns a `ParameterEditError`
 * into a 422 that names the offending field.
 *
 * **There is no endpoint here that can retarget a filled rung** (`PRD.md:386`).
 * That is not achieved by a guard clause — it is achieved by the edit surface
 * containing only ladder parameters, with lot and rung fields absent from the
 * editable set entirely.
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

interface EditBody {
  parameters?: Record<string, unknown>;
  reason?: string;
}

@Controller('parameters')
export class ParametersController {
  constructor(
    private readonly parameters: ParameterService,
    @Inject(PARAMETER_CHANGE_REPOSITORY)
    private readonly changes: ParameterChangeRepository,
  ) {}

  /** Current editable parameters for every ladder instance. */
  @Get()
  getAll(): unknown[] {
    return this.parameters.editableStrategyIds().map((strategyId) => ({
      strategyId,
      parameters: this.parameters.parametersOf(strategyId),
    }));
  }

  /**
   * The append-only change log (`PRD.md:392`).
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
    const parameters = this.parameters.parametersOf(strategyId);

    if (!parameters) {
      throw new NotFoundException(`unknown or non-editable strategy "${strategyId}"`);
    }

    return { strategyId, parameters };
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
    try {
      const result = await this.parameters.edit({
        strategyId,
        requested: body?.parameters ?? {},
        timestamp: new Date().toISOString(),
        reason: body?.reason ?? null,
      });

      return {
        ...result,
        // Stated explicitly in the response because it is the property the
        // whole endpoint exists to preserve.
        appliesTo: 'future rungs only — held lots keep the targets they filled with',
      };
    } catch (error) {
      if (error instanceof ParameterEditError) {
        throw new UnprocessableEntityException({
          message: error.message,
          detail: error.detail ?? null,
        });
      }

      // A validation failure from `buildDipLadderConfig` — a value that is the
      // right field but out of range. Same 422, with the builder's own message.
      if (error instanceof Error) {
        throw new UnprocessableEntityException({ message: error.message, detail: null });
      }

      throw error;
    }
  }
}
