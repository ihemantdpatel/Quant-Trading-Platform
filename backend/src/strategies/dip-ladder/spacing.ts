import { Bar } from '../../market-data/types';
import { DipLadderConfig, SpacingMode } from './config';

/**
 * Rung spacing: how far below the anchor the next rung sits.
 *
 * Both modes are implemented from day one (`PRD.md:87`). The distinction that
 * matters is that percentage spacing is *proportional* — each rung is 5% below
 * the one above, so absolute gaps shrink as price falls — while ATR spacing is
 * *absolute*, a fixed dollar distance derived from recent daily range. On a 3x
 * leveraged ETF the second is the volatility-aware choice; the first is what
 * the rules were reasoned about in, so it is the default.
 */

/** Prices are compared and emitted at cent precision to match fixture data. */
export function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Wilder's True Range for one bar: the greatest of the current range, and the
 * gap-inclusive distances from the previous close.
 *
 * The previous-close terms are what make this gap-aware — a bar that opens
 * well below yesterday's close has a true range far larger than its own
 * high-low, and on TQQQ that gap is exactly the move the ladder cares about.
 */
export function trueRange(bar: Bar, previousClose: number | null): number {
  const highLow = bar.high - bar.low;

  if (previousClose === null) {
    return highLow;
  }

  return Math.max(highLow, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
}

/**
 * ATR over `period` daily bars, as a simple mean of true ranges.
 *
 * A simple mean rather than Wilder's smoothing: the smoothed variant carries
 * state from every bar ever seen, which would make the spacing depend on how
 * much history happened to be loaded. A flat window over the last `period`
 * bars is reproducible from any starting point — which matters because Story 8
 * reloads this after a restart and must land on the same number.
 *
 * Returns `null` when there is not enough history to compute a full window,
 * so the caller can fall back rather than act on a partial figure.
 */
export function computeAtr(dailyBars: Bar[], period: number): number | null {
  // `period` true ranges need `period + 1` bars, since the first bar has no
  // previous close and would otherwise contribute a gap-blind range.
  if (dailyBars.length < period + 1) {
    return null;
  }

  const window = dailyBars.slice(-(period + 1));
  let total = 0;

  for (let i = 1; i < window.length; i += 1) {
    total += trueRange(window[i], window[i - 1].close);
  }

  return total / period;
}

export interface SpacingResult {
  /** Absolute price distance between consecutive rungs. */
  distance: number;
  /** Which mode actually produced the distance, after any fallback. */
  mode: SpacingMode;
  /** True when ATR was requested but history was insufficient. */
  fellBack: boolean;
}

/**
 * Resolves the spacing distance below a given anchor price.
 *
 * `dailyBars` is only consulted in ATR mode. When ATR is requested but history
 * is too short — the first sessions after a cold start, or a newly listed
 * symbol — this falls back to percentage spacing rather than refusing to
 * trade or, worse, silently using a partial-window ATR. The fallback is
 * reported in the result so a caller can surface it rather than have the
 * ladder quietly change behaviour.
 */
export function resolveSpacing(
  anchorPrice: number,
  config: DipLadderConfig,
  dailyBars: Bar[] = [],
): SpacingResult {
  // Checked before ATR because it consults no history and cannot fall back:
  // the distance is stated outright rather than derived from market data.
  if (config.spacingMode === SpacingMode.FIXED_DOLLAR) {
    return {
      distance: roundToCents(config.spacingDollars),
      mode: SpacingMode.FIXED_DOLLAR,
      fellBack: false,
    };
  }

  if (config.spacingMode === SpacingMode.ATR) {
    const atr = computeAtr(dailyBars, config.atrPeriod);

    if (atr !== null && atr > 0) {
      return {
        distance: roundToCents(atr * config.atrMultiple),
        mode: SpacingMode.ATR,
        fellBack: false,
      };
    }

    return {
      distance: roundToCents(anchorPrice * config.spacingPercent),
      mode: SpacingMode.PERCENTAGE,
      fellBack: true,
    };
  }

  return {
    distance: roundToCents(anchorPrice * config.spacingPercent),
    mode: SpacingMode.PERCENTAGE,
    fellBack: false,
  };
}

/**
 * The next rung price: one spacing unit below the anchor.
 *
 * Clamped at zero so a pathological ATR wider than the anchor price cannot
 * produce a negative rung. Such a rung is unreachable rather than wrong, and
 * the invalidation floor stops the ladder long before it matters.
 */
export function nextRungPrice(
  anchorPrice: number,
  config: DipLadderConfig,
  dailyBars: Bar[] = [],
): number {
  const { distance } = resolveSpacing(anchorPrice, config, dailyBars);
  return roundToCents(Math.max(0, anchorPrice - distance));
}
