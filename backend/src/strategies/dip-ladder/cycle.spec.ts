import { DateTime } from 'luxon';
import { Bar, BarSize } from '../../market-data/types';
import { buildDipLadderConfig } from './config';
import { LotStatus } from './lot';
import { replayLadder } from './replay-ladder';
import { RungStatus } from './rung';

/**
 * The ladder-cycling suite on purpose-built series.
 *
 * The committed fixtures are strategy-agnostic by design, which makes them poor
 * instruments for pinning an exact cycle count or isolating one rung's
 * behaviour. These series are authored to put price exactly where a specific
 * rule can be observed, and every price is chosen against the hand-calculated
 * ladder:
 *
 *   anchor 100.00 → rungs 95.00, 90.25, 85.74
 *   targets (fill × 1.05): 95.00 → 99.75, 90.25 → 94.76, 85.74 → 90.03
 *
 * One consequence of the defaults shapes several suites below and is worth
 * stating up front: with spacing == target (both 5%), a rung's re-entry price
 * always sits *above* the next lower lot's target — the 95.00 rung re-fires at
 * 95.00 while the 90.25 lot targets 94.76. So at the defaults an upper rung
 * cannot cycle while the lot beneath it still holds; both cycle, each strictly
 * at its own level. Isolating the holding rule needs a target wider than the
 * spacing, which the 10%-target suite uses.
 */

const config = buildDipLadderConfig('TQQQ', { symbolCapital: 10_000 });

/**
 * Builds a 5-minute bar series from closes, starting at 09:45 ET (the first
 * bar eligible to fire) and advancing 5 minutes per close, rolling to the next
 * session's 09:45 after 15:55.
 */
function series(closes: number[], startDate = '2025-01-02'): Bar[] {
  let cursor = DateTime.fromISO(`${startDate}T09:45:00`, { zone: 'America/New_York' });

  return closes.map((close) => {
    const bar: Bar = {
      symbol: 'TQQQ',
      barSize: BarSize.FIVE_MIN,
      timestamp: cursor.toISO({ suppressMilliseconds: false })!,
      open: close,
      high: close,
      low: close,
      close,
      volume: 1_000_000,
    };

    cursor = cursor.plus({ minutes: 5 });

    // Roll to the next weekday's 09:45 once past the close.
    if (cursor.hour >= 16) {
      cursor = cursor.plus({ days: cursor.weekday >= 5 ? 8 - cursor.weekday : 1 }).set({
        hour: 9,
        minute: 45,
      });
    }

    return bar;
  });
}

/** Opens the ladder at 100.00 so the bootstrap anchor is unambiguous. */
const OPEN_AT_100 = [100];

describe('ladder cycling', () => {
  describe('a single rung fires, exits, re-arms, and fires again', () => {
    // 95.00 fires → 99.75 target reached → re-arms → fires again, three times.
    const result = replayLadder(series([...OPEN_AT_100, 95, 99.75, 95, 99.75, 95, 99.75]), config);

    it('completes 3 cycles on the 95.00 rung', () => {
      expect(result.completedCycles).toHaveLength(3);
      expect(result.completedCycles.every((c) => c.rungPrice === 95)).toBe(true);
    });

    it('re-arms at the original price, not the exit price', () => {
      const rung = result.rungs.find((r) => r.price === 95)!;

      expect(rung.price).toBe(95);
      expect(rung.completedCycles).toBe(3);
      // 99.75 was the exit; the rung must not have moved there.
      expect(result.rungs.some((r) => r.price === 99.75)).toBe(false);
    });

    it('opens a distinct lot each cycle, all at the same rung', () => {
      const lots = result.lots.filter((l) => l.rungPrice === 95);

      expect(lots).toHaveLength(3);
      expect(new Set(lots.map((l) => l.id)).size).toBe(3);
      expect(lots.every((l) => l.fillPrice === 95 && l.exitTarget === 99.75)).toBe(true);
    });

    it('realizes the same P&L on each identical cycle', () => {
      const [first, ...rest] = result.completedCycles;

      expect(rest.every((c) => c.realized === first.realized)).toBe(true);
      expect(first.realized).toBeCloseTo(4.75 * first.quantity, 2);
    });
  });

  /**
   * A consequence of the default parameters worth recording, because it looks
   * like a missing feature and is not.
   *
   * With spacing == target (both 5%), a rung's re-entry price always sits
   * *above* the next lower lot's target: the 95.00 rung re-fires at 95.00 while
   * the 90.25 lot targets 94.76. So any move that re-fires the upper rung has
   * already taken the lower lot past its own target. "Upper rung cycles while
   * the lower lot holds" is therefore unreachable at the defaults — as
   * `chop-range` shows, both rungs cycle, each strictly at its own level.
   *
   * That is still per-lot behaviour and still not a blended exit. Isolating the
   * holding case simply requires a target wider than the spacing, which the
   * next suite uses.
   */
  describe('at default parameters both rungs cycle independently', () => {
    const result = replayLadder(series([...OPEN_AT_100, 95, 90.25, 99.8]), config);

    it('fires both rungs on the way down', () => {
      expect(result.entries.map((e) => e.limitPrice)).toEqual([95, 90.25]);
    });

    it('exits the higher rung first, leaving lower lots running', () => {
      // `PRD.md:131` — "Lower lots keep running when higher lots exit."
      expect(result.exits[0].rungPrice).toBe(95);
    });

    it('exits each lot at its own target', () => {
      for (const cycle of result.completedCycles) {
        expect(cycle.exitPrice).toBeCloseTo(cycle.fillPrice * 1.05, 2);
      }
    });
  });

  /**
   * The isolated version, with a take-profit wider than the rung spacing so the
   * window actually exists: 10% target, 5% spacing.
   *
   *   rung 95.00 → target 104.50
   *   rung 90.25 → target  99.28
   *
   * Price oscillating between 94.90 and 99.00 stays under the 90.25 lot's
   * 99.28 target on every swing, and under the 95.00 lot's 104.50 target too.
   * What this proves is the *holding* rule: a lot below its target is never
   * sold, no matter how many bars pass or how price moves around it.
   */
  describe('a lot below its target is never sold', () => {
    const wideTarget = buildDipLadderConfig('TQQQ', {
      symbolCapital: 10_000,
      takeProfitPercent: 0.1,
    });

    const result = replayLadder(
      series([...OPEN_AT_100, 95, 90.25, 94.9, 99, 94.9, 99, 94.9, 99]),
      wideTarget,
    );

    it('never exits either lot — both stay below their targets', () => {
      expect(result.exits).toHaveLength(0);
      expect(result.completedCycles).toHaveLength(0);
    });

    it('holds both lots to the end', () => {
      expect(result.position.heldLots.map((l) => l.rungPrice).sort((a, b) => b - a)).toEqual([
        95, 90.25,
      ]);
      expect(result.lots.every((l) => l.status === LotStatus.HELD)).toBe(true);
    });

    it('computes each target from its own fill, not the blend', () => {
      const upper = result.lots.find((l) => l.rungPrice === 95)!;
      const lower = result.lots.find((l) => l.rungPrice === 90.25)!;

      expect(upper.exitTarget).toBe(104.5);
      expect(lower.exitTarget).toBe(99.28);
      // The blend of 95.00 and 90.25 would sit between them; neither target is
      // anywhere near a blended level.
      expect(upper.exitTarget).not.toBe(lower.exitTarget);
    });

    it('books no loss on any lot', () => {
      for (const lot of result.lots) {
        if (lot.status === LotStatus.CLOSED) {
          expect(lot.exitPrice!).toBeGreaterThan(lot.fillPrice);
        }
      }
    });
  });

  describe('a rung holding a lot cannot fire again', () => {
    // Price sits at and below 95.00 for several bars without ever recovering to
    // the target, so the rung stays held throughout.
    const result = replayLadder(series([...OPEN_AT_100, 95, 94.5, 94.2, 95, 94.8]), config);

    it('opens exactly one lot at the 95.00 rung', () => {
      expect(result.lots.filter((l) => l.rungPrice === 95)).toHaveLength(1);
    });

    it('leaves that rung HELD for the whole series', () => {
      const rung = result.rungs.find((r) => r.price === 95)!;

      expect(rung.status).toBe(RungStatus.HELD);
      expect(rung.completedCycles).toBe(0);
    });
  });

  describe('re-armed empty rungs do not count against the concurrent limit', () => {
    /**
     * Five rungs fire and the shallowest exits, leaving 4 held and one re-armed.
     * The ladder must then be able to add a sixth level — proof the limit
     * counts held lots, not ledger entries.
     */
    const result = replayLadder(
      series([
        ...OPEN_AT_100,
        95,
        90.25,
        85.74,
        81.45,
        77.38, // 5 held — the limit
        99.75, // the 95.00 lot exits; that rung re-arms empty
      ]),
      config,
    );

    it('holds 4 lots after the exit but keeps 5 rungs in the ledger', () => {
      expect(result.position.heldLots).toHaveLength(4);
      expect(result.rungs).toHaveLength(5);
    });

    it('marks the exited rung RE_ARMED, not removed', () => {
      const rung = result.rungs.find((r) => r.price === 95)!;

      expect(rung.status).toBe(RungStatus.RE_ARMED);
      expect(rung.lotId).toBeNull();
    });
  });

  describe('same-bar re-fire is not permitted', () => {
    // A single bar closing at 99.75 exits the 95.00 lot. The rung re-arms on
    // that bar but must not re-fire until a later one.
    const result = replayLadder(series([...OPEN_AT_100, 95, 99.75]), config);

    it('does not open a replacement lot on the exit bar', () => {
      const exitBar = result.completedCycles[0].closedAt;

      expect(result.entries.some((e) => e.timestamp === exitBar)).toBe(false);
    });

    it('records the exit timestamp on the rung as the re-fire guard', () => {
      const rung = result.rungs.find((r) => r.price === 95)!;

      expect(rung.lastExitAt).toBe(result.completedCycles[0].closedAt);
    });
  });

  describe('FIFO disposal across cycles', () => {
    /**
     * Two lots end up at the same rung across cycles, and the oldest is sold
     * first. Built by letting the 95.00 rung fire, exit, and fire again — the
     * second lot is strictly newer, so any disposal must take the first.
     */
    const result = replayLadder(series([...OPEN_AT_100, 95, 99.75, 95, 99.75]), config);

    it('disposes lots in the order they were opened', () => {
      const [first, second] = result.completedCycles;

      expect(first.openedAt < second.openedAt).toBe(true);
      expect(first.closedAt < second.closedAt).toBe(true);
      expect(first.lotId).not.toBe(second.lotId);
    });
  });
});
