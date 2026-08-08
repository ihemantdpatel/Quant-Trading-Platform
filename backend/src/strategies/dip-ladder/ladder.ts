import { Bar } from '../../market-data/types';
import { resolveAnchor } from './anchor';
import { DipLadderConfig } from './config';
import { evaluateInvalidation, InvalidationResult } from './invalidation';
import { findRung, selectFireableRung } from './rung';
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

  // An existing empty rung the bar has reached takes precedence over extending
  // the ladder. This is what lets a re-armed rung fire again at its original
  // price instead of being bypassed by a freshly computed level below it.
  const existing = selectFireableRung(position.rungs, bar.close, bar.timestamp);

  if (existing) {
    return buildEntry(existing.price, bar, position, config, `re-arm/pending rung`);
  }

  const anchor = resolveAnchor(position.heldLots, previousClose, sessionOpen);
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
