/**
 * Daily and monthly realized-P&L emails.
 *
 * Read-only over persisted rows, like the daily soak report: it holds no broker
 * and no strategy, so nothing here can place or cancel an order. Each daemon
 * emails its own account's summary — one process, one account.
 */

import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { DateTime } from 'luxon';
import { AppConfigService } from '../config/app-config.service';
import { ET_ZONE } from '../market-data/types';
import {
  FILL_REPOSITORY,
  FillRepository,
  GRID_LOT_REPOSITORY,
  GridLotRepository,
} from '../repositories/repository.interfaces';
import { GRID_ID_PREFIX } from '../strategies/grid/grid.strategy';
import { MAILER, Mailer } from './mailer';
import {
  EmailAccount,
  RenderedEmail,
  RenderOptions,
  renderDaily,
  renderPeriod,
} from './pnl-email.renderer';
import { buildDailyPnl, buildPeriodPnl, monthRange, PnlInputs } from './pnl-summary';

/** Raised when a send is requested but SMTP is not configured. */
export class EmailNotConfiguredError extends Error {
  constructor() {
    super('email is not configured — set SMTP_USER, SMTP_PASS and EMAIL_TO');
  }
}

@Injectable()
export class PnlEmailService {
  constructor(
    @Inject(GRID_LOT_REPOSITORY) private readonly gridLots: GridLotRepository,
    @Inject(FILL_REPOSITORY) private readonly fills: FillRepository,
    private readonly appConfig: AppConfigService,
    @Optional() @Inject(MAILER) private readonly mailer: Mailer | null = null,
  ) {}

  get enabled(): boolean {
    return this.mailer !== null;
  }

  /** Grid lots with the strategy and symbol their rows carry, plus every fill. */
  async loadInputs(): Promise<PnlInputs> {
    const strategyIds = (await this.gridLots.findStrategyIds()).filter((id) =>
      id.startsWith(GRID_ID_PREFIX),
    );

    const lots = (
      await Promise.all(
        strategyIds.map(async (strategyId) =>
          (await this.gridLots.findByStrategy(strategyId)).map((lot) => ({
            strategyId,
            // One grid instance trades one symbol, named in its id — the same
            // reconstruction `EngineController.fallbackGridLots` uses.
            symbol: strategyId.slice(GRID_ID_PREFIX.length),
            lot,
          })),
        ),
      )
    ).flat();

    return { lots, fills: await this.fills.findAll() };
  }

  private account(): EmailAccount {
    return { alias: this.appConfig.accountAlias, mode: this.appConfig.executionMode };
  }

  async renderDaily(date: string, options?: RenderOptions): Promise<RenderedEmail> {
    return renderDaily(buildDailyPnl(await this.loadInputs(), date), this.account(), options);
  }

  async renderPeriod(from: string, to: string, options?: RenderOptions): Promise<RenderedEmail> {
    return renderPeriod(buildPeriodPnl(await this.loadInputs(), from, to), this.account(), options);
  }

  async renderMonthly(month: string, options?: RenderOptions): Promise<RenderedEmail> {
    const { from, to } = monthRange(month);
    return this.renderPeriod(from, to, options);
  }

  async sendDaily(date: string): Promise<RenderedEmail> {
    return this.send(await this.renderDaily(date));
  }

  async sendMonthly(month: string): Promise<RenderedEmail> {
    return this.send(await this.renderMonthly(month));
  }

  private async send(email: RenderedEmail): Promise<RenderedEmail> {
    if (this.mailer === null) {
      throw new EmailNotConfiguredError();
    }
    await this.mailer.send(email);
    return email;
  }
}

export const DAILY_SEND_AT = { hour: 16, minute: 30 };
export const MONTHLY_SEND_AT = { day: 1, hour: 8, minute: 0 };

/**
 * `setTimeout` overflows past 2^31−1 ms (~24.8 days) and fires immediately, and
 * a monthly delay can exceed that. Longer waits are chunked and re-armed.
 */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** The next weekday 16:30 ET strictly after `now`. */
export function nextDailyRun(now: DateTime): DateTime {
  let candidate = now.setZone(ET_ZONE).set({ ...DAILY_SEND_AT, second: 0, millisecond: 0 });

  if (candidate <= now) {
    candidate = candidate.plus({ days: 1 });
  }
  // Luxon weekdays: 6 = Saturday, 7 = Sunday.
  while (candidate.weekday > 5) {
    candidate = candidate.plus({ days: 1 });
  }

  return candidate;
}

/** The next 1st-of-month 08:00 ET strictly after `now`. */
export function nextMonthlyRun(now: DateTime): DateTime {
  const candidate = now.setZone(ET_ZONE).set({ ...MONTHLY_SEND_AT, second: 0, millisecond: 0 });

  return candidate > now ? candidate : candidate.plus({ months: 1 });
}

type Clock = () => DateTime;

/**
 * Sends the daily email at 16:30 ET on weekdays and the monthly one at 08:00 ET
 * on the 1st, for the previous month.
 *
 * **One-shot timers that re-arm**, for the reason `PostCloseReconcileService`
 * gives: a fixed interval drifts across DST and anchors to process start.
 *
 * **Started only when IB is bound and email is configured.** Under the mock
 * broker the only lots are fixture replays, and emailing those would be noise.
 * Holidays are not skipped — there is no holiday calendar, and a "no trades"
 * email on a closed day is harmless.
 *
 * **A failed send is logged and dropped — never retried, never rethrown.** An
 * unhandled rejection in a timer callback would turn a mail outage into a
 * daemon outage. `POST /reports/email/*` is the manual resend.
 */
@Injectable()
export class PnlEmailScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PnlEmailScheduler.name);
  private dailyTimer: ReturnType<typeof setTimeout> | null = null;
  private monthlyTimer: ReturnType<typeof setTimeout> | null = null;
  private clock: Clock = () => DateTime.now().setZone(ET_ZONE);
  /**
   * The last run instant. Re-arming computes from no earlier than this, so a
   * timer that fires a millisecond before its target cannot schedule — and
   * send — the same email twice.
   */
  private floor: DateTime | null = null;

  private now(): DateTime {
    const now = this.clock();
    return this.floor !== null && this.floor >= now ? this.floor : now;
  }

  constructor(
    private readonly emails: PnlEmailService,
    private readonly appConfig: AppConfigService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.appConfig.usesIbBroker || !this.emails.enabled) {
      return;
    }
    this.start();
  }

  start(clock?: Clock): void {
    if (clock) {
      this.clock = clock;
    }
    if (this.dailyTimer === null) {
      this.armDaily();
    }
    if (this.monthlyTimer === null) {
      this.armMonthly();
    }
  }

  onModuleDestroy(): void {
    this.stop();
  }

  stop(): void {
    if (this.dailyTimer) clearTimeout(this.dailyTimer);
    if (this.monthlyTimer) clearTimeout(this.monthlyTimer);
    this.dailyTimer = null;
    this.monthlyTimer = null;
  }

  private armDaily(): void {
    const at = nextDailyRun(this.now());
    this.logger.log(`daily P&L email scheduled for ${at.toISO()}`);
    this.dailyTimer = this.schedule(
      at,
      () => this.emails.sendDaily(at.toISODate()!).then(() => undefined),
      () => this.armDaily(),
      'daily',
    );
  }

  private armMonthly(): void {
    const at = nextMonthlyRun(this.now());
    this.logger.log(`monthly P&L email scheduled for ${at.toISO()}`);
    this.monthlyTimer = this.schedule(
      at,
      () =>
        this.emails.sendMonthly(at.minus({ months: 1 }).toFormat('yyyy-MM')).then(() => undefined),
      () => this.armMonthly(),
      'monthly',
    );
  }

  /**
   * Waits until `at` — in chunks no longer than `MAX_TIMER_MS` — runs `job`,
   * then calls `rearm`. The chunk path re-arms without running, recomputing the
   * target from the clock so a long wait cannot drift.
   */
  private schedule(
    at: DateTime,
    job: () => Promise<void>,
    rearm: () => void,
    label: string,
  ): ReturnType<typeof setTimeout> {
    const delay = at.toMillis() - this.clock().toMillis();

    if (delay > MAX_TIMER_MS) {
      return setTimeout(rearm, MAX_TIMER_MS);
    }

    return setTimeout(
      () => {
        job()
          .then(() => this.logger.log(`${label} P&L email sent`))
          .catch((error: unknown) =>
            this.logger.warn(`${label} P&L email failed: ${(error as Error).message}`),
          )
          .finally(() => {
            if (this.floor === null || at > this.floor) {
              this.floor = at;
            }
            rearm();
          });
      },
      Math.max(0, delay),
    );
  }
}
