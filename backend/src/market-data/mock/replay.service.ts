import { Injectable } from '@nestjs/common';
import { Observable, from } from 'rxjs';
import { isOnBarBoundary, toEt } from '../session';
import { Bar, Fixture } from '../types';
import { loadFixture } from './fixtures';

/**
 * Streams a committed fixture as a bar sequence.
 *
 * This is the seam every later story plugs into: Story 3 replays fixtures
 * through the dip ladder, Story 6 drives the engine from it, and Story 10
 * swaps in the real IB adapter behind the same shape. It deliberately does no
 * strategy work — it emits bars in order and nothing else.
 */
@Injectable()
export class ReplayService {
  /**
   * Returns a fixture's bars as a plain array.
   *
   * A defensive copy, so a consumer mutating a bar cannot corrupt the imported
   * JSON module for every other consumer in the process.
   */
  getBars(fixtureName: string): Bar[] {
    return loadFixture(fixtureName).bars.map((bar) => ({ ...bar }));
  }

  getFixture(fixtureName: string): Fixture {
    const fixture = loadFixture(fixtureName);
    return { ...fixture, bars: fixture.bars.map((bar) => ({ ...bar })) };
  }

  /**
   * Streams bars as an Observable, matching the RxJS-based event loop the
   * backend is built around (`project-scope.md` §3). Synchronous emission —
   * replay is as fast as the consumer, with no artificial pacing.
   */
  stream(fixtureName: string): Observable<Bar> {
    return from(this.getBars(fixtureName));
  }

  /**
   * Validates ordering guarantees the rest of the system relies on: strictly
   * increasing timestamps, no duplicates, and legitimate bar boundaries.
   *
   * Returns problems rather than throwing so a caller can report all of them.
   */
  validateOrdering(bars: Bar[]): string[] {
    const problems: string[] = [];
    const seen = new Set<number>();

    for (let i = 0; i < bars.length; i += 1) {
      const bar = bars[i];
      const millis = toEt(bar.timestamp).toMillis();

      if (!isOnBarBoundary(bar.timestamp, bar.barSize)) {
        problems.push(`bar ${i} (${bar.timestamp}) is not on a ${bar.barSize} boundary`);
      }

      if (seen.has(millis)) {
        problems.push(`bar ${i} (${bar.timestamp}) duplicates an earlier timestamp`);
      }
      seen.add(millis);

      if (i > 0) {
        const prevMillis = toEt(bars[i - 1].timestamp).toMillis();
        if (millis <= prevMillis) {
          problems.push(
            `bar ${i} (${bar.timestamp}) does not advance past bar ${i - 1} (${bars[i - 1].timestamp})`,
          );
        }
      }
    }

    return problems;
  }
}
