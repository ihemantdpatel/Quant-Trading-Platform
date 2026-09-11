/**
 * Grid-strategy parameters.
 *
 * Deliberately smaller than `DipLadderConfig`: there is no spacing mode, no
 * ATR, no escalation, no hard floor. Every price this strategy places is
 * computed fresh from the currently-held lots each time it is asked
 * (`levels.ts`) rather than from a persisted level ledger, so the only
 * knobs are the ones that feed that computation directly.
 */

export interface GridConfig {
  symbol: string;
  /** Whole-share quantity for every order — entries and exits alike. */
  quantity: number;
  /**
   * Fixed-dollar spacing. Used two ways: the distance between successive dip
   * buy levels below the lowest held lot, and the amount added to a lot's
   * own fill price to compute its sell target.
   */
  gap: number;
  /** How many stepped dip-buy levels to maintain below the lowest held lot. */
  maxBuyLevels: number;
  /** Cap on concurrent resting sells; the oldest/lowest-priced lots (FIFO) get them. */
  maxSellOrders: number;
  /**
   * Dollars added past the last close for the flat (0-lot) entry, so the
   * resulting limit is marketable without being a true `MARKET` order — this
   * strategy never submits an unprotected market order on an instrument with
   * no stop-loss beneath a position.
   */
  entryBuffer: number;
}

export const DEFAULT_GRID_CONFIG: Omit<GridConfig, 'symbol'> = {
  quantity: 50,
  gap: 0.5,
  maxBuyLevels: 2,
  maxSellOrders: 2,
  entryBuffer: 0.05,
};

/**
 * Builds a full config from partial overrides.
 *
 * Validation is eager and throws, for the same reason `buildDipLadderConfig`
 * does: every value here moves real money once the mode is not SHADOW, and a
 * nonsensical value is not something to discover halfway through a session.
 */
export function buildGridConfig(
  symbol: string,
  overrides: Partial<Omit<GridConfig, 'symbol'>> = {},
): GridConfig {
  const config: GridConfig = { symbol, ...DEFAULT_GRID_CONFIG, ...overrides };

  if (!config.symbol) {
    throw new Error('grid config requires a symbol');
  }

  if (!Number.isInteger(config.quantity) || config.quantity < 1) {
    throw new Error(`quantity must be a positive integer, got ${config.quantity}`);
  }

  if (config.gap <= 0) {
    throw new Error(`gap must be positive, got ${config.gap}`);
  }

  if (!Number.isInteger(config.maxBuyLevels) || config.maxBuyLevels < 1) {
    throw new Error(`maxBuyLevels must be a positive integer, got ${config.maxBuyLevels}`);
  }

  if (!Number.isInteger(config.maxSellOrders) || config.maxSellOrders < 1) {
    throw new Error(`maxSellOrders must be a positive integer, got ${config.maxSellOrders}`);
  }

  if (config.entryBuffer < 0) {
    // Zero is allowed — the marketable entry would rest exactly at the last
    // close, which is still non-negative and still a legitimate limit price.
    throw new Error(`entryBuffer must not be negative, got ${config.entryBuffer}`);
  }

  return config;
}
