/**
 * `RiskEvent` — the audit record for everything the risk layer refuses,
 * shrinks, or halts.
 *
 * One event per rejection, resize, halt, and kill-switch activation
 * (`stories.md:340`). Approvals are deliberately *not* events: an approved
 * intent becomes an order, and the order log is that record. Emitting an event
 * per approval would bury the four things an operator actually needs to see in
 * a stream of routine traffic.
 *
 * Every field is plain and serializable — Story 8 persists these as rows, and
 * Story 6 serves them from `GET /risk-events`.
 */

import { RiskDecision, RiskIntent, RiskReason } from './types';

export enum RiskEventType {
  /** An intent was refused outright. */
  REJECTION = 'REJECTION',
  /** An intent was approved at a reduced quantity. */
  RESIZE = 'RESIZE',
  /** The daily loss breaker halted all strategies. */
  HALT = 'HALT',
  /** The kill switch was engaged or released. */
  KILL_SWITCH = 'KILL_SWITCH',
  /** A startup assertion refused a mode. */
  STARTUP_ASSERTION = 'STARTUP_ASSERTION',
}

export interface RiskEvent {
  type: RiskEventType;
  reason: RiskReason | string;
  /** Human-readable, naming the numbers that produced the outcome. */
  detail: string;
  /** ISO-8601 ET. Sourced from the intent's bar timestamp, never a clock. */
  timestamp: string;
  /** Null for events not tied to a specific intent (halts, kill switch). */
  intent: RiskIntent | null;
  /** Populated on RESIZE. Null otherwise. */
  approvedQuantity: number | null;
}

/**
 * The sink the risk manager writes events to.
 *
 * An interface, not a concrete logger, because Story 6 serves these over HTTP
 * and Story 8 persists them — the risk manager should not change when the
 * destination does.
 */
export interface RiskEventSink {
  emit(event: RiskEvent): void;
}

/**
 * In-memory sink. Real behaviour for SHADOW replay and the test suite, replaced
 * by a Prisma-backed implementation at Story 8 behind the same interface.
 */
export class InMemoryRiskEventSink implements RiskEventSink {
  private readonly events: RiskEvent[] = [];
  private readonly subscribers = new Set<(event: RiskEvent) => void>();

  emit(event: RiskEvent): void {
    this.events.push(event);
    this.subscribers.forEach((subscriber) => subscriber(event));
  }

  /**
   * Forwards every event to a listener as it is emitted. Returns an
   * unsubscribe function.
   *
   * How Story 6 gets risk events into the repository it serves over HTTP
   * without the risk layer depending on the repository layer — the dependency
   * points from engine to risk, never the reverse.
   */
  subscribe(listener: (event: RiskEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  all(): RiskEvent[] {
    return [...this.events];
  }

  ofType(type: RiskEventType): RiskEvent[] {
    return this.events.filter((event) => event.type === type);
  }

  clear(): void {
    this.events.length = 0;
  }
}

/**
 * Builds the event for a non-approved decision, or null when the decision was a
 * clean approval.
 *
 * Centralized so "exactly one event per rejection or resize" is a property of
 * one function rather than a discipline spread across the control modules.
 */
export function eventForDecision(decision: RiskDecision): RiskEvent | null {
  if (decision.outcome === 'APPROVED') {
    return null;
  }

  return {
    type: decision.outcome === 'RESIZED' ? RiskEventType.RESIZE : RiskEventType.REJECTION,
    reason: decision.reason,
    detail: decision.detail,
    timestamp: decision.intent.timestamp,
    intent: decision.intent,
    approvedQuantity: decision.outcome === 'RESIZED' ? decision.approvedQuantity : null,
  };
}
