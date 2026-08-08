/**
 * Pacing queue tests (`stories.md:611`).
 *
 * These run on a **virtual clock**. The limits being enforced are a 10-minute
 * window and a 15-second cooldown, so a suite on the real clock would either
 * take ten minutes or assert nothing meaningful. The fake clock advances only
 * when the queue sleeps, which makes the window arithmetic exactly checkable —
 * including at the boundary, where an off-by-one is the difference between 60
 * requests and a pacing violation.
 *
 * The headline assertion is the burst test: **no 10-minute window ever contains
 * more than the configured maximum**, checked across every window position
 * rather than just the total.
 */

import { DEFAULT_PACING_CONFIG, historicalRequestKey, PacingQueue } from './pacing-queue';

/**
 * A clock that only moves when something sleeps.
 *
 * Deliberately not `jest.useFakeTimers()`: the queue awaits its sleeper between
 * dispatches, and driving that with timer mocks means interleaving timer
 * advancement with promise resolution by hand. Injecting the clock keeps the
 * test reading as a sequence of requests rather than as timer bookkeeping.
 */
function virtualClock() {
  let current = 0;

  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
    get time() {
      return current;
    },
  };
}

describe('PacingQueue', () => {
  describe('rate limiting', () => {
    it('dispatches freely while the window has room', async () => {
      const clock = virtualClock();
      const queue = new PacingQueue({ maxRequestsPerWindow: 5 }, clock.now, clock.sleep);

      for (let i = 0; i < 5; i += 1) {
        await queue.enqueue(`k${i}`, async () => i);
      }

      // Nothing waited: five requests, a five-request window.
      expect(queue.stats().rateLimitWaits).toBe(0);
      expect(clock.time).toBe(0);
    });

    it('makes the request that would breach the limit wait for the window to drain', async () => {
      const clock = virtualClock();
      const queue = new PacingQueue(
        { maxRequestsPerWindow: 3, windowMs: 600_000 },
        clock.now,
        clock.sleep,
      );

      for (let i = 0; i < 3; i += 1) {
        await queue.enqueue(`k${i}`, async () => i);
      }

      expect(clock.time).toBe(0);

      // The fourth must wait a full window, because all three were at t=0.
      await queue.enqueue('k4', async () => 'fourth');

      expect(clock.time).toBe(600_000);
      expect(queue.stats().rateLimitWaits).toBe(1);
    });

    it('never exceeds the limit in any window under burst load', async () => {
      // `stories.md:611`, and the reason this file exists. 200 requests fired
      // as fast as the queue will take them, then every window position is
      // checked — not just the total, which a burst at the very end would pass
      // while still violating the limit.
      const clock = virtualClock();
      const dispatchedAt: number[] = [];
      const queue = new PacingQueue(
        { maxRequestsPerWindow: 55, windowMs: 600_000 },
        clock.now,
        clock.sleep,
      );

      await Promise.all(
        Array.from({ length: 200 }, (_, i) =>
          queue.enqueue(`burst-${i}`, async () => {
            dispatchedAt.push(clock.now());
          }),
        ),
      );

      expect(dispatchedAt).toHaveLength(200);

      for (let i = 0; i < dispatchedAt.length; i += 1) {
        const windowEnd = dispatchedAt[i] + 600_000;
        const inWindow = dispatchedAt.filter((at) => at >= dispatchedAt[i] && at < windowEnd);

        expect(inWindow.length).toBeLessThanOrEqual(55);
      }
    });

    it('lets a request through once the oldest ages out of the window', async () => {
      const clock = virtualClock();
      const queue = new PacingQueue(
        { maxRequestsPerWindow: 2, windowMs: 1000 },
        clock.now,
        clock.sleep,
      );

      await queue.enqueue('a', async () => 1);
      await queue.enqueue('b', async () => 2);

      // Advance past the window without the queue sleeping: both entries expire.
      clock.advance(1001);
      await queue.enqueue('c', async () => 3);

      expect(queue.stats().rateLimitWaits).toBe(0);
      expect(queue.stats().inWindow).toBe(1);
    });

    it('dispatches strictly in submission order', async () => {
      // Reordering to fit a limit would make a backfill's request pattern
      // depend on timing, and an out-of-order gap-fill is far harder to reason
      // about when a range comes back short.
      const clock = virtualClock();
      const order: number[] = [];
      const queue = new PacingQueue(
        { maxRequestsPerWindow: 2, windowMs: 1000 },
        clock.now,
        clock.sleep,
      );

      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          queue.enqueue(`k${i}`, async () => {
            order.push(i);
          }),
        ),
      );

      expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });
  });

  describe('the identical-request cooldown', () => {
    it('delays an identical request rather than dropping it', async () => {
      // `stories.md:612` — "suppressed or delayed, **never sent**" refers to
      // sending it too early. Dropping would silently leave a hole in the
      // cached history, indistinguishable later from a market holiday.
      const clock = virtualClock();
      const queue = new PacingQueue({ identicalRequestCooldownMs: 15_000 }, clock.now, clock.sleep);

      const first = await queue.enqueue('same', async () => 'first');
      const second = await queue.enqueue('same', async () => 'second');

      // Both ran. The second simply ran later.
      expect(first).toBe('first');
      expect(second).toBe('second');
      expect(clock.time).toBe(15_000);
      expect(queue.stats().cooldownWaits).toBe(1);
      expect(queue.stats().totalDispatched).toBe(2);
    });

    it('does not delay requests with different keys', async () => {
      const clock = virtualClock();
      const queue = new PacingQueue({}, clock.now, clock.sleep);

      await queue.enqueue('a', async () => 1);
      await queue.enqueue('b', async () => 2);

      expect(clock.time).toBe(0);
      expect(queue.stats().cooldownWaits).toBe(0);
    });

    it('waits only the remaining cooldown, not the full interval', async () => {
      const clock = virtualClock();
      const queue = new PacingQueue({ identicalRequestCooldownMs: 15_000 }, clock.now, clock.sleep);

      await queue.enqueue('same', async () => 1);
      clock.advance(10_000);
      await queue.enqueue('same', async () => 2);

      // 10s already elapsed, so only 5s more.
      expect(clock.time).toBe(15_000);
    });

    it('allows an identical request once the cooldown has fully elapsed', async () => {
      const clock = virtualClock();
      const queue = new PacingQueue({ identicalRequestCooldownMs: 15_000 }, clock.now, clock.sleep);

      await queue.enqueue('same', async () => 1);
      clock.advance(15_001);
      await queue.enqueue('same', async () => 2);

      expect(queue.stats().cooldownWaits).toBe(0);
    });
  });

  describe('failures', () => {
    it('propagates a failing request to its own caller', async () => {
      const clock = virtualClock();
      const queue = new PacingQueue({}, clock.now, clock.sleep);

      await expect(
        queue.enqueue('a', async () => Promise.reject(new Error('IB said no'))),
      ).rejects.toThrow('IB said no');
    });

    it('keeps dispatching after one request fails', async () => {
      // A failed backfill segment must not stall every request behind it.
      const clock = virtualClock();
      const queue = new PacingQueue({}, clock.now, clock.sleep);

      const failed = queue.enqueue('a', async () => Promise.reject(new Error('boom')));
      const after = queue.enqueue('b', async () => 'ok');

      await expect(failed).rejects.toThrow('boom');
      await expect(after).resolves.toBe('ok');
    });

    it('counts a failed request against the pacing window', async () => {
      // IB counts the request it received, whatever the outcome. Not counting
      // failures would let a run of errors quietly breach the limit.
      const clock = virtualClock();
      const queue = new PacingQueue({}, clock.now, clock.sleep);

      await expect(
        queue.enqueue('a', async () => Promise.reject(new Error('x'))),
      ).rejects.toThrow();

      expect(queue.stats().inWindow).toBe(1);
    });
  });

  describe('defaults', () => {
    it('sits below IB’s documented ceiling', () => {
      // IB's limit is approximate and breaching it is silent, so there is no
      // feedback telling us we were too close. The headroom is deliberate.
      expect(DEFAULT_PACING_CONFIG.maxRequestsPerWindow).toBeLessThan(60);
      expect(DEFAULT_PACING_CONFIG.windowMs).toBe(600_000);
      expect(DEFAULT_PACING_CONFIG.identicalRequestCooldownMs).toBe(15_000);
    });

    it('reset forgets the window and the cooldowns', async () => {
      const clock = virtualClock();
      const queue = new PacingQueue({ maxRequestsPerWindow: 1 }, clock.now, clock.sleep);

      await queue.enqueue('a', async () => 1);
      queue.reset();
      await queue.enqueue('a', async () => 2);

      expect(clock.time).toBe(0);
    });
  });

  describe('historicalRequestKey', () => {
    it('distinguishes different ranges of the same symbol', () => {
      // Two gap-fills for different dates are not identical requests and must
      // not be collapsed into one cooldown.
      const a = historicalRequestKey('TQQQ', '1day', '2024-01-01', '2024-06-01');
      const b = historicalRequestKey('TQQQ', '1day', '2024-06-01', '2024-12-01');

      expect(a).not.toBe(b);
    });

    it('treats the same symbol, size, and range as identical', () => {
      expect(historicalRequestKey('TQQQ', '5min', 'a', 'b')).toBe(
        historicalRequestKey('TQQQ', '5min', 'a', 'b'),
      );
    });

    it('distinguishes bar sizes', () => {
      expect(historicalRequestKey('TQQQ', '1day', 'a', 'b')).not.toBe(
        historicalRequestKey('TQQQ', '5min', 'a', 'b'),
      );
    });
  });
});
