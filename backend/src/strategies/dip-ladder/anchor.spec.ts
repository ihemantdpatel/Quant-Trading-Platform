import {
  AnchorBasis,
  bootstrapAnchor,
  isRebasableGap,
  lowestHeldLotPrice,
  resolveAnchor,
} from './anchor';
import { buildDipLadderConfig, SpacingMode } from './config';
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

  /**
   * `gapRebasePercent` — the deliberate exception to the max rule.
   *
   * The rule exists because "wait rather than chase" becomes "never trade" once
   * a gap exceeds the rung spacing: under RESTING placement the first rung then
   * sits above the market, `isRestable` refuses it, and nothing is placed at
   * all. These cases pin both the threshold behaviour and the direction —
   * re-basing must never move the anchor *up*.
   */
  describe('bootstrap — gap re-basing', () => {
    const rebasing = buildDipLadderConfig('TQQQ', { gapRebasePercent: 0.01 });

    it('is off by default, so the committed fixture rung prices are unchanged', () => {
      const off = buildDipLadderConfig('TQQQ');

      expect(off.gapRebasePercent).toBeNull();
      // The gap-down-open fixture's 4% gap, which scenarios.spec.ts pins at 95.
      expect(bootstrapAnchor(100, 96, off)).toBe(100);
      expect(nextRungPrice(bootstrapAnchor(100, 96, off), off)).toBe(95);
    });

    it('re-bases onto the open when the gap exceeds the threshold', () => {
      // 4% down against a 1% threshold: the anchor follows price to 96.00
      // rather than staying at a level the market has already left.
      expect(bootstrapAnchor(100, 96, rebasing)).toBe(96);
    });

    it('leaves the max rule in force for a gap inside the threshold', () => {
      // 0.5% down — the ladder still waits rather than chasing.
      expect(bootstrapAnchor(100, 99.5, rebasing)).toBe(100);
    });

    it('treats the threshold as inclusive at its boundary', () => {
      // Exactly 1% down re-bases; a hair less does not. Pinned because the
      // comparison direction is the whole rule.
      expect(bootstrapAnchor(100, 99, rebasing)).toBe(99);
      expect(bootstrapAnchor(100, 99.01, rebasing)).toBe(100);
    });

    it('never re-bases on a gap up — the max rule already selects the open', () => {
      // Guards against a sign error making the rule bidirectional. A gap up
      // must resolve through max(), which yields the same value either way,
      // so the assertion that matters is that it is not the *previous close*.
      expect(bootstrapAnchor(100, 104, rebasing)).toBe(104);
      expect(isRebasableGap(100, 104, rebasing)).toBe(false);
    });

    it('places the first rung below the gapped-down open, where it can rest', () => {
      // The point of the whole rule: at $1 fixed-dollar spacing the rung must
      // land under the market so a resting BUY limit is not marketable.
      const live = buildDipLadderConfig('TQQQ', {
        spacingMode: SpacingMode.FIXED_DOLLAR,
        spacingDollars: 1,
        gapRebasePercent: 0.01,
      });

      const gappedOpen = 70;
      const anchor = bootstrapAnchor(72, gappedOpen, live);

      expect(anchor).toBe(gappedOpen);
      expect(nextRungPrice(anchor, live)).toBe(69);
      expect(nextRungPrice(anchor, live)).toBeLessThan(gappedOpen);
    });

    it('without re-basing, the same gap strands every rung above the market', () => {
      // The defect this rule fixes, asserted directly so it cannot silently
      // return: a 2.8% gap against $1 rungs leaves all five levels above the
      // open, so a resting ladder places nothing at all.
      const stranded = buildDipLadderConfig('TQQQ', {
        spacingMode: SpacingMode.FIXED_DOLLAR,
        spacingDollars: 1,
      });

      const gappedOpen = 70;
      let price = bootstrapAnchor(72, gappedOpen, stranded);
      expect(price).toBe(72);

      const levels: number[] = [];
      for (let i = 0; i < stranded.maxConcurrentRungs; i += 1) {
        price = nextRungPrice(price, stranded);
        levels.push(price);
      }

      // 71, 70, 69, 68, 67 — the first two are at or above the open, so a
      // resting limit there is marketable and `isRestable` declines it.
      expect(levels.filter((level) => level >= gappedOpen)).not.toHaveLength(0);
    });

    it('does not re-base while lots are held — the ladder must keep descending', () => {
      // Progression takes precedence, so a gap-down open cannot move the
      // anchor above exposure the ladder already carries.
      expect(resolveAnchor([lot(95)], 100, 90, rebasing)).toEqual({
        price: 95,
        basis: AnchorBasis.PROGRESSION,
      });
    });

    it('reports no gap when the previous close is absent or non-positive', () => {
      // The gap is a ratio against the previous close; guarding these keeps a
      // division by zero from silently reading as "no gap".
      expect(isRebasableGap(null, 96, rebasing)).toBe(false);
      expect(isRebasableGap(0, 96, rebasing)).toBe(false);
      expect(bootstrapAnchor(null, 96, rebasing)).toBe(96);
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
