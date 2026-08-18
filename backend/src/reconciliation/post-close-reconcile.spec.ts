/**
 * The post-close reconciliation job.
 *
 * Two things are worth testing here and they are quite different. The first is
 * the **schedule arithmetic** — a job pinned to the market close must survive
 * DST and weekends, and getting that wrong is silent: the run simply happens at
 * the wrong hour, or on a day with no close behind it. The second is the
 * **safety envelope** — this runs unattended, so a broker that cannot be
 * reached must leave the ledger alone rather than halt anything, and a thrown
 * error must not escape a timer callback and take the daemon down.
 */

import { DateTime } from 'luxon';
import { ET_ZONE } from '../market-data/types';
import {
  DEFAULT_POST_CLOSE_CONFIG,
  PostCloseReconcileService,
} from './post-close-reconcile.service';
import { OrderReconciliationReport, ReconciliationService } from './reconciliation.service';

const et = (iso: string): DateTime => DateTime.fromISO(iso, { zone: ET_ZONE });

function harness(report?: Partial<OrderReconciliationReport>) {
  const reconcileOrders = jest
    .fn<Promise<OrderReconciliationReport>, [string]>()
    .mockResolvedValue({
      ranAt: '2025-01-20T16:15:00.000-05:00',
      symbols: ['TQQQ'],
      brokerReachable: true,
      ordersUpdated: 0,
      ...report,
    });

  const service = new PostCloseReconcileService({
    reconcileOrders,
  } as unknown as ReconciliationService);

  jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

  return { service, reconcileOrders };
}

describe('nextRunAt', () => {
  it('schedules the delay after today’s close when the day is still young', () => {
    const { service } = harness();

    const next = service.nextRunAt(et('2025-01-20T10:00:00'));

    expect(next.toFormat('yyyy-MM-dd HH:mm')).toBe(
      `2025-01-20 16:${DEFAULT_POST_CLOSE_CONFIG.delayMinutesAfterClose}`,
    );
  });

  it('rolls to the next day once this evening’s run has passed', () => {
    const { service } = harness();

    const next = service.nextRunAt(et('2025-01-20T20:00:00'));

    expect(next.toFormat('yyyy-MM-dd HH:mm')).toBe('2025-01-21 16:15');
  });

  it('schedules strictly after now, never on the instant it just fired', () => {
    // Re-arming exactly on the boundary would fire again immediately and spin.
    const { service } = harness();

    const next = service.nextRunAt(et('2025-01-20T16:15:00'));

    expect(next.toFormat('yyyy-MM-dd')).toBe('2025-01-21');
  });

  it('skips the weekend — there is no close to follow', () => {
    const { service } = harness();

    // Friday evening, after the run.
    const next = service.nextRunAt(et('2025-01-24T20:00:00'));

    expect(next.toFormat('cccc yyyy-MM-dd HH:mm')).toBe('Monday 2025-01-27 16:15');
  });

  it('keeps 16:15 ET across a DST transition rather than drifting an hour', () => {
    // The reason this is a one-shot timer that re-arms rather than a 24h
    // interval: an interval would land at 15:15 or 17:15 for half the year.
    const { service } = harness();

    // US DST began 2025-03-09. The run on the 10th must still be 16:15 ET.
    const next = service.nextRunAt(et('2025-03-09T20:00:00'));

    expect(next.toFormat('yyyy-MM-dd HH:mm')).toBe('2025-03-10 16:15');
    expect(next.offsetNameShort).toBe('EDT');
  });
});

describe('runNow', () => {
  it('reconciles orders and reports what it corrected', async () => {
    const { service, reconcileOrders } = harness({ ordersUpdated: 2 });

    await service.runNow(et('2025-01-20T16:15:00'));

    expect(reconcileOrders).toHaveBeenCalledTimes(1);
  });

  it('does not run twice for the same session', async () => {
    const { service, reconcileOrders } = harness();

    await service.runNow(et('2025-01-20T16:15:00'));
    await service.runNow(et('2025-01-20T16:20:00'));

    expect(reconcileOrders).toHaveBeenCalledTimes(1);
  });

  it('runs again on the following session', async () => {
    const { service, reconcileOrders } = harness();

    await service.runNow(et('2025-01-20T16:15:00'));
    await service.runNow(et('2025-01-21T16:15:00'));

    expect(reconcileOrders).toHaveBeenCalledTimes(2);
  });

  it('warns rather than halting when the broker cannot be reached', async () => {
    // The whole reason this job reconciles orders and not positions: an
    // unattended halt is the failure nobody sees until the next morning.
    const { service } = harness({ brokerReachable: false });
    const warn = jest.spyOn(service['logger'], 'warn');

    await service.runNow(et('2025-01-20T16:15:00'));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not reach the broker'));
  });

  it('swallows a thrown error instead of taking the daemon down', async () => {
    // An unhandled rejection inside a timer callback is fatal to the process.
    // A failed maintenance read must never become an outage.
    const { service, reconcileOrders } = harness();
    reconcileOrders.mockRejectedValue(new Error('IB did not respond'));
    const error = jest.spyOn(service['logger'], 'error');

    await expect(service.runNow(et('2025-01-20T16:15:00'))).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('will retry'));
  });
});

describe('start', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('arms a timer that does not hold the process open', () => {
    // A scheduled job must not be the reason the daemon cannot exit.
    jest.useFakeTimers();
    const { service } = harness();

    service.start(et('2025-01-20T10:00:00'));

    expect(jest.getTimerCount()).toBe(1);
    service.stop();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('is idempotent — a second start does not stack a second timer', () => {
    jest.useFakeTimers();
    const { service } = harness();

    service.start(et('2025-01-20T10:00:00'));
    service.start(et('2025-01-20T10:00:00'));

    expect(jest.getTimerCount()).toBe(1);
    service.stop();
  });

  it('runs the reconciliation when the timer fires, then re-arms', async () => {
    jest.useFakeTimers();
    const { service, reconcileOrders } = harness();

    service.start(et('2025-01-20T10:00:00'));

    await jest.advanceTimersByTimeAsync(7 * 60 * 60 * 1000);

    expect(reconcileOrders).toHaveBeenCalledTimes(1);
    // Re-armed for the next session rather than stopping after one run.
    expect(jest.getTimerCount()).toBe(1);

    service.stop();
  });
});
