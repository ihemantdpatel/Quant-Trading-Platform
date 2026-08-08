/**
 * The kill switch: a single point that halts all new order submission.
 *
 * **Effective within one evaluation cycle** (`PRD.md:492`). That is a
 * consequence of where it is read, not of anything clever here: the risk
 * manager checks it at the top of every `evaluate()` call, and every intent
 * goes through `evaluate()`, so the next intent after engagement is already
 * blocked. There is no queue to drain and no cached decision to invalidate.
 *
 * Stateful and therefore a service rather than a pure function — Story 6
 * toggles it over HTTP and Story 7 puts it on every dashboard route.
 *
 * **Engaging halts submission. It never liquidates.** Same reasoning as the
 * loss breaker: this class exposes no method that could produce a sell.
 */

import { Injectable } from '@nestjs/common';
import { RiskEvent, RiskEventSink, RiskEventType } from './risk-event';

export interface KillSwitchState {
  engaged: boolean;
  /** Why it was last engaged or released. Null before first use. */
  reason: string | null;
  /** ISO-8601, when it last changed. Null before first use. */
  changedAt: string | null;
}

@Injectable()
export class KillSwitchService {
  private state: KillSwitchState = { engaged: false, reason: null, changedAt: null };

  /**
   * The sink is optional so the switch can be constructed bare in unit tests
   * and pure contexts. When absent, transitions still happen — they are simply
   * not audited, and the risk manager owns the sink that matters.
   */
  constructor(private readonly sink?: RiskEventSink) {}

  isEngaged(): boolean {
    return this.state.engaged;
  }

  snapshot(): KillSwitchState {
    return { ...this.state };
  }

  /**
   * Halts all new submission.
   *
   * Idempotent: re-engaging an engaged switch is a no-op that emits no second
   * event, so a dashboard double-click does not fill the audit log with
   * duplicate activations. Returns whether this call changed the state.
   */
  engage(reason: string, at: string): boolean {
    if (this.state.engaged) {
      return false;
    }

    this.state = { engaged: true, reason, changedAt: at };
    this.audit('engaged', reason, at);
    return true;
  }

  /**
   * Releases the switch, permitting submission again.
   *
   * Deliberately a separate explicit call with its own reason. Releasing is an
   * operator decision that belongs in the audit log as prominently as engaging.
   */
  release(reason: string, at: string): boolean {
    if (!this.state.engaged) {
      return false;
    }

    this.state = { engaged: false, reason, changedAt: at };
    this.audit('released', reason, at);
    return true;
  }

  private audit(action: string, reason: string, at: string): void {
    const event: RiskEvent = {
      type: RiskEventType.KILL_SWITCH,
      reason: `KILL_SWITCH_${action.toUpperCase()}`,
      detail: `kill switch ${action}: ${reason}`,
      timestamp: at,
      intent: null,
      approvedQuantity: null,
    };

    this.sink?.emit(event);
  }
}
