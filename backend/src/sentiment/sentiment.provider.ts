/**
 * `SentimentProvider` — declared now, unimplemented until a paid feed exists
 * (`PRD.md:196`).
 *
 * **The interface shape encodes the decision that sentiment is a veto filter,
 * not an entry trigger.** `vetoes()` answers "should this intent be suppressed"
 * and returns a boolean. There is deliberately no method that returns intents,
 * no `shouldEnter()`, no signal a strategy could act on positively. A provider
 * cannot cause a trade through this interface — only prevent one.
 *
 * That asymmetry is the point. A sentiment feed that generates entries makes
 * the feed's quality a trading input; one that only suppresses them can, at
 * worst, cost an opportunity. On a dip-buying ladder with no stop-loss, "at
 * worst you miss a rung" is the failure mode to design for.
 */

export enum SentimentScore {
  BEARISH = 'BEARISH',
  NEUTRAL = 'NEUTRAL',
  BULLISH = 'BULLISH',
}

export interface SentimentReading {
  symbol: string;
  score: SentimentScore;
  /** 0–1. A provider unsure of its own reading must not drive a veto. */
  confidence: number;
  /** ISO-8601. Staleness matters: an old reading must not veto a live bar. */
  asOf: string;
  /** Where this came from, for the audit trail. */
  source: string;
}

export interface SentimentProvider {
  readonly name: string;

  /** The current reading for a symbol, or null when none is available. */
  read(symbol: string): SentimentReading | null;

  /**
   * Whether sentiment suppresses trading this symbol right now.
   *
   * The only decision this interface can influence. A provider that cannot
   * answer must return `false` — absence of data is not a veto, or an outage
   * would silently halt the strategy.
   */
  vetoes(symbol: string): boolean;
}
