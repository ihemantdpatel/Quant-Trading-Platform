/**
 * `npm run email:sample -- --days 7 [--out ./email-samples] [--no-send]`
 *
 * **Renders the P&L emails from real recent trades, for reviewing the format.**
 * Produces two messages over the last `--days` ET days:
 *
 * 1. the **daily** email for the most recent day in the window that closed a
 *    trade — so the per-trade table is not empty on a quiet day — and
 * 2. the **period** email (the monthly layout) over the whole window.
 *
 * Both are written to `--out` as `.html` for a local look, and sent with a
 * `[SAMPLE]` subject prefix unless `--no-send` is given. Read-only over the
 * database, exactly like the daemon's own sends.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DateTime } from 'luxon';
import { AppConfigService, resolveEmailConfig } from '../config/app-config.service';
import { AppConfig, validateConfig } from '../config/config.schema';
import { ET_ZONE } from '../market-data/types';
import { NodemailerMailer } from '../observability/mailer';
import { PnlEmailService } from '../observability/pnl-email.service';
import { etDateOf, tradesBetween } from '../observability/pnl-summary';
import {
  PrismaFillRepository,
  PrismaGridLotRepository,
} from '../repositories/prisma/prisma.repositories';
import { PrismaService } from '../repositories/prisma/prisma.service';

export const EMAIL_SAMPLE_USAGE = `Usage: npm run email:sample -- [--days 7] [--out ./email-samples] [--no-send]

  --days N     ET days to cover, ending today (default 7)
  --out DIR    where to write the .html previews (default ./email-samples)
  --no-send    write the previews only; do not send`;

export interface EmailSampleArgs {
  days: number;
  out: string;
  send: boolean;
}

export function parseEmailSampleArgs(argv: string[]): EmailSampleArgs {
  const value = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
  };

  const rawDays = value('--days') ?? '7';
  const days = Number(rawDays);

  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new Error(`--days must be a whole number from 1 to 366, got ${rawDays}`);
  }

  return { days, out: value('--out') ?? './email-samples', send: !argv.includes('--no-send') };
}

/** The ET window `[from, to]` of `days` days ending on `today`. */
export function sampleWindow(today: DateTime, days: number): { from: string; to: string } {
  const to = today.setZone(ET_ZONE).startOf('day');
  return { from: to.minus({ days: days - 1 }).toISODate()!, to: to.toISODate()! };
}

/* istanbul ignore next -- I/O wrapper; the decisions above are covered */
export async function runEmailSample(
  argv: string[],
  out: NodeJS.WritableStream = process.stdout,
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    out.write(`${EMAIL_SAMPLE_USAGE}\n`);
    return 0;
  }

  let args: EmailSampleArgs;
  let config: AppConfig;

  try {
    args = parseEmailSampleArgs(argv);
    config = validateConfig(process.env);
  } catch (error) {
    out.write(`${(error as Error).message}\n\n${EMAIL_SAMPLE_USAGE}\n`);
    return 1;
  }

  if (!config.DATABASE_URL) {
    out.write('DATABASE_URL is not set — there are no persisted trades to sample.\n');
    return 1;
  }

  const email = resolveEmailConfig(config);
  // The service reads only the alias and mode; the rest of AppConfigService is
  // Nest wiring this one-off process does not need.
  const appConfig = {
    accountAlias: config.ACCOUNT_ALIAS,
    executionMode: config.EXECUTION_MODE,
  } as AppConfigService;

  if (args.send && email === null) {
    out.write('SMTP_USER, SMTP_PASS and EMAIL_TO must be set to send (or pass --no-send).\n');
    return 1;
  }

  const prisma = new PrismaService();

  try {
    const alias = appConfig.accountAlias;
    const emails = new PnlEmailService(
      new PrismaGridLotRepository(prisma, alias),
      new PrismaFillRepository(prisma, alias),
      appConfig,
      email === null ? null : new NodemailerMailer(email),
    );

    const { from, to } = sampleWindow(DateTime.now(), args.days);
    const inputs = await emails.loadInputs();
    const trades = tradesBetween(inputs.lots, from, to);
    const dailyDate = trades.length > 0 ? etDateOf(trades[trades.length - 1].closedAt) : to;

    const options = { subjectPrefix: '[SAMPLE]' };
    const daily = await emails.renderDaily(dailyDate, options);
    const period = await emails.renderPeriod(from, to, {
      ...options,
      periodLabel: `last ${args.days} days`,
    });

    const dir = resolve(args.out);
    mkdirSync(dir, { recursive: true });
    const dailyPath = join(dir, `daily-${dailyDate}.html`);
    const periodPath = join(dir, `period-${from}_${to}.html`);
    writeFileSync(dailyPath, daily.html);
    writeFileSync(periodPath, period.html);

    out.write(`account ${alias}: ${trades.length} closed trade(s) between ${from} and ${to}\n`);
    out.write(`  ${daily.subject}\n    → ${dailyPath}\n`);
    out.write(`  ${period.subject}\n    → ${periodPath}\n`);

    if (args.send) {
      const mailer = new NodemailerMailer(email!);
      await mailer.send(daily);
      await mailer.send(period);
      out.write(`sent both to ${email!.to.join(', ')}\n`);
    }

    return 0;
  } catch (error) {
    out.write(`failed: ${(error as Error).message}\n`);
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

/* istanbul ignore if -- entrypoint */
if (require.main === module) {
  void runEmailSample(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
