/**
 * Dip-ladder parameters.
 *
 * Every default here is load-bearing and traceable to `PRD.md` §1. Two in
 * particular are recorded decisions rather than tuning knobs, and both are
 * defaulted to the safe side:
 *
 * - `spacingMode` defaults to `PERCENTAGE`. ATR spacing is fully implemented
 *   from day one so switching is a config change rather than a rewrite
 *   (`PRD.md:87`), but percentage is what the rules were reasoned about in.
 * - `escalationFactor` defaults to 1 (flat sizing). Escalating size on lower
 *   rungs is the mechanism that converts a bad trade into an account-ending
 *   one, because the largest position gets established where there is most
 *   evidence the thesis is wrong (`PRD.md:117`). It exists as a parameter and
 *   is off.
 */

export enum SpacingMode {
  /** Rungs a fixed percentage apart. */
  PERCENTAGE = 'PERCENTAGE',
  /** Rungs an ATR multiple apart, volatility-normalized. */
  ATR = 'ATR',
}

export enum ExitMode {
  /**
   * Each lot exits at its own target from its own fill price. The default, and
   * the reason the ladder can cycle upper rungs while lower rungs hold.
   */
  PER_LOT = 'PER_LOT',
  /**
   * The whole position exits at one level off the blended average. Available
   * as a config option but **not the default** (`PRD.md:159`) — it closes
   * everything at once and forfeits the cycling that motivates per-lot exits.
   */
  AVERAGE_COST = 'AVERAGE_COST',
}

export interface DipLadderConfig {
  symbol: string;
  spacingMode: SpacingMode;
  /** Fractional, not basis points: 0.05 = 5%. Used when mode is PERCENTAGE. */
  spacingPercent: number;
  /** Multiple of ATR-14 on daily bars. Used when mode is ATR. */
  atrMultiple: number;
  /** Lookback for the ATR calculation, in daily bars. */
  atrPeriod: number;
  /**
   * Per-lot take-profit, fractional. 0.05 = +5%, matching rung spacing so a
   * lot's target sits at the level of the rung above it.
   */
  takeProfitPercent: number;
  /** Per-lot (default) or blended average-cost exits. */
  exitMode: ExitMode;
  /** Fraction of symbol capital per rung. 0.25 = 25%. */
  sizePerRung: number;
  /**
   * Multiplier applied per rung depth: rung N is sized
   * `sizePerRung * escalationFactor^N`. 1 means flat.
   */
  escalationFactor: number;
  /** Hard ceiling on lots held at once (`PRD.md:163`). */
  maxConcurrentRungs: number;
  /** Fractional drop below first entry at which adding stops. 0.25 = 25%. */
  hardFloorPercent: number;
  /**
   * Capital allocated to this symbol, used to size each rung.
   *
   * `null` is the honest default and is deliberate: `PRD.md:112` records that
   * this figure is not yet set, and Story 5 builds the startup assertion that
   * refuses PAPER/LIVE while it is unset. A numeric default here would be
   * exactly the silent default the PRD forbids. Sizing returns zero quantity
   * when it is null, so SHADOW replay still produces priced intents.
   */
  symbolCapital: number | null;
}

export const DEFAULT_DIP_LADDER_CONFIG: Omit<DipLadderConfig, 'symbol'> = {
  spacingMode: SpacingMode.PERCENTAGE,
  spacingPercent: 0.05,
  atrMultiple: 1,
  atrPeriod: 14,
  takeProfitPercent: 0.05,
  exitMode: ExitMode.PER_LOT,
  sizePerRung: 0.25,
  escalationFactor: 1,
  maxConcurrentRungs: 5,
  hardFloorPercent: 0.25,
  symbolCapital: null,
};

/**
 * Builds a full config from partial overrides.
 *
 * Validation is eager and throws, because a nonsensical spacing or rung count
 * is not something to discover halfway through a replay — every value here
 * moves real money once the mode is not SHADOW.
 */
export function buildDipLadderConfig(
  symbol: string,
  overrides: Partial<Omit<DipLadderConfig, 'symbol'>> = {},
): DipLadderConfig {
  const config: DipLadderConfig = { symbol, ...DEFAULT_DIP_LADDER_CONFIG, ...overrides };

  if (!config.symbol) {
    throw new Error('dip ladder config requires a symbol');
  }

  if (config.spacingPercent <= 0 || config.spacingPercent >= 1) {
    throw new Error(
      `spacingPercent must be between 0 and 1 exclusive, got ${config.spacingPercent}`,
    );
  }

  if (config.atrMultiple <= 0) {
    throw new Error(`atrMultiple must be positive, got ${config.atrMultiple}`);
  }

  // An ATR needs at least one prior bar to produce a true range.
  if (!Number.isInteger(config.atrPeriod) || config.atrPeriod < 2) {
    throw new Error(`atrPeriod must be an integer of at least 2, got ${config.atrPeriod}`);
  }

  if (config.takeProfitPercent <= 0) {
    // A non-positive target would let a lot "exit" at or below its fill price,
    // which is the loss-booking exit the strategy does not have.
    throw new Error(`takeProfitPercent must be positive, got ${config.takeProfitPercent}`);
  }

  if (config.sizePerRung <= 0) {
    throw new Error(`sizePerRung must be positive, got ${config.sizePerRung}`);
  }

  if (config.escalationFactor < 1) {
    throw new Error(
      `escalationFactor must be at least 1 (1 = flat sizing), got ${config.escalationFactor}`,
    );
  }

  if (!Number.isInteger(config.maxConcurrentRungs) || config.maxConcurrentRungs < 1) {
    throw new Error(
      `maxConcurrentRungs must be a positive integer, got ${config.maxConcurrentRungs}`,
    );
  }

  if (config.hardFloorPercent <= 0 || config.hardFloorPercent >= 1) {
    throw new Error(
      `hardFloorPercent must be between 0 and 1 exclusive, got ${config.hardFloorPercent}`,
    );
  }

  if (config.symbolCapital !== null && config.symbolCapital <= 0) {
    throw new Error(`symbolCapital must be positive when set, got ${config.symbolCapital}`);
  }

  return config;
}
