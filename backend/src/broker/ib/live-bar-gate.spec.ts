/**
 * The regression for the PAPER incident: IB's bar subscription replayed a
 * historical window into a live ladder, firing five rungs in sixteen seconds
 * against stale prices while the engine could submit orders.
 *
 * `FakeIbSocket` never modelled the backfill burst, which is exactly why the
 * whole Story 10 suite passed while the real subscription did this. These cases
 * model it directly.
 */

import { Bar, BarSize } from '../../market-data/types';
import { BACKFILL_SETTLE_MS, LiveBarGate } from './live-bar-gate';

function bar(timestamp: string, close = 95): Bar {
  return {
    symbol: 'TQQQ',
    barSize: BarSize.FIVE_MIN,
    timestamp,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1000,
  };
}

/** A controllable clock, so no test waits on a real timer. */
function clock(start = 0) {
  let t = start;

  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('LiveBarGate', () => {
  it('suppresses an entire historical backfill burst', () => {
    const c = clock();
    const gate = new LiveBarGate({ now: c.now });

    // A burst: many bars, back to back, no meaningful gap. This is the shape
    // that walked the ladder down five rungs.
    const burst = [
      '2026-08-10T09:30:00.000-04:00',
      '2026-08-10T09:35:00.000-04:00',
      '2026-08-10T09:40:00.000-04:00',
      '2026-08-10T09:45:00.000-04:00',
      '2026-08-10T09:50:00.000-04:00',
    ];

    const forwarded = burst.filter((t) => {
      c.advance(5);
      return gate.accept(bar(t)) !== null;
    });

    expect(forwarded).toEqual([]);
    expect(gate.watermark()).toBe('2026-08-10T09:50:00.000-04:00');
  });

  it('forwards live bars once the window has settled', () => {
    const c = clock();
    const gate = new LiveBarGate({ now: c.now });

    c.advance(5);
    gate.accept(bar('2026-08-10T09:30:00.000-04:00'));
    c.advance(5);
    gate.accept(bar('2026-08-10T09:35:00.000-04:00'));

    // The quiet gap that separates backfill from live.
    c.advance(BACKFILL_SETTLE_MS);

    const live = gate.accept(bar('2026-08-10T09:40:00.000-04:00', 96));

    expect(live).not.toBeNull();
    expect(live?.timestamp).toBe('2026-08-10T09:40:00.000-04:00');
    expect(gate.isDraining()).toBe(false);
  });

  it('suppresses repeated emissions of the in-progress bar', () => {
    const c = clock();
    const gate = new LiveBarGate({ now: c.now });

    c.advance(BACKFILL_SETTLE_MS);
    expect(gate.accept(bar('2026-08-10T09:40:00.000-04:00', 95))).not.toBeNull();

    // IB re-emits the forming bar as its price moves. Same timestamp: not a new
    // closed bar, and forwarding it would evaluate the ladder repeatedly on one
    // five-minute period.
    c.advance(1_000);
    expect(gate.accept(bar('2026-08-10T09:40:00.000-04:00', 96))).toBeNull();
    c.advance(1_000);
    expect(gate.accept(bar('2026-08-10T09:40:00.000-04:00', 97))).toBeNull();

    // The next period closes and is forwarded.
    c.advance(1_000);
    expect(gate.accept(bar('2026-08-10T09:45:00.000-04:00', 97))).not.toBeNull();
  });

  it('never forwards a bar older than one already seen', () => {
    const c = clock();
    const gate = new LiveBarGate({ now: c.now });

    c.advance(BACKFILL_SETTLE_MS);
    gate.accept(bar('2026-08-10T09:45:00.000-04:00'));

    // Out-of-order delivery must not rewind the ladder onto a stale price.
    c.advance(100);
    expect(gate.accept(bar('2026-08-10T09:40:00.000-04:00'))).toBeNull();
    expect(gate.watermark()).toBe('2026-08-10T09:45:00.000-04:00');
  });

  it('forwards the first bar when the subscription returns no history', () => {
    const c = clock();
    const gate = new LiveBarGate({ now: c.now });

    // A symbol IB has no cached bars for, or a market long closed. Without the
    // clock starting at construction this would drain forever and drop every
    // live bar silently — a feed that looks connected and delivers nothing.
    c.advance(BACKFILL_SETTLE_MS);

    expect(gate.accept(bar('2026-08-10T09:40:00.000-04:00'))).not.toBeNull();
  });

  it('keeps draining while emissions keep arriving', () => {
    const c = clock();
    const gate = new LiveBarGate({ now: c.now });

    // A long backfill window: each emission restarts the settle clock, so the
    // window is not declared drained partway through and half-replayed.
    for (let i = 0; i < 50; i += 1) {
      c.advance(BACKFILL_SETTLE_MS - 1);
      const minute = String(i).padStart(2, '0');
      expect(gate.accept(bar(`2026-08-10T10:${minute}:00.000-04:00`))).toBeNull();
    }

    expect(gate.isDraining()).toBe(true);
  });
});
