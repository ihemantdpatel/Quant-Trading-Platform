/**
 * Reconnect, backoff, forced re-auth, and staleness (`stories.md:615`–`618`).
 *
 * The delays are asserted **as values**, not as elapsed wall-clock time: a test
 * that only measured duration would pass on a linear backoff, and the doubling
 * is the property that keeps a flapping Gateway from being hammered.
 *
 * The most important assertion in this file is the negative one — exhausting
 * retries produces a halt signal and nothing resembling a liquidation.
 */

import {
  backoffDelay,
  DEFAULT_RECONNECT_CONFIG,
  DEFAULT_STALE_THRESHOLD_MS,
  isStale,
  ReconnectOutcome,
  ReconnectPolicy,
} from './reconnect';

/** Records what was slept without actually sleeping. */
function recordingSleeper() {
  const slept: number[] = [];

  return { slept, sleep: async (ms: number) => void slept.push(ms) };
}

function silence(policy: ReconnectPolicy): ReconnectPolicy {
  jest.spyOn(policy['logger'], 'log').mockImplementation(() => undefined);
  jest.spyOn(policy['logger'], 'warn').mockImplementation(() => undefined);
  jest.spyOn(policy['logger'], 'error').mockImplementation(() => undefined);

  return policy;
}

describe('backoffDelay', () => {
  it('doubles each attempt', () => {
    const config = { maxAttempts: 10, baseDelayMs: 1000, maxDelayMs: 600_000 };

    expect([1, 2, 3, 4, 5].map((n) => backoffDelay(n, config))).toEqual([
      1000, 2000, 4000, 8000, 16_000,
    ]);
  });

  it('caps at maxDelayMs', () => {
    // Without a cap, attempt 10 on a 1s base waits over eight minutes — long
    // enough that a Gateway back early stays unused for most of a session.
    const config = { maxAttempts: 20, baseDelayMs: 1000, maxDelayMs: 60_000 };

    expect(backoffDelay(10, config)).toBe(60_000);
    expect(backoffDelay(20, config)).toBe(60_000);
  });
});

describe('ReconnectPolicy', () => {
  describe('a transient socket drop', () => {
    it('reconnects on the first successful attempt', async () => {
      // `stories.md:616`.
      const { slept, sleep } = recordingSleeper();
      const policy = silence(new ReconnectPolicy({ baseDelayMs: 10 }, sleep));

      const result = await policy.reconnect(async () => undefined);

      expect(result.outcome).toBe(ReconnectOutcome.RECONNECTED);
      expect(result.attempts).toBe(1);
      expect(slept).toEqual([10]);
    });

    it('retries with exponentially increasing delays', async () => {
      const { slept, sleep } = recordingSleeper();
      const policy = silence(new ReconnectPolicy({ baseDelayMs: 100, maxAttempts: 5 }, sleep));

      let calls = 0;
      const result = await policy.reconnect(async () => {
        calls += 1;
        if (calls < 4) {
          throw new Error('ECONNREFUSED');
        }
      });

      expect(result.outcome).toBe(ReconnectOutcome.RECONNECTED);
      expect(result.attempts).toBe(4);
      expect(slept).toEqual([100, 200, 400, 800]);
    });

    it('reports the last error while it is still retrying', async () => {
      const { sleep } = recordingSleeper();
      const policy = silence(new ReconnectPolicy({ baseDelayMs: 1, maxAttempts: 3 }, sleep));

      const result = await policy.reconnect(async () => {
        throw new Error('gateway not listening');
      });

      expect(result.lastError).toBe('gateway not listening');
    });
  });

  describe('retries exhausted — the fail-safe state', () => {
    it('reports EXHAUSTED after the configured number of attempts', async () => {
      // `stories.md:617`. This is the outcome that halts new entries.
      const { slept, sleep } = recordingSleeper();
      const policy = silence(new ReconnectPolicy({ baseDelayMs: 1, maxAttempts: 4 }, sleep));

      const result = await policy.reconnect(async () => {
        throw new Error('still down');
      });

      expect(result.outcome).toBe(ReconnectOutcome.EXHAUSTED);
      expect(result.attempts).toBe(4);
      expect(slept).toHaveLength(4);
      expect(result.lastError).toBe('still down');
    });

    it('offers no way to liquidate — the result is a signal, not an action', async () => {
      // `PRD.md:317`. Asserted structurally: the policy's entire vocabulary is
      // two outcomes and some diagnostics. There is no order, no position, and
      // no callback through which a sell could be issued, so exhaustion
      // *cannot* become a realized loss no matter how a caller misuses it.
      const { sleep } = recordingSleeper();
      const policy = silence(new ReconnectPolicy({ baseDelayMs: 1, maxAttempts: 2 }, sleep));

      const result = await policy.reconnect(async () => {
        throw new Error('down');
      });

      expect(Object.keys(result).sort()).toEqual([
        'attempts',
        'delays',
        'lastError',
        'outcome',
        'scheduled',
      ]);
      expect(Object.values(ReconnectOutcome)).toEqual(['RECONNECTED', 'EXHAUSTED']);
    });

    it('logs that positions are not liquidated', async () => {
      // The operator-facing half of the same guarantee.
      const { sleep } = recordingSleeper();
      const policy = new ReconnectPolicy({ baseDelayMs: 1, maxAttempts: 1 }, sleep);
      jest.spyOn(policy['logger'], 'warn').mockImplementation(() => undefined);
      const error = jest.spyOn(policy['logger'], 'error').mockImplementation(() => undefined);

      await policy.reconnect(async () => {
        throw new Error('down');
      });

      expect(error).toHaveBeenCalledWith(expect.stringMatching(/will NOT be liquidated/));
    });
  });

  describe('IB Gateway scheduled re-authentication', () => {
    it('is handled as a routine event, not an exception', async () => {
      // `stories.md:596`. The daily re-auth must not read as a fault — an
      // operator who learns to ignore a daily critical alert will ignore the
      // real one.
      const { sleep } = recordingSleeper();
      const policy = silence(new ReconnectPolicy({ baseDelayMs: 1 }, sleep));

      const result = await policy.reconnectAfterReauth(async () => undefined);

      expect(result.outcome).toBe(ReconnectOutcome.RECONNECTED);
      expect(result.scheduled).toBe(true);
    });

    it('logs at info rather than error when it succeeds', async () => {
      const { sleep } = recordingSleeper();
      const policy = new ReconnectPolicy({ baseDelayMs: 1 }, sleep);
      const log = jest.spyOn(policy['logger'], 'log').mockImplementation(() => undefined);
      const error = jest.spyOn(policy['logger'], 'error').mockImplementation(() => undefined);

      await policy.reconnectAfterReauth(async () => undefined);

      expect(log).toHaveBeenCalledWith(expect.stringMatching(/routine daily event/));
      expect(error).not.toHaveBeenCalled();
    });

    it('still fails safe when the re-auth never comes back', async () => {
      // Starting routinely does not make an outage routine.
      const { sleep } = recordingSleeper();
      const policy = silence(new ReconnectPolicy({ baseDelayMs: 1, maxAttempts: 3 }, sleep));

      const result = await policy.reconnectAfterReauth(async () => {
        throw new Error('login failed');
      });

      expect(result.outcome).toBe(ReconnectOutcome.EXHAUSTED);
      expect(result.scheduled).toBe(true);
    });

    it('marks an ordinary drop as unscheduled', async () => {
      const { sleep } = recordingSleeper();
      const policy = silence(new ReconnectPolicy({ baseDelayMs: 1 }, sleep));

      expect((await policy.reconnect(async () => undefined)).scheduled).toBe(false);
    });
  });

  it('defaults to a bounded budget', () => {
    expect(DEFAULT_RECONNECT_CONFIG.maxAttempts).toBeGreaterThan(0);
    expect(DEFAULT_RECONNECT_CONFIG.maxAttempts).toBeLessThan(20);
    expect(DEFAULT_RECONNECT_CONFIG.maxDelayMs).toBeGreaterThan(
      DEFAULT_RECONNECT_CONFIG.baseDelayMs,
    );
  });
});

describe('isStale', () => {
  it('is false before any bar has arrived', () => {
    // Startup, not staleness. Counting from process start would halt every
    // boot that happened outside market hours.
    expect(isStale(null, 10_000_000, 1000)).toBe(false);
  });

  it('is false within the threshold', () => {
    expect(isStale(1000, 1000 + 999, 1000)).toBe(false);
  });

  it('is false exactly at the threshold', () => {
    // Strictly greater-than: a bar arriving precisely on the boundary is on
    // time, and halting on it would trip on ordinary jitter.
    expect(isStale(1000, 2000, 1000)).toBe(false);
  });

  it('is true past the threshold', () => {
    expect(isStale(1000, 2001, 1000)).toBe(true);
  });

  it('defaults to three missed 5-minute bars', () => {
    // One missed bar is normal on a thin symbol; three in a session means the
    // feed is gone rather than the market being quiet.
    expect(DEFAULT_STALE_THRESHOLD_MS).toBe(15 * 60 * 1000);
  });

  describe('when data was expected but none has arrived', () => {
    it('is false within the threshold of first expecting data', () => {
      // A subscription that opened moments ago has not missed anything yet.
      expect(isStale(null, 1000 + 999, 1000, 1000)).toBe(false);
    });

    it('is true once nothing has arrived past the threshold', () => {
      // The regression this exists for: a socket that reconnected but never
      // resumed its feed. `lastBarAtMs` is null because the reconnect cleared
      // it, so without a reference point this reads as startup forever while
      // the ladder evaluates against a price that stopped updating.
      expect(isStale(null, 2001, 1000, 1000)).toBe(true);
    });

    it('is false with no reference point, however long it has been', () => {
      // Genuine startup is still not staleness — the caller has not begun
      // expecting data, so silence carries no information.
      expect(isStale(null, 10_000_000, 1000, null)).toBe(false);
    });

    it('prefers an arrived bar over the expectation point', () => {
      // Once a bar exists it is the better evidence: the feed demonstrably
      // works, so staleness is measured from delivery, not from subscription.
      expect(isStale(2000, 2500, 1000, 1)).toBe(false);
    });
  });
});
