import { DateTime } from 'luxon';
import {
  formatEt,
  isOnBarBoundary,
  isPostMarket,
  isPreMarket,
  isRegularSession,
  nextSessionDay,
  parseEtDate,
  sessionBarTimes,
  toEt,
} from './session';
import { BarSize } from './types';

describe('session helpers', () => {
  describe('isRegularSession', () => {
    it.each([
      ['2025-01-02T09:29:00.000-05:00', false],
      ['2025-01-02T09:30:00.000-05:00', true],
      ['2025-01-02T09:45:00.000-05:00', true],
      ['2025-01-02T15:55:00.000-05:00', true],
      // Half-open on the close: a bar opening at 16:00 is post-market.
      ['2025-01-02T16:00:00.000-05:00', false],
    ])('%s → %s', (timestamp, expected) => {
      expect(isRegularSession(timestamp)).toBe(expected);
    });
  });

  it('classifies pre- and post-market bars', () => {
    expect(isPreMarket('2025-01-02T08:00:00.000-05:00')).toBe(true);
    expect(isPreMarket('2025-01-02T09:30:00.000-05:00')).toBe(false);
    expect(isPostMarket('2025-01-02T16:30:00.000-05:00')).toBe(true);
    expect(isPostMarket('2025-01-02T15:55:00.000-05:00')).toBe(false);
  });

  describe('isOnBarBoundary', () => {
    it('accepts 5-minute boundaries and rejects off-boundary times', () => {
      expect(isOnBarBoundary('2025-01-02T09:35:00.000-05:00', BarSize.FIVE_MIN)).toBe(true);
      expect(isOnBarBoundary('2025-01-02T09:37:00.000-05:00', BarSize.FIVE_MIN)).toBe(false);
    });

    it('rejects timestamps carrying seconds or milliseconds', () => {
      expect(isOnBarBoundary('2025-01-02T09:35:30.000-05:00', BarSize.FIVE_MIN)).toBe(false);
      expect(isOnBarBoundary('2025-01-02T09:35:00.500-05:00', BarSize.FIVE_MIN)).toBe(false);
    });

    it('stamps daily bars at the opening bell', () => {
      expect(isOnBarBoundary('2025-01-02T09:30:00.000-05:00', BarSize.DAILY)).toBe(true);
      expect(isOnBarBoundary('2025-01-02T16:00:00.000-05:00', BarSize.DAILY)).toBe(false);
    });

    /**
     * The DST cases the story calls for. US transitions happen at 02:00 ET, so
     * session bars must stay on clean wall-clock boundaries either side even
     * though the UTC offset moves by an hour.
     */
    it('holds across the spring-forward transition (2025-03-09)', () => {
      // Friday before: EST (-05:00). Monday after: EDT (-04:00).
      expect(isOnBarBoundary('2025-03-07T09:35:00.000-05:00', BarSize.FIVE_MIN)).toBe(true);
      expect(isOnBarBoundary('2025-03-10T09:35:00.000-04:00', BarSize.FIVE_MIN)).toBe(true);
    });

    it('holds across the fall-back transition (2025-11-02)', () => {
      expect(isOnBarBoundary('2025-10-31T09:35:00.000-04:00', BarSize.FIVE_MIN)).toBe(true);
      expect(isOnBarBoundary('2025-11-03T09:35:00.000-05:00', BarSize.FIVE_MIN)).toBe(true);
    });

    it('treats an off-boundary UTC instant as off-boundary in ET too', () => {
      // 14:32Z is 09:32 ET — a real instant that is not a 5-minute boundary.
      expect(isOnBarBoundary('2025-01-02T14:32:00.000Z', BarSize.FIVE_MIN)).toBe(false);
    });
  });

  describe('sessionBarTimes', () => {
    it('produces 78 bars from 09:30 to 15:55 inclusive', () => {
      const times = sessionBarTimes(parseEtDate('2025-01-02'));

      expect(times).toHaveLength(78);
      expect(times[0].toFormat('HH:mm')).toBe('09:30');
      expect(times[77].toFormat('HH:mm')).toBe('15:55');
    });

    it('every generated time is on a 5-minute boundary within the session', () => {
      const times = sessionBarTimes(parseEtDate('2025-01-02'));

      for (const t of times) {
        const iso = formatEt(t);
        expect(isOnBarBoundary(iso, BarSize.FIVE_MIN)).toBe(true);
        expect(isRegularSession(iso)).toBe(true);
      }
    });

    it('keeps wall-clock times stable on a DST transition day', () => {
      // 2025-03-09 is the spring-forward date; the session that follows must
      // still open at 09:30 ET, now at a -04:00 offset.
      const times = sessionBarTimes(parseEtDate('2025-03-10'));

      expect(times[0].toFormat('HH:mm')).toBe('09:30');
      expect(times[0].offset).toBe(-240);
      expect(times[77].toFormat('HH:mm')).toBe('15:55');
    });
  });

  describe('nextSessionDay', () => {
    it('advances one weekday and skips weekends', () => {
      const friday = parseEtDate('2025-01-03');

      expect(nextSessionDay(friday).toISODate()).toBe('2025-01-06');
    });

    it('preserves wall-clock time across a DST boundary', () => {
      // Friday → Monday, crossing the Sunday 02:00 spring-forward.
      const cursor = nextSessionDay(
        parseEtDate('2025-03-07').set({ hour: 9, minute: 30 }) as DateTime<true>,
      );

      expect(cursor.toISODate()).toBe('2025-03-10');
      expect(cursor.toFormat('HH:mm')).toBe('09:30');
      expect(cursor.offset).toBe(-240);
    });
  });

  describe('toEt', () => {
    it('normalizes a UTC instant into ET', () => {
      expect(toEt('2025-01-02T14:30:00.000Z').toFormat('HH:mm')).toBe('09:30');
    });
  });

  describe('parseEtDate', () => {
    it('parses a calendar date in ET', () => {
      expect(parseEtDate('2025-01-02').toISODate()).toBe('2025-01-02');
    });

    it('throws on an unparseable date rather than returning an invalid DateTime', () => {
      // A typo in a fixture definition must fail immediately, not propagate as
      // a series of "Invalid DateTime" timestamps.
      expect(() => parseEtDate('not-a-date')).toThrow(/Invalid ET date/);
    });
  });
});
