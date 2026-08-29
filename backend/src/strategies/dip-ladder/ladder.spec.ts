import { Bar, BarSize } from '../../market-data/types';
import { buildDipLadderConfig, OrderPlacement, SpacingMode } from './config';
import { evaluateBar, isRungHeld, rungAllocationFraction, rungQuantity } from './ladder';
import { HeldLot, LadderPosition } from './types';

function bar(close: number, timestamp = '2025-01-02T10:00:00.000-05:00', open = close): Bar {
  return {
    symbol: 'TQQQ',
    barSize: BarSize.FIVE_MIN,
    timestamp,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: 1_000_000,
  };
}

function lot(rungPrice: number): HeldLot {
  return {
    rungPrice,
    fillPrice: rungPrice,
    quantity: 10,
    openedAt: '2025-01-02T10:00:00.000-05:00',
  };
}

/**
 * A position whose rungs are all held — the Story 3 shape, where every rung in
 * the ledger carries a lot. Re-armed and pending rungs are exercised separately
 * in `rung.spec.ts` and the cycle scenarios.
 */
function position(rungPrices: number[], firstEntryPrice: number | null = null): LadderPosition {
  return {
    rungs: rungPrices.map((price, i) => ({
      price,
      lotId: `lot-${i + 1}`,
      lastExitAt: null,
    })),
    heldLots: rungPrices.map(lot),
    firstEntryPrice: firstEntryPrice ?? (rungPrices.length > 0 ? rungPrices[0] : null),
  };
}

const FLAT: LadderPosition = { rungs: [], heldLots: [], firstEntryPrice: null };

describe('sizing', () => {
  const config = buildDipLadderConfig('TQQQ', { symbolCapital: 10_000 });

  it('allocates 25% of symbol capital to every rung — flat by default', () => {
    for (let depth = 0; depth < 5; depth += 1) {
      expect(rungAllocationFraction(depth, config)).toBe(0.25);
    }
  });

  it('sizes each rung at 25% of capital in whole shares', () => {
    // 10,000 × 25% = 2,500 → 2,500 / 100.00 = 25 shares.
    expect(rungQuantity(100, 0, config)).toBe(25);
    // Deeper rung, same allocation, lower price → more shares.
    expect(rungQuantity(50, 4, config)).toBe(50);
  });

  it('floors to whole shares rather than overshooting the allocation', () => {
    // 2,500 / 87.41 = 28.6 → 28 shares, not 29.
    expect(rungQuantity(87.41, 0, config)).toBe(28);
  });

  it('a fully-extended flat ladder is 125% of nominal', () => {
    const total = [0, 1, 2, 3, 4].reduce(
      (sum, depth) => sum + rungAllocationFraction(depth, config),
      0,
    );

    expect(total).toBeCloseTo(1.25);
  });

  it('escalation is off by default — depth does not change the allocation', () => {
    expect(rungAllocationFraction(0, config)).toBe(rungAllocationFraction(4, config));
  });

  it('escalates when explicitly enabled', () => {
    const escalating = buildDipLadderConfig('TQQQ', {
      symbolCapital: 10_000,
      escalationFactor: 1.5,
    });

    expect(rungAllocationFraction(0, escalating)).toBeCloseTo(0.25);
    expect(rungAllocationFraction(1, escalating)).toBeCloseTo(0.375);
    expect(rungAllocationFraction(2, escalating)).toBeCloseTo(0.5625);
  });

  /**
   * `PRD.md:112` — the capital figure is not yet set, and Story 5's startup
   * assertion refuses PAPER/LIVE until it is. SHADOW replay still needs
   * correctly *priced* intents, which is what Story 3 verifies.
   */
  it('returns zero quantity while symbol capital is unset', () => {
    expect(rungQuantity(100, 0, buildDipLadderConfig('TQQQ'))).toBe(0);
  });

  it('returns zero rather than dividing by a non-positive price', () => {
    expect(rungQuantity(0, 0, config)).toBe(0);
  });
});

/**
 * "A rung may not fire while it already holds a lot" (`PRD.md:84`) in
 * isolation. Story 3's anchor progression cannot produce a collision — the
 * anchor is the lowest held lot, so the next rung is always strictly below
 * every held lot — but Story 4's re-arming can, so the rule is pinned here
 * before that story depends on it.
 */
describe('isRungHeld', () => {
  it('is true for a rung a lot occupies', () => {
    expect(isRungHeld(position([95, 90.25]), 90.25)).toBe(true);
  });

  it('is false for a free rung', () => {
    expect(isRungHeld(position([95, 90.25]), 85.74)).toBe(false);
  });

  it('is false when flat', () => {
    expect(isRungHeld(FLAT, 95)).toBe(false);
  });

  it('compares at cent precision, so float noise cannot free a held rung', () => {
    // 90.25 reconstructed through arithmetic that leaves a float tail.
    const noisy = 95 - 4.75000000001;

    expect(noisy).not.toBe(90.25);
    expect(isRungHeld(position([90.25]), noisy)).toBe(true);
  });
});

describe('evaluateBar', () => {
  const config = buildDipLadderConfig('TQQQ', { symbolCapital: 10_000 });

  describe('session window', () => {
    it('does not fire before 09:45 even when price is at the rung', () => {
      const decision = evaluateBar(
        bar(94, '2025-01-02T09:40:00.000-05:00'),
        FLAT,
        config,
        100,
        100,
      );

      expect(decision.intent).toBeNull();
      expect(decision.blocked?.kind).toBe('OUTSIDE_WINDOW');
    });

    it('fires at 09:45', () => {
      const decision = evaluateBar(
        bar(94, '2025-01-02T09:45:00.000-05:00'),
        FLAT,
        config,
        100,
        100,
      );

      expect(decision.intent).not.toBeNull();
    });

    it('does not fire at 16:00', () => {
      const decision = evaluateBar(
        bar(94, '2025-01-02T16:00:00.000-05:00'),
        FLAT,
        config,
        100,
        100,
      );

      expect(decision.blocked?.kind).toBe('OUTSIDE_WINDOW');
    });

    it('does not fire pre- or post-market', () => {
      expect(
        evaluateBar(bar(94, '2025-01-02T08:00:00.000-05:00'), FLAT, config, 100, 100).intent,
      ).toBeNull();
      expect(
        evaluateBar(bar(94, '2025-01-02T17:00:00.000-05:00'), FLAT, config, 100, 100).intent,
      ).toBeNull();
    });
  });

  describe('firing rule', () => {
    it('fires when the close is at or below the rung', () => {
      // Anchor 100 → rung 95.
      expect(evaluateBar(bar(95), FLAT, config, 100, 100).intent?.limitPrice).toBe(95);
      expect(evaluateBar(bar(94.5), FLAT, config, 100, 100).intent?.limitPrice).toBe(95);
    });

    it('does not fire when the close is above the rung', () => {
      const decision = evaluateBar(bar(95.01), FLAT, config, 100, 100);

      expect(decision.intent).toBeNull();
      expect(decision.blocked?.kind).toBe('ABOVE_RUNG');
    });

    /**
     * `PRD.md:92` — a rung missed by an intra-bar spike that recovers before
     * the close is accepted. The strategy buys weakness; being slightly late
     * is not costly, and chasing the wick would fill at a price that no longer
     * exists.
     */
    it('ignores an intra-bar spike through the rung that recovers by the close', () => {
      const spike: Bar = {
        ...bar(96, '2025-01-02T10:00:00.000-05:00', 96),
        // Traded down to 93 — through the 95 rung — but closed back at 96.
        low: 93,
      };

      expect(evaluateBar(spike, FLAT, config, 100, 100).intent).toBeNull();
    });

    it('does not fire a rung that already holds a lot', () => {
      // Held at 95 → anchor progresses to 95, next rung 90.25. A bar closing
      // at 94 is below the held rung but above the next one.
      const decision = evaluateBar(bar(94), position([95]), config, 100, 100);

      expect(decision.intent).toBeNull();
      expect(decision.rungPrice).toBe(90.25);
      expect(decision.blocked?.kind).toBe('ABOVE_RUNG');
    });

    it('the anchor keeps the next rung clear of every held lot', () => {
      // Anchor is the lowest held (90.25) → rung 85.74, below both lots.
      const decision = evaluateBar(bar(80), position([95, 90.25]), config, 100, 100);

      expect(decision.rungPrice).toBe(85.74);
      expect(isRungHeld(position([95, 90.25]), 85.74)).toBe(false);
    });
  });

  describe('anchor integration', () => {
    it('uses the bootstrap anchor when flat', () => {
      // max(prev close 100, open 96) = 100 → rung 95.
      expect(
        evaluateBar(bar(94, '2025-01-02T10:00:00.000-05:00'), FLAT, config, 100, 96).rungPrice,
      ).toBe(95);
    });

    it('gap-down — the gapped open alone does not fire the first rung', () => {
      // Session opens at 96 after a 100 close. Rung is at 95; a bar closing at
      // 95.50 near the open is not "almost there" — it does not fire.
      const decision = evaluateBar(bar(95.5), FLAT, config, 100, 96);

      expect(decision.rungPrice).toBe(95);
      expect(decision.intent).toBeNull();
    });

    it('progresses off the lowest held lot once holding', () => {
      const decision = evaluateBar(bar(90), position([100, 95]), config, 100, 100);

      // Lowest held 95 → rung 90.25; close 90 fires it.
      expect(decision.rungPrice).toBe(90.25);
      expect(decision.intent?.limitPrice).toBe(90.25);
    });
  });

  describe('invalidation integration', () => {
    it('stops firing at 5 concurrent rungs', () => {
      const full = position([95, 90.25, 85.74, 81.45, 77.38], 95);
      const decision = evaluateBar(bar(50), full, config, 100, 100);

      expect(decision.intent).toBeNull();
      expect(decision.blocked?.kind).toBe('INVALIDATED');
      expect(decision.blocked?.detail).toContain('5 of 5');
    });

    it('fires while the next rung is still above the floor', () => {
      // First entry 100 → floor 75. Anchor 95 → rung 90.25, well above it.
      const decision = evaluateBar(bar(60), position([100, 95], 100), config, 100, 100);

      expect(decision.intent?.limitPrice).toBe(90.25);
    });

    /**
     * The floor blocks *adding* and emits no sell (`PRD.md:170`). Constructed
     * with a first entry high enough that the next rung falls under the floor
     * while fewer than 5 lots are held, so the floor is what binds rather than
     * the rung limit.
     */
    it('stops adding once the next rung is at or below the hard floor, and emits no sell', () => {
      // First entry 100 → floor 75. Lowest held 78 → next rung 74.10 < 75.
      const deep = position([100, 90, 84, 78], 100);
      const decision = evaluateBar(bar(60), deep, config, 100, 100);

      expect(decision.rungPrice).toBe(74.1);
      expect(decision.intent).toBeNull();
      expect(decision.blocked?.kind).toBe('INVALIDATED');
      expect(decision.blocked?.detail).toContain('holding, not selling');
    });

    it('leaves held lots untouched when the floor blocks', () => {
      const deep = position([100, 90, 84, 78], 100);
      const before = JSON.parse(JSON.stringify(deep.heldLots));

      evaluateBar(bar(60), deep, config, 100, 100);

      expect(deep.heldLots).toEqual(before);
    });
  });

  /**
   * RESTING places the order before price arrives, so the reach test that
   * governs IMMEDIATE does not apply. What still must hold is that a BUY limit
   * rests *below* the market — at or above it the order is marketable and the
   * exchange fills it on arrival, which is the opposite of a ladder waiting at
   * a predetermined level.
   */
  describe('RESTING placement stays below the market', () => {
    const resting = buildDipLadderConfig('TQQQ', {
      symbolCapital: 10_000,
      orderPlacement: OrderPlacement.RESTING,
    });

    it('rests a newly extended rung below the close', () => {
      // Anchor 100 → rung 95, with the close at 99. The ordinary case: the
      // order waits at 95 rather than being declined for not being reached.
      const decision = evaluateBar(bar(99), FLAT, resting, 100, 100);

      expect(decision.intent?.limitPrice).toBe(95);
    });

    /**
     * The bug this guard exists for, at the prices it was reported at: a rung
     * at 69 with the market at 68.20. The rung re-armed at its original price
     * and price then recovered past it, so `highestFireableRung` — which
     * ignores where price is — returned a level above the close. Sent as a
     * resting buy it was marketable and filled instantly at the ask.
     */
    it('declines a re-armed rung that price has recovered above', () => {
      const reArmed: LadderPosition = {
        rungs: [{ price: 69, lotId: null, lastExitAt: null }],
        heldLots: [],
        firstEntryPrice: 69,
      };

      const decision = evaluateBar(bar(68.2), reArmed, resting, 70, 70);

      expect(decision.intent).toBeNull();
      expect(decision.blocked?.kind).toBe('ABOVE_RUNG');
    });

    it('declines a rung sitting exactly at the close', () => {
      // A limit equal to the close is marketable too, and a level the market is
      // already sitting on is not a dip.
      const atClose: LadderPosition = {
        rungs: [{ price: 95, lotId: null, lastExitAt: null }],
        heldLots: [],
        firstEntryPrice: 95,
      };

      expect(evaluateBar(bar(95), atClose, resting, 100, 100).intent).toBeNull();
    });

    it('still rests a re-armed rung the market is above', () => {
      // The guard must not break cycling: a re-armed rung below the close is
      // exactly what the ladder re-places an order at.
      const reArmed: LadderPosition = {
        rungs: [{ price: 95, lotId: null, lastExitAt: null }],
        heldLots: [],
        firstEntryPrice: 95,
      };

      expect(evaluateBar(bar(99), reArmed, resting, 100, 100).intent?.limitPrice).toBe(95);
    });

    /**
     * The anchor is the lowest *held* lot, not the market, so a position held
     * while price falls beneath it computes a next rung above the close. The
     * newly-extended path needs the same guard as the re-armed one.
     */
    it('declines a newly extended rung when price has fallen below the anchor', () => {
      // Held at 95 → anchor 95, next rung 90.25, with the close already at 88.
      const decision = evaluateBar(bar(88), position([95]), resting, 100, 100);

      expect(decision.rungPrice).toBe(90.25);
      expect(decision.intent).toBeNull();
      expect(decision.blocked?.kind).toBe('ABOVE_RUNG');
    });

    it('leaves IMMEDIATE placement unchanged', () => {
      // The default the committed fixtures were computed under: a close above
      // the rung fires nothing, and a close at or below it fires.
      expect(evaluateBar(bar(99), FLAT, config, 100, 100).intent).toBeNull();
      expect(evaluateBar(bar(95), FLAT, config, 100, 100).intent?.limitPrice).toBe(95);
    });
  });

  /**
   * Gap re-basing, end to end through the firing decision.
   *
   * The anchor rule is unit-tested in `anchor.spec.ts`; what these cases pin is
   * the consequence that motivates it — under RESTING placement a stale anchor
   * does not merely shift the rung, it means **no order is placed at all**, and
   * re-basing is what restores a placement. Written at the live fixed-dollar
   * geometry because that is where the defect actually bites: a $1 rung is
   * narrower than an ordinary TQQQ gap.
   */
  describe('gap-down open under RESTING placement', () => {
    const base = {
      symbolCapital: 10_000,
      orderPlacement: OrderPlacement.RESTING,
      spacingMode: SpacingMode.FIXED_DOLLAR,
      spacingDollars: 1,
      fixedQuantity: 50,
    };

    const stranded = buildDipLadderConfig('TQQQ', base);
    const rebasing = buildDipLadderConfig('TQQQ', { ...base, gapRebasePercent: 0.01 });

    // Previous close 72.00, session gaps down and opens at 70.00 (-2.8%).
    const PREVIOUS_CLOSE = 72;
    const GAPPED_OPEN = 70;

    it('places nothing without re-basing — the defect', () => {
      // Anchor stays at 72.00, so the first rung is 71.00: above a market
      // trading at 69.95, where a resting BUY limit would be marketable.
      const decision = evaluateBar(bar(69.95), FLAT, stranded, PREVIOUS_CLOSE, GAPPED_OPEN);

      expect(decision.rungPrice).toBe(71);
      expect(decision.intent).toBeNull();
      expect(decision.blocked?.kind).toBe('ABOVE_RUNG');
    });

    it('places a resting limit below the market once re-based', () => {
      // Anchor follows the open to 70.00, so the rung lands at 69.00 — under
      // the 69.95 close, where the order rests instead of filling on arrival.
      const decision = evaluateBar(bar(69.95), FLAT, rebasing, PREVIOUS_CLOSE, GAPPED_OPEN);

      expect(decision.rungPrice).toBe(69);
      expect(decision.intent?.limitPrice).toBe(69);
      expect(decision.intent?.quantity).toBe(50);
    });

    it('still emits a limit order, never a market order', () => {
      // The ladder buys at a predetermined level. Re-basing moves *where* that
      // level is; it must not turn the entry into a market order, since there
      // is no stop-loss underneath a lot once it fills.
      const intent = evaluateBar(bar(69.95), FLAT, rebasing, PREVIOUS_CLOSE, GAPPED_OPEN).intent;

      expect(intent?.limitPrice).toBeDefined();
      expect(intent!.limitPrice).toBeLessThan(69.95);
    });

    it('leaves an ordinary down open on the max rule', () => {
      // Opening 0.3% below the previous close is not a gap: the anchor holds at
      // 72.00 and the ladder waits at 71.00 rather than chasing price down.
      const decision = evaluateBar(bar(71.75), FLAT, rebasing, PREVIOUS_CLOSE, 71.8);

      expect(decision.rungPrice).toBe(71);
      expect(decision.intent?.limitPrice).toBe(71);
    });

    it('does not re-base while a lot is held', () => {
      // Progression anchors on the held lot at 71.00, so the next rung is
      // 70.00 — below existing exposure, regardless of the gap.
      const decision = evaluateBar(
        bar(69.95),
        position([71]),
        rebasing,
        PREVIOUS_CLOSE,
        GAPPED_OPEN,
      );

      expect(decision.rungPrice).toBe(70);
    });
  });

  describe('emitted intent', () => {
    it('is a BUY limit at the rung price with the firing reason', () => {
      const decision = evaluateBar(
        bar(94, '2025-01-02T10:05:00.000-05:00'),
        FLAT,
        config,
        100,
        100,
      );

      expect(decision.intent).toEqual({
        symbol: 'TQQQ',
        side: 'BUY',
        quantity: 26,
        limitPrice: 95,
        timestamp: '2025-01-02T10:05:00.000-05:00',
        reason: expect.stringContaining('rung at 95.00'),
      });
    });

    it('never emits a side other than BUY', () => {
      const decisions = [
        evaluateBar(bar(94), FLAT, config, 100, 100),
        evaluateBar(bar(90), position([95]), config, 100, 100),
        evaluateBar(bar(50), position([95, 90.25], 95), config, 100, 100),
      ];

      for (const decision of decisions) {
        if (decision.intent) {
          expect(decision.intent.side).toBe('BUY');
        }
      }
    });

    it('does not mutate the position it was given', () => {
      const held = position([95]);
      const before = JSON.parse(JSON.stringify(held));

      evaluateBar(bar(90), held, config, 100, 100);

      expect(held).toEqual(before);
    });
  });
});
