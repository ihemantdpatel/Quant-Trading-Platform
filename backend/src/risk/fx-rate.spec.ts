import { convertEquity, FX_MAX_AGE_MS, FxRateBook, FxStatus, isUsableRate } from './fx-rate';

const T0 = Date.UTC(2026, 8, 28, 14, 0, 0);

function book(now: { t: number }): FxRateBook {
  return new FxRateBook('USD', 'CAD', () => now.t);
}

describe('FxRateBook', () => {
  it('is UNAVAILABLE before any quote, never a default rate', () => {
    const snapshot = book({ t: T0 }).snapshot();

    expect(snapshot.status).toBe(FxStatus.UNAVAILABLE);
    expect(snapshot.rate).toBeNull();
    expect(snapshot.pair).toBe('USD.CAD');
  });

  it('is FRESH up to the max age and STALE one millisecond past it', () => {
    const clock = { t: T0 };
    const fx = book(clock);
    fx.record({ base: 'USD', quote: 'CAD', rate: 1.3874, receivedAt: T0 });

    clock.t = T0 + FX_MAX_AGE_MS;
    expect(fx.snapshot().status).toBe(FxStatus.FRESH);

    clock.t = T0 + FX_MAX_AGE_MS + 1;
    expect(fx.snapshot().status).toBe(FxStatus.STALE);
    // A stale quote still reports its rate and age so an operator can see what
    // it was, but the status is what the risk manager decides on.
    expect(fx.snapshot().rate).toBe(1.3874);
    expect(fx.snapshot().ageMs).toBe(FX_MAX_AGE_MS + 1);
  });

  it('ages a future-stamped quote at zero rather than negative', () => {
    const fx = book({ t: T0 });
    fx.record({ base: 'USD', quote: 'CAD', rate: 1.38, receivedAt: T0 + 5_000 });

    expect(fx.snapshot().ageMs).toBe(0);
  });

  it.each([0, -1.38, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses unusable rate %p and keeps the previous quote ageing',
    (bad) => {
      const clock = { t: T0 };
      const fx = book(clock);
      fx.record({ base: 'USD', quote: 'CAD', rate: 1.3874, receivedAt: T0 });

      clock.t = T0 + 60_000;
      fx.record({ base: 'USD', quote: 'CAD', rate: bad, receivedAt: clock.t });

      const snapshot = fx.snapshot();
      expect(snapshot.rate).toBe(1.3874);
      // Not refreshed by the bad reading: the age is still measured from T0.
      expect(snapshot.ageMs).toBe(60_000);
      expect(snapshot.lastError).toContain('unusable');
    },
  );

  it('refuses a quote for the wrong pair', () => {
    const fx = book({ t: T0 });
    fx.record({ base: 'CAD', quote: 'USD', rate: 0.72, receivedAt: T0 });

    expect(fx.snapshot().status).toBe(FxStatus.UNAVAILABLE);
    expect(fx.snapshot().lastError).toBe('received CAD.USD, expected USD.CAD');
  });

  it('keeps the last failure next to a quote, and clears it on a good reading', () => {
    const fx = book({ t: T0 });
    fx.recordFailure('IB not connected');
    expect(fx.snapshot().lastError).toBe('IB not connected');

    fx.record({ base: 'USD', quote: 'CAD', rate: 1.38, receivedAt: T0 });
    expect(fx.snapshot().lastError).toBeNull();
    expect(fx.snapshot().receivedAt).toBe(new Date(T0).toISOString());
  });
});

describe('isUsableRate', () => {
  it('accepts only finite positive rates', () => {
    expect(isUsableRate(1.38)).toBe(true);
    expect(isUsableRate(0)).toBe(false);
    expect(isUsableRate(Number.NaN)).toBe(false);
  });
});

describe('convertEquity', () => {
  it('passes equity through untouched when no conversion is needed, even with no book', () => {
    expect(convertEquity(175_000, 'USD', 'USD', null)).toEqual({
      ok: true,
      equity: 175_000,
      detail: null,
    });
  });

  it('divides CAD equity by the USD.CAD rate', () => {
    const fx = book({ t: T0 });
    fx.record({ base: 'USD', quote: 'CAD', rate: 1.3874, receivedAt: T0 });

    const result = convertEquity(242_800, 'CAD', 'USD', fx);

    expect(result.ok).toBe(true);
    // 242,800 / 1.3874 = 175,003.60 — the Story 13 figure, now derived live.
    expect(result.ok && result.equity).toBeCloseTo(175_003.6, 2);
  });

  it('tightens the cap when CAD weakens — the drift the hand conversion missed', () => {
    const fx = book({ t: T0 });
    fx.record({ base: 'USD', quote: 'CAD', rate: 1.45, receivedAt: T0 });

    const result = convertEquity(242_800, 'CAD', 'USD', fx);

    expect(result.ok && result.equity).toBeLessThan(175_000);
  });

  it('refuses with no book configured', () => {
    const result = convertEquity(242_800, 'CAD', 'USD', null);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.detail).toContain('no USD.CAD rate source');
  });

  it('refuses a book for a different pair', () => {
    const result = convertEquity(242_800, 'CAD', 'USD', new FxRateBook('USD', 'EUR'));

    expect(result.ok).toBe(false);
  });

  it('refuses before any quote has arrived', () => {
    const result = convertEquity(242_800, 'CAD', 'USD', book({ t: T0 }));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.detail).toContain('never received');
  });

  it('refuses a stale quote rather than using the cached rate', () => {
    const clock = { t: T0 };
    const fx = book(clock);
    fx.record({ base: 'USD', quote: 'CAD', rate: 1.3874, receivedAt: T0 });
    fx.recordFailure('IB did not respond');
    clock.t = T0 + FX_MAX_AGE_MS + 1_000;

    const result = convertEquity(242_800, 'CAD', 'USD', fx);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.detail).toContain('stale (181s old)');
    expect(!result.ok && result.detail).toContain('IB did not respond');
  });
});
