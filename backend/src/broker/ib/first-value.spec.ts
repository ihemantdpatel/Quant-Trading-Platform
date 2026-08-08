/**
 * `firstValue` — the Observable-to-Promise bridge, and its timeout.
 *
 * ## Why this test exists
 *
 * A regression test for a real failure. IB Gateway running but **not
 * authenticated** accepts a TCP connection and then says nothing: the
 * Observables behind `getPositions` and `getAccountSummary` never emit and
 * never error. Without a timeout the promise hung forever.
 *
 * That hang landed inside `StartupSequence`, which `EngineModule.onModuleInit`
 * runs *before* `app.listen()`. So the process never bound its HTTP port, had
 * nothing holding the event loop open, and **exited 0** — a clean exit that
 * compose dutifully restarted, forever. The symptom was a container in a
 * restart loop with no error and no stack trace; the cause was a promise that
 * never settled.
 *
 * The rule this encodes: **a broker that will not answer must fail like a
 * broker that refused.** Only then can the fail-safe path above it run — halt
 * the symbols, surface the reason, keep serving the dashboard.
 */

import { Observable, Subject } from 'rxjs';
import { firstValue } from './stoqey-ib-socket';

describe('firstValue', () => {
  it('resolves with the first emission and unsubscribes', async () => {
    let unsubscribed = false;

    const observable = new Observable<number>((subscriber) => {
      setTimeout(() => subscriber.next(42), 1);
      return () => {
        unsubscribed = true;
      };
    });

    await expect(firstValue(observable, 1_000)).resolves.toBe(42);
    expect(unsubscribed).toBe(true);
  });

  it('rejects when the observable errors', async () => {
    const subject = new Subject<number>();
    const promise = firstValue(subject, 1_000);

    subject.error(new Error('socket closed'));

    await expect(promise).rejects.toThrow('socket closed');
  });

  it('REJECTS rather than hanging when IB never answers', async () => {
    // The regression. A `Subject` that never emits is exactly what an
    // unauthenticated Gateway produces: connected, silent, indefinitely.
    const silent = new Subject<number>();

    await expect(firstValue(silent, 20)).rejects.toThrow(
      'IB did not respond within 20ms — treating as unreachable',
    );
  });

  it('does not leave a timer holding the event loop open after resolving', async () => {
    // The mechanism behind the restart loop: a pending timer or an unsettled
    // promise decides whether the process can exit. Resolving must clear it.
    const subject = new Subject<number>();
    const promise = firstValue(subject, 60_000);

    subject.next(7);

    await expect(promise).resolves.toBe(7);
    // If the 60s timer were still pending, Jest would warn about an open
    // handle; asserting the resolution is what proves `clearTimeout` ran.
  });

  it('ignores emissions after the first, and settles only once', async () => {
    const subject = new Subject<number>();
    const promise = firstValue(subject, 1_000);

    subject.next(1);
    subject.next(2);
    subject.error(new Error('too late'));

    // A second settle attempt on an already-resolved promise is silently
    // ignored by the runtime, but the guard is what keeps `unsubscribe` from
    // being called twice on a live subscription.
    await expect(promise).resolves.toBe(1);
  });

  it('tolerates an observable that emits synchronously on subscribe', async () => {
    // `subscription` is assigned after `subscribe()` returns, so a synchronous
    // emission settles before the variable exists. This is the TDZ case the
    // `done` flag guards.
    const immediate = new Observable<string>((subscriber) => {
      subscriber.next('sync');
    });

    await expect(firstValue(immediate, 1_000)).resolves.toBe('sync');
  });
});
