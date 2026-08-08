import { buildDipLadderConfig } from './config';
import { BlockReason, evaluateInvalidation, hardFloorPrice, heldRungCount } from './invalidation';
import { HeldLot, LadderPosition } from './types';

function lot(rungPrice: number): HeldLot {
  return {
    rungPrice,
    fillPrice: rungPrice,
    quantity: 10,
    openedAt: '2025-01-02T10:00:00.000-05:00',
  };
}

function position(rungPrices: number[], firstEntryPrice: number | null = null): LadderPosition {
  return {
    rungs: rungPrices.map((price, i) => ({ price, lotId: `lot-${i + 1}`, lastExitAt: null })),
    heldLots: rungPrices.map(lot),
    firstEntryPrice: firstEntryPrice ?? (rungPrices.length > 0 ? rungPrices[0] : null),
  };
}

describe('invalidation', () => {
  const config = buildDipLadderConfig('TQQQ');

  describe('concurrent rung limit', () => {
    it('permits adding below the limit', () => {
      expect(evaluateInvalidation(position([95, 90.25]), 85.74, config).canAdd).toBe(true);
    });

    it('stops firing at 5 concurrent rungs', () => {
      const full = position([95, 90.25, 85.74, 81.45, 77.38]);
      const result = evaluateInvalidation(full, 73.51, config);

      expect(result.canAdd).toBe(false);
      expect(result.reason).toBe(BlockReason.MAX_RUNGS_HELD);
      expect(result.detail).toContain('5 of 5');
    });

    it('permits the fifth rung itself — the limit binds on the sixth', () => {
      expect(evaluateInvalidation(position([95, 90.25, 85.74, 81.45]), 77.38, config).canAdd).toBe(
        true,
      );
    });

    it('honours a non-default limit', () => {
      const narrow = buildDipLadderConfig('TQQQ', { maxConcurrentRungs: 2 });

      expect(evaluateInvalidation(position([95, 90.25]), 85.74, narrow).canAdd).toBe(false);
    });

    /**
     * Re-armed empty rungs must not consume a slot (`PRD.md:163`). The count is
     * modelled over *held lots*, so a rung whose lot has exited is structurally
     * incapable of counting — this test pins that property before Story 4
     * introduces the exits that create the case.
     */
    it('counts held lots only, so a re-armed empty rung consumes no slot', () => {
      const fiveHeld = position([95, 90.25, 85.74, 81.45, 77.38]);
      expect(heldRungCount(fiveHeld)).toBe(5);

      // The 95.00 rung's lot has exited and the rung is re-armed: it stays in
      // the ledger at its original price but holds nothing.
      const afterExit: LadderPosition = {
        rungs: fiveHeld.rungs.map((rung) =>
          rung.price === 95
            ? { ...rung, lotId: null, lastExitAt: '2025-01-03T10:00:00.000-05:00' }
            : rung,
        ),
        heldLots: fiveHeld.heldLots.filter((l) => l.rungPrice !== 95),
        firstEntryPrice: fiveHeld.firstEntryPrice,
      };

      // The rung is still there — re-arming preserves the level.
      expect(afterExit.rungs).toHaveLength(5);

      expect(heldRungCount(afterExit)).toBe(4);
      expect(evaluateInvalidation(afterExit, 73.51, config).canAdd).toBe(true);
    });
  });

  describe('hard floor', () => {
    it('does not bind when flat — there is no first entry to measure from', () => {
      const flat: LadderPosition = { rungs: [], heldLots: [], firstEntryPrice: null };

      expect(hardFloorPrice(flat, config)).toBeNull();
      expect(evaluateInvalidation(flat, 1, config).canAdd).toBe(true);
    });

    it('sits 25% below first entry', () => {
      expect(hardFloorPrice(position([95], 100), config)).toBeCloseTo(75);
    });

    it('permits adding above the floor', () => {
      expect(evaluateInvalidation(position([95], 100), 76, config).canAdd).toBe(true);
    });

    it('stops adding at the floor', () => {
      const result = evaluateInvalidation(position([95], 100), 75, config);

      expect(result.canAdd).toBe(false);
      expect(result.reason).toBe(BlockReason.HARD_FLOOR);
    });

    it('stops adding below the floor', () => {
      expect(evaluateInvalidation(position([95], 100), 70, config).canAdd).toBe(false);
    });

    it('measures from first entry, not from the lowest lot still held', () => {
      // First entry at 100 (floor 75) but that lot has exited; the lowest
      // remaining is 80. The floor must still be 75, not 60.
      const afterFirstExited: LadderPosition = {
        rungs: [
          { price: 100, lotId: null, lastExitAt: '2025-01-03T10:00:00.000-05:00' },
          { price: 80, lotId: 'lot-2', lastExitAt: null },
        ],
        heldLots: [lot(80)],
        firstEntryPrice: 100,
      };

      expect(hardFloorPrice(afterFirstExited, config)).toBeCloseTo(75);
      expect(evaluateInvalidation(afterFirstExited, 74, config).canAdd).toBe(false);
    });

    it('honours a non-default floor percentage', () => {
      const shallow = buildDipLadderConfig('TQQQ', { hardFloorPercent: 0.1 });

      expect(hardFloorPrice(position([95], 100), shallow)).toBeCloseTo(90);
      expect(evaluateInvalidation(position([95], 100), 89, shallow).canAdd).toBe(false);
    });
  });

  /**
   * The single most important property in this module. Both limits stop the
   * ladder *adding*; neither ever produces an exit. `InvalidationResult` has no
   * field capable of expressing "sell", which is what makes this structural
   * rather than a convention a later change could break.
   */
  describe('never sells', () => {
    it('emits no sell intent at the hard floor — it blocks adding and holds', () => {
      const result = evaluateInvalidation(position([95], 100), 60, config);

      expect(result.canAdd).toBe(false);
      expect(result.detail).toContain('holding, not selling');
      expect(Object.keys(result).sort()).toEqual(['canAdd', 'detail', 'reason']);
    });

    it('emits no sell intent at the rung limit', () => {
      const result = evaluateInvalidation(position([95, 90, 85, 80, 75], 100), 70, config);

      expect(result.canAdd).toBe(false);
      expect(Object.keys(result)).not.toContain('side');
      expect(Object.keys(result)).not.toContain('exit');
    });

    it('leaves held lots untouched when both limits bind at once', () => {
      const deep = position([95, 90, 85, 80, 75], 100);
      const before = JSON.parse(JSON.stringify(deep.heldLots));

      evaluateInvalidation(deep, 50, config);

      expect(deep.heldLots).toEqual(before);
    });
  });

  it('reports the rung limit first when both conditions bind', () => {
    const result = evaluateInvalidation(position([95, 90, 85, 80, 75], 100), 50, config);

    expect(result.reason).toBe(BlockReason.MAX_RUNGS_HELD);
  });
});
