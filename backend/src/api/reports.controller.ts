/**
 * The daily soak report over HTTP (Story 12).
 *
 * Read-only by construction — there is no control endpoint here, and the
 * service behind it holds no broker. A soak operator pulls a session's report
 * each day, and the dashboard can render the same JSON.
 */

import { Controller, Get, Query, UnprocessableEntityException } from '@nestjs/common';
import { DailyReport, DailyReportService } from '../observability/daily-report.service';
import { sessionDateOf } from '../strategies/dip-ladder/session-window';

/** `yyyy-MM-dd`, the ET session key `sessionDateOf` produces. */
const SESSION_DATE = /^\d{4}-\d{2}-\d{2}$/;

@Controller()
export class ReportsController {
  constructor(private readonly reports: DailyReportService) {}

  /**
   * The report for one ET session, defaulting to today's.
   *
   * The date is validated rather than passed through: an unparseable value
   * would otherwise match no records and produce a confidently empty report,
   * which during a soak reads exactly like a quiet session.
   */
  @Get('reports/daily')
  async daily(@Query('date') date?: string): Promise<DailyReport> {
    const now = new Date().toISOString();
    const sessionDate = date ?? sessionDateOf(now);

    if (!SESSION_DATE.test(sessionDate)) {
      throw new UnprocessableEntityException(
        `date must be an ET session date formatted yyyy-MM-dd, got "${sessionDate}"`,
      );
    }

    return this.reports.build(sessionDate, now);
  }
}
