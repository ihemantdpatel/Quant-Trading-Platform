import { DateTime } from 'luxon';
import { AppConfigService } from '../config/app-config.service';
import { ExecutionMode } from '../config/execution-mode';
import { ET_ZONE } from '../market-data/types';
import {
  InMemoryFillRepository,
  InMemoryGridLotRepository,
} from '../repositories/in-memory/in-memory.repositories';
import { GridLotStatus } from '../strategies/grid/lot';
import { RecordingMailer } from './mailer';
import {
  EmailNotConfiguredError,
  MAX_TIMER_MS,
  nextDailyRun,
  nextMonthlyRun,
  PnlEmailScheduler,
  PnlEmailService,
} from './pnl-email.service';

const et = (iso: string): DateTime => DateTime.fromISO(iso, { zone: ET_ZONE });

function appConfig(usesIbBroker = true): AppConfigService {
  return {
    accountAlias: 'nuuixl118',
    executionMode: ExecutionMode.PAPER,
    usesIbBroker,
  } as AppConfigService;
}

async function service(mailer: RecordingMailer | null = new RecordingMailer()) {
  const gridLots = new InMemoryGridLotRepository();
  const fills = new InMemoryFillRepository();
  await gridLots.save(
    {
      id: 'g1',
      fillPrice: 70,
      quantity: 50,
      openedAt: '2026-09-25T10:00:00.000-04:00',
      sellTarget: 70.5,
      status: GridLotStatus.CLOSED,
      closedAt: '2026-09-25T11:00:00.000-04:00',
      exitPrice: 70.5,
      workingOrderId: null,
    },
    'grid:TQQQ',
    'TQQQ',
  );
  // A non-grid strategy id is not a grid lot and is not read as one.
  await gridLots.save(
    {
      id: 'x',
      fillPrice: 1,
      quantity: 1,
      openedAt: '2026-09-25T10:00:00.000-04:00',
      sellTarget: 2,
      status: GridLotStatus.CLOSED,
      closedAt: '2026-09-25T11:00:00.000-04:00',
      exitPrice: 2,
      workingOrderId: null,
    },
    'dip-ladder:TQQQ',
    'TQQQ',
  );
  return { emails: new PnlEmailService(gridLots, fills, appConfig(), mailer), mailer };
}

describe('PnlEmailService', () => {
  it('attributes each grid lot to its strategy and symbol', async () => {
    const { emails } = await service();

    const inputs = await emails.loadInputs();

    expect(inputs.lots.map((l) => [l.strategyId, l.symbol, l.lot.id])).toEqual([
      ['grid:TQQQ', 'TQQQ', 'g1'],
    ]);
  });

  it('sends the daily email', async () => {
    const { emails, mailer } = await service();

    const sent = await emails.sendDaily('2026-09-25');

    expect(mailer!.sent).toHaveLength(1);
    expect(sent.subject).toBe(
      '[IB nuuixl118 · PAPER] Daily P&L · Fri, Sep 25, 2026 (session close): +$25.00 (1 trade)',
    );
  });

  it('sends the monthly email over the whole calendar month', async () => {
    const { emails, mailer } = await service();

    await emails.sendMonthly('2026-09');

    expect(mailer!.sent[0].subject).toContain(
      'Monthly P&L · September 2026 (Sep 1 – Sep 30, 2026): +$25.00 (1 trade)',
    );
    expect(mailer!.sent[0].text).toContain('(Sep 1 – Sep 30, 2026)');
  });

  it('refuses to send without a mailer', async () => {
    const { emails } = await service(null);

    expect(emails.enabled).toBe(false);
    await expect(emails.sendDaily('2026-09-25')).rejects.toBeInstanceOf(EmailNotConfiguredError);
  });
});

describe('next run times', () => {
  it('runs the daily email at 16:30 ET the same weekday when still ahead', () => {
    expect(nextDailyRun(et('2026-09-25T09:00')).toISO()).toBe('2026-09-25T16:30:00.000-04:00');
  });

  it('moves past a run already due, and from Friday evening to Monday', () => {
    expect(nextDailyRun(et('2026-09-24T16:30')).toISODate()).toBe('2026-09-25');
    expect(nextDailyRun(et('2026-09-25T17:00')).toISODate()).toBe('2026-09-28');
    expect(nextDailyRun(et('2026-09-26T12:00')).toISODate()).toBe('2026-09-28');
  });

  it('keeps 16:30 ET across the DST change', () => {
    // US DST ends Sunday 2026-11-01.
    expect(nextDailyRun(et('2026-10-30T17:00')).toISO()).toBe('2026-11-02T16:30:00.000-05:00');
  });

  it('accepts a clock in another zone', () => {
    const utc = DateTime.fromISO('2026-09-25T21:00:00Z', { zone: 'utc' }); // 17:00 ET
    expect(nextDailyRun(utc).toISODate()).toBe('2026-09-28');
  });

  it('runs the monthly email at 08:00 ET on the 1st, rolling the year', () => {
    expect(nextMonthlyRun(et('2026-09-27T10:00')).toISO()).toBe('2026-10-01T08:00:00.000-04:00');
    expect(nextMonthlyRun(et('2026-10-01T07:59')).toISODate()).toBe('2026-10-01');
    expect(nextMonthlyRun(et('2026-10-01T08:00')).toISODate()).toBe('2026-11-01');
    expect(nextMonthlyRun(et('2026-12-15T10:00')).toISO()).toBe('2027-01-01T08:00:00.000-05:00');
  });
});

describe('PnlEmailScheduler', () => {
  let now: DateTime;
  const clock = (): DateTime => now;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** Advances both the fake timers and the injected clock. */
  async function advance(ms: number): Promise<void> {
    now = now.plus({ milliseconds: ms });
    await jest.advanceTimersByTimeAsync(ms);
  }

  it('does not start without IB or without email', async () => {
    const { emails } = await service();
    const withoutIb = new PnlEmailScheduler(emails, appConfig(false));
    withoutIb.onApplicationBootstrap();
    expect(jest.getTimerCount()).toBe(0);

    const { emails: disabled } = await service(null);
    new PnlEmailScheduler(disabled, appConfig()).onApplicationBootstrap();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('starts both timers when IB and email are configured, and stops on destroy', async () => {
    const { emails } = await service();
    const scheduler = new PnlEmailScheduler(emails, appConfig());

    scheduler.onApplicationBootstrap();
    expect(jest.getTimerCount()).toBe(2);

    scheduler.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('sends the daily email at 16:30 ET for that date, once, and re-arms', async () => {
    const { emails, mailer } = await service();
    now = et('2026-09-25T16:00');
    const scheduler = new PnlEmailScheduler(emails, appConfig());
    scheduler.start(clock);

    await advance(30 * 60 * 1000);

    expect(mailer!.sent.map((m) => m.subject)).toEqual([
      '[IB nuuixl118 · PAPER] Daily P&L · Fri, Sep 25, 2026 (session close): +$25.00 (1 trade)',
    ]);

    // Nothing more until Monday 16:30.
    await advance(60 * 60 * 1000);
    expect(mailer!.sent).toHaveLength(1);
    scheduler.stop();
  });

  it('does not send twice when a timer fires a moment early', async () => {
    const { emails, mailer } = await service();
    now = et('2026-09-25T16:00');
    const scheduler = new PnlEmailScheduler(emails, appConfig());
    scheduler.start(clock);

    // The clock lags the timer by 5ms: when it fires, "now" is before 16:30.
    now = now.minus({ milliseconds: 5 });
    await advance(30 * 60 * 1000);
    await advance(10);

    expect(mailer!.sent).toHaveLength(1);
    scheduler.stop();
  });

  it('logs and survives a failed send, then re-arms', async () => {
    const { emails, mailer } = await service();
    mailer!.failWith = new Error('SMTP down');
    now = et('2026-09-25T16:29');
    const scheduler = new PnlEmailScheduler(emails, appConfig());
    scheduler.start(clock);

    await advance(60 * 1000);

    expect(mailer!.sent).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(2);
    scheduler.stop();
  });

  it('sends the previous month on the 1st', async () => {
    const { emails, mailer } = await service();
    now = et('2026-10-01T07:59');
    const scheduler = new PnlEmailScheduler(emails, appConfig());
    scheduler.start(clock);

    await advance(60 * 1000);

    expect(mailer!.sent.map((m) => m.subject)).toEqual([
      '[IB nuuixl118 · PAPER] Monthly P&L · September 2026 (Sep 1 – Sep 30, 2026): +$25.00 (1 trade)',
    ]);
    scheduler.stop();
  });

  it('chunks a wait longer than setTimeout can hold instead of firing at once', async () => {
    const { emails, mailer } = await service();
    // 2 Oct → 1 Nov is ~30 days, past the ~24.8-day timer ceiling.
    now = et('2026-10-01T09:00');
    const scheduler = new PnlEmailScheduler(emails, appConfig());
    scheduler.start(clock);
    scheduler.stop(); // drop the daily timer; re-arm only the monthly below
    (scheduler as unknown as { armMonthly(): void }).armMonthly();

    await advance(MAX_TIMER_MS);
    expect(mailer!.sent).toHaveLength(0);

    await advance(et('2026-11-01T08:00').toMillis() - now.toMillis());
    expect(mailer!.sent.map((m) => m.subject)).toEqual([
      '[IB nuuixl118 · PAPER] Monthly P&L · October 2026 (Oct 1 – Oct 31, 2026): $0.00 (0 trades)',
    ]);
    scheduler.stop();
  });
});
