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
 * How often the scheduler compares the wall clock against its pending runs.
 * A send therefore lands up to this long after its nominal time.
 */
export const TICK_MS = 60_000;

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

interface PendingRun {
  label: string;
  at: DateTime;
  job: () => Promise<void>;
  rearm: () => void;
  running: boolean;
}

/**
 * Sends the daily email at 16:30 ET on weekdays and the monthly one at 08:00 ET
 * on the 1st, for the previous month.
 *
 * **A short interval that checks the wall clock, not a long one-shot timer.**
 * Node timers run on the monotonic clock, and under Docker Desktop that clock
 * stops while the host sleeps: a 24-hour `setTimeout` armed before a night of
 * laptop sleep fired ~16 hours late, the next morning. The wall clock keeps
 * counting, so a tick compares it against each pending run and a send that fell
 * due during a sleep goes out on the first tick after waking. Each job holds at
 * most one pending run, so a long sleep sends one late email and then re-arms
 * from the present — it never replays every day it missed. Comparing against an
 * absolute instant also keeps 16:30 ET fixed across DST.
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
  private ticker: ReturnType<typeof setInterval> | null = null;
  private daily: PendingRun | null = null;
  private monthly: PendingRun | null = null;
  private clock: Clock = () => DateTime.now().setZone(ET_ZONE);
  /**
   * The last run instant. Re-arming computes from no earlier than this, so a
   * wall clock stepped backwards after a send (an NTP correction) cannot
   * schedule — and send — the same email twice.
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
    if (this.ticker !== null) {
      return;
    }
    this.armDaily();
    this.armMonthly();
    this.ticker = setInterval(() => this.tick(), TICK_MS);
  }

  onModuleDestroy(): void {
    this.stop();
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.daily = null;
    this.monthly = null;
  }

  private armDaily(): void {
    const at = nextDailyRun(this.now());
    this.logger.log(`daily P&L email scheduled for ${at.toISO()}`);
    this.daily = {
      label: 'daily',
      at,
      job: () => this.emails.sendDaily(at.toISODate()!).then(() => undefined),
      rearm: () => this.armDaily(),
      running: false,
    };
  }

  private armMonthly(): void {
    const at = nextMonthlyRun(this.now());
    this.logger.log(`monthly P&L email scheduled for ${at.toISO()}`);
    this.monthly = {
      label: 'monthly',
      at,
      job: () =>
        this.emails.sendMonthly(at.minus({ months: 1 }).toFormat('yyyy-MM')).then(() => undefined),
      rearm: () => this.armMonthly(),
      running: false,
    };
  }

  private tick(): void {
    const now = this.clock();
    for (const run of [this.daily, this.monthly]) {
      if (run !== null && !run.running && now >= run.at) {
        this.fire(run, now);
      }
    }
  }

  /**
   * Runs one due job, then re-arms it. `running` stops the next tick starting a
   * second send while a slow SMTP exchange is still in flight.
   */
  private fire(run: PendingRun, now: DateTime): void {
    run.running = true;
    const lateMs = now.toMillis() - run.at.toMillis();
    if (lateMs > TICK_MS) {
      this.logger.warn(
        `${run.label} P&L email is ${Math.round(lateMs / 60_000)} min late ` +
          `(due ${run.at.toISO()}) — was the host asleep?`,
      );
    }

    run
      .job()
      .then(() => this.logger.log(`${run.label} P&L email sent`))
      .catch((error: unknown) =>
        this.logger.warn(`${run.label} P&L email failed: ${(error as Error).message}`),
      )
      .finally(() => {
        if (this.floor === null || run.at > this.floor) {
          this.floor = run.at;
        }
        // A stop() while the send was in flight must stay stopped.
        if (this.ticker !== null) {
          run.rearm();
        }
      });
  }
}
