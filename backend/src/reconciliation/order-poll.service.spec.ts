/**
 * The periodic mid-session order-poll job.
 *
 * Mirrors `post-close-reconcile.spec.ts`'s safety-envelope coverage — a
 * broker that cannot be reached must leave the ledger alone, and a thrown
 * error must not escape a timer callback — plus the interval-specific
 * behaviour: it fires repeatedly rather than once, and the timer must not
 * hold the process open.
 */

import { DEFAULT_ORDER_POLL_CONFIG, OrderPollService } from './order-poll.service';
import { OrderReconciliationReport, ReconciliationService } from './reconciliation.service';

function harness(report?: Partial<OrderReconciliationReport>) {
  const reconcileOrders = jest
    .fn<Promise<OrderReconciliationReport>, [string]>()
    .mockResolvedValue({
      ranAt: '2025-01-20T11:05:00.000-05:00',
      symbols: ['TQQQ'],
      brokerReachable: true,
      ordersUpdated: 0,
      ...report,
    });

  const service = new OrderPollService({
    reconcileOrders,
  } as unknown as ReconciliationService);

  jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

  return { service, reconcileOrders };
}

describe('poll', () => {
  it('reconciles orders', async () => {
    const { service, reconcileOrders } = harness();

    await service.poll('2025-01-20T11:05:00.000-05:00');

    expect(reconcileOrders).toHaveBeenCalledWith('2025-01-20T11:05:00.000-05:00');
  });

  it('logs when it corrects a stale order row', async () => {
    const { service } = harness({ ordersUpdated: 1 });
    const log = jest.spyOn(service['logger'], 'log');

    await service.poll('2025-01-20T11:05:00.000-05:00');

    expect(log).toHaveBeenCalledWith(expect.stringContaining('corrected 1 stale order row'));
  });

  it('warns rather than halting when the broker cannot be reached', async () => {
    const { service } = harness({ brokerReachable: false });
    const warn = jest.spyOn(service['logger'], 'warn');

    await service.poll('2025-01-20T11:05:00.000-05:00');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not reach the broker'));
  });

  it('swallows a thrown error instead of taking the daemon down', async () => {
    const { service, reconcileOrders } = harness();
    reconcileOrders.mockRejectedValue(new Error('IB did not respond'));
    const error = jest.spyOn(service['logger'], 'error');

    await expect(service.poll('2025-01-20T11:05:00.000-05:00')).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('will retry'));
  });
});

describe('start', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('arms a timer that does not hold the process open', () => {
    jest.useFakeTimers();
    const { service } = harness();

    service.start();

    expect(jest.getTimerCount()).toBe(1);
    service.stop();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('is idempotent — a second start does not stack a second timer', () => {
    jest.useFakeTimers();
    const { service } = harness();

    service.start();
    service.start();

    expect(jest.getTimerCount()).toBe(1);
    service.stop();
  });

  it('polls every interval, repeatedly, not just once', async () => {
    jest.useFakeTimers();
    const { service, reconcileOrders } = harness();

    service.start();

    await jest.advanceTimersByTimeAsync(DEFAULT_ORDER_POLL_CONFIG.intervalMs);
    expect(reconcileOrders).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(DEFAULT_ORDER_POLL_CONFIG.intervalMs);
    expect(reconcileOrders).toHaveBeenCalledTimes(2);

    // Still just the one recurring timer, not a fresh one stacked per tick.
    expect(jest.getTimerCount()).toBe(1);

    service.stop();
  });

  it('honours a configured interval', async () => {
    jest.useFakeTimers();
    const reconcileOrders = jest
      .fn<Promise<OrderReconciliationReport>, [string]>()
      .mockResolvedValue({
        ranAt: '2025-01-20T11:05:00.000-05:00',
        symbols: [],
        brokerReachable: true,
        ordersUpdated: 0,
      });
    const service = new OrderPollService({ reconcileOrders } as unknown as ReconciliationService, {
      intervalMs: 60_000,
    });
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);

    service.start();

    await jest.advanceTimersByTimeAsync(60_000);
    expect(reconcileOrders).toHaveBeenCalledTimes(1);

    service.stop();
  });
});
