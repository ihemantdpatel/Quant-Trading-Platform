/**
 * `LeapsStrategy` — scaffold.
 *
 * Story 16 implements timed or threshold-based multi-month positioning
 * (`project-scope.md`). Registered and **disabled**; emits nothing.
 *
 * Its evaluation is calendar-driven rather than bar-driven, which is why the
 * interface carries `evaluate(ctx, state)` alongside `onBar` — a strategy whose
 * trigger is "the third Friday is eight weeks out" has no bar to hang that
 * decision on, and `ctx.now` is supplied precisely so it need not read a clock.
 */

import { ScaffoldStrategy } from '../scaffold';
import { JsonValue } from '../types';

export const LEAPS_STRATEGY_ID = 'leaps';

export class LeapsStrategy extends ScaffoldStrategy {
  readonly id = LEAPS_STRATEGY_ID;

  protected initialData(): Record<string, JsonValue> {
    return { openPositions: [], lastEvaluatedAt: null };
  }
}
