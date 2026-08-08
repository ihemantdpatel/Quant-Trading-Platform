import { Bar, BarSize, Fixture } from '../../types';
import { assertInvariants, checkInvariants } from './invariants';

/**
 * Exercises the failure paths. A fixture invariant checker that cannot detect a
 * broken fixture is worthless — these tests prove it reports rather than passes.
 */
const bar = (timestamp: string, open: number, close: number): Bar => ({
  symbol: 'TQQQ',
  barSize: BarSize.FIVE_MIN,
  timestamp,
  open,
  high: Math.max(open, close),
  low: Math.min(open, close),
  close,
  volume: 1000,
});

const fixtureOf = (bars: Bar[], invariants: Fixture['invariants']): Fixture => ({
  name: 'synthetic',
  symbol: 'TQQQ',
  barSize: BarSize.FIVE_MIN,
  expectation: 'synthetic fixture used to exercise the invariant checker',
  invariants,
  bars,
});

describe('invariant failure detection', () => {
  it('fails minBarCount when there are too few bars', () => {
    const fixture = fixtureOf(
      [bar('2025-01-02T09:30:00.000-05:00', 100, 100)],
      [{ kind: 'minBarCount', value: 10 }],
    );

    expect(checkInvariants(fixture)[0].passed).toBe(false);
    expect(() => assertInvariants(fixture)).toThrow(/violates its invariants/);
  });

  it('fails closesBelowFirstBarByPct when the decline is too shallow', () => {
    const fixture = fixtureOf(
      [bar('2025-01-02T09:30:00.000-05:00', 100, 99), bar('2025-01-02T09:35:00.000-05:00', 99, 98)],
      [{ kind: 'closesBelowFirstBarByPct', value: 25 }],
    );

    expect(checkInvariants(fixture)[0].passed).toBe(false);
  });

  it('reports "no gap-down session found" when every session opens flat or up', () => {
    const fixture = fixtureOf(
      [
        bar('2025-01-02T09:30:00.000-05:00', 100, 100),
        // Next session opens above the prior close — no gap down anywhere.
        bar('2025-01-03T09:30:00.000-05:00', 101, 102),
      ],
      [{ kind: 'recoversToPreviousClose' }],
    );

    const result = checkInvariants(fixture)[0];
    expect(result.passed).toBe(false);
    expect(result.detail).toBe('no gap-down session found');
  });

  it('fails recoversToPreviousClose when price gaps down and never recovers', () => {
    const fixture = fixtureOf(
      [
        bar('2025-01-02T09:30:00.000-05:00', 100, 100),
        bar('2025-01-03T09:30:00.000-05:00', 96, 95),
      ],
      [{ kind: 'recoversToPreviousClose' }],
    );

    expect(checkInvariants(fixture)[0].passed).toBe(false);
  });

  it('fails gapDownFromPreviousClosePct when sessions are contiguous', () => {
    const fixture = fixtureOf(
      [
        bar('2025-01-02T09:30:00.000-05:00', 100, 100),
        bar('2025-01-02T09:35:00.000-05:00', 100, 100),
      ],
      [{ kind: 'gapDownFromPreviousClosePct', value: 4 }],
    );

    expect(checkInvariants(fixture)[0].passed).toBe(false);
  });

  it('fails containsSessionTime when the bar is absent', () => {
    const fixture = fixtureOf(
      [bar('2025-01-02T09:30:00.000-05:00', 100, 100)],
      [{ kind: 'containsSessionTime', time: '09:45' }],
    );

    const result = checkInvariants(fixture)[0];
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/absent/);
  });

  it('fails pre/post-market checks when no such bars exist', () => {
    const fixture = fixtureOf(
      [bar('2025-01-02T10:30:00.000-05:00', 100, 100)],
      [{ kind: 'containsPreMarketBars' }, { kind: 'containsPostMarketBars' }],
    );

    const results = checkInvariants(fixture);
    expect(results[0].passed).toBe(false);
    expect(results[1].passed).toBe(false);
  });

  it('fails bandCrossings when price never traverses the band', () => {
    const fixture = fixtureOf(
      [bar('2025-01-02T09:30:00.000-05:00', 94, 94)],
      [{ kind: 'bandCrossings', low: 90, high: 98, minCrossings: 3 }],
    );

    expect(checkInvariants(fixture)[0].passed).toBe(false);
  });

  it('lists every failing invariant in one error', () => {
    const fixture = fixtureOf(
      [bar('2025-01-02T09:30:00.000-05:00', 100, 100)],
      [{ kind: 'minBarCount', value: 50 }, { kind: 'containsPreMarketBars' }],
    );

    expect(() => assertInvariants(fixture)).toThrow(/minBarCount/);
    expect(() => assertInvariants(fixture)).toThrow(/containsPreMarketBars/);
  });

  it('passes silently when every invariant holds', () => {
    const fixture = fixtureOf(
      [bar('2025-01-02T09:30:00.000-05:00', 100, 100)],
      [{ kind: 'minBarCount', value: 1 }],
    );

    expect(() => assertInvariants(fixture)).not.toThrow();
  });
});
