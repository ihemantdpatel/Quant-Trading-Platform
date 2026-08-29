/**
 * The dip ladder as a `Strategy` plugin.
 *
 * This is an **adapter, not a reimplementation**. Every rule — anchor
 * resolution, rung spacing, the session window, invalidation, per-lot exits,
 * FIFO disposal, re-arming — stays in the pure modules Stories 3 and 4 built
 * and tested. This class does three things they cannot do alone:
 *
 * 1. Holds the cross-bar session tracking (`previousSessionClose`,
 *    `sessionOpen`) that `replay-ladder.ts` kept in a local variable, and puts
 *    it in **serializable `StrategyState`** instead — because that harness was
 *    explicitly not the production engine (`replay-ladder.ts:16`), and a local
 *    does not survive the restart Story 8 requires.
 * 2. Maps the ladder's `EntryIntent`/`ExitIntent` onto the shared `OrderIntent`.
 *    The ladder's types were written so this mapping would be mechanical
 *    (`dip-ladder/types.ts:22`), and it is.
 * 3. Orders exits before entries on each bar, so a freed rung is visible to the
 *    same bar's entry decision — the sequencing `replay-ladder.ts` established
 *    and the chop suite depends on.
 *
 * **Lots are opened here on intent, not on fill.** That is a deliberate
 * limitation of this layer and the engine corrects it: `EngineService`
 * reconciles state against the broker's actual fills, so a rejected or resized
 * order does not leave a phantom lot. Keeping the strategy's own view
 * fill-agnostic is what lets it stay pure — it has no broker to ask.
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
import { DipLadderConfig, OrderPlacement } from './config';
import { ExitIntent, selectExit, selectRestingExits } from './exits';
import { evaluateBar } from './ladder';
import { closeLot, Lot, LotStatus, openLot, splitLot } from './lot';
import { clearWorking, createRung, findRung, markHeld, markWorking, reArm, Rung } from './rung';
import { isSessionOpenBar, sessionDateOf } from './session-window';
import { EntryIntent, LadderPosition } from './types';

export const DIP_LADDER_STATE_VERSION = 1;

/**
 * Id prefix for every ladder instance (`dip-ladder:TQQQ`).
 *
 * Exported so the engine can identify ladder instances among all registered
 * strategies without hard-coding the string — only the ladder's state carries
 * lots and rungs, and reading those fields off a scaffold's state yields
 * `undefined`.
 */
export const DIP_LADDER_ID_PREFIX = 'dip-ladder:';

/**
 * The ladder's durable state. Every field is a plain JSON value — this is the
 * unit Story 8 persists and Story 9 reconciles.
 */
export interface DipLadderStateData extends Record<string, JsonValue> {
  lots: Lot[] & JsonValue;
  rungs: Rung[] & JsonValue;
  firstEntryPrice: number | null;
  lotSequence: number;
  previousSessionClose: number | null;
  runningClose: number | null;
  sessionOpen: number | null;
  sessionDate: string | null;
}

/** Narrow read of the opaque state blob, with the ladder's own shape restored. */
function ladderData(state: StrategyState): DipLadderStateData {
  return state.data as unknown as DipLadderStateData;
}

export class DipLadderStrategy implements Strategy {
  readonly id: string;

  constructor(private readonly config: DipLadderConfig) {
    // Instance-per-symbol: the id carries the symbol so per-strategy risk
    // limits and the dashboard can distinguish two ladders on two symbols.
    this.id = `${DIP_LADDER_ID_PREFIX}${config.symbol}`;
  }

  get symbol(): string {
    return this.config.symbol;
  }

  get parameters(): DipLadderConfig {
    return this.config;
  }

  async initialize(_ctx: StrategyContext): Promise<StrategyState> {
    return {
      strategyId: this.id,
      version: DIP_LADDER_STATE_VERSION,
      symbols: [this.config.symbol],
      data: {
        lots: [],
        rungs: [],
        firstEntryPrice: null,
        lotSequence: 0,
        previousSessionClose: null,
        runningClose: null,
        sessionOpen: null,
        sessionDate: null,
      } as unknown as Record<string, JsonValue>,
    };
  }

  /**
   * Bar-driven. Ticks are not a ladder input — firing is decided on 5-minute
   * bar *close* (`PRD.md:92`), and acting on a tick would fire on the
   * intra-bar spike the rules deliberately ignore.
   */
  onTick(): OrderIntent[] {
    return [];
  }

  /**
   * The ladder's evaluation of one closed bar.
   *
   * Mutates `state.data` in place: the coordinator owns the state object and
   * hands the same reference to each hook call, so accumulating here is what
   * makes the ladder progress across bars. Every value written stays JSON —
   * the contract suite asserts the round trip after bar processing precisely
   * because this is where a non-serializable value would creep in.
   */
  onBar(bar: Bar, state: StrategyState): OrderIntent[] {
    if (bar.symbol !== this.config.symbol) {
      return [];
    }

    // Pre/post-market bars are excluded entirely (`PRD.md:100`) — including
    // from session tracking, so an after-hours print never becomes the close
    // the next session's anchor is measured against.
    if (!isRegularSession(bar.timestamp)) {
      return [];
    }

    const data = ladderData(state);
    const intents: OrderIntent[] = [];

    this.trackSession(bar, data);

    // ---- Exits first, so this bar's entry sees the freed rung ----
    //
    // The two placement modes ask different questions here, mirroring the split
    // on the entry side. IMMEDIATE asks which lot has *reached* its target — a
    // question only a closed bar can answer, and one that therefore misses a
    // rally spiking through the target and retracing. RESTING asks which lot has
    // no order protecting its target yet, and leaves the watching to the
    // exchange.
    //
    // Under RESTING no lot is closed here. The order goes to the broker and
    // waits; the lot closes only when a fill arrives, because until then the
    // shares are still held and a lot closed against an unfilled order would
    // misreport the position to reconciliation — and re-arm a rung against
    // shares that were never sold.
    if (this.config.orderPlacement === OrderPlacement.RESTING) {
      for (const exit of selectRestingExits(
        data.lots,
        bar.close,
        bar.timestamp,
        this.config.symbol,
      )) {
        intents.push(this.toExitIntent(exit));
      }
    } else {
      const exit = selectExit(data.lots, bar.close, bar.timestamp, this.config.symbol);

      if (exit) {
        this.applyExit(exit, data, bar.timestamp);
        intents.push(this.toExitIntent(exit));
      }
    }

    // ---- Then the entry decision ----
    // `trackSession` above always assigns `sessionOpen` before this point — it
    // sets it whenever the field is null — so the non-null assertion is a
    // statement of that invariant rather than an unchecked risk. A `?? bar.open`
    // fallback here would be an unreachable branch, and worse, it would silently
    // anchor off the wrong bar if the invariant ever broke instead of failing.
    const decision = evaluateBar(
      bar,
      this.positionView(data),
      this.config,
      data.previousSessionClose,
      data.sessionOpen!,
      [],
    );

    if (decision.intent) {
      // In RESTING mode no lot is opened here. The order goes to the broker and
      // waits; the lot is created only when a fill arrives, because until then
      // there are no shares and an optimistically-opened lot would misreport the
      // position to reconciliation for as long as the order sat unfilled.
      //
      // The rung is still recorded — as WORKING once the engine reports the
      // order id — so `selectFireableRung` will not place a second order at the
      // same level on the next bar.
      if (this.config.orderPlacement === OrderPlacement.IMMEDIATE) {
        this.applyEntry(decision.intent, data, bar.timestamp);
      }

      intents.push(this.toEntryIntent(decision.intent));
    }

    data.runningClose = bar.close;

    return intents;
  }

  /**
   * No context-driven decisions. The ladder fires on bar close and nothing
   * else — there is no timed behaviour for this hook to express.
   */
  evaluate(): OrderIntent[] {
    return [];
  }

  /**
   * Idempotent: the ladder holds no connection, timer, or handle. Lots and
   * rungs live in state the coordinator owns, and are deliberately **not**
   * cleared here — a terminated ladder still holds real shares, and discarding
   * lot composition would leave Story 9 nothing to reconcile against.
   */
  async terminate(): Promise<void> {
    return;
  }

  /**
   * Session boundary tracking.
   *
   * `previousSessionClose` is the last close of the *prior session*, frozen for
   * the whole of the current one. Feeding the anchor the previous *bar's* close
   * would let it track price downward intraday, holding the rung a permanent
   * spacing-unit below spot so it could never be reached — the reasoning
   * recorded at `replay-ladder.ts:62`.
   */
  private trackSession(bar: Bar, data: DipLadderStateData): void {
    const date = sessionDateOf(bar.timestamp);

    if (date !== data.sessionDate) {
      data.previousSessionClose = data.runningClose;
      data.sessionDate = date;
      data.sessionOpen = null;
    }

    if (data.sessionOpen === null) {
      data.sessionOpen = bar.open;
    }

    if (isSessionOpenBar(bar.timestamp)) {
      data.sessionOpen = bar.open;
    }
  }

  private positionView(data: DipLadderStateData): LadderPosition {
    return {
      rungs: data.rungs,
      heldLots: data.lots.filter((lot) => lot.status === LotStatus.HELD),
      firstEntryPrice: data.firstEntryPrice,
    };
  }

  /**
   * Records the lot and re-arms its rung **at the original price**.
   *
   * The exit fills at the lot's own target, which is the assumption Story 4
   * made and Story 11 replaces with a real fill model. The engine overrides
   * this with the broker's actual fill price.
   */
  private applyExit(exit: ExitIntent, data: DipLadderStateData, at: string): void {
    // `selectExit` chose this lot from `data.lots`, so the lookup always
    // succeeds. There is deliberately no not-found branch: it would be
    // unreachable code dressed up as a safety check, and a guard that can
    // never run is a guard nobody can verify still works.
    const index = data.lots.findIndex((lot) => lot.id === exit.lotId);
    const closed = closeLot(data.lots[index], exit.limitPrice, at);
    data.lots[index] = closed;
    data.rungs = data.rungs.map((rung) =>
      rung.lotId === closed.id ? reArm(rung, at) : rung,
    ) as DipLadderStateData['rungs'];
  }

  /**
   * Records that a limit order is now resting at `rungPrice`.
   *
   * Called by the engine after the broker acknowledges the order, not when the
   * intent is created — a rung must not be marked `WORKING` for an order that
   * was rejected or never reached IB, or the level would be blocked forever
   * with nothing actually resting there.
   *
   * Creates the rung if the ladder has not established this level before, which
   * is the ordinary case: in RESTING mode the rung's first appearance is when
   * its order is placed, not when a lot fills.
   */
  static recordWorkingOrder(state: StrategyState, rungPrice: number, clientOrderId: string): void {
    const data = ladderData(state);
    const existing = findRung(data.rungs, rungPrice);

    data.rungs = (
      existing
        ? data.rungs.map((rung) =>
            rung.price === existing.price ? markWorking(rung, clientOrderId) : rung,
          )
        : [...data.rungs, markWorking(createRung(rungPrice), clientOrderId)]
    ) as DipLadderStateData['rungs'];
  }

  /**
   * Releases a resting order that went away without filling — cancelled,
   * rejected, or expired at the close.
   *
   * The rung becomes fireable again. Without this a DAY order that expired
   * overnight would leave its rung `WORKING` forever, and the ladder would
   * never place another order at that level.
   */
  static clearWorkingOrder(state: StrategyState, clientOrderId: string): void {
    const data = ladderData(state);

    data.rungs = data.rungs.map((rung) =>
      rung.workingOrderId === clientOrderId ? clearWorking(rung) : rung,
    ) as DipLadderStateData['rungs'];

    // A resting SELL that went away leaves its lot held with nothing protecting
    // its target. Clearing the id is what makes the lot eligible for a fresh
    // order on the next bar — the exit-side equivalent of a rung becoming
    // fireable again, and the reason a DAY-expired sell re-places itself
    // without any separate scheduling.
    data.lots = data.lots.map((lot) =>
      lot.workingOrderId === clientOrderId ? { ...lot, workingOrderId: null } : lot,
    ) as DipLadderStateData['lots'];
  }

  /**
   * Records that a SELL is now resting against `lotId`.
   *
   * Called by the engine after the broker acknowledges the order, for the same
   * reason as `recordWorkingOrder`: a lot must not be marked as protected by an
   * order that was rejected or never reached IB, or `selectRestingExits` would
   * skip it forever and its target would go unwatched.
   */
  static recordWorkingExit(state: StrategyState, lotId: string, clientOrderId: string): void {
    const data = ladderData(state);

    data.lots = data.lots.map((lot) =>
      lot.id === lotId ? { ...lot, workingOrderId: clientOrderId } : lot,
    ) as DipLadderStateData['lots'];
  }

  /**
   * Closes a lot from a broker fill on a resting SELL, re-arming its rung.
   *
   * The RESTING-mode counterpart to `applyExit`, and the difference is the whole
   * point of Story 14a: the lot closes at the **actual** fill price rather than
   * at the target it assumed, and the rung re-arms only now — when the shares
   * have genuinely been sold — rather than when the intent was created.
   *
   * **A partial fill splits the lot** rather than shrinking it; see `splitLot`
   * for why. The sold portion closes and the remainder stays held at the same
   * basis, keeping its place in the FIFO queue. The rung deliberately does
   * **not** re-arm in that case: it still holds shares, and re-arming a level
   * that is still occupied would let the ladder place an entry against exposure
   * it has not actually released.
   *
   * Returns the closed portion so the engine can persist and report it.
   */
  static closeLotFromFill(
    state: StrategyState,
    fill: { lotId: string; price: number; quantity: number; at: string },
  ): { closed: Lot; remainder: Lot | null } | null {
    const data = ladderData(state);
    const index = data.lots.findIndex((lot) => lot.id === fill.lotId);

    // Unlike `applyExit`, this lookup genuinely can miss: the fill arrives from
    // the broker long after the intent, across restarts and reconciliation, so
    // the lot it names may have been closed by another path already. Returning
    // null lets the engine treat it as an unattributable fill rather than
    // throwing on the fill router.
    if (index === -1 || data.lots[index].status !== LotStatus.HELD) {
      return null;
    }

    const lot = data.lots[index];

    if (fill.quantity < lot.quantity) {
      data.lotSequence += 1;
      const { sold, remainder } = splitLot(
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
      ] as DipLadderStateData['lots'];

      return { closed: sold, remainder };
    }

    const closed = closeLot(lot, fill.price, fill.at);
    data.lots = data.lots.map((candidate) =>
      candidate.id === lot.id ? closed : candidate,
    ) as DipLadderStateData['lots'];
    data.rungs = data.rungs.map((rung) =>
      rung.lotId === closed.id ? reArm(rung, fill.at) : rung,
    ) as DipLadderStateData['rungs'];

    return { closed, remainder: null };
  }

  /**
   * Opens a lot from a broker fill on a resting order.
   *
   * This is the RESTING-mode counterpart to `applyEntry`: the shares now exist,
   * so the lot is created from the **actual** fill price and quantity rather
   * than the rung's assumed values. The exit target follows from the real fill
   * price, which is the rule that each lot exits at its own fill +5%
   * (`PRD.md:129`).
   *
   * Returns the opened lot so the engine can persist it.
   */
  static openLotFromFill(
    state: StrategyState,
    config: DipLadderConfig,
    fill: { rungPrice: number; price: number; quantity: number; at: string },
  ): Lot {
    const data = ladderData(state);

    data.lotSequence += 1;

    const lot = openLot({
      id: `${config.symbol}-lot-${data.lotSequence}`,
      rungPrice: fill.rungPrice,
      fillPrice: fill.price,
      quantity: fill.quantity,
      openedAt: fill.at,
      takeProfitPercent: config.takeProfitPercent,
      takeProfitDollars: config.takeProfitDollars,
    });

    data.lots.push(lot);

    const existing = findRung(data.rungs, fill.rungPrice);

    data.rungs = (
      existing
        ? data.rungs.map((rung) => (rung.price === existing.price ? markHeld(rung, lot.id) : rung))
        : [...data.rungs, markHeld(createRung(fill.rungPrice), lot.id)]
    ) as DipLadderStateData['rungs'];

    if (data.firstEntryPrice === null) {
      data.firstEntryPrice = lot.fillPrice;
    }

    return lot;
  }

  private applyEntry(entry: EntryIntent, data: DipLadderStateData, at: string): void {
    data.lotSequence += 1;

    const lot = openLot({
      id: `${this.config.symbol}-lot-${data.lotSequence}`,
      rungPrice: entry.limitPrice,
      // Assumed fill at the rung. The engine replaces this with the broker's
      // actual fill price once the order round-trips.
      fillPrice: entry.limitPrice,
      quantity: entry.quantity,
      openedAt: at,
      takeProfitPercent: this.config.takeProfitPercent,
      takeProfitDollars: this.config.takeProfitDollars,
    });

    data.lots.push(lot);

    const existing = findRung(data.rungs, lot.rungPrice);

    data.rungs = (
      existing
        ? data.rungs.map((rung) => (rung.price === existing.price ? markHeld(rung, lot.id) : rung))
        : [...data.rungs, markHeld(createRung(lot.rungPrice), lot.id)]
    ) as DipLadderStateData['rungs'];

    if (data.firstEntryPrice === null) {
      data.firstEntryPrice = lot.fillPrice;
    }
  }

  /** The mechanical mapping the ladder's types were designed for. */
  private toEntryIntent(entry: EntryIntent): OrderIntent {
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
      metadata: { rungPrice: entry.limitPrice },
    };
  }

  private toExitIntent(exit: ExitIntent): OrderIntent {
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
      metadata: { lotId: exit.lotId, rungPrice: exit.rungPrice },
    };
  }

  /** Read helpers the engine and API use to project state without re-deriving it. */
  static lotsOf(state: StrategyState): Lot[] {
    return ladderData(state).lots;
  }

  static rungsOf(state: StrategyState): Rung[] {
    return ladderData(state).rungs;
  }
}
