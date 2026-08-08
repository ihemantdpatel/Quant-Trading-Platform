import { ReplayService } from '../../market-data/mock/replay.service';
import { isRegularSession } from '../../market-data/session';
import { buildDipLadderConfig } from './config';
import { LotStatus } from './lot';
import { replayLadder } from './replay-ladder';
import { isWithinFiringWindow } from './session-window';

/**
 * Scenario suites for Stories 3 and 4.
 *
 * Story 3's exit criterion: replaying each fixture produces entry intents at
 * prices matching hand-calculated rung values, and no intent is ever generated
 * outside 09:45–16:00 ET.
 *
 * Story 4's exit criterion is the chop suite below: ≥3 complete cycles on one
 * rung with correct realized P&L, while a lower lot remains held and untouched
 * across all of them.
 *
 * Rung arithmetic used throughout, at the default 5% spacing:
 *
 *   anchor 100.00 → 95.00 → 90.25 → 85.74 → 81.45 → 77.38
 *
 * Each figure is `roundToCents(previous × 0.95)`. A lot's exit target is its
 * own fill × 1.05, so the 95.00 rung targets 99.75 and the 90.25 rung 94.76.
 */

const replay = new ReplayService();
const config = buildDipLadderConfig('TQQQ', { symbolCapital: 10_000 });

const RUNGS_FROM_100 = [95, 90.25, 85.74, 81.45, 77.38];

const ALL_FIXTURES = [
  'gap-down-open',
  'gap-down-recover',
  'steady-decline',
  'chop-range',
  'session-edges',
];

describe('dip ladder scenarios', () => {
  describe('steady-decline — ladder extends fully then stops', () => {
    const result = replayLadder(replay.getBars('steady-decline'), config);

    it('fires exactly the five hand-calculated rungs', () => {
      expect(result.entries.map((i) => i.limitPrice)).toEqual(RUNGS_FROM_100);
    });

    it('stops at 5 concurrent rungs despite a 32% decline', () => {
      expect(result.position.heldLots).toHaveLength(5);
    });

    it('still holds every lot at the end — the limits block adding, not holding', () => {
      expect(result.position.heldLots.map((l) => l.rungPrice)).toEqual(RUNGS_FROM_100);
    });

    /**
     * A monotonic decline never lets any lot reach its +5% target, so nothing
     * exits. This is the "lots only ever exit in profit" rule observed on the
     * scenario built to stress it: price falls 32%, through the hard floor, and
     * not one lot is sold.
     */
    it('exits nothing — no lot reaches its target in a monotonic decline', () => {
      expect(result.exits).toHaveLength(0);
      expect(result.completedCycles).toHaveLength(0);
      expect(result.totalRealized).toBe(0);
    });

    it('blocks further entries once the ladder is full', () => {
      const invalidated = result.blocked.filter((b) => b.reason.kind === 'INVALIDATED');

      expect(invalidated.length).toBeGreaterThan(0);
      expect(invalidated[0].reason.detail).toContain('5 of 5');
    });

    it('sizes every rung at 25% of symbol capital', () => {
      for (const intent of result.entries) {
        const deployed = intent.quantity * intent.limitPrice;
        expect(deployed).toBeLessThanOrEqual(2_500);
        expect(deployed).toBeGreaterThan(2_500 - intent.limitPrice);
      }
    });
  });

  describe('gap-down-open — the gap does not fire the first rung', () => {
    const result = replayLadder(replay.getBars('gap-down-open'), config);

    it('places the first rung at 95.00, below the 96.00 gapped open', () => {
      expect(result.entries[0].limitPrice).toBe(95);
      expect(result.entries[0].limitPrice).toBeLessThan(96);
    });

    it('fires only after price trades down through the rung, not at the open', () => {
      const firstFire = result.entries[0].timestamp;

      expect(firstFire.startsWith('2025-01-03')).toBe(true);
      expect(isWithinFiringWindow(firstFire)).toBe(true);
    });
  });

  describe('gap-down-recover — no stale anchor stranded below market', () => {
    const result = replayLadder(replay.getBars('gap-down-recover'), config);

    it('fires no rung — price never reaches 95.00', () => {
      expect(result.entries).toHaveLength(0);
      expect(result.position.heldLots).toHaveLength(0);
    });

    it('was evaluated throughout rather than skipped', () => {
      expect(result.blocked.some((b) => b.reason.kind === 'ABOVE_RUNG')).toBe(true);
    });
  });

  /**
   * **The headline test for Story 4.** The scenario that motivates per-lot
   * exits: an upper rung fires, hits its own target, exits, re-arms at its
   * original price, and fires again — repeatedly — while a lower lot holds
   * through the entire drawdown untouched.
   */
  describe('chop-range — the cycle suite', () => {
    const result = replayLadder(replay.getBars('chop-range'), config);

    const cyclesAt95 = result.completedCycles.filter((c) => c.rungPrice === 95);

    it('completes at least 3 full cycles on the 95.00 rung', () => {
      expect(cyclesAt95.length).toBeGreaterThanOrEqual(3);
    });

    it('each cycle exits at that lot’s own target, 5% above its own fill', () => {
      for (const cycle of cyclesAt95) {
        expect(cycle.fillPrice).toBe(95);
        // 95.00 × 1.05 = 99.75, computed from this lot's fill, not the blend.
        expect(cycle.exitPrice).toBe(99.75);
      }
    });

    it('realized P&L per cycle matches the hand calculation', () => {
      for (const cycle of cyclesAt95) {
        // (99.75 − 95.00) × quantity, gross of costs (no fill model yet).
        expect(cycle.realized).toBeCloseTo(4.75 * cycle.quantity, 2);
      }
    });

    it('re-arms the 95.00 rung at its original price, never at the exit price', () => {
      const rung = result.rungs.find((r) => r.price === 95);

      expect(rung).toBeDefined();
      expect(rung!.price).toBe(95);
      expect(rung!.completedCycles).toBe(cyclesAt95.length);
    });

    /**
     * Both rungs cycle here, and independently — this fixture swings the full
     * 88→100 every oscillation, so price clears the 90.25 lot's 94.76 target as
     * well as the 95.00 lot's 99.75. Each lot still exits strictly at *its own*
     * level, which is the point: the two rungs are not coupled.
     *
     * The "lower lot holds while an upper rung cycles" case needs a range that
     * recovers past the upper target but not the lower one. `chop-range` cannot
     * show it, so it is asserted on a purpose-built series in
     * `cycle.spec.ts` → 'upper rung cycles while a lower lot holds'.
     */
    it('cycles both rungs, each at its own target', () => {
      const cyclesAt9025 = result.completedCycles.filter((c) => c.rungPrice === 90.25);

      expect(cyclesAt9025.length).toBeGreaterThanOrEqual(3);
      expect(cyclesAt9025.every((c) => c.exitPrice === 94.76)).toBe(true);
      expect(cyclesAt95.every((c) => c.exitPrice === 99.75)).toBe(true);
    });

    it('never lets a lot exit at another rung’s target', () => {
      for (const cycle of result.completedCycles) {
        // 95.00 → 99.75 and 90.25 → 94.76. A blended exit would collapse these
        // onto one level.
        expect(cycle.exitPrice).toBeCloseTo(cycle.fillPrice * 1.05, 2);
      }
    });

    it('every exit is a SELL at a lot’s own target', () => {
      for (const exit of result.exits) {
        const lot = result.lots.find((l) => l.id === exit.lotId)!;

        expect(exit.side).toBe('SELL');
        expect(exit.limitPrice).toBe(lot.exitTarget);
      }
    });

    it('every completed cycle is profitable — no loss is ever booked', () => {
      expect(result.completedCycles.length).toBeGreaterThan(0);
      for (const cycle of result.completedCycles) {
        expect(cycle.exitPrice).toBeGreaterThan(cycle.fillPrice);
        expect(cycle.realized).toBeGreaterThan(0);
      }
    });

    it('total realized P&L is the sum of the individual cycles', () => {
      const expected = result.completedCycles.reduce((sum, c) => sum + c.realized, 0);

      expect(result.totalRealized).toBeCloseTo(expected, 2);
      expect(result.totalRealized).toBeGreaterThan(0);
    });
  });

  describe('session-edges — the firing window is respected exactly', () => {
    const result = replayLadder(replay.getBars('session-edges'), config);

    it('generates no intent outside 09:45–16:00 ET', () => {
      for (const intent of result.entries) {
        expect(isWithinFiringWindow(intent.timestamp)).toBe(true);
      }
    });

    it('evaluates no pre- or post-market bar', () => {
      const evaluated = [
        ...result.entries.map((i) => i.timestamp),
        ...result.blocked.map((b) => b.timestamp),
      ];

      expect(evaluated.length).toBeGreaterThan(0);
      for (const timestamp of evaluated) {
        expect(isRegularSession(timestamp)).toBe(true);
      }
    });

    it('rejects the 09:30 and 09:40 bars as outside the window', () => {
      const outside = result.blocked
        .filter((b) => b.reason.kind === 'OUTSIDE_WINDOW')
        .map((b) => b.timestamp);

      expect(outside.some((t) => t.includes('T09:30'))).toBe(true);
      expect(outside.some((t) => t.includes('T09:40'))).toBe(true);
      expect(outside.some((t) => t.includes('T09:45'))).toBe(false);
    });
  });

  describe('invariants across every fixture', () => {
    it('never generates an entry outside the firing window', () => {
      for (const name of ALL_FIXTURES) {
        for (const intent of replayLadder(replay.getBars(name), config).entries) {
          expect(isWithinFiringWindow(intent.timestamp)).toBe(true);
        }
      }
    });

    it('never generates an exit outside the firing window', () => {
      for (const name of ALL_FIXTURES) {
        for (const exit of replayLadder(replay.getBars(name), config).exits) {
          expect(isWithinFiringWindow(exit.timestamp)).toBe(true);
        }
      }
    });

    it('every entry is a BUY and every exit a SELL', () => {
      for (const name of ALL_FIXTURES) {
        const { entries, exits } = replayLadder(replay.getBars(name), config);

        expect(entries.every((i) => i.side === 'BUY')).toBe(true);
        expect(exits.every((i) => i.side === 'SELL')).toBe(true);
      }
    });

    /**
     * The structural guarantee: no lot anywhere, on any fixture, is ever sold
     * below what it paid. There is no stop and no loss-booking exit.
     */
    it('never sells a lot below its fill price', () => {
      for (const name of ALL_FIXTURES) {
        const { lots } = replayLadder(replay.getBars(name), config);

        for (const lot of lots) {
          if (lot.status === LotStatus.CLOSED) {
            expect(lot.exitPrice!).toBeGreaterThan(lot.fillPrice);
          }
        }
      }
    });

    it('never holds two lots at the same rung simultaneously', () => {
      for (const name of ALL_FIXTURES) {
        const { position } = replayLadder(replay.getBars(name), config);
        const prices = position.heldLots.map((l) => l.rungPrice);

        expect(new Set(prices).size).toBe(prices.length);
      }
    });

    it('never exceeds the 5-concurrent-rung limit', () => {
      for (const name of ALL_FIXTURES) {
        const { position } = replayLadder(replay.getBars(name), config);

        expect(position.heldLots.length).toBeLessThanOrEqual(5);
      }
    });
  });
});
