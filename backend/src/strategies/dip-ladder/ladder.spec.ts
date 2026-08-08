import { Bar, BarSize } from '../../market-data/types';
import { buildDipLadderConfig } from './config';
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
