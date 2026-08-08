import { BrokerOrder } from '../broker/broker-adapter.interface';
import { equityContract } from '../domain/contract';
import { Bar, BarSize } from '../market-data/types';
import {
  applySlippage,
  commissionFor,
  DEFAULT_FILL_MODEL_CONFIG,
  evaluateFill,
  tradesThrough,
} from './fill-model';

function bar(overrides: Partial<Bar> = {}): Bar {
  return {
    symbol: 'TQQQ',
    barSize: BarSize.FIVE_MIN,
    timestamp: '2025-01-02T10:00:00.000-05:00',
    open: 50,
    high: 51,
    low: 49,
    close: 50.5,
    volume: 1_000_000,
    ...overrides,
  };
}

function order(overrides: Partial<BrokerOrder> = {}): BrokerOrder {
  return {
    clientOrderId: 'co-1',
    contract: equityContract('TQQQ'),
    side: 'BUY',
    quantity: 100,
    orderType: 'LMT',
    limitPrice: 49.5,
    timeInForce: 'DAY',
    timestamp: '2025-01-02T10:00:00.000-05:00',
    ...overrides,
  };
}

describe('fill model — limit fills only when price trades through', () => {
  it('fills a BUY when the bar low reaches the limit', () => {
    expect(tradesThrough(order({ limitPrice: 49.5 }), bar({ low: 49 }))).toBe(true);
  });

  it('does not fill a BUY when the bar low stayed above the limit', () => {
    const decision = evaluateFill(order({ limitPrice: 48 }), bar({ low: 49 }));

    expect(decision.filled).toBe(false);
    expect(decision.price).toBeNull();
    expect(decision.reason).toContain('did not trade through');
  });

  it('fills a SELL when the bar high reaches the limit', () => {
    expect(tradesThrough(order({ side: 'SELL', limitPrice: 50.5 }), bar({ high: 51 }))).toBe(true);
  });

  it('does not fill a SELL when the bar high stayed below the limit', () => {
    const decision = evaluateFill(order({ side: 'SELL', limitPrice: 52 }), bar({ high: 51 }));

    expect(decision.filled).toBe(false);
    expect(decision.reason).toContain('did not trade through');
  });

  it('treats an exact touch as a fill — the documented optimistic reading', () => {
    expect(tradesThrough(order({ limitPrice: 49 }), bar({ low: 49 }))).toBe(true);
    expect(tradesThrough(order({ side: 'SELL', limitPrice: 51 }), bar({ high: 51 }))).toBe(true);
  });

  it('a bar that closed below the limit but never traded there does not fill', () => {
    // The case the touch rule exists for: close is below the limit, but the
    // bar's own low never reached it — impossible in reality, and a fill here
    // would award a price that never printed.
    const decision = evaluateFill(order({ limitPrice: 40 }), bar({ low: 49, close: 49.2 }));

    expect(decision.filled).toBe(false);
  });

  it('a market order always trades', () => {
    expect(tradesThrough(order({ orderType: 'MKT' }), bar({ low: 100, high: 200 }))).toBe(true);
  });

  it('fills at the limit price, not the bar close', () => {
    const decision = evaluateFill(order({ limitPrice: 49.5 }), bar({ low: 48, close: 48.2 }), {
      ...DEFAULT_FILL_MODEL_CONFIG,
      slippagePercent: 0,
    });

    expect(decision.price).toBe(49.5);
  });

  it('prices a market order at the bar close', () => {
    const decision = evaluateFill(order({ orderType: 'MKT' }), bar({ close: 50.5 }), {
      ...DEFAULT_FILL_MODEL_CONFIG,
      slippagePercent: 0,
    });

    expect(decision.price).toBe(50.5);
  });

  it('rejects a zero-quantity order rather than filling it', () => {
    const decision = evaluateFill(order({ quantity: 0 }), bar());

    expect(decision.filled).toBe(false);
    expect(decision.commission).toBe(0);
    expect(decision.reason).toBe('zero quantity');
  });

  it('fills without a touch when requireTouch is off', () => {
    const decision = evaluateFill(order({ limitPrice: 10 }), bar({ low: 49 }), {
      ...DEFAULT_FILL_MODEL_CONFIG,
      requireTouch: false,
    });

    expect(decision.filled).toBe(true);
  });
});

describe('fill model — slippage always works against the order', () => {
  it('raises a BUY fill price', () => {
    expect(applySlippage(100, 'BUY', 0.001)).toBe(100.1);
  });

  it('lowers a SELL fill price', () => {
    expect(applySlippage(100, 'SELL', 0.001)).toBe(99.9);
  });

  it('is a no-op at zero', () => {
    expect(applySlippage(100, 'BUY', 0)).toBe(100);
    expect(applySlippage(100, 'SELL', 0)).toBe(100);
  });

  it('costs the order in both directions on a real fill', () => {
    const buy = evaluateFill(order({ limitPrice: 50 }), bar({ low: 49 }));
    const sell = evaluateFill(order({ side: 'SELL', limitPrice: 50 }), bar({ high: 51 }));

    expect(buy.price!).toBeGreaterThan(50);
    expect(sell.price!).toBeLessThan(50);
  });
});

describe('fill model — commission', () => {
  it('charges the per-share rate above the minimum', () => {
    // 1000 shares × $0.0035 = $3.50, above the $1.00 floor.
    expect(commissionFor(1000, DEFAULT_FILL_MODEL_CONFIG)).toBe(3.5);
  });

  it('applies the per-order minimum on a small order', () => {
    // 100 shares × $0.0035 = $0.35, floored to $1.00.
    expect(commissionFor(100, DEFAULT_FILL_MODEL_CONFIG)).toBe(1);
  });

  it('is zero for a zero-quantity order rather than charging the minimum', () => {
    expect(commissionFor(0, DEFAULT_FILL_MODEL_CONFIG)).toBe(0);
  });

  it('is always positive on a fill', () => {
    const decision = evaluateFill(order(), bar({ low: 48 }));

    expect(decision.commission).toBeGreaterThan(0);
  });
});
