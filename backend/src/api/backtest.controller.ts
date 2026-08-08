/**
 * The backtest API (Story 11).
 *
 * Read endpoints serve persisted runs; `POST /backtest` and `POST /backtest/sweep`
 * execute one. Three properties are deliberate:
 *
 * - **Nothing here can submit an order.** A backtest runs against a
 *   `SimulatedBrokerAdapter` the harness constructs internally, which holds no
 *   socket. The engine's `BROKER_ADAPTER` binding is never touched, so no
 *   request to this controller can reach IB whatever the execution mode is.
 * - **Nothing here can fetch history.** Bars come from the cache only
 *   (`BacktestService`), because a sweep issuing its own requests would breach
 *   IB's pacing limits — a correctness requirement, not a performance one
 *   (`PRD.md:289`).
 * - **Nothing here writes strategy parameters.** A backtest reports what a
 *   parameter set *would* have done; adopting one is Story 13's decision
 *   (`stories.md:651`), and there is no endpoint that applies a result.
 *
 * A run is CPU-bound and synchronous. A decade of daily bars is fast, but a
 * large sweep is not, so requests are bounded by `MAX_SWEEP_COMBINATIONS`
 * rather than allowed to tie up the process indefinitely — the same process
 * serves the dashboard an operator may need during a live session.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import { BacktestCommand, BacktestService } from '../backtest/backtest.service';
import { expandGrid, SweepRanking } from '../backtest/parameter-sweep';
import { BarSize } from '../market-data/types';

/**
 * Ceiling on a single sweep request.
 *
 * 64 combinations over a decade of daily bars is already minutes of CPU. A
 * larger grid is a legitimate thing to want, but it belongs in a script that
 * can run unattended rather than in an HTTP request holding a connection open
 * on the process that also serves the dashboard.
 */
export const MAX_SWEEP_COMBINATIONS = 64;

interface BacktestRequestBody {
  symbol?: string;
  barSize?: string;
  from?: string;
  to?: string;
  symbolCapital?: number;
  accountEquity?: number;
  includeSynthetic?: boolean;
  ladder?: BacktestCommand['ladder'];
  fillModel?: BacktestCommand['fillModel'];
  grid?: BacktestCommand['grid'];
  rankBy?: string;
  label?: string;
}

@Controller('backtest')
export class BacktestController {
  constructor(private readonly backtest: BacktestService) {}

  /** Every persisted run, newest first. */
  @Get()
  async listRuns() {
    const runs = await this.backtest.listRuns();

    return { runs, count: runs.length };
  }

  /** One run with its metrics. */
  @Get(':id')
  async findRun(@Param('id') id: string) {
    const found = await this.backtest.findRun(id);

    if (found === null) {
      throw new NotFoundException(`no backtest run "${id}"`);
    }

    return found;
  }

  /**
   * Runs a backtest over a cached range.
   *
   * The full `result` is deliberately **not** returned: an equity curve over a
   * decade of daily bars is thousands of points and the dashboard charts them
   * from a separate request. Statistics plus the run id are what a caller needs
   * to decide whether to look closer.
   */
  @Post()
  async run(@Body() body: BacktestRequestBody) {
    const command = this.toCommand(body);
    const report = await this.unprocessableOnEmptyRange(() => this.backtest.run(command));

    return {
      runId: report.runId,
      symbol: report.symbol,
      barSize: report.barSize,
      rangeStart: report.rangeStart,
      rangeEnd: report.rangeEnd,
      barsProcessed: report.barsProcessed,
      synthetic: report.synthetic,
      statistics: report.statistics,
      // Reported because a hole in the history reads as a flat market and would
      // flatter the drawdown — the most dangerous way for a result to be wrong.
      coverage: report.result.coverage,
      closedTrades: report.result.closedTrades,
      openLots: report.result.openLots,
      equityCurve: report.result.equityCurve,
    };
  }

  /** Runs a grid sweep, persisting one run per combination. */
  @Post('sweep')
  async sweep(@Body() body: BacktestRequestBody) {
    const command = this.toCommand(body);

    if (!command.grid) {
      throw new BadRequestException('sweep requires a grid');
    }

    const combinations = expandGrid(command.grid).length;

    if (combinations > MAX_SWEEP_COMBINATIONS) {
      throw new BadRequestException(
        `grid expands to ${combinations} combinations, over the limit of ${MAX_SWEEP_COMBINATIONS}. ` +
          'Narrow the grid, or run it as a script rather than over HTTP.',
      );
    }

    return this.unprocessableOnEmptyRange(() => this.backtest.sweep(command));
  }

  /**
   * Translates "the cache holds no bars for this range" into a 422 that keeps
   * the message.
   *
   * Without this the service's carefully worded "run a backfill first" is
   * swallowed by Nest's default handler and the operator gets a bare
   * `Internal server error` — which turns the most likely and most fixable
   * failure into the least diagnosable one. It is a 422 rather than a 500
   * because the request was well-formed but cannot be satisfied, and rather
   * than a 400 because the range may become valid after a backfill without the
   * request changing at all.
   */
  private async unprocessableOnEmptyRange<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.startsWith('no cached')) {
        throw new UnprocessableEntityException(message);
      }

      throw error;
    }
  }

  /**
   * Validates and narrows a request body.
   *
   * Validation is explicit rather than delegated to a pipe, matching the rest
   * of this API. An invalid bar size or an inverted range must be a 400 with a
   * reason, not a run over zero bars that reports a flat market.
   */
  private toCommand(body: BacktestRequestBody): BacktestCommand {
    const symbol = body.symbol?.trim();

    if (!symbol) {
      throw new BadRequestException('symbol is required');
    }

    const barSize = body.barSize ?? BarSize.DAILY;

    if (!Object.values(BarSize).includes(barSize as BarSize)) {
      throw new BadRequestException(
        `barSize must be one of ${Object.values(BarSize).join(', ')}, got "${barSize}"`,
      );
    }

    if (!body.from || !body.to) {
      throw new BadRequestException('from and to are required');
    }

    if (body.from >= body.to) {
      throw new BadRequestException(`from (${body.from}) must precede to (${body.to})`);
    }

    if (body.symbolCapital !== undefined && body.symbolCapital <= 0) {
      throw new BadRequestException('symbolCapital must be positive when supplied');
    }

    if (
      body.rankBy !== undefined &&
      !Object.values(SweepRanking).includes(body.rankBy as SweepRanking)
    ) {
      throw new BadRequestException(
        `rankBy must be one of ${Object.values(SweepRanking).join(', ')}`,
      );
    }

    return {
      symbol,
      barSize: barSize as BarSize,
      from: body.from,
      to: body.to,
      symbolCapital: body.symbolCapital,
      accountEquity: body.accountEquity,
      includeSynthetic: body.includeSynthetic,
      ladder: body.ladder,
      fillModel: body.fillModel,
      grid: body.grid,
      rankBy: body.rankBy as SweepRanking | undefined,
      label: body.label,
    };
  }
}
