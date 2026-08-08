/**
 * `WheelStrategy` — scaffold.
 *
 * Story 16 implements cash-secured puts transitioning to covered calls on
 * assignment. Registered and **disabled**; emits nothing.
 *
 * This is the strategy that most needs `Contract` to model options from day one
 * (`PRD.md:224`): the wheel is defined by strike, expiry, and right, and an
 * equity-shaped contract could not express a single one of its orders. The
 * seed state names the assignment phase for the same reason — the transition
 * put-assigned → covered-call is the strategy's core state machine.
 */

import { ScaffoldStrategy } from '../scaffold';
import { JsonValue } from '../types';

export const WHEEL_STRATEGY_ID = 'wheel';

export enum WheelPhase {
  /** Selling cash-secured puts, holding no shares. */
  CASH_SECURED_PUT = 'CASH_SECURED_PUT',
  /** Put assigned; selling covered calls against the assigned shares. */
  COVERED_CALL = 'COVERED_CALL',
}

export class WheelStrategy extends ScaffoldStrategy {
  readonly id = WHEEL_STRATEGY_ID;

  protected initialData(): Record<string, JsonValue> {
    return { phase: WheelPhase.CASH_SECURED_PUT, assignedShares: 0 };
  }
}
