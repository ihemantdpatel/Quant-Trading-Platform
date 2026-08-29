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
  /**
   * Rungs a fixed currency amount apart, independent of price level.
   *
   * Percentage spacing is *proportional*, so the dollar gap between rungs — and
   * therefore the profit a round trip yields at a fixed share count — changes
   * as price moves. A 1% target on 50 shares is $36 at $72 and $50 at $100.
   * This mode exists for the operator who is targeting a **currency** figure
   * per round trip rather than a percentage return: with `fixedQuantity`, the
   * profit per cycle is `spacingDollars * fixedQuantity` at every price level.
   *
   * The trade-off it accepts is that a fixed gap is a *widening* percentage as
   * price falls, so a ladder in a deep drawdown spaces its rungs further apart
   * in relative terms than a percentage ladder would.
   */
  FIXED_DOLLAR = 'FIXED_DOLLAR',
}

export enum OrderPlacement {
  /**
   * An order is created only once a bar closes at or below the rung price
   * (`PRD.md:92`). The original rule, and the one every committed fixture's
   * expectations were computed under.
   *
   * Its cost is that a rung touched by an intra-bar wick that recovers before
   * the close fires nothing at all — the ladder buys the *close*, not the dip.
   */
  IMMEDIATE = 'IMMEDIATE',
  /**
   * A limit order rests at the rung price continuously, so the exchange fills
   * it whenever price reaches the level — including on an intra-bar wick the
   * bar-close rule would miss.
   *
   * This is what a dip ladder is supposed to do: the levels are chosen in
   * advance, so waiting for a bar to confirm what the order would already have
   * captured only forfeits fills. It is **not** the default because it changes
   * what reaches the broker: orders rest unattended, across restarts, and must
   * be reconciled against IB's open orders on boot or a restart duplicates
   * them.
   */
  RESTING = 'RESTING',
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
  /**
   * Absolute currency distance between rungs. Used when mode is FIXED_DOLLAR.
   *
   * In the same currency as the instrument's price, so the arithmetic
   * `spacingDollars * fixedQuantity = profit per round trip` holds directly.
   */
  spacingDollars: number;
  /** Lookback for the ATR calculation, in daily bars. */
  atrPeriod: number;
  /**
   * Per-lot take-profit, fractional. 0.05 = +5%, matching rung spacing so a
   * lot's target sits at the level of the rung above it.
   */
  takeProfitPercent: number;
  /**
   * Per-lot take-profit as an absolute currency amount above the lot's own
   * fill price. When set, it **supersedes** `takeProfitPercent`.
   *
   * `null` — the default — leaves the percentage rule in force, so every
   * committed fixture and every existing lot keeps the behaviour its expected
   * values were computed under.
   *
   * Set this to match `spacingDollars` when targeting a fixed profit per
   * cycle: a lot's target then lands exactly on the rung above it, which is
   * the property that makes the ladder cycle cleanly.
   */
  takeProfitDollars: number | null;
  /** Per-lot (default) or blended average-cost exits. */
  exitMode: ExitMode;
  /**
   * Whether entries rest at the broker as limit orders or are created on a bar
   * close that has already reached the rung.
   *
   * Defaults to `IMMEDIATE` so the committed fixtures keep testing the rule
   * their expected intents were computed under. The live engine selects
   * `RESTING`; see `strategies.module.ts`.
   */
  orderPlacement: OrderPlacement;
  /**
   * Fractional gap-down size beyond which the bootstrap anchor re-bases onto
   * today's open instead of the previous close. 0.01 = 1%.
   *
   * `null` — the default — leaves the plain `max(previousClose, open)` rule in
   * force, so every committed fixture keeps the rung prices its expected
   * intents were computed under. Opted into in `strategies.module.ts`, the same
   * way `orderPlacement` and `fixedQuantity` are, and for the same reason.
   *
   * The problem it solves is specific to RESTING placement: an anchor left at
   * the previous close puts the first rung above a gapped-down market, where
   * `isRestable` refuses to place it, so the ladder does nothing for as long as
   * the gap holds. See `bootstrapAnchor` for why erring toward the open is the
   * safe direction — the entry is still a limit order resting below the market.
   */
  gapRebasePercent: number | null;
  /** Fraction of symbol capital per rung. 0.25 = 25%. */
  sizePerRung: number;
  /**
   * Whole-share quantity for every rung, overriding capital-derived sizing.
   *
   * `null` — the default — sizes each rung as a fraction of `symbolCapital`,
   * which is price-dependent. A fixed count is what makes profit per round trip
   * a knowable currency figure rather than one that drifts with price.
   *
   * **This bypasses `sizePerRung` and `escalationFactor` entirely**, so it also
   * bypasses the capital allocation as a sizing input. It does *not* bypass the
   * risk layer: `RiskManagerService` still caps and resizes every intent, so a
   * fixed quantity is a request, not a guarantee.
   */
  fixedQuantity: number | null;
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
  spacingDollars: 1,
  takeProfitPercent: 0.05,
  takeProfitDollars: null,
  exitMode: ExitMode.PER_LOT,
  orderPlacement: OrderPlacement.IMMEDIATE,
  gapRebasePercent: null,
  sizePerRung: 0.25,
  fixedQuantity: null,
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

  if (config.spacingDollars <= 0) {
    throw new Error(`spacingDollars must be positive, got ${config.spacingDollars}`);
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

  if (config.takeProfitDollars !== null && config.takeProfitDollars <= 0) {
    // Same reasoning as the percentage above: a non-positive absolute target
    // would place a lot's exit at or below its fill price, which is the
    // loss-booking exit the strategy does not have.
    throw new Error(`takeProfitDollars must be positive when set, got ${config.takeProfitDollars}`);
  }

  if (
    config.gapRebasePercent !== null &&
    (config.gapRebasePercent <= 0 || config.gapRebasePercent >= 1)
  ) {
    // Zero would re-base on any open below the previous close — every ordinary
    // down day, not a gap — which is the "chase the market" behaviour this rule
    // is bounded to avoid. One or more can never be reached by a real session.
    throw new Error(
      `gapRebasePercent must be between 0 and 1 exclusive when set, got ${config.gapRebasePercent}`,
    );
  }

  if (config.sizePerRung <= 0) {
    throw new Error(`sizePerRung must be positive, got ${config.sizePerRung}`);
  }

  if (
    config.fixedQuantity !== null &&
    (!Number.isInteger(config.fixedQuantity) || config.fixedQuantity < 1)
  ) {
    // Whole shares only: a fractional quantity would be rejected at the broker
    // rather than here, where the reason is legible.
    throw new Error(
      `fixedQuantity must be a positive integer when set, got ${config.fixedQuantity}`,
    );
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
