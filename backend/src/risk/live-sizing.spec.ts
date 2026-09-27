import { ExecutionMode } from '../config/execution-mode';
import { applyLiveSizing } from './live-sizing';
import { RiskIntent } from './types';

function intent(overrides: Partial<RiskIntent> = {}): RiskIntent {
  return {
    strategyId: 'grid:TQQQ',
    symbol: 'TQQQ',
    side: 'BUY',
    quantity: 50,
    limitPrice: 72,
    timestamp: '2026-09-28T10:00:00-04:00',
    reason: 'level',
    ...overrides,
  };
}

describe('applyLiveSizing', () => {
  it('scales a LIVE buy and floors to whole shares', () => {
    const sizing = applyLiveSizing(intent(), ExecutionMode.LIVE, 0.25);

    // 50 × 0.25 = 12.5 → 12. Rounding up would exceed the reduced size.
    expect(sizing.quantity).toBe(12);
    expect(sizing.detail).toContain('50 → 12');
  });

  it('leaves PAPER untouched — the reduction is for real money only', () => {
    expect(applyLiveSizing(intent(), ExecutionMode.PAPER, 0.25)).toEqual({
      quantity: 50,
      detail: null,
    });
  });

  it('never scales a sell, which must cover the whole lot that filled', () => {
    expect(applyLiveSizing(intent({ side: 'SELL' }), ExecutionMode.LIVE, 0.25).quantity).toBe(50);
  });

  it('is a no-op at full size', () => {
    expect(applyLiveSizing(intent(), ExecutionMode.LIVE, 1).detail).toBeNull();
  });

  it('can floor to zero, which the caller must treat as nothing to submit', () => {
    expect(applyLiveSizing(intent({ quantity: 3 }), ExecutionMode.LIVE, 0.25).quantity).toBe(0);
  });
});
