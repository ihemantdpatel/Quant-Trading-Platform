import { formatEt, nextSessionDay, parseEtDate, sessionBarTimes } from '../session';
import { Bar, BarSize } from '../types';

/**
 * Deterministic bar generator.
 *
 * Determinism is the whole point: every downstream strategy test replays these
 * series, so "same seed → byte-identical output" is a hard requirement, not a
 * convenience. That rules out `Math.random()` entirely — it cannot be seeded.
 */

/**
 * mulberry32: a small, fast, well-distributed 32-bit PRNG.
 *
 * Chosen over `Math.random()` because it is seedable, and over a naive LCG
 * because low-bit LCG output correlates badly — visible here as a repeating
 * up/down pattern in the generated series.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;

  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rounds to cents. Prices carrying float noise are unreadable in a committed fixture. */
export function roundPrice(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface GeneratorOptions {
  symbol: string;
  barSize: BarSize;
  /** ET calendar date of the first session, `yyyy-MM-dd`. */
  startDate: string;
  /** Number of sessions to generate. For 5-min bars, each session is 78 bars. */
  sessions: number;
  startPrice: number;
  seed: number;
  /**
   * Per-bar standard deviation as a fraction of price. TQQQ is 3x leveraged;
   * the default is deliberately wide relative to an unleveraged equity.
   */
  volatility?: number;
  /** Per-bar drift as a fraction of price. Negative generates a decline. */
  drift?: number;
}

const DEFAULT_VOLATILITY = 0.0025;
const DEFAULT_DRIFT = 0;

/**
 * Box-Muller transform: converts two uniform randoms into a normally
 * distributed value. Uniform noise would produce a price path with no
 * clustering, which does not resemble a real series.
 */
function gaussian(rand: () => number): number {
  const u1 = Math.max(rand(), Number.EPSILON);
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Builds one OHLC bar around an open→close move, placing the wicks beyond
 * whichever of open/close is more extreme so the bar is always internally
 * consistent (high ≥ max(open, close), low ≤ min(open, close)).
 */
function buildBar(
  symbol: string,
  barSize: BarSize,
  timestamp: string,
  open: number,
  close: number,
  rand: () => number,
  volatility: number,
): Bar {
  const wickScale = open * volatility;
  const high = Math.max(open, close) + rand() * wickScale;
  const low = Math.min(open, close) - rand() * wickScale;

  return {
    symbol,
    barSize,
    timestamp,
    open: roundPrice(open),
    high: roundPrice(high),
    low: roundPrice(low),
    close: roundPrice(close),
    // Integer volume with a floor, so no bar looks like a data outage.
    volume: Math.floor(500_000 + rand() * 2_000_000),
  };
}

/**
 * Generates a deterministic bar series.
 *
 * The same options always produce a byte-identical result. Prices are carried
 * at full precision between bars and rounded only on output, so rounding does
 * not accumulate into a drift the caller never asked for.
 */
export function generateBars(options: GeneratorOptions): Bar[] {
  const {
    symbol,
    barSize,
    startDate,
    sessions,
    startPrice,
    seed,
    volatility = DEFAULT_VOLATILITY,
    drift = DEFAULT_DRIFT,
  } = options;

  const rand = mulberry32(seed);
  const bars: Bar[] = [];
  let price = startPrice;
  let sessionDate = parseEtDate(startDate);

  for (let s = 0; s < sessions; s += 1) {
    // Weekends carry no session; advance without consuming randomness so the
    // series stays identical regardless of which weekday it starts on.
    while (sessionDate.weekday > 5) {
      sessionDate = sessionDate.plus({ days: 1 });
    }

    if (barSize === BarSize.DAILY) {
      const open = price;
      const close = open * (1 + drift + gaussian(rand) * volatility);
      bars.push(
        buildBar(
          symbol,
          barSize,
          formatEt(sessionDate.set({ hour: 9, minute: 30, second: 0, millisecond: 0 })),
          open,
          close,
          rand,
          volatility,
        ),
      );
      price = close;
    } else {
      for (const barTime of sessionBarTimes(sessionDate)) {
        const open = price;
        const close = open * (1 + drift + gaussian(rand) * volatility);
        bars.push(buildBar(symbol, barSize, formatEt(barTime), open, close, rand, volatility));
        price = close;
      }
    }

    sessionDate = nextSessionDay(sessionDate);
  }

  return bars;
}
