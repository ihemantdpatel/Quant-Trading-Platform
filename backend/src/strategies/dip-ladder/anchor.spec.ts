import { AnchorBasis, bootstrapAnchor, lowestHeldLotPrice, resolveAnchor } from './anchor';
import { buildDipLadderConfig } from './config';
import { nextRungPrice } from './spacing';
import { HeldLot } from './types';

function lot(rungPrice: number, openedAt = '2025-01-02T10:00:00.000-05:00'): HeldLot {
  return { rungPrice, fillPrice: rungPrice, quantity: 10, openedAt };
}

describe('anchor', () => {
  describe('bootstrap — no position held', () => {
    it('takes the higher of previous close and today open (normal case)', () => {
      // Open below the prior close: the close wins.
      expect(bootstrapAnchor(100, 99.5)).toBe(100);
      // Open above the prior close: the open wins.
      expect(bootstrapAnchor(100, 101)).toBe(101);
    });

    it('uses today open on the first session ever seen', () => {
      expect(bootstrapAnchor(null, 100)).toBe(100);
    });

    /**
     * The `gap-down-open` fixture: session 1 closes at 100.00, session 2 opens
     * at 96.00. The first rung must sit a full spacing unit below the anchor,
     * so the system waits rather than treating the 4% gap as "almost there".
     */
    it('gap-down — first rung sits a further 5% below the anchor, not at the gap', () => {
      const config = buildDipLadderConfig('TQQQ');
      const anchor = bootstrapAnchor(100, 96);

      expect(anchor).toBe(100);

      // 5% of 100.00 = 5.00 → rung at 95.00, which is below the 96.00 gapped
      // open. The gap alone does not fire a rung.
      expect(nextRungPrice(anchor, config)).toBe(95);
      expect(nextRungPrice(anchor, config)).toBeLessThan(96);
    });

    /**
     * The `gap-down-recover` fixture: gaps to 96.00 then closes at 102.00.
     * Because the anchor takes the max, it is never left below the market.
     */
    it('gap-down-then-recover — no stale anchor stranded below market', () => {
      const gapDayAnchor = bootstrapAnchor(100, 96);
      expect(gapDayAnchor).toBe(100);

      // Next session opens above the recovered close: the anchor follows up.
      const nextDayAnchor = bootstrapAnchor(102, 102.5);
      expect(nextDayAnchor).toBe(102.5);
      expect(nextDayAnchor).toBeGreaterThan(gapDayAnchor);
    });

    it('re-bases each session rather than holding a stale level', () => {
      expect(bootstrapAnchor(100, 96)).toBe(100);
      expect(bootstrapAnchor(96, 95)).toBe(96);
      expect(bootstrapAnchor(95, 94)).toBe(95);
    });
  });

  describe('progression — position held', () => {
    it('anchors on the lowest held lot', () => {
      expect(lowestHeldLotPrice([lot(95), lot(90.25), lot(100)])).toBe(90.25);
    });

    it('returns null when flat', () => {
      expect(lowestHeldLotPrice([])).toBeNull();
    });

    it('chains the next rung one spacing unit below the lowest held lot', () => {
      const config = buildDipLadderConfig('TQQQ');

      // Lowest held at 95.00 → next rung 5% below = 90.25.
      expect(nextRungPrice(lowestHeldLotPrice([lot(100), lot(95)])!, config)).toBe(90.25);
    });

    it('ignores a lot that is no longer held, so exits stop influencing rungs', () => {
      // Story 4 removes exited lots; the anchor must follow what remains.
      const afterExit = [lot(95)];

      expect(lowestHeldLotPrice(afterExit)).toBe(95);
    });
  });

  describe('resolveAnchor', () => {
    it('bootstraps when flat', () => {
      expect(resolveAnchor([], 100, 96)).toEqual({ price: 100, basis: AnchorBasis.BOOTSTRAP });
    });

    it('progresses when holding, ignoring the session bootstrap inputs', () => {
      // Session open of 99 sits well above the held lot; the ladder must
      // extend from live exposure rather than re-base upward.
      expect(resolveAnchor([lot(95), lot(90.25)], 100, 99)).toEqual({
        price: 90.25,
        basis: AnchorBasis.PROGRESSION,
      });
    });
  });
});
