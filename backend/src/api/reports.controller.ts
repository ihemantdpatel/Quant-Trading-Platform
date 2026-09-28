/**
 * The daily soak report over HTTP (Story 12).
 *
 * Read-only by construction — the services behind it hold no broker. A soak
 * operator pulls a session's report each day, and the dashboard can render the
 * same JSON. The two `POST /reports/email/*` routes send a P&L email; they read
 * the same persisted rows and still cannot reach a broker.
 */

import {
  BadGatewayException,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DateTime } from 'luxon';
import { ET_ZONE } from '../market-data/types';
import { DailyReport, DailyReportService } from '../observability/daily-report.service';
import { EmailNotConfiguredError, PnlEmailService } from '../observability/pnl-email.service';
import { RenderedEmail } from '../observability/pnl-email.renderer';
import { isIsoDate, isIsoMonth } from '../observability/pnl-summary';
import { sessionDateOf } from '../strategies/dip-ladder/session-window';

/** `yyyy-MM-dd`, the ET session key `sessionDateOf` produces. */
const SESSION_DATE = /^\d{4}-\d{2}-\d{2}$/;

@Controller()
export class ReportsController {
  constructor(
    private readonly reports: DailyReportService,
    private readonly emails: PnlEmailService,
  ) {}

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

  /**
   * Sends one ET day's P&L email now, defaulting to today — the manual resend
   * for a day the scheduler missed (daemon down at 16:30), and the way to test
   * SMTP settings. Read-only over persisted rows; nothing here can trade.
   */
  @Post('reports/email/daily')
  @HttpCode(200)
  async emailDaily(@Query('date') date?: string): Promise<{ sent: string }> {
    const day = date ?? DateTime.now().setZone(ET_ZONE).toISODate()!;

    if (!isIsoDate(day)) {
      throw new UnprocessableEntityException(`date must be formatted yyyy-MM-dd, got "${day}"`);
    }

    return this.sendOrExplain(() => this.emails.sendDaily(day));
  }

  /** Sends one month's P&L email now, defaulting to the previous month. */
  @Post('reports/email/monthly')
  @HttpCode(200)
  async emailMonthly(@Query('month') month?: string): Promise<{ sent: string }> {
    const period =
      month ?? DateTime.now().setZone(ET_ZONE).minus({ months: 1 }).toFormat('yyyy-MM');

    if (!isIsoMonth(period)) {
      throw new UnprocessableEntityException(`month must be formatted yyyy-MM, got "${period}"`);
    }

    return this.sendOrExplain(() => this.emails.sendMonthly(period));
  }

  private async sendOrExplain(send: () => Promise<RenderedEmail>): Promise<{ sent: string }> {
    try {
      return { sent: (await send()).subject };
    } catch (error) {
      if (error instanceof EmailNotConfiguredError) {
        throw new ServiceUnavailableException(error.message);
      }
      // SMTP refused or timed out — the upstream failed, not this request.
      throw new BadGatewayException(`email send failed: ${(error as Error).message}`);
    }
  }
}
