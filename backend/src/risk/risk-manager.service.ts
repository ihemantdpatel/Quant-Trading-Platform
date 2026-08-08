/**
 * The risk manager — the mandatory chokepoint.
 *
 * **Strategies emit intents. Only the risk manager calls the broker**
 * (`PRD.md:237`). There is no code path from a strategy to order submission
 * that bypasses this class, and `architecture.spec.ts` asserts that over module
 * imports rather than leaving it to convention.
 *
 * `evaluate()` is the single entry point. It applies the controls in a
 * deliberate order — cheapest and most absolute first:
 *
 * 1. **Intent validity** — a malformed intent is rejected before any control
 *    reasons about it, so no cap has to defend against a negative quantity.
 * 2. **Kill switch** — the operator's explicit stop outranks every computed
 *    limit. Checked here is what makes it effective within one evaluation
 *    cycle (`PRD.md:492`).
 * 3. **Daily loss breaker** — an automated halt, same absolute character.
 * 4. **Capital caps** — the only control that can *resize* rather than refuse.
 *
 * Order matters for which reason gets reported, and the reported reason is what
 * an operator acts on. A rejection during a kill-switch halt should say "kill
 * switch", not "per-symbol limit", even when both are true.
 *
 * **Exits are never blocked by a capital cap** and are deliberately still
 * evaluated by the halts above: a kill switch means "submit nothing", which
 * includes sells. That is the conservative reading — halting is reversible by
 * an operator, whereas an unintended sell is not.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ExecutionMode } from '../config/execution-mode';
import {
  applyCapitalCap,
  DeployedCapital,
  NO_CAPITAL_DEPLOYED,
  withIntentDeployed,
} from './capital-cap';
import { DailyPnl, evaluateLossBreaker, FLAT_PNL } from './loss-breaker';
import { KillSwitchService } from './kill-switch.service';
import { RiskConfig } from './risk.config';
import {
  eventForDecision,
  RiskEvent,
  RiskEventSink,
  RiskEventType,
  InMemoryRiskEventSink,
} from './risk-event';
import { intentNotional, RiskDecision, RiskIntent, RiskOutcome, RiskReason } from './types';

/**
 * The account state the controls are evaluated against.
 *
 * Passed per evaluation rather than held as service state, which keeps the
 * decision a pure function of (intent, config, account) and means Story 6 can
 * source it fresh from the repositories without this class owning a cache that
 * could go stale mid-session.
 */
export interface AccountSnapshot {
  deployed: DeployedCapital;
  pnl: DailyPnl;
}

export const EMPTY_ACCOUNT: AccountSnapshot = {
  deployed: NO_CAPITAL_DEPLOYED,
  pnl: FLAT_PNL,
};

@Injectable()
export class RiskManagerService {
  private readonly logger = new Logger(RiskManagerService.name);

  /**
   * True once the loss breaker has tripped. Sticky for the session: a breaker
   * that un-halted when an unrealized mark recovered would flap in exactly the
   * volatility that tripped it. Cleared only by an explicit `resetBreaker()`,
   * which is an operator decision.
   */
  private breakerHalted = false;

  constructor(
    private readonly config: RiskConfig,
    private readonly mode: ExecutionMode,
    private readonly killSwitch: KillSwitchService = new KillSwitchService(),
    private readonly sink: RiskEventSink = new InMemoryRiskEventSink(),
  ) {}

  /**
   * The chokepoint. Every intent from every strategy passes through here.
   *
   * Emits exactly one `RiskEvent` for any non-approval and none for a clean
   * approval — the order log is the record of what was approved.
   */
  evaluate(intent: RiskIntent, account: AccountSnapshot = EMPTY_ACCOUNT): RiskDecision {
    const decision = this.decide(intent, account);
    const event = eventForDecision(decision);

    if (event) {
      this.sink.emit(event);
    }

    this.logDecision(decision);

    return decision;
  }

  /**
   * Evaluates a batch of intents against a *running* capital total.
   *
   * Necessary rather than convenient: five rungs firing on one bar, or eight
   * symbols dipping together, must not each be measured against the same
   * starting headroom. Evaluating them independently is precisely how the
   * broad-selloff case at `PRD.md:243` slips past a cap that each individual
   * intent satisfies.
   */
  evaluateBatch(intents: RiskIntent[], account: AccountSnapshot = EMPTY_ACCOUNT): RiskDecision[] {
    let running = account.deployed;
    const decisions: RiskDecision[] = [];

    for (const intent of intents) {
      const decision = this.evaluate(intent, { deployed: running, pnl: account.pnl });
      decisions.push(decision);

      if (decision.approvedQuantity > 0) {
        running = withIntentDeployed(running, intent, decision.approvedQuantity);
      }
    }

    return decisions;
  }

  /**
   * Whether the engine may submit at all, independent of any particular intent.
   *
   * `SHADOW` submits nothing by definition (`PRD.md:268`) — the intent is logged
   * with its full order payload and goes no further. This is the check the
   * Story 6 engine consults before handing an approved decision to a broker.
   */
  canSubmit(): boolean {
    return (
      this.mode !== ExecutionMode.SHADOW && !this.killSwitch.isEngaged() && !this.breakerHalted
    );
  }

  isHalted(): boolean {
    return this.breakerHalted;
  }

  /** Operator action, recorded. Not reachable on a timer. */
  resetBreaker(reason: string, at: string): void {
    this.breakerHalted = false;
    this.sink.emit({
      type: RiskEventType.HALT,
      reason: 'BREAKER_RESET',
      detail: `daily loss breaker reset: ${reason}`,
      timestamp: at,
      intent: null,
      approvedQuantity: null,
    });
  }

  private decide(intent: RiskIntent, account: AccountSnapshot): RiskDecision {
    const reject = (reason: RiskReason, detail: string): RiskDecision => ({
      outcome: RiskOutcome.REJECTED,
      reason,
      detail,
      intent,
      approvedQuantity: 0,
    });

    if (!Number.isFinite(intent.quantity) || intent.quantity <= 0) {
      return reject(
        RiskReason.INVALID_INTENT,
        `quantity must be a positive number, got ${intent.quantity}`,
      );
    }

    if (!Number.isFinite(intent.limitPrice) || intent.limitPrice <= 0) {
      return reject(
        RiskReason.INVALID_INTENT,
        `limitPrice must be a positive number, got ${intent.limitPrice}`,
      );
    }

    if (this.killSwitch.isEngaged()) {
      const state = this.killSwitch.snapshot();
      return reject(
        RiskReason.KILL_SWITCH,
        `kill switch engaged (${state.reason ?? 'no reason recorded'}) — no new submission`,
      );
    }

    // Evaluated every cycle rather than only while un-halted, so a breach trips
    // on the bar it happens. `breakerHalted` then keeps it tripped.
    const breaker = evaluateLossBreaker(account.pnl, this.config);

    if (breaker.halted && !this.breakerHalted) {
      this.breakerHalted = true;
      // The halt itself is its own event, distinct from the rejection of the
      // intent that happened to be in flight — one records the state change,
      // the other records what was refused because of it.
      this.sink.emit({
        type: RiskEventType.HALT,
        reason: RiskReason.DAILY_LOSS_HALT,
        detail: breaker.detail,
        timestamp: intent.timestamp,
        intent: null,
        approvedQuantity: null,
      });
      this.logger.warn(`daily loss breaker halted all strategies — ${breaker.detail}`);
    }

    if (this.breakerHalted) {
      return reject(
        RiskReason.DAILY_LOSS_HALT,
        `daily loss breaker has halted all strategies — ${breaker.detail}. ` +
          'Existing positions are held, not liquidated.',
      );
    }

    const capital = applyCapitalCap(intent, this.config, account.deployed);

    if (capital.approvedQuantity <= 0) {
      return reject(capital.reason, capital.detail);
    }

    if (capital.approvedQuantity < intent.quantity) {
      return {
        outcome: RiskOutcome.RESIZED,
        reason: capital.reason,
        detail: capital.detail,
        intent,
        approvedQuantity: capital.approvedQuantity,
      };
    }

    return {
      outcome: RiskOutcome.APPROVED,
      reason: capital.reason,
      detail: capital.detail,
      intent,
      approvedQuantity: capital.approvedQuantity,
    };
  }

  /**
   * In `SHADOW`, an approved decision is logged **with its full order payload**
   * and submitted nowhere (`PRD.md:268`). Logging the payload rather than a
   * summary is what makes shadow mode a real verification step — the Story 12
   * soak reconciles these lines against hand-calculated rung prices.
   */
  private logDecision(decision: RiskDecision): void {
    const { intent, outcome, approvedQuantity } = decision;
    const payload = {
      symbol: intent.symbol,
      side: intent.side,
      quantity: approvedQuantity,
      orderType: 'LMT',
      limitPrice: intent.limitPrice,
      timeInForce: 'DAY',
      notional: intentNotional({ quantity: approvedQuantity, limitPrice: intent.limitPrice }),
      strategyId: intent.strategyId,
      timestamp: intent.timestamp,
    };

    if (outcome === RiskOutcome.REJECTED) {
      this.logger.log(`REJECTED ${intent.symbol} — ${decision.detail}`);
      return;
    }

    const prefix = this.mode === ExecutionMode.SHADOW ? 'SHADOW (not submitted)' : this.mode;
    this.logger.log(`${prefix} ${outcome} ${JSON.stringify(payload)} — ${decision.detail}`);
  }
}

export type { RiskEvent };
