import { isPostMarket, isPreMarket, toEt } from '../../session';
import { Bar, Fixture, FixtureInvariant } from '../../types';

/**
 * Machine-checked validation of a fixture's documented expectation.
 *
 * Every fixture must declare at least one invariant, so a fixture cannot be
 * silently edited into something that no longer demonstrates what its name
 * claims. Story 3 hangs hand-calculated rung prices off these scenarios; if
 * `steady-decline` quietly stopped declining, those expectations would rot.
 *
 * Invariants are expressed purely in terms of price and time. They know nothing
 * about anchors, rungs, or lots — a fixture that encoded strategy concepts
 * would no longer be an independent test of the strategy.
 */

export interface InvariantResult {
  invariant: FixtureInvariant;
  passed: boolean;
  detail: string;
}

/** Counts how many times the close series crosses fully from below `low` to above `high`, or back. */
export function countBandCrossings(bars: Bar[], low: number, high: number): number {
  let crossings = 0;
  // `null` until price first resolves to one side of the band; a series that
  // starts inside the band should not score a crossing on its first exit.
  let side: 'below' | 'above' | null = null;

  for (const bar of bars) {
    if (bar.close <= low) {
      if (side === 'above') {
        crossings += 1;
      }
      side = 'below';
    } else if (bar.close >= high) {
      if (side === 'below') {
        crossings += 1;
      }
      side = 'above';
    }
  }

  return crossings;
}

function checkOne(fixture: Fixture, invariant: FixtureInvariant): InvariantResult {
  const { bars } = fixture;
  const first = bars[0];
  const last = bars[bars.length - 1];

  switch (invariant.kind) {
    case 'minBarCount': {
      const passed = bars.length >= invariant.value;
      return {
        invariant,
        passed,
        detail: `${bars.length} bars (needs ≥ ${invariant.value})`,
      };
    }

    case 'closesBelowFirstBarByPct': {
      const dropPct = ((first.open - last.close) / first.open) * 100;
      const passed = dropPct >= invariant.value;
      return {
        invariant,
        passed,
        detail: `closes ${dropPct.toFixed(2)}% below first open (needs ≥ ${invariant.value}%)`,
      };
    }

    case 'gapDownFromPreviousClosePct': {
      // The gap is between the last bar of one session and the first of the
      // next, so it is only meaningful across a session boundary.
      let maxGapPct = 0;
      for (let i = 1; i < bars.length; i += 1) {
        const prevDay = toEt(bars[i - 1].timestamp).toISODate();
        const currDay = toEt(bars[i].timestamp).toISODate();
        if (prevDay === currDay) continue;

        const gapPct = ((bars[i - 1].close - bars[i].open) / bars[i - 1].close) * 100;
        maxGapPct = Math.max(maxGapPct, gapPct);
      }
      const passed = maxGapPct >= invariant.value;
      return {
        invariant,
        passed,
        detail: `largest overnight gap down ${maxGapPct.toFixed(2)}% (needs ≥ ${invariant.value}%)`,
      };
    }

    case 'recoversToPreviousClose': {
      // Finds the session that gapped down, then asks whether price later
      // regained the prior session's close.
      let gapIndex = -1;
      let priorClose = 0;
      for (let i = 1; i < bars.length; i += 1) {
        const prevDay = toEt(bars[i - 1].timestamp).toISODate();
        const currDay = toEt(bars[i].timestamp).toISODate();
        if (prevDay !== currDay && bars[i].open < bars[i - 1].close) {
          gapIndex = i;
          priorClose = bars[i - 1].close;
          break;
        }
      }

      if (gapIndex === -1) {
        return { invariant, passed: false, detail: 'no gap-down session found' };
      }

      const peak = Math.max(...bars.slice(gapIndex).map((b) => b.high));
      const passed = peak >= priorClose;
      return {
        invariant,
        passed,
        detail: `post-gap peak ${peak.toFixed(2)} vs prior close ${priorClose.toFixed(2)}`,
      };
    }

    case 'bandCrossings': {
      const crossings = countBandCrossings(bars, invariant.low, invariant.high);
      const passed = crossings >= invariant.minCrossings;
      return {
        invariant,
        passed,
        detail: `${crossings} crossings of ${invariant.low}–${invariant.high} (needs ≥ ${invariant.minCrossings})`,
      };
    }

    case 'containsSessionTime': {
      const passed = bars.some((b) => toEt(b.timestamp).toFormat('HH:mm') === invariant.time);
      return {
        invariant,
        passed,
        detail: `bar at ${invariant.time} ${passed ? 'present' : 'absent'}`,
      };
    }

    case 'containsPreMarketBars': {
      const count = bars.filter((b) => isPreMarket(b.timestamp)).length;
      return { invariant, passed: count > 0, detail: `${count} pre-market bars` };
    }

    case 'containsPostMarketBars': {
      const count = bars.filter((b) => isPostMarket(b.timestamp)).length;
      return { invariant, passed: count > 0, detail: `${count} post-market bars` };
    }
  }
}

export function checkInvariants(fixture: Fixture): InvariantResult[] {
  return fixture.invariants.map((invariant) => checkOne(fixture, invariant));
}

/** Throws with every failure listed, so a broken fixture reports all its problems at once. */
export function assertInvariants(fixture: Fixture): void {
  const failures = checkInvariants(fixture).filter((r) => !r.passed);

  if (failures.length > 0) {
    const detail = failures.map((f) => `  - ${f.invariant.kind}: ${f.detail}`).join('\n');
    throw new Error(`Fixture "${fixture.name}" violates its invariants:\n${detail}`);
  }
}
