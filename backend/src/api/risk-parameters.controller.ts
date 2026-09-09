/**
 * Live editing of `RiskConfig.perSymbolLimits` — the risk layer's per-symbol
 * capital ceiling (`capital-cap.ts`).
 *
 * A separate controller from `ParametersController` because it edits a
 * separate config: `RiskConfig`, shared across every strategy trading a
 * symbol, rather than one strategy's `DipLadderConfig`. See
 * `RiskParameterService` for why this exists at all, and
 * `PerSymbolLimitChangeRepository` for why the audit trail is its own table.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  PER_SYMBOL_LIMIT_CHANGE_REPOSITORY,
  PerSymbolLimitChange,
  PerSymbolLimitChangeRepository,
} from '../repositories/repository.interfaces';
import { RiskParameterEditError, RiskParameterService } from '../risk/risk-parameter.service';

interface EditBody {
  limit?: unknown;
  reason?: string;
}

@Controller('risk-limits')
export class RiskParametersController {
  constructor(
    private readonly riskParameters: RiskParameterService,
    @Inject(PER_SYMBOL_LIMIT_CHANGE_REPOSITORY)
    private readonly changes: PerSymbolLimitChangeRepository,
  ) {}

  /** Current per-symbol limits. A symbol absent here is unconstrained by this control. */
  @Get()
  getAll(): Record<string, number> {
    return this.riskParameters.current();
  }

  /**
   * The append-only change log. Served before `:symbol` so the literal path
   * wins — Nest matches in declaration order, and `changes` would otherwise
   * be read as a symbol.
   */
  @Get('changes')
  async getChanges(): Promise<PerSymbolLimitChange[]> {
    return this.changes.findAll();
  }

  /**
   * Applies an edit.
   *
   * Every future BUY intent for `symbol` crosses `RiskManagerService.evaluate`
   * exactly as before — this changes only where the ceiling sits, never
   * whether the chokepoint runs.
   */
  @Post(':symbol')
  @HttpCode(HttpStatus.OK)
  async edit(@Param('symbol') symbol: string, @Body() body: EditBody): Promise<unknown> {
    try {
      const result = await this.riskParameters.edit({
        symbol,
        limit: Number(body?.limit),
        timestamp: new Date().toISOString(),
        reason: body?.reason ?? null,
      });

      return result;
    } catch (error) {
      if (error instanceof RiskParameterEditError) {
        throw new UnprocessableEntityException({ message: error.message });
      }

      throw error;
    }
  }
}
