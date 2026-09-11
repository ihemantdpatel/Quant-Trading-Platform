/**
 * The grid strategy as a `Strategy` plugin.
 *
 * **This replaces the Story 2 scaffold.** The scaffold's doc comment framed a
 * "grid" as a fixed lattice of levels independent of exposure, contrasted
 * with the ladder's anchor chaining off the lowest held lot. This
 * implementation does chain off held lots — the requirement it was built
 * against explicitly asks for buy levels stepped below the lowest held lot
 * and a sell per lot at that lot's own fill price — so that framing is
 * superseded, not honoured. What *is* preserved from the scaffold's spirit is
 * the "will not share rung code" line: this strategy has no `Rung` or
 * `RungStatus` at all.
 *
 * **No pre-computed level ledger, deliberately.** Every order this strategy
 * places is DAY time-in-force and expires naturally at the close, so there is
 * nothing to re-arm across sessions the way the ladder's `Rung` exists to
 * support. Buy and sell prices are computed fresh every time from the lots
 * currently held (`levels.ts`) — once at each session's first bar, and again
 * immediately whenever a fill changes the held-lot set.
 *
 * This class does three things, mirroring `DipLadderStrategy`'s adapter role:
 * 1. Holds the one cross-bar scalar this strategy needs (`sessionDate`) in
 *    serializable `StrategyState`.
 * 2. Maps `levels.ts`'s `GridIntent` onto the shared `OrderIntent`.
 * 3. Exposes small statics `EngineService` calls after a broker fill, mirroring
 *    `DipLadderStrategy`'s shape but smaller — there is no rung to mark
 *    `WORKING`, so only the SELL side needs a persisted working-order id.
 */

import { Bar } from '../../market-data/types';
import { isRegularSession } from '../../market-data/session';
import { Strategy } from '../strategy.interface';
import {
  equityContract,
  JsonValue,
  OrderIntent,
  OrderType,
  StrategyContext,
  StrategyState,
  TimeInForce,
} from '../types';
import { GridConfig } from './config';
import { computeGridIntents, GridEntryIntent, GridExitIntent, GridIntent } from './levels';
import {
  closeGridLot,
  GridLot,
  GridLotStatus,
  heldGridLots,
  openGridLot,
  splitGridLot,
} from './lot';
import { sessionDateOf } from './session';

export const GRID_STATE_VERSION = 1;

/**
 * Id prefix for every grid instance (`grid:TQQQ`).
 *
 * Exported so the engine can identify grid instances among all registered
 * strategies without hard-coding the string — mirrors `DIP_LADDER_ID_PREFIX`
 * exactly, and for the same reason: only a grid instance's state carries
 * `lots` in this shape.
 */
export const GRID_ID_PREFIX = 'grid:';

/**
 * The grid strategy's durable state. Every field is a plain JSON value.
 *
 * Deliberately smaller than `DipLadderStateData` — there are no rungs, no
 * anchor scalars, no daily-bar history. `sessionDate` is the only cross-bar
 * fact this strategy needs, and losing it across a restart is harmless: the
 * next live bar is simply treated as a fresh session-open trigger, which
 * re-emits the same desired intents (silently deduped against whatever is
 * already resting).
 */
export interface GridStateData extends Record<string, JsonValue> {
  lots: GridLot[] & JsonValue;
  lotSequence: number;
  sessionDate: string | null;
}

/** Narrow read of the opaque state blob, with this strategy's own shape restored. */
function gridData(state: StrategyState): GridStateData {
  return state.data as unknown as GridStateData;
}

export class GridStrategy implements Strategy {
  readonly id: string;

  constructor(private readonly config: GridConfig) {
    // Instance-per-symbol, matching the ladder: the id carries the symbol so
    // per-strategy risk limits and the dashboard can distinguish instances.
    this.id = `${GRID_ID_PREFIX}${config.symbol}`;
  }

  get symbol(): string {
    return this.config.symbol;
  }

  get parameters(): GridConfig {
    return this.config;
  }

  async initialize(): Promise<StrategyState> {
    return {
      strategyId: this.id,
      version: GRID_STATE_VERSION,
      symbols: [this.config.symbol],
      data: {
        lots: [],
        lotSequence: 0,
        sessionDate: null,
      } as unknown as Record<string, JsonValue>,
    };
  }

  /** Bar-driven only. No tick input, matching the dip ladder. */
  onTick(): OrderIntent[] {
    return [];
  }

  /**
   * Recomputes once at each session's first bar, and never again this
   * session from this hook — a fill mid-session is what triggers the other
   * recompute point, `evaluate` below.
   */
  onBar(bar: Bar, state: StrategyState): OrderIntent[] {
    if (bar.symbol !== this.config.symbol) {
      return [];
    }

    // Pre/post-market bars are excluded entirely, matching the dip ladder —
    // an after-hours print must never be read as the session's opening bar.
    if (!isRegularSession(bar.timestamp)) {
      return [];
    }

    const data = gridData(state);
    const date = sessionDateOf(bar.timestamp);

    if (date === data.sessionDate) {
      return [];
    }

    data.sessionDate = date;

    const intents = computeGridIntents({
      symbol: this.config.symbol,
      close: bar.close,
      timestamp: bar.timestamp,
      heldLots: heldGridLots(data.lots),
      config: this.config,
    });

    return intents.map((intent) => this.toOrderIntent(intent));
  }

  /**
   * The fill-triggered recompute hook. `EngineService.recomputeGrid` calls
   * this directly after a fill has mutated `state.data.lots` via
   * `openLotFromFill`/`closeLotFromFill`, using a minimal one-bar context
   * built from the last known price — never a clock read.
   */
  evaluate(ctx: StrategyContext, state: StrategyState): OrderIntent[] {
    if (!ctx.symbols.includes(this.config.symbol)) {
      return [];
    }

    const bar = ctx.history[ctx.history.length - 1];

    if (!bar) {
      return [];
    }

    const data = gridData(state);

    const intents = computeGridIntents({
      symbol: this.config.symbol,
      close: bar.close,
      timestamp: bar.timestamp,
      heldLots: heldGridLots(data.lots),
      config: this.config,
    });

    return intents.map((intent) => this.toOrderIntent(intent));
  }

  /**
   * Idempotent: this strategy holds no connection, timer, or handle. Lots
   * live in state the coordinator owns and are deliberately not cleared here
   * — a terminated instance still holds real shares.
   */
  async terminate(): Promise<void> {
    return;
  }

  private toOrderIntent(intent: GridIntent): OrderIntent {
    if (intent.side === 'BUY') {
      const entry = intent as GridEntryIntent;
      return {
        strategyId: this.id,
        contract: equityContract(entry.symbol),
        side: 'BUY',
        quantity: entry.quantity,
        orderType: OrderType.LIMIT,
        limitPrice: entry.limitPrice,
        timeInForce: TimeInForce.DAY,
        timestamp: entry.timestamp,
        reason: entry.reason,
      };
    }

    const exit = intent as GridExitIntent;
    return {
      strategyId: this.id,
      contract: equityContract(exit.symbol),
      side: 'SELL',
      quantity: exit.quantity,
      orderType: OrderType.LIMIT,
      limitPrice: exit.limitPrice,
      timeInForce: TimeInForce.DAY,
      timestamp: exit.timestamp,
      reason: exit.reason,
      // The lot id is what lets a fill be matched back to the lot it closes —
      // the broker reports a net position and knows nothing of lot composition.
      metadata: { lotId: exit.lotId },
    };
  }

  /**
   * Records that a SELL is now resting against `lotId`.
   *
   * Called by the engine after the broker acknowledges the order, mirroring
   * `DipLadderStrategy.recordWorkingExit` exactly: a lot must not be marked
   * as protected by an order that was rejected or never reached IB.
   */
  static recordWorkingExit(state: StrategyState, lotId: string, clientOrderId: string): void {
    const data = gridData(state);

    data.lots = data.lots.map((lot) =>
      lot.id === lotId ? { ...lot, workingOrderId: clientOrderId } : lot,
    ) as GridStateData['lots'];
  }

  /**
   * Releases a resting order that went away without filling — cancelled,
   * rejected, or expired at the close.
   *
   * Unlike the dip ladder there is no rung to release: a grid buy carries no
   * persisted "pending" bookkeeping at all (see the accepted limitation in
   * the plan this strategy was built from), so this only ever has an effect
   * for a SELL's `clientOrderId`. Called unconditionally for both sides
   * anyway, mirroring `DipLadderStrategy.clearWorkingOrder`'s call sites in
   * `EngineService` — a harmless no-op when no lot matches.
   */
  static clearWorkingOrder(state: StrategyState, clientOrderId: string): void {
    const data = gridData(state);

    data.lots = data.lots.map((lot) =>
      lot.workingOrderId === clientOrderId ? { ...lot, workingOrderId: null } : lot,
    ) as GridStateData['lots'];
  }

  /**
   * Opens a lot from a broker fill on a resting BUY.
   *
   * The sell target is frozen now, from the `gap` in force at this moment —
   * a later runtime edit to `gap` affects future buy levels and future lots
   * only, never this one.
   */
  static openLotFromFill(
    state: StrategyState,
    config: GridConfig,
    fill: { price: number; quantity: number; at: string },
  ): GridLot {
    const data = gridData(state);

    data.lotSequence += 1;

    const lot = openGridLot({
      id: `${config.symbol}-grid-lot-${data.lotSequence}`,
      fillPrice: fill.price,
      quantity: fill.quantity,
      openedAt: fill.at,
      gap: config.gap,
    });

    data.lots.push(lot);

    return lot;
  }

  /**
   * Closes a lot from a broker fill on a resting SELL.
   *
   * **A partial fill splits the lot** rather than shrinking it — see
   * `splitGridLot` for why, identical reasoning to the dip ladder. Returns
   * `null` when the fill names a lot this process cannot find or that is
   * already closed, so the engine can treat it as unattributable rather than
   * throwing on the fill router.
   */
  static closeLotFromFill(
    state: StrategyState,
    fill: { lotId: string; price: number; quantity: number; at: string },
  ): { closed: GridLot; remainder: GridLot | null } | null {
    const data = gridData(state);
    const index = data.lots.findIndex((lot) => lot.id === fill.lotId);

    if (index === -1 || data.lots[index].status !== GridLotStatus.HELD) {
      return null;
    }

    const lot = data.lots[index];

    if (fill.quantity < lot.quantity) {
      data.lotSequence += 1;
      const { sold, remainder } = splitGridLot(
        lot,
        fill.quantity,
        fill.price,
        fill.at,
        `${lot.id}-r${data.lotSequence}`,
      );

      data.lots = [
        ...data.lots.slice(0, index),
        sold,
        remainder,
        ...data.lots.slice(index + 1),
      ] as GridStateData['lots'];

      return { closed: sold, remainder };
    }

    const closed = closeGridLot(lot, fill.price, fill.at);
    data.lots = data.lots.map((candidate) =>
      candidate.id === lot.id ? closed : candidate,
    ) as GridStateData['lots'];

    return { closed, remainder: null };
  }

  /** Read helper the engine and reconciliation use to project state without re-deriving it. */
  static lotsOf(state: StrategyState): GridLot[] {
    return gridData(state).lots;
  }
}
