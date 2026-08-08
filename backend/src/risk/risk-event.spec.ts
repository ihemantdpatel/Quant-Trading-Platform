import { eventForDecision, InMemoryRiskEventSink, RiskEvent, RiskEventType } from './risk-event';
import { RiskDecision, RiskIntent, RiskOutcome, RiskReason } from './types';

const intent: RiskIntent = {
  strategyId: 'dip-ladder',
  symbol: 'TQQQ',
  side: 'BUY',
  quantity: 100,
  limitPrice: 50,
  timestamp: '2026-03-02T10:00:00-05:00',
  reason: 'rung fired',
};

function decision(overrides: Partial<RiskDecision> = {}): RiskDecision {
  return {
    outcome: RiskOutcome.APPROVED,
    reason: RiskReason.WITHIN_LIMITS,
    detail: 'within limits',
    intent,
    approvedQuantity: 100,
    ...overrides,
  };
}

describe('eventForDecision', () => {
  it('produces no event for an approval', () => {
    expect(eventForDecision(decision())).toBeNull();
  });

  it('produces a REJECTION event carrying the reason and intent', () => {
    const event = eventForDecision(
      decision({
        outcome: RiskOutcome.REJECTED,
        reason: RiskReason.GLOBAL_CAPITAL_CAP,
        detail: 'cap exhausted',
        approvedQuantity: 0,
      }),
    );

    expect(event).toMatchObject({
      type: RiskEventType.REJECTION,
      reason: RiskReason.GLOBAL_CAPITAL_CAP,
      detail: 'cap exhausted',
      timestamp: intent.timestamp,
      approvedQuantity: null,
    });
    expect(event?.intent).toEqual(intent);
  });

  it('produces a RESIZE event carrying the approved quantity', () => {
    const event = eventForDecision(
      decision({
        outcome: RiskOutcome.RESIZED,
        reason: RiskReason.PER_SYMBOL_LIMIT,
        approvedQuantity: 40,
      }),
    );

    expect(event?.type).toBe(RiskEventType.RESIZE);
    expect(event?.approvedQuantity).toBe(40);
  });

  it('sources the timestamp from the intent, never a clock', () => {
    // Clock-free keeps replay deterministic and the audit trail aligned with
    // the bar that caused the decision.
    const event = eventForDecision(decision({ outcome: RiskOutcome.REJECTED }));

    expect(event?.timestamp).toBe(intent.timestamp);
  });
});

describe('InMemoryRiskEventSink', () => {
  let sink: InMemoryRiskEventSink;

  const event = (type: RiskEventType): RiskEvent => ({
    type,
    reason: 'TEST',
    detail: 'detail',
    timestamp: intent.timestamp,
    intent: null,
    approvedQuantity: null,
  });

  beforeEach(() => {
    sink = new InMemoryRiskEventSink();
  });

  it('records events in order', () => {
    sink.emit(event(RiskEventType.HALT));
    sink.emit(event(RiskEventType.REJECTION));

    expect(sink.all().map((e) => e.type)).toEqual([RiskEventType.HALT, RiskEventType.REJECTION]);
  });

  it('filters by type', () => {
    sink.emit(event(RiskEventType.HALT));
    sink.emit(event(RiskEventType.REJECTION));
    sink.emit(event(RiskEventType.HALT));

    expect(sink.ofType(RiskEventType.HALT)).toHaveLength(2);
  });

  it('returns a copy so callers cannot mutate the log', () => {
    sink.emit(event(RiskEventType.HALT));
    sink.all().push(event(RiskEventType.REJECTION));

    expect(sink.all()).toHaveLength(1);
  });

  it('clears', () => {
    sink.emit(event(RiskEventType.HALT));
    sink.clear();

    expect(sink.all()).toEqual([]);
  });

  describe('subscribe', () => {
    /**
     * How Story 6 forwards risk events into the repository it serves over HTTP
     * without the risk layer depending on the repository layer — the dependency
     * points from engine to risk, never the reverse.
     */
    it('forwards every emitted event to a listener', () => {
      const received: RiskEventType[] = [];
      sink.subscribe((e) => received.push(e.type));

      sink.emit(event(RiskEventType.HALT));
      sink.emit(event(RiskEventType.REJECTION));

      expect(received).toEqual([RiskEventType.HALT, RiskEventType.REJECTION]);
    });

    it('still records the event itself, not only forwards it', () => {
      sink.subscribe(() => undefined);
      sink.emit(event(RiskEventType.HALT));

      expect(sink.all()).toHaveLength(1);
    });

    it('supports several listeners', () => {
      let first = 0;
      let second = 0;
      sink.subscribe(() => (first += 1));
      sink.subscribe(() => (second += 1));

      sink.emit(event(RiskEventType.HALT));

      expect(first).toBe(1);
      expect(second).toBe(1);
    });

    it('stops forwarding after unsubscribe', () => {
      const received: RiskEventType[] = [];
      const unsubscribe = sink.subscribe((e) => received.push(e.type));

      unsubscribe();
      sink.emit(event(RiskEventType.HALT));

      expect(received).toEqual([]);
    });
  });

  it('round-trips an event through JSON — Story 8 persists these as rows', () => {
    const original: RiskEvent = { ...event(RiskEventType.RESIZE), intent, approvedQuantity: 40 };
    sink.emit(original);

    expect(JSON.parse(JSON.stringify(sink.all()[0]))).toEqual(original);
  });
});
