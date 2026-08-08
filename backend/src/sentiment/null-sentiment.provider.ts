/**
 * The null sentiment provider — the one wired in for every phase before a paid
 * feed is acquired (`PRD.md:199`).
 *
 * Returns neutral and **never vetoes**. This is a real implementation of the
 * "no sentiment data" case rather than a placeholder: the system's behaviour
 * with no feed is fully defined, and swapping in a real provider at Story 16
 * changes a binding, not a call site.
 *
 * Choosing "never veto" over "always veto" is deliberate — absent data must not
 * halt a strategy, or an unconfigured provider would silently stop all trading
 * while looking like a working install.
 */

import { Injectable } from '@nestjs/common';
import { SentimentProvider, SentimentReading, SentimentScore } from './sentiment.provider';

@Injectable()
export class NullSentimentProvider implements SentimentProvider {
  readonly name = 'null';

  /**
   * Always a neutral reading with zero confidence.
   *
   * Zero rather than one: this provider knows nothing, and a downstream
   * consumer weighting by confidence should give it no weight. Returning a
   * reading rather than `null` keeps consumers off a null-check path that would
   * otherwise be untested until a real provider arrives.
   */
  read(symbol: string): SentimentReading {
    return {
      symbol,
      score: SentimentScore.NEUTRAL,
      confidence: 0,
      asOf: '1970-01-01T00:00:00.000Z',
      source: this.name,
    };
  }

  /** Never vetoes. There is no branch here that can return true. */
  vetoes(): boolean {
    return false;
  }
}
