/**
 * The live ladder's geometry, asserted end to end.
 *
 * `strategies.module.ts` selects fixed-dollar spacing, a fixed quantity, and
 * resting orders — a combination no fixture covers, since every committed
 * fixture runs percentage spacing under `IMMEDIATE`. This spec pins the numbers
 * the live PAPER engine will actually place orders at.
 */

import { buildDipLadderConfig, DipLadderConfig, OrderPlacement, SpacingMode } from './config';
import {
  DIP_LADDER_SYMBOL,
  LADDER_FIXED_QUANTITY,
  LADDER_SPACING_DOLLARS,
} from '../strategies.module';
import { rungQuantity } from './ladder';
import { nextRungPrice } from './spacing';
import { exitTargetFor } from './lot';
import { hardFloorPrice } from './invalidation';
import { LadderPosition } from './types';

/** Mirrors the factory in `strategies.module.ts`. */
function liveConfig(): DipLadderConfig {
  return buildDipLadderConfig(DIP_LADDER_SYMBOL, {
    symbolCapital: 40_000,
    orderPlacement: OrderPlacement.RESTING,
    spacingMode: SpacingMode.FIXED_DOLLAR,
    spacingDollars: LADDER_SPACING_DOLLARS,
    takeProfitDollars: LADDER_SPACING_DOLLARS,
    fixedQuantity: LADDER_FIXED_QUANTITY,
  });
}

describe('live ladder geometry', () => {
  const config = liveConfig();

  it('targets $50 per completed cycle', () => {
    expect(LADDER_SPACING_DOLLARS * LADDER_FIXED_QUANTITY).toBe(50);
  });

  it('walks five rungs one dollar apart from a $72 anchor', () => {
    const rungs: number[] = [];
    let anchor = 72;

    for (let i = 0; i < config.maxConcurrentRungs; i += 1) {
      anchor = nextRungPrice(anchor, config);
      rungs.push(anchor);
    }

    expect(rungs).toEqual([71, 70, 69, 68, 67]);
  });

  it('sizes every rung at 50 shares regardless of depth', () => {
    expect([71, 70, 69, 68, 67].map((price, depth) => rungQuantity(price, depth, config))).toEqual([
      50, 50, 50, 50, 50,
    ]);
  });

  it('sets each exit one rung above its own entry', () => {
    expect(
      [71, 70, 69, 68, 67].map((p) =>
        exitTargetFor(p, config.takeProfitPercent, config.takeProfitDollars),
      ),
    ).toEqual([72, 71, 70, 69, 68]);
  });

  it('deploys ~$17,250 at full extension, well inside the symbol allocation', () => {
    const deployed = [71, 70, 69, 68, 67].reduce(
      (sum, price, depth) => sum + price * rungQuantity(price, depth, config),
      0,
    );

    expect(deployed).toBeCloseTo(17_250, 0);
    expect(deployed).toBeLessThan(config.symbolCapital as number);
  });

  /**
   * The consequence the backtest surfaced, pinned as a fact rather than left
   * implicit: a 25% hard floor is ~$18 below a $72 anchor while five $1 rungs
   * span $5. The ladder therefore exhausts its rungs long before the floor is
   * ever consulted — the floor is not the binding constraint here,
   * `maxConcurrentRungs` is.
   */
  it('exhausts its rungs far above the hard floor', () => {
    const floor = hardFloorPrice(
      { rungs: [], heldLots: [], firstEntryPrice: 72 } as unknown as LadderPosition,
      config,
    ) as number;
    const deepestRung = 72 - config.maxConcurrentRungs * LADDER_SPACING_DOLLARS;

    expect(floor).toBeCloseTo(54, 0);
    expect(deepestRung).toBeGreaterThan(floor);
  });
});
