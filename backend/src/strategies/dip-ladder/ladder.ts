import { Bar } from '../../market-data/types';
import { resolveAnchor } from './anchor';
import { DipLadderConfig, OrderPlacement } from './config';
import { evaluateInvalidation, InvalidationResult } from './invalidation';
import { findRung, highestFireableRung, selectFireableRung } from './rung';
import { isWithinFiringWindow } from './session-window';
import { nextRungPrice, roundToCents } from './spacing';
import { EntryIntent, LadderPosition } from './types';

/**
 * The firing decision: given a closed 5-minute bar and the current position,
 * does a rung fire?
 *
 * This composes the four pure modules — anchor, spacing, session window,
 * invalidation — and is itself pure. It emits `EntryIntent[]` and nothing
 * else: no submission, no persistence, no clock. Story 5 is the only path to
 * a broker, and Story 3 deliberately stops at the intent.
 *
 * There is no sell path anywhere in this file.
 */

/**
 * Fraction of symbol capital allocated to the rung at `depth` (0-based).
 *
 * With the default `escalationFactor` of 1 this is flat — every rung is the
 * same 25% (`PRD.md:107`). Escalation is a parameter, defaulted off, and is
 * expressed as a power of depth so that turning it on produces the familiar
 * 1×, 1.5×, 2.25× progression rather than a bespoke table.
 */
export function rungAllocationFraction(depth: number, config: DipLadderConfig): number {
  return config.sizePerRung * Math.pow(config.escalationFactor, depth);
}

/**
 * Whole-share quantity for a rung.
 *
 * Floors rather than rounds: rounding up would deploy more capital than the
 * allocation permits, and on the fifth rung of a fully-extended ladder that
 * overshoot compounds against the global cap Story 5 enforces.
 *
 * Returns 0 when `symbolCapital` is unset. That is the honest answer while the
 * PRD's open item stands (`PRD.md:112`) — SHADOW replay still produces
 * correctly *priced* intents, which is what Story 3 is verifying, and Story 5's
 * startup assertion refuses PAPER/LIVE until a real figure is configured.
 */
export function rungQuantity(price: number, depth: number, config: DipLadderConfig): number {
  // A fixed quantity is checked first and is independent of both price and
  // capital — that independence is the whole point, since it is what makes
  // profit per round trip a knowable currency figure rather than one that
  // drifts as price moves. `symbolCapital` is deliberately not consulted here:
  // the risk layer, not the allocation, is what bounds a fixed-size ladder.
  if (config.fixedQuantity !== null) {
    return config.fixedQuantity;
  }

  if (config.symbolCapital === null || price <= 0) {
    return 0;
  }

  return Math.floor((config.symbolCapital * rungAllocationFraction(depth, config)) / price);
}

export interface FiringDecision {
  /** The intent, when one fired. */
  intent: EntryIntent | null;
  /** The rung price evaluated, for logging even when nothing fired. */
  rungPrice: number | null;
  /** Why nothing fired. Null when an intent was produced. */
  blocked: BlockedReason | null;
}

/**
 * True when a lot already occupies the rung at `rungPrice`.
 *
 * A rung is identified by its price level, so this is a price comparison at
 * cent precision — the same precision rungs are emitted at, so a rung and the
 * lot filled at it always compare equal despite float arithmetic.
 *
 * This is the rule "a rung may not fire while it already holds a lot"
 * (`PRD.md:84`). `evaluateBar` deliberately does **not** call it, because in
 * Story 3 it cannot fire: the anchor is the lowest held lot and the next rung
 * is strictly below it, so the computed rung can never coincide with a held
 * one. Calling it there would be an unreachable branch dressed up as a safety
 * check. Story 4 introduces re-armed rungs, which can sit at the level the
 * anchor next resolves to — that is where this guard becomes load-bearing, and
 * it is defined and tested here so the rule exists before the story that needs
 * it.
 */
export function isRungHeld(position: LadderPosition, rungPrice: number): boolean {
  const target = roundToCents(rungPrice);
  return position.heldLots.some((lot) => roundToCents(lot.rungPrice) === target);
}

/**
 * True when a BUY limit at `rungPrice` would actually rest rather than fill on
 * arrival.
 *
 * A buy limit is marketable at or above the offer, so the exchange fills it
 * immediately at the prevailing price instead of holding it at the level. The
 * strict comparison is deliberate: a limit *equal* to the close is marketable
 * too, and a rung the market is already sitting on is not a dip.
 *
 * The bar's close stands in for the market. It is the freshest price a pure
 * bar-driven strategy has, and it is the same reference the IMMEDIATE path
 * already compares against — so both placement modes decide "is this level
 * below the market" from one source, and neither needs a quote.
 *
 * This is only a question under RESTING. Under IMMEDIATE the order is created
 * at the moment the close reaches the rung, and being marketable is then the
 * intent rather than a fault.
 */
export function isRestable(rungPrice: number, close: number): boolean {
  return roundToCents(rungPrice) < roundToCents(close);
}

/**
 * True when a SELL limit at `target` would rest rather than fill on arrival.
 *
 * The mirror of `isRestable`: a sell limit is marketable at or below the bid,
 * so a target the market has already reached fills immediately at the
 * prevailing price instead of holding at the level.
 *
 * **Under normal operation this always passes**, and that is the point rather
 * than a weakness. `exitTarget` is frozen above `fillPrice` at open, and at the
 * instant a BUY fills the market is *at* that fill price — so a lot's sell limit
 * is non-marketable when placed and stays so until price rallies to it. The
 * guard earns its place on the one case where the premise does not hold: a lot
 * reconstructed by `recover:lots` whose target is already below the current
 * market. There the correct action is to place nothing and report, never to dump
 * shares into a marketable sell on a 3x ETF.
 */
export function isRestableExit(target: number, close: number): boolean {
  return roundToCents(target) > roundToCents(close);
}

/**
 * The decline a RESTING rung above the market produces.
 *
 * Reuses `ABOVE_RUNG` rather than introducing a kind: the condition is the same
 * one the IMMEDIATE path reports — the market has not come down to this level —
 * and callers that already surface `ABOVE_RUNG` need no change to describe it.
 * The detail names the placement so a log line distinguishes "waiting for the
 * close to reach the rung" from "refusing to rest a marketable buy".
 */
function aboveMarket(rungPrice: number, close: number): FiringDecision {
  return {
    intent: null,
    rungPrice,
    blocked: {
      kind: 'ABOVE_RUNG',
      detail:
        `rung ${rungPrice.toFixed(2)} is at or above close ${close.toFixed(2)} — ` +
        'a resting buy limit there would be marketable and fill immediately',
    },
  };
}

export type BlockedReason =
  | { kind: 'OUTSIDE_WINDOW'; detail: string }
  | { kind: 'ABOVE_RUNG'; detail: string }
  | { kind: 'RUNG_HELD'; detail: string }
  | { kind: 'INVALIDATED'; detail: string };

/**
 * Evaluates one closed bar against the ladder.
 *
 * `previousClose` and `sessionOpen` feed the bootstrap anchor and are ignored
 * once a lot is held. `dailyBars` is consulted only in ATR spacing mode.
 *
 * Firing rule (`PRD.md:92`): the bar's close is at or below the rung price and
 * that rung holds no lot. A rung missed by an intra-bar spike that recovers
 * before the close is accepted and not chased — the strategy buys weakness,
 * and being slightly late is not costly.
 */
export function evaluateBar(
  bar: Bar,
  position: LadderPosition,
  config: DipLadderConfig,
  previousClose: number | null,
  sessionOpen: number,
  dailyBars: Bar[] = [],
): FiringDecision {
  if (!isWithinFiringWindow(bar.timestamp)) {
    return {
      intent: null,
      rungPrice: null,
      blocked: {
        kind: 'OUTSIDE_WINDOW',
        detail: `${bar.timestamp} is outside the 09:45–16:00 ET firing window`,
      },
    };
  }

  // An existing empty rung takes precedence over extending the ladder. This is
  // what lets a re-armed rung fire again at its original price instead of being
  // bypassed by a freshly computed level below it.
  //
  // **The reach test differs by placement mode, and that difference is the
  // feature.** Under IMMEDIATE a rung is a candidate only once the bar has
  // closed at or below it, because the order is created at that moment. Under
  // RESTING the order is placed *before* price arrives — waiting for the bar to
  // reach the level would forfeit exactly the intra-bar fill the resting order
  // exists to capture, and would leave a released rung permanently unplaced
  // whenever price sits above it.
  const resting = config.orderPlacement === OrderPlacement.RESTING;
  const existing = resting
    ? highestFireableRung(position.rungs, bar.timestamp)
    : selectFireableRung(position.rungs, bar.close, bar.timestamp);

  if (existing) {
    // A resting BUY limit must sit *below* the market to rest. A re-armed rung
    // keeps its original price while price recovers past it, so
    // `highestFireableRung` — which ignores where price is, by design — will
    // hand back a level above the close. Sent as a limit order that is a
    // marketable buy: it fills instantly at the ask instead of waiting for the
    // dip, which is the opposite of what a predetermined-level ladder does.
    if (resting && !isRestable(existing.price, bar.close)) {
      return aboveMarket(existing.price, bar.close);
    }

    return buildEntry(existing.price, bar, position, config, `re-arm/pending rung`);
  }

  const anchor = resolveAnchor(position.heldLots, previousClose, sessionOpen, config);
  const rungPrice = nextRungPrice(anchor.price, config, dailyBars);

  // The ladder only extends below a level it does not already have. Without
  // this, a rung that exited and re-armed would be shadowed by a new rung at
  // the same price, and the ledger would accumulate duplicates.
  if (findRung(position.rungs, rungPrice)) {
    return {
      intent: null,
      rungPrice,
      blocked: {
        kind: 'RUNG_HELD',
        detail: `rung ${rungPrice.toFixed(2)} already exists and holds a lot`,
      },
    };
  }

  // **The resting-order rule.** A limit order is placed *at* the rung and waits
  // there, so the bar's close being above the rung is the normal case rather
  // than a reason to decline — the order rests until price comes to it.
  //
  // This is what makes the ladder capture an intra-bar dip. Under the immediate
  // rule below, a wick through the rung that recovered before the close fired
  // nothing at all (`PRD.md:92`); with an order already resting, the exchange
  // fills it on the way through.
  //
  // "Below the market" is the one thing that still has to hold. A newly
  // extended rung sits a full spacing unit under the anchor, so it is normally
  // well below the close — but the anchor is the lowest *held* lot, not the
  // market, so a position held while price falls far beneath it puts the next
  // computed rung above the close too.
  if (config.orderPlacement === OrderPlacement.RESTING) {
    if (!isRestable(rungPrice, bar.close)) {
      return aboveMarket(rungPrice, bar.close);
    }

    return buildEntry(
      rungPrice,
      bar,
      position,
      config,
      `${anchor.basis.toLowerCase()} anchor ${anchor.price.toFixed(2)}, resting limit`,
    );
  }

  if (bar.close > rungPrice) {
    return {
      intent: null,
      rungPrice,
      blocked: {
        kind: 'ABOVE_RUNG',
        detail: `close ${bar.close.toFixed(2)} is above rung ${rungPrice.toFixed(2)}`,
      },
    };
  }

  return buildEntry(
    rungPrice,
    bar,
    position,
    config,
    `${anchor.basis.toLowerCase()} anchor ${anchor.price.toFixed(2)}`,
  );
}

/**
 * Applies the invalidation limits and builds the entry intent.
 *
 * Shared by both firing paths — an existing empty rung and a newly extended
 * one — so the 5-rung limit and the hard floor cannot be bypassed by a
 * re-armed rung. That matters: re-arming is precisely the mechanism that could
 * otherwise let the ladder exceed its concurrent-rung ceiling.
 */
function buildEntry(
  rungPrice: number,
  bar: Bar,
  position: LadderPosition,
  config: DipLadderConfig,
  basis: string,
): FiringDecision {
  const invalidation: InvalidationResult = evaluateInvalidation(position, rungPrice, config);

  if (!invalidation.canAdd) {
    return {
      intent: null,
      rungPrice,
      blocked: { kind: 'INVALIDATED', detail: invalidation.detail! },
    };
  }

  const depth = position.heldLots.length;

  return {
    rungPrice,
    blocked: null,
    intent: {
      symbol: config.symbol,
      side: 'BUY',
      quantity: rungQuantity(rungPrice, depth, config),
      limitPrice: rungPrice,
      timestamp: bar.timestamp,
      reason:
        `rung at ${rungPrice.toFixed(2)}: close ${bar.close.toFixed(2)} ` +
        `at or below rung, ${basis}`,
    },
  };
}
