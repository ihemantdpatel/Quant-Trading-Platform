import { lastValueFrom, toArray } from 'rxjs';
import { toEt } from '../session';
import { Bar, BarSize } from '../types';
import { FIXTURE_NAMES } from './fixtures';
import { ReplayService } from './replay.service';

describe('ReplayService', () => {
  const service = new ReplayService();

  describe.each(FIXTURE_NAMES)('%s', (name) => {
    it('emits bars in strict timestamp order with no duplicates', async () => {
      const bars = await lastValueFrom(service.stream(name).pipe(toArray()));

      expect(bars.length).toBeGreaterThan(0);
      expect(service.validateOrdering(bars)).toEqual([]);
    });

    it('streams the same bars the fixture holds, in the same order', async () => {
      const streamed = await lastValueFrom(service.stream(name).pipe(toArray()));

      expect(streamed).toEqual(service.getBars(name));
    });

    it('is contiguous within each session, jumping only overnight', () => {
      const bars = service.getBars(name);
      // Only regular-session bars are expected to be 5 minutes apart; the
      // session-edges fixture deliberately includes pre/post-market bars.
      const bySession = new Map<string, Bar[]>();
      for (const bar of bars) {
        const day = toEt(bar.timestamp).toISODate()!;
        const list = bySession.get(day) ?? [];
        list.push(bar);
        bySession.set(day, list);
      }

      for (const sessionBars of bySession.values()) {
        const regular = sessionBars.filter((b) => {
          const dt = toEt(b.timestamp);
          const mins = dt.hour * 60 + dt.minute;
          return mins >= 9 * 60 + 30 && mins < 16 * 60;
        });

        for (let i = 1; i < regular.length; i += 1) {
          const gapMinutes =
            (toEt(regular[i].timestamp).toMillis() - toEt(regular[i - 1].timestamp).toMillis()) /
            60_000;
          expect(gapMinutes).toBe(5);
        }
      }
    });
  });

  it('returns a defensive copy so consumers cannot corrupt the fixture', () => {
    const first = service.getBars('chop-range');
    first[0].close = -999;

    expect(service.getBars('chop-range')[0].close).not.toBe(-999);
  });

  it('getFixture returns the expectation and invariants alongside the bars', () => {
    const fixture = service.getFixture('chop-range');

    expect(fixture.name).toBe('chop-range');
    expect(fixture.expectation).toMatch(/oscillates/);
    expect(fixture.invariants.length).toBeGreaterThan(0);
    expect(fixture.bars.length).toBeGreaterThan(0);
  });

  it('getFixture copies bars defensively too', () => {
    const fixture = service.getFixture('chop-range');
    fixture.bars[0].close = -999;

    expect(service.getFixture('chop-range').bars[0].close).not.toBe(-999);
  });

  it('rejects an unknown fixture name', () => {
    expect(() => service.getBars('nope')).toThrow(/Unknown fixture/);
    expect(() => service.stream('nope')).toThrow(/Unknown fixture/);
  });

  it('replays deterministically — two runs are byte-identical', async () => {
    const a = await lastValueFrom(service.stream('chop-range').pipe(toArray()));
    const b = await lastValueFrom(service.stream('chop-range').pipe(toArray()));

    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  describe('validateOrdering', () => {
    const bar = (timestamp: string): Bar => ({
      symbol: 'TQQQ',
      barSize: BarSize.FIVE_MIN,
      timestamp,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 1,
    });

    it('reports duplicate timestamps', () => {
      const problems = service.validateOrdering([
        bar('2025-01-02T09:30:00.000-05:00'),
        bar('2025-01-02T09:30:00.000-05:00'),
      ]);

      expect(problems.join(' ')).toMatch(/duplicates an earlier timestamp/);
    });

    it('reports out-of-order bars', () => {
      const problems = service.validateOrdering([
        bar('2025-01-02T09:35:00.000-05:00'),
        bar('2025-01-02T09:30:00.000-05:00'),
      ]);

      expect(problems.join(' ')).toMatch(/does not advance past/);
    });

    it('reports off-boundary bars', () => {
      const problems = service.validateOrdering([bar('2025-01-02T09:32:00.000-05:00')]);

      expect(problems.join(' ')).toMatch(/is not on a 5min boundary/);
    });

    it('accepts a clean sequence', () => {
      expect(
        service.validateOrdering([
          bar('2025-01-02T09:30:00.000-05:00'),
          bar('2025-01-02T09:35:00.000-05:00'),
        ]),
      ).toEqual([]);
    });
  });
});
