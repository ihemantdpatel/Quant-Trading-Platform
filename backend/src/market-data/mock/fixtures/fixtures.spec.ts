import { isOnBarBoundary, toEt } from '../../session';
import { BarSize } from '../../types';
import { allFixtures, FIXTURE_NAMES, isFixtureName, loadFixture } from './index';
import { assertInvariants, checkInvariants, countBandCrossings } from './invariants';

describe('fixtures', () => {
  it('exposes all five scenarios named in stories.md', () => {
    expect(FIXTURE_NAMES).toEqual([
      'gap-down-open',
      'gap-down-recover',
      'steady-decline',
      'chop-range',
      'session-edges',
    ]);
  });

  describe.each(FIXTURE_NAMES)('%s', (name) => {
    const fixture = loadFixture(name);

    it('loads with a documented expectation and at least one invariant', () => {
      expect(fixture.name).toBe(name);
      expect(fixture.symbol).toBe('TQQQ');
      expect(fixture.expectation.length).toBeGreaterThan(40);
      expect(fixture.invariants.length).toBeGreaterThan(0);
    });

    // The story's core requirement: each fixture satisfies what it claims.
    it('satisfies every documented invariant', () => {
      const results = checkInvariants(fixture);

      for (const result of results) {
        expect(`${result.invariant.kind}: ${result.detail}`).toBe(
          result.passed ? `${result.invariant.kind}: ${result.detail}` : 'PASS',
        );
      }
      expect(() => assertInvariants(fixture)).not.toThrow();
    });

    it('has bars in strict timestamp order with no duplicates', () => {
      const times = fixture.bars.map((b) => toEt(b.timestamp).toMillis());

      for (let i = 1; i < times.length; i += 1) {
        expect(times[i]).toBeGreaterThan(times[i - 1]);
      }
      expect(new Set(times).size).toBe(times.length);
    });

    it('has internally consistent OHLC on every bar', () => {
      for (const bar of fixture.bars) {
        expect(bar.high).toBeGreaterThanOrEqual(Math.max(bar.open, bar.close));
        expect(bar.low).toBeLessThanOrEqual(Math.min(bar.open, bar.close));
        expect(bar.volume).toBeGreaterThan(0);
        expect(bar.symbol).toBe(fixture.symbol);
        expect(bar.barSize).toBe(BarSize.FIVE_MIN);
      }
    });

    it('places every bar on a 5-minute boundary in ET', () => {
      for (const bar of fixture.bars) {
        expect(isOnBarBoundary(bar.timestamp, BarSize.FIVE_MIN)).toBe(true);
      }
    });
  });

  describe('scenario-specific expectations', () => {
    it('gap-down-open gaps ~4% below the prior close and does not recover', () => {
      const bars = loadFixture('gap-down-open').bars;
      const day1 = bars.filter((b) => b.timestamp.startsWith('2025-01-02'));
      const day2 = bars.filter((b) => b.timestamp.startsWith('2025-01-03'));

      const priorClose = day1[day1.length - 1].close;
      const gappedOpen = day2[0].open;

      expect(priorClose).toBeCloseTo(100, 1);
      expect(gappedOpen).toBeCloseTo(96, 1);
      expect((priorClose - gappedOpen) / priorClose).toBeCloseTo(0.04, 2);
      // Never regains the prior close — that is the -recover fixture's job.
      expect(Math.max(...day2.map((b) => b.high))).toBeLessThan(priorClose);
    });

    it('gap-down-recover gaps down then trades back above the prior close', () => {
      const bars = loadFixture('gap-down-recover').bars;
      const day1 = bars.filter((b) => b.timestamp.startsWith('2025-01-02'));
      const day2 = bars.filter((b) => b.timestamp.startsWith('2025-01-03'));

      const priorClose = day1[day1.length - 1].close;

      expect(day2[0].open).toBeCloseTo(96, 1);
      expect(Math.max(...day2.map((b) => b.high))).toBeGreaterThan(priorClose);
      expect(day2[day2.length - 1].close).toBeGreaterThan(priorClose);
    });

    it('steady-decline falls more than 25% below its first bar', () => {
      const bars = loadFixture('steady-decline').bars;
      const drop = (bars[0].open - bars[bars.length - 1].close) / bars[0].open;

      expect(drop).toBeGreaterThan(0.25);
    });

    it('chop-range crosses its band at least 3 times', () => {
      const bars = loadFixture('chop-range').bars;

      expect(countBandCrossings(bars, 90, 98)).toBeGreaterThanOrEqual(3);
    });

    it('session-edges includes the boundary bars Story 3 needs', () => {
      const bars = loadFixture('session-edges').bars;
      const times = new Set(bars.map((b) => toEt(b.timestamp).toFormat('HH:mm')));

      // 09:44 is not a 5-minute boundary; the bar covering it opens at 09:40.
      expect(times.has('09:30')).toBe(true);
      expect(times.has('09:40')).toBe(true);
      expect(times.has('09:45')).toBe(true);
      expect(times.has('15:55')).toBe(true);
      expect(times.has('16:00')).toBe(true);
      expect(times.has('08:00')).toBe(true);
      expect(times.has('17:00')).toBe(true);
    });
  });

  describe('loadFixture', () => {
    it('returns all five from allFixtures', () => {
      expect(allFixtures()).toHaveLength(5);
    });

    it('throws a helpful error naming valid options', () => {
      expect(() => loadFixture('nonexistent')).toThrow(/Unknown fixture "nonexistent"/);
      expect(() => loadFixture('nonexistent')).toThrow(/chop-range/);
    });

    it('narrows valid names', () => {
      expect(isFixtureName('chop-range')).toBe(true);
      expect(isFixtureName('nope')).toBe(false);
    });
  });

  describe('countBandCrossings', () => {
    it('counts full traversals, not touches', () => {
      const bar = (close: number) => ({
        symbol: 'T',
        barSize: BarSize.FIVE_MIN,
        timestamp: '2025-01-02T09:30:00.000-05:00',
        open: close,
        high: close,
        low: close,
        close,
        volume: 1,
      });

      // below → above → below = 2 crossings
      expect(countBandCrossings([bar(89), bar(99), bar(89)], 90, 98)).toBe(2);
      // never reaches the far side
      expect(countBandCrossings([bar(89), bar(94), bar(89)], 90, 98)).toBe(0);
    });

    it('does not count an initial exit from inside the band', () => {
      const bar = (close: number) => ({
        symbol: 'T',
        barSize: BarSize.FIVE_MIN,
        timestamp: '2025-01-02T09:30:00.000-05:00',
        open: close,
        high: close,
        low: close,
        close,
        volume: 1,
      });

      expect(countBandCrossings([bar(94), bar(99)], 90, 98)).toBe(0);
    });
  });
});
