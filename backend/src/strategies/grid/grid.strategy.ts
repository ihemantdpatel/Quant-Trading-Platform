/**
 * `GridStrategy` — scaffold.
 *
 * Story 16 implements bracket limit orders at configured price increments
 * (`project-scope.md`). Registered and **disabled**; emits nothing.
 *
 * The distinction from the dip ladder is worth recording now, because the two
 * look similar and are not: a grid is a *fixed* lattice of levels that does not
 * move with exposure, whereas the ladder's anchor chains off the lowest held
 * lot (`stories.md:221`). They will not share rung code.
 */

import { ScaffoldStrategy } from '../scaffold';
import { JsonValue } from '../types';

export const GRID_STRATEGY_ID = 'grid';

export class GridStrategy extends ScaffoldStrategy {
  readonly id = GRID_STRATEGY_ID;

  protected initialData(): Record<string, JsonValue> {
    return { gridLevels: [] };
  }
}
