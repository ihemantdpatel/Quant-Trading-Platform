/**
 * `IBBrokerAdapter` — the fail-safe paths (`stories.md:610`).
 *
 * Every test here drives `FakeIbSocket`, so socket drops, forced re-auth, and a
 * feed that goes quiet all happen on cue. None of those is reliably reproducible
 * against a live Gateway, which is exactly why they would otherwise ship
 * untested and first execute with real money behind them.
 */

import { equityContract } from '../../domain/contract';
import { Bar, BarSize } from '../../market-data/types';
import { ConnectionState, OrderStatus } from '../broker-adapter.interface';
import { FakeIbSocket } from './fake-ib-socket';
import { IBBrokerAdapter } from './ib-broker.adapter';
import { PacingQueue } from './pacing-queue';
import { ReconnectPolicy } from './reconnect';

const TQQQ = equityContract('TQQQ');

/** No real waiting: reconnect backoff and pacing are asserted, not slept through. */
const instantSleep = async (): Promise<void> => undefined;

function bar(timestamp: string, close: number): Bar {
  return {
    symbol: 'TQQQ',
    barSize: BarSize.FIVE_MIN,
    timestamp,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000,
  };
}

/** An adapter whose retries and pacing waits resolve immediately. */
function buildAdapter(
  socket: FakeIbSocket,
  options: {
    maxAttempts?: number;
    staleThresholdMs?: number;
    now?: () => number;
    livenessProbeMs?: number;
  } = {},
): IBBrokerAdapter {
  return new IBBrokerAdapter(
    socket,
    {
      staleThresholdMs: options.staleThresholdMs ?? 15 * 60 * 1000,
      // Off by default: these tests call `checkLiveness()` directly rather than
      // waiting on a timer, so no suite depends on wall-clock timing.
      livenessProbeMs: options.livenessProbeMs ?? 0,
    },
    options.now ?? (() => 0),
    new PacingQueue({}, () => 0, instantSleep),
    new ReconnectPolicy({ maxAttempts: options.maxAttempts ?? 3 }, instantSleep),
  );
}

/** Lets queued reconnect microtasks settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('IBBrokerAdapter', () => {
  describe('connection lifecycle', () => {
    it('reports CONNECTED after a successful connect', async () => {
      const socket = new FakeIbSocket();
      const adapter = buildAdapter(socket);

      await adapter.connect();

      expect(adapter.isConnected()).toBe(true);
      expect(adapter.connectionHealth().state).toBe(ConnectionState.CONNECTED);
    });

    it('reports DISCONNECTED with a reason when the initial connect fails', async () => {
      const socket = new FakeIbSocket();
      socket.failConnectUntil(99, 'gateway not running');
      const adapter = buildAdapter(socket);

      await expect(adapter.connect()).rejects.toThrow('gateway not running');

      // Not FAILED: no retry budget has been spent, so this is not the
      // exhausted state that halts entries.
      expect(adapter.connectionHealth().state).toBe(ConnectionState.DISCONNECTED);
      expect(adapter.connectionHealth().lastError).toBe('gateway not running');
    });
  });

  describe('socket drop → exponential backoff → reconnect (stories.md:616)', () => {
    it('reconnects after a transient drop and returns to CONNECTED', async () => {
      const socket = new FakeIbSocket();
      const adapter = buildAdapter(socket);
      await adapter.connect();

      // `failConnectUntil` counts *all* connect calls, and the initial connect
      // above was already call 1 — so failing until call 3 makes the first two
      // reconnect attempts fail and the third succeed.
      socket.failConnectUntil(3);
      socket.simulateSocketDrop();
      await settle();

      expect(adapter.connectionHealth().state).toBe(ConnectionState.CONNECTED);
      expect(adapter.connectionHealth().reconnectAttempts).toBe(2);
    });

    it('runs one reconnect loop when a flapping socket emits repeated drops', async () => {
      const socket = new FakeIbSocket();
      const adapter = buildAdapter(socket);
      await adapter.connect();

      const before = socket.connectCallCount();

      socket.simulateSocketDrop();
      socket.simulateSocketDrop();
      socket.simulateSocketDrop();
      await settle();

      // One reconnect, not three: a second loop would burn the retry budget at
      // triple rate and could declare FAILED on a socket that recovered.
      expect(socket.connectCallCount()).toBe(before + 1);
    });
  });

  describe('retries exhausted → halt entries, positions untouched (stories.md:617)', () => {
    it('lands in FAILED and never emits a liquidating action', async () => {
      const socket = new FakeIbSocket();
      socket.seedPositions([{ symbol: 'TQQQ', quantity: 300, averageCost: 40 }]);
      const adapter = buildAdapter(socket, { maxAttempts: 3 });
      await adapter.connect();

      socket.failConnectUntil(99, 'gateway down');
      socket.simulateSocketDrop();
      await settle();

      expect(adapter.connectionHealth().state).toBe(ConnectionState.FAILED);
      expect(adapter.isConnected()).toBe(false);

      // **The whole point.** A technical fault must never become a realized
      // loss (`PRD.md:317`): nothing was sold, and submission now throws rather
      // than quietly succeeding against a dead socket.
      expect(socket.placedOrders).toHaveLength(0);
      await expect(
        adapter.submit({
          clientOrderId: 'co-1',
          contract: TQQQ,
          side: 'SELL',
          quantity: 300,
          orderType: 'LMT',
          limitPrice: 40,
          timeInForce: 'DAY',
          timestamp: '2025-01-02T10:00:00.000-05:00',
        }),
      ).rejects.toThrow('IB not connected');
      expect(socket.placedOrders).toHaveLength(0);
    });

    it('notifies connection subscribers so the engine can halt', async () => {
      const socket = new FakeIbSocket();
      const adapter = buildAdapter(socket, { maxAttempts: 2 });
      await adapter.connect();

      const states: ConnectionState[] = [];
      adapter.onConnectionChange((health) => states.push(health.state));

      socket.failConnectUntil(99);
      socket.simulateSocketDrop();
      await settle();

      expect(states).toContain(ConnectionState.FAILED);
    });
  });

  describe('a connection lost without any IB error code', () => {
    /*
      Observed against a live Gateway: the socket disappeared, IB reported
      nothing on either channel, and so no disconnect event existed to route.
      The adapter's health stayed CONNECTED, every API call timed out for
      hours, and `reconnectAttempts` still read 0 because `ReconnectPolicy` is
      driven by events that never arrived.

      `simulateSilentDrop` reproduces exactly that — it does not emit an event.
    */

    it('detects the loss and reconnects, though IB reported nothing', async () => {
      const socket = new FakeIbSocket();
      const adapter = buildAdapter(socket);
      await adapter.connect();

      socket.simulateSilentDrop();

      // Before the probe runs, health must not claim CONNECTED beside a socket
      // that is gone — `GET /status` would otherwise show `state: CONNECTED`
      // next to `connected: false`, and an operator reading the state field
      // alone would conclude the broker was fine.
      expect(adapter.connectionHealth().state).toBe(ConnectionState.CONNECTING);
      expect(adapter.isConnected()).toBe(false);

      adapter.checkLiveness();
      await settle();

      expect(adapter.connectionHealth().state).toBe(ConnectionState.CONNECTED);
      expect(adapter.isConnected()).toBe(true);
      // Reconnected rather than merely re-labelled.
      expect(socket.connectCallCount()).toBe(2);
    });

    it('lands in FAILED when the silent loss cannot be recovered', async () => {
      const socket = new FakeIbSocket();
      socket.seedPositions([{ symbol: 'TQQQ', quantity: 300, averageCost: 40 }]);
      const adapter = buildAdapter(socket, { maxAttempts: 3 });
      await adapter.connect();

      socket.failConnectUntil(99, 'gateway down');
      socket.simulateSilentDrop();
      adapter.checkLiveness();
      await settle();

      expect(adapter.connectionHealth().state).toBe(ConnectionState.FAILED);

      // The rule that governs this file: a technical fault never becomes a
      // realized loss. A silent drop reaches the same halt as a reported one,
      // and sells nothing on the way (`PRD.md:316`).
      expect(socket.placedOrders).toHaveLength(0);
    });

    it('notifies connection subscribers so the engine halts new entries', async () => {
      const socket = new FakeIbSocket();
      const adapter = buildAdapter(socket, { maxAttempts: 2 });
      await adapter.connect();

      const states: ConnectionState[] = [];
      adapter.onConnectionChange((health) => states.push(health.state));

      socket.failConnectUntil(99);
      socket.simulateSilentDrop();
      adapter.checkLiveness();
      await settle();

      expect(states).toContain(ConnectionState.FAILED);
    });

    it('never reports CONNECTED while the socket says otherwise', async () => {
      const socket = new FakeIbSocket();
      const adapter = buildAdapter(socket);
      await adapter.connect();

      expect(adapter.connectionHealth().state).toBe(ConnectionState.CONNECTED);

      socket.simulateSilentDrop();

      // The two fields on `GET /status` are derived from these; they must not
      // contradict each other in the window before the probe fires.
      const health = adapter.connectionHealth();
      expect(health.state).not.toBe(ConnectionState.CONNECTED);
      expect(health.connectedAt).toBeNull();
      expect(adapter.isConnected()).toBe(false);
    });

    it('does nothing while the socket is healthy', async () => {
      const socket = new FakeIbSocket();
      const adapter = buildAdapter(socket);
      await adapter.connect();

      adapter.checkLiveness();
      await settle();

      // No spurious reconnect: a probe that fires on a live socket would
      // reset the pacing window and the staleness clock for no reason.
      expect(socket.connectCallCount()).toBe(1);
      expect(adapter.connectionHealth().state).toBe(ConnectionState.CONNECTED);
    });

    it('does not spend a second retry budget once the loss is already known', async () => {
      const socket = new FakeIbSocket();
      const adapter = buildAdapter(socket, { maxAttempts: 2 });
      await adapter.connect();

      socket.failConnectUntil(99);
      socket.simulateSilentDrop();
      adapter.checkLiveness();
      await settle();
      expect(adapter.connectionHealth().state).toBe(ConnectionState.FAILED);

      const attemptsAfterFirst = socket.connectCallCount();
      adapter.checkLiveness();
      await settle();

      // FAILED is terminal until someone reconnects deliberately; re-probing
      // it would retry forever on a Gateway that is genuinely gone.
      expect(socket.connectCallCount()).toBe(attemptsAfterFirst);
    });

    it('ignores a reported drop already being handled', async () => {
      const socket = new FakeIbSocket();
      const adapter = buildAdapter(socket);
      await adapter.connect();

      // A normal drop puts the adapter in CONNECTING while it retries; a probe
      // landing mid-reconnect must not start a competing loop.
      socket.failConnectUntil(3);
      socket.simulateSocketDrop();
      adapter.checkLiveness();
      await settle();

      expect(adapter.connectionHealth().state).toBe(ConnectionState.CONNECTED);
    });

    it('fires on its own timer, without anyone calling checkLiveness', async () => {
      // The other cases drive `checkLiveness()` directly, which leaves the
      // timer wiring — the thing that actually makes this work in production —
      // unexercised. Fake timers assert it without sleeping.
      jest.useFakeTimers();

      try {
        const socket = new FakeIbSocket();
        const adapter = buildAdapter(socket, { livenessProbeMs: 15_000 });
        await adapter.connect();

        socket.simulateSilentDrop();
        jest.advanceTimersByTime(15_000);
        // Let the reconnect promise chain settle under fake timers.
        await Promise.resolve();
        await Promise.resolve();

        expect(socket.connectCallCount()).toBe(2);

        await adapter.disconnect();
      } finally {
        jest.useRealTimers();
      }
    });

    it('stops probing once disconnected, so nothing reconnects behind an operator', async () => {
      jest.useFakeTimers();

      try {
        const socket = new FakeIbSocket();
        const adapter = buildAdapter(socket, { livenessProbeMs: 15_000 });
        await adapter.connect();
        await adapter.disconnect();

        const attempts = socket.connectCallCount();
        jest.advanceTimersByTime(60_000);
        await Promise.resolve();

        // A deliberate local disconnect must stay disconnected.
        expect(socket.connectCallCount()).toBe(attempts);
      } finally {
        jest.useRealTimers();
      }
    });

    it('keeps watching after a reconnect, since the new session can vanish too', async () => {
      const socket = new FakeIbSocket();
      const adapter = buildAdapter(socket);
      await adapter.connect();

      socket.simulateSilentDrop();
      adapter.checkLiveness();
      await settle();
      expect(socket.connectCallCount()).toBe(2);

      // Second silent loss on the restored session.
      socket.simulateSilentDrop();
      adapter.checkLiveness();
      await settle();

      expect(socket.connectCallCount()).toBe(3);
      expect(adapter.isConnected()).toBe(true);
    });
  });

  describe('forced re-authentication is routine (stories.md:615)', () => {
    it('reconnects and resumes streaming without entering FAILED', async () => {
      const socket = new FakeIbSocket();
      const adapter = buildAdapter(socket);
      await adapter.connect();

      const received: Bar[] = [];
      adapter.subscribeBars(TQQQ, BarSize.FIVE_MIN, (b) => received.push(b));

      socket.simulateScheduledReauth();
      await settle();

      expect(adapter.connectionHealth().state).toBe(ConnectionState.CONNECTED);

      // Streaming resumes — the subscription survives the re-auth.
      socket.emitBar(bar('2025-01-02T10:00:00.000-05:00', 42));
      expect(received).toHaveLength(1);
    });

    it('clears the pacing window on reconnect, since IB counts per session', async () => {
      const socket = new FakeIbSocket();
      const adapter = buildAdapter(socket);
      await adapter.connect();
      socket.seedBars('TQQQ', BarSize.DAILY, []);

      await adapter.getHistoricalBars({
        contract: TQQQ,
        barSize: BarSize.DAILY,
        from: '2025-01-02T00:00:00.000-05:00',
        to: '2025-01-03T00:00:00.000-05:00',
      });
      expect(adapter.pacingStats().inWindow).toBe(1);

      socket.simulateScheduledReauth();
      await settle();

      expect(adapter.pacingStats().inWindow).toBe(0);
    });
  });

  describe('stale data is its own fail-safe trigger (stories.md:618)', () => {
    it('is not stale before any bar has arrived', () => {
      const adapter = buildAdapter(new FakeIbSocket(), { now: () => 10_000_000 });

      // Startup, not staleness — no bar was expected yet.
      expect(adapter.isDataStale()).toBe(false);
    });

    it('becomes stale once the feed goes quiet past the threshold', async () => {
      const socket = new FakeIbSocket();
      let clock = 0;
      const adapter = buildAdapter(socket, { staleThresholdMs: 1_000, now: () => clock });
      await adapter.connect();

      adapter.subscribeBars(TQQQ, BarSize.FIVE_MIN, () => undefined);
      socket.emitBar(bar('2025-01-02T10:00:00.000-05:00', 42));

      clock = 500;
      expect(adapter.isDataStale()).toBe(false);

      clock = 1_500;
      expect(adapter.isDataStale()).toBe(true);
    });

    it('measures staleness from arrival, so a reconnect does not trip it immediately', async () => {
      const socket = new FakeIbSocket();
      let clock = 0;
      const adapter = buildAdapter(socket, { staleThresholdMs: 1_000, now: () => clock });
      await adapter.connect();

      adapter.subscribeBars(TQQQ, BarSize.FIVE_MIN, () => undefined);
      socket.emitBar(bar('2025-01-02T10:00:00.000-05:00', 42));

      clock = 5_000;
      expect(adapter.isDataStale()).toBe(true);

      socket.simulateSocketDrop();
      await settle();

      // A reconnected session has delivered no bar yet. Keeping the old
      // timestamp would report a healthy new connection as stale.
      expect(adapter.isDataStale()).toBe(false);
    });

    it('goes stale when a reconnect restores the socket but not the feed', async () => {
      const socket = new FakeIbSocket();
      let clock = 0;
      const adapter = buildAdapter(socket, { staleThresholdMs: 1_000, now: () => clock });
      await adapter.connect();

      adapter.subscribeBars(TQQQ, BarSize.FIVE_MIN, () => undefined);
      socket.emitBar(bar('2025-01-02T10:00:00.000-05:00', 42));

      socket.simulateSocketDrop();
      await settle();

      // The reconnect cleared the last-bar timestamp, which is correct. What
      // must not follow is silence being excused forever: this connection is
      // up and delivering nothing, which is the dangerous case precisely
      // because every status reader still says CONNECTED.
      const reconnectedAt = clock;
      clock = reconnectedAt + 500;
      expect(adapter.isDataStale()).toBe(false);

      clock = reconnectedAt + 1_500;
      expect(adapter.isDataStale()).toBe(true);
    });

    it('goes stale on a flapping socket that never delivered a bar', async () => {
      const socket = new FakeIbSocket();
      let clock = 0;
      const adapter = buildAdapter(socket, { staleThresholdMs: 1_000, now: () => clock });
      await adapter.connect();

      // Subscribed from t=0 and never delivering. Observed against a live
      // Gateway with no market-data entitlement: the socket dropped and
      // recovered every ~13 minutes against a 15-minute threshold, and because
      // each reconnect restarted the expectation clock the halt never fired.
      adapter.subscribeBars(TQQQ, BarSize.FIVE_MIN, () => undefined);

      for (const at of [800, 1_600, 2_400]) {
        clock = at;
        socket.simulateSocketDrop();
        await settle();
      }

      // Past the threshold measured from the *original* subscription. A feed
      // that has never produced a bar must not have its deadline renewed by a
      // reconnect, or silence is excused for as long as the socket keeps
      // flapping — which is exactly when an operator needs to be told.
      clock = 3_000;
      expect(adapter.isDataStale()).toBe(true);
    });

    it('still forgives the first moments of a reconnect that had been delivering', async () => {
      const socket = new FakeIbSocket();
      let clock = 0;
      const adapter = buildAdapter(socket, { staleThresholdMs: 1_000, now: () => clock });
      await adapter.connect();

      adapter.subscribeBars(TQQQ, BarSize.FIVE_MIN, () => undefined);
      socket.emitBar(bar('2025-01-02T10:00:00.000-05:00', 42));

      // The complement of the test above, and the reason the reset cannot
      // simply be deleted: a feed that *was* healthy gets its grace period.
      clock = 5_000;
      socket.simulateSocketDrop();
      await settle();

      clock = 5_500;
      expect(adapter.isDataStale()).toBe(false);
    });

    it('clears the expectation once a bar finally arrives', async () => {
      const socket = new FakeIbSocket();
      let clock = 0;
      const adapter = buildAdapter(socket, { staleThresholdMs: 1_000, now: () => clock });
      await adapter.connect();

      adapter.subscribeBars(TQQQ, BarSize.FIVE_MIN, () => undefined);

      clock = 1_500;
      expect(adapter.isDataStale()).toBe(true);

      // A late-arriving first bar is recovery, not a permanent halt — the
      // watchdog has to be able to un-trip or it would need a restart to clear.
      clock = 1_600;
      socket.emitBar(bar('2025-01-02T10:00:00.000-05:00', 42));
      expect(adapter.isDataStale()).toBe(false);
    });
  });

  describe('market-data errors are reported, not only logged', () => {
    it('surfaces a rejected subscription with its IB code', async () => {
      const socket = new FakeIbSocket();
      const adapter = buildAdapter(socket);
      await adapter.connect();
      adapter.subscribeBars(TQQQ, BarSize.FIVE_MIN, () => undefined);

      expect(adapter.dataErrorList()).toEqual([]);

      socket.simulateDataError('TQQQ', 354, 'requested market data is not subscribed');

      // The code is what tells an operator this is an entitlement problem
      // rather than a transport one, so it must survive to `/status`.
      expect(adapter.dataErrorList()).toEqual([
        expect.objectContaining({
          symbol: 'TQQQ',
          code: 354,
          message: 'requested market data is not subscribed',
        }),
      ]);
    });

    it('keeps only the newest error per symbol', async () => {
      const socket = new FakeIbSocket();
      const adapter = buildAdapter(socket);
      await adapter.connect();
      adapter.subscribeBars(TQQQ, BarSize.FIVE_MIN, () => undefined);

      // IB repeats the rejection on every re-subscription attempt, so an
      // appended list would grow for as long as the fault lasts.
      socket.simulateDataError('TQQQ', 354, 'first');
      socket.simulateDataError('TQQQ', 354, 'second');
      socket.simulateDataError('TQQQ', 354, 'third');

      expect(adapter.dataErrorList()).toHaveLength(1);
      expect(adapter.dataErrorList()[0].message).toBe('third');
    });

    it('clears a symbol error once its bars resume', async () => {
      const socket = new FakeIbSocket();
      const adapter = buildAdapter(socket);
      await adapter.connect();
      adapter.subscribeBars(TQQQ, BarSize.FIVE_MIN, () => undefined);

      socket.simulateDataError('TQQQ', 354, 'not subscribed');
      expect(adapter.dataErrorList()).toHaveLength(1);

      // A bar is proof the subscription recovered. Leaving the error would
      // describe a feed that is now working as broken.
      socket.emitBar(bar('2025-01-02T10:00:00.000-05:00', 42));
      expect(adapter.dataErrorList()).toEqual([]);
    });

    it('does not halt entries — reporting only', async () => {
      const socket = new FakeIbSocket();
      const adapter = buildAdapter(socket);
      await adapter.connect();
      adapter.subscribeBars(TQQQ, BarSize.FIVE_MIN, () => undefined);

      socket.simulateDataError('TQQQ', 2104, 'market data farm connection is OK');

      // IB uses this channel for benign notices too. The staleness watchdog is
      // what acts, on the evidence that matters — bars stopped arriving.
      expect(adapter.isConnected()).toBe(true);
      expect(adapter.connectionHealth().state).toBe(ConnectionState.CONNECTED);
    });
  });

  describe('historical requests are always paced', () => {
    it('routes every request through the pacing queue', async () => {
      const socket = new FakeIbSocket();
      const adapter = buildAdapter(socket);
      await adapter.connect();
      socket.seedBars('TQQQ', BarSize.DAILY, [bar('2025-01-02T00:00:00.000-05:00', 40)]);

      expect(adapter.pacingStats().totalDispatched).toBe(0);

      await adapter.getHistoricalBars({
        contract: TQQQ,
        barSize: BarSize.DAILY,
        from: '2025-01-01T00:00:00.000-05:00',
        to: '2025-01-03T00:00:00.000-05:00',
      });

      expect(adapter.pacingStats().totalDispatched).toBe(1);
    });

    it('requests RTH only for 5-minute bars, since the ladder cannot fire outside it', async () => {
      const socket = new FakeIbSocket();
      const adapter = buildAdapter(socket);
      await adapter.connect();
      socket.seedBars('TQQQ', BarSize.FIVE_MIN, []);

      await adapter.getHistoricalBars({
        contract: TQQQ,
        barSize: BarSize.FIVE_MIN,
        from: '2025-01-02T09:30:00.000-05:00',
        to: '2025-01-02T16:00:00.000-05:00',
      });

      expect(socket.historicalRequests[0].regularHoursOnly).toBe(true);
    });
  });

  describe('order path (built for Story 13, unreachable in SHADOW)', () => {
    it('passes the order to the socket unchanged when connected', async () => {
      const socket = new FakeIbSocket();
      const adapter = buildAdapter(socket);
      await adapter.connect();

      const ack = await adapter.submit({
        clientOrderId: 'co-7',
        contract: TQQQ,
        side: 'BUY',
        quantity: 25,
        orderType: 'LMT',
        limitPrice: 38.5,
        timeInForce: 'DAY',
        timestamp: '2025-01-02T10:00:00.000-05:00',
      });

      expect(ack.status).toBe(OrderStatus.SUBMITTED);
      expect(socket.placedOrders[0]).toMatchObject({
        clientOrderId: 'co-7',
        quantity: 25,
        limitPrice: 38.5,
      });
    });
  });

  describe('commission corrections', () => {
    it('forwards a late commission report keyed to its fill', async () => {
      const socket = new FakeIbSocket();
      const adapter = buildAdapter(socket);
      const seen: Array<{ fillId: string; commission: number }> = [];

      adapter.onCommission((report) => seen.push(report));
      socket.emitCommission({ fillId: 'exec-1', commission: 1.05 });

      expect(seen).toEqual([{ fillId: 'exec-1', commission: 1.05 }]);
    });
  });
});
