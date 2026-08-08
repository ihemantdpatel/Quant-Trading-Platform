/**
 * Synthetic 3x QQQ → approximate TQQQ, for history TQQQ does not have.
 *
 * **TQQQ launched in February 2010** (`PRD.md:298`), so the 2000 dot-com crash
 * and the 2008 financial crisis simply do not exist for it. The deepest real
 * drawdowns available are 2020 (~70%) and 2022 (~80%). To evaluate the *rules*
 * across the two larger ones, QQQ daily history is taken back to 1999 and each
 * day's return multiplied by three.
 *
 * ## Why this series is labelled, loudly and structurally
 *
 * Naive 3x compounding is **optimistic, and knowably so**. A real leveraged ETF
 * pays an expense ratio and daily financing costs on the leveraged portion,
 * which compound against the holder and make it decay faster than this
 * calculation — most visibly in exactly the choppy, high-volatility regimes a
 * dip-buying ladder is designed for. A backtest that silently mixed these bars
 * with real ones would report a return the instrument could not have produced,
 * and would do it in the scenarios that matter most.
 *
 * So `synthetic: true` is set on every bar here, `BarRepository.findRange`
 * excludes such bars unless explicitly asked for, and the two facts together
 * mean silent mixing requires someone to opt in twice.
 *
 * ## What is modelled, and what deliberately is not
 *
 * Daily *returns* are tripled — not prices. Tripling a price level would be
 * meaningless; leverage applies to the daily change, and the path-dependent
 * decay that follows from that is the entire point of the exercise.
 *
 * Financing and expense drag are **not** modelled, because doing so
 * convincingly needs a historical rate series this system does not carry, and a
 * plausible-looking guess would be worse than an obvious omission: it would
 * make the series look trustworthy while still being wrong. The label carries
 * that caveat instead.
 */

import { Bar, BarSize } from '../types';

/** TQQQ's actual inception. Synthetic bars must never overlap real history. */
export const TQQQ_INCEPTION = '2010-02-11';

export const DEFAULT_LEVERAGE = 3;

export interface SyntheticOptions {
  /** Symbol the output is labelled with — the leveraged instrument. */
  targetSymbol: string;
  /** Daily return multiplier. 3 for TQQQ. */
  leverage?: number;
  /**
   * Starting price for the synthetic series.
   *
   * Arbitrary by nature: the series exists to show *shape* — drawdown depth,
   * recovery time, how far a ladder extends — and every one of those is
   * scale-invariant. 100 keeps percentages readable.
   */
  startPrice?: number;
}

/**
 * Builds a leveraged series from an unleveraged one.
 *
 * The first bar seeds the level; each subsequent bar applies `leverage ×` the
 * source's daily close-to-close return. Intrabar OHLC is scaled proportionally
 * from the synthetic close, since the source's intrabar path is not recoverable
 * — and pretending otherwise would invent precision the method does not have.
 */
export function synthesizeLeveragedSeries(source: Bar[], options: SyntheticOptions): Bar[] {
  const leverage = options.leverage ?? DEFAULT_LEVERAGE;
  const startPrice = options.startPrice ?? 100;

  if (source.length === 0) {
    return [];
  }

  const ordered = [...source].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const output: Bar[] = [];
  let level = startPrice;

  for (let i = 0; i < ordered.length; i += 1) {
    const bar = ordered[i];

    if (i > 0) {
      const previousClose = ordered[i - 1].close;

      // A zero or negative previous close cannot produce a return. Carrying the
      // level forward unchanged is the only honest option — inventing one would
      // put a fabricated move into a series used to judge drawdown depth.
      if (previousClose > 0) {
        const sourceReturn = (bar.close - previousClose) / previousClose;
        level = level * (1 + leverage * sourceReturn);
      }
    }

    // A leveraged fund cannot go below zero: a -33.4% day in the underlying
    // would wipe out a 3x fund entirely, and in reality circuit breakers and
    // intraday rebalancing intervene. Flooring keeps the series arithmetically
    // valid rather than modelling that mechanism, which is beyond what a
    // daily-return approximation can claim.
    level = Math.max(level, 0.01);

    const scale = bar.close > 0 ? level / bar.close : 1;

    output.push({
      symbol: options.targetSymbol,
      barSize: BarSize.DAILY,
      timestamp: bar.timestamp,
      open: round(bar.open * scale),
      high: round(bar.high * scale),
      low: round(bar.low * scale),
      close: round(level),
      volume: bar.volume,
      // **Non-negotiable.** The repository's default read excludes these, and
      // that exclusion is only as good as this flag.
      synthetic: true,
    });
  }

  return output;
}

/**
 * Drops bars at or after TQQQ's inception.
 *
 * Synthetic history exists only to cover the period real history cannot. An
 * overlap would put two bars in play for one instant — one real, one
 * approximate — and any read that included both would be comparing the
 * instrument to itself.
 */
export function beforeInception(bars: Bar[], inception = TQQQ_INCEPTION): Bar[] {
  return bars.filter((bar) => bar.timestamp < `${inception}T00:00:00.000-05:00`);
}

/**
 * True when a set mixes synthetic and real bars.
 *
 * Exists so the mixing rule is **checkable** rather than merely documented: the
 * backtester asserts on this before reporting a result, so a labelled series
 * cannot become an unlabelled conclusion.
 */
export function containsMixedProvenance(bars: Bar[]): boolean {
  const hasSynthetic = bars.some((bar) => bar.synthetic === true);
  const hasReal = bars.some((bar) => bar.synthetic !== true);

  return hasSynthetic && hasReal;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
