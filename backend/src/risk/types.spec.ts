import {
  intentNotional,
  isApproved,
  isSubmittable,
  RiskDecision,
  RiskIntent,
  RiskOutcome,
  RiskReason,
  roundToCents,
} from './types';

const intent: RiskIntent = {
  strategyId: 'dip-ladder',
  symbol: 'TQQQ',
  side: 'BUY',
  quantity: 100,
  limitPrice: 50.125,
  timestamp: '2026-03-02T10:00:00-05:00',
  reason: 'rung fired',
};

describe('intentNotional', () => {
  it('multiplies quantity by the limit price', () => {
    expect(intentNotional({ quantity: 100, limitPrice: 50 })).toBe(5_000);
  });

  it('rounds to cents so float drift cannot accumulate across a batch', () => {
    expect(intentNotional({ quantity: 3, limitPrice: 0.1 })).toBe(0.3);
    expect(intentNotional(intent)).toBe(5_012.5);
  });

  it('is zero for a zero quantity', () => {
    expect(intentNotional({ quantity: 0, limitPrice: 50 })).toBe(0);
  });
});

describe('decision predicates', () => {
  const decision = (overrides: Partial<RiskDecision>): RiskDecision => ({
    outcome: RiskOutcome.APPROVED,
    reason: RiskReason.WITHIN_LIMITS,
    detail: '',
    intent,
    approvedQuantity: 100,
    ...overrides,
  });

  it('isApproved is true only for a full approval', () => {
    expect(isApproved(decision({}))).toBe(true);
    expect(isApproved(decision({ outcome: RiskOutcome.RESIZED, approvedQuantity: 50 }))).toBe(
      false,
    );
    expect(isApproved(decision({ outcome: RiskOutcome.REJECTED, approvedQuantity: 0 }))).toBe(
      false,
    );
  });

  it('isSubmittable is true for approvals and resizes, false for rejections', () => {
    // A resize is still an order to place, just a smaller one.
    expect(isSubmittable(decision({}))).toBe(true);
    expect(isSubmittable(decision({ outcome: RiskOutcome.RESIZED, approvedQuantity: 50 }))).toBe(
      true,
    );
    expect(isSubmittable(decision({ outcome: RiskOutcome.REJECTED, approvedQuantity: 0 }))).toBe(
      false,
    );
  });
});

describe('roundToCents', () => {
  it('rounds to two decimals', () => {
    expect(roundToCents(1.006)).toBe(1.01);
    expect(roundToCents(1.004)).toBe(1);
    expect(roundToCents(-1.24)).toBe(-1.24);
  });

  it('collapses binary float drift', () => {
    // The reason notional is rounded at all: 0.1 × 3 is 0.30000000000000004,
    // and that error accumulates across a batch evaluated against a cap.
    expect(roundToCents(0.1 * 3)).toBe(0.3);
    expect(roundToCents(50.125 * 100)).toBe(5_012.5);
  });
});
