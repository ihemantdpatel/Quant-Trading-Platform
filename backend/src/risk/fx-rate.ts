/**
 * Live FX conversion for the global capital cap (Story 15).
 *
 * The account's equity is denominated in **CAD** and every cap, limit, and
 * position notional in **USD** (`risk.config.ts`, `equityCurrency` vs
 * `accountCurrency`). Until this existed the gap was closed by converting the
 * balance once, by hand, which left the cap carrying a rate that went stale the
 * moment it was written — a weakening CAD shrank the real USD equity while the
 * constant stood still, silently loosening the cap.
 *
 * The rate is **market data**, so it is treated the way bars are: it has an
 * age, and past a bound it is stale. A stale or missing rate **blocks new
 * entries** rather than falling back to the last value of unknown age — a stale
 * rate mis-sizes every order silently, which is worse than not trading. Exits
 * are never blocked by this, for the same reason the capital cap never blocks
 * them: a missing rate must not strand a lot at its target.
 *
 * Pure apart from the book's injected clock, so the rule lives under the 95%
 * risk-layer coverage threshold while the broker plumbing that feeds it does
 * not.
 */

/** Oldest a quote may be and still size an order. Three missed 60s polls. */
export const FX_MAX_AGE_MS = 180_000;

/**
 * One reading of a currency pair, as `base.quote` — `USD.CAD` is how many CAD
 * one USD buys.
 */
export interface FxQuote {
  base: string;
  quote: string;
  /**
   * The **ask**, not the mid. Equity is converted by dividing by this rate, so
   * the higher side yields the smaller USD equity and therefore the tighter
   * cap. The spread is tiny on IDEALPRO; erring tight costs nothing that
   * matters.
   */
  rate: number;
  /** Epoch ms at which this process received the quote. */
  receivedAt: number;
}

export enum FxStatus {
  /** No FX needed — equity is already in the cap currency. */
  NOT_REQUIRED = 'NOT_REQUIRED',
  FRESH = 'FRESH',
  STALE = 'STALE',
  UNAVAILABLE = 'UNAVAILABLE',
}

/** What `/status` reports and what the risk manager decides on. */
export interface FxSnapshot {
  status: FxStatus;
  pair: string;
  rate: number | null;
  /** ISO-8601 UTC, or null before the first quote. */
  receivedAt: string | null;
  ageMs: number | null;
  /** The last fetch failure, kept so a stale rate can say why. */
  lastError: string | null;
}

export function pairName(base: string, quote: string): string {
  return `${base}.${quote}`;
}

/**
 * Rejects a reading no real market produces. Anything that fails here is
 * treated as "no quote", never as a rate — a zero or negative rate would make
 * the converted equity infinite or negative, and either one disables the cap.
 */
export function isUsableRate(rate: number): boolean {
  return Number.isFinite(rate) && rate > 0;
}

/**
 * Holds the latest quote for one pair and classifies it against a clock.
 *
 * Mutable and shared: `RiskModule` provides one instance, the poller writes to
 * it, and the risk manager reads it on every BUY. The risk layer never imports
 * the broker to get a rate — the poller pushes it here, the same direction
 * `SYMBOL_CAPITAL_SOURCE` flows.
 */
export class FxRateBook {
  private latest: FxQuote | null = null;
  private lastError: string | null = null;

  constructor(
    readonly base: string,
    readonly quote: string,
    private readonly now: () => number = () => Date.now(),
    private readonly maxAgeMs: number = FX_MAX_AGE_MS,
  ) {}

  get pair(): string {
    return pairName(this.base, this.quote);
  }

  /**
   * Records a reading. A pair mismatch or unusable rate is recorded as an error
   * and leaves the previous quote to age out — it is never allowed to replace a
   * good one, and never extends its life.
   */
  record(quote: FxQuote): void {
    if (quote.base !== this.base || quote.quote !== this.quote) {
      this.lastError = `received ${pairName(quote.base, quote.quote)}, expected ${this.pair}`;
      return;
    }

    if (!isUsableRate(quote.rate)) {
      this.lastError = `unusable ${this.pair} rate ${quote.rate}`;
      return;
    }

    this.latest = { ...quote };
    this.lastError = null;
  }

  recordFailure(message: string): void {
    this.lastError = message;
  }

  snapshot(): FxSnapshot {
    if (!this.latest) {
      return {
        status: FxStatus.UNAVAILABLE,
        pair: this.pair,
        rate: null,
        receivedAt: null,
        ageMs: null,
        lastError: this.lastError,
      };
    }

    // A quote stamped in the future (clock skew) is aged at zero rather than
    // negative, which would otherwise read as fresher than fresh forever.
    const ageMs = Math.max(0, this.now() - this.latest.receivedAt);

    return {
      status: ageMs <= this.maxAgeMs ? FxStatus.FRESH : FxStatus.STALE,
      pair: this.pair,
      rate: this.latest.rate,
      receivedAt: new Date(this.latest.receivedAt).toISOString(),
      ageMs,
      lastError: this.lastError,
    };
  }
}

export type EquityConversion =
  { ok: true; equity: number; detail: string | null } | { ok: false; detail: string };

/**
 * Converts equity from `equityCurrency` into the cap currency, or refuses.
 *
 * Same currency → no rate consulted, and a missing book is irrelevant. Different
 * currency → requires a book for exactly `capCurrency.equityCurrency` holding a
 * fresh quote. There is no fallback: no book, no quote, or an old quote all
 * refuse.
 */
export function convertEquity(
  equity: number,
  equityCurrency: string,
  capCurrency: string,
  book: FxRateBook | null,
): EquityConversion {
  if (equityCurrency === capCurrency) {
    return { ok: true, equity, detail: null };
  }

  const pair = pairName(capCurrency, equityCurrency);

  if (!book || book.base !== capCurrency || book.quote !== equityCurrency) {
    return {
      ok: false,
      detail:
        `equity is in ${equityCurrency} and the cap in ${capCurrency}, but no ${pair} rate ` +
        'source is configured — new entries are blocked rather than sized off an unconverted figure',
    };
  }

  const snapshot = book.snapshot();

  if (snapshot.status !== FxStatus.FRESH || snapshot.rate === null) {
    const age =
      snapshot.ageMs === null ? 'never received' : `${Math.round(snapshot.ageMs / 1000)}s old`;
    const cause = snapshot.lastError ? ` (last error: ${snapshot.lastError})` : '';

    return {
      ok: false,
      detail:
        `${pair} rate is ${snapshot.status.toLowerCase()} (${age})${cause} — new entries are ` +
        'blocked until a fresh rate arrives; a cached rate is never used',
    };
  }

  const converted = Math.round((equity / snapshot.rate) * 100) / 100;

  return {
    ok: true,
    equity: converted,
    detail: `equity ${equity.toFixed(2)} ${equityCurrency} at ${pair} ${snapshot.rate} = ${converted.toFixed(2)} ${capCurrency}`,
  };
}
