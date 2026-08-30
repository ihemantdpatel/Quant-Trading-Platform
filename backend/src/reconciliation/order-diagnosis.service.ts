/**
 * Read-only diagnosis of what rests at the broker versus what the ladder
 * believes rests there.
 *
 * ## Why this is a separate service from `ReconciliationService`
 *
 * `reconcileAll` *repairs* — it releases rungs, adopts orphans, restores state
 * from the database, and can halt a symbol on the lot-sum assertion. That makes
 * it the wrong tool for the question "what is wrong right now?", because asking
 * changes the answer. An operator deciding whether to intervene needs to see
 * the divergence **before** anything acts on it.
 *
 * So this service holds no repair path at all. It reads `getOpenOrders()`, joins
 * it against live ladder state, and classifies. It writes nothing, releases no
 * rung, halts no symbol, and places and cancels no order. The two actions that
 * *do* act — placing a diagnosed gap, cancelling a diagnosed duplicate — live
 * behind their own explicit routes and consume this diagnosis as input.
 *
 * ## The four categories, and why each is a distinct finding
 *
 * - `MATCHED` — a rung or lot whose `workingOrderId` is present at the broker.
 *   The healthy case; reported so a clean result is legible as "checked and
 *   fine" rather than as an empty screen, which is the same distinction
 *   `RUNG_VERIFICATION_SKIPPED` draws in the daily report.
 * - `UNBACKED` — the ladder holds a `workingOrderId` the broker does not list.
 *   The order expired at the close or was cancelled in TWS. The level is
 *   blocked and the ladder has silently stopped laddering there. **Repaired by
 *   `POST /reconcile`, not here** — release is reconciliation's job and
 *   duplicating it would give two routes that can free a level.
 * - `ORPHAN` — an order at the broker no rung or lot claims. Either the crash
 *   window (placed, then the process died before persisting) or an order an
 *   operator placed by hand. Reported, never cancelled: the existing rule that
 *   the engine does not destroy orders it cannot explain is exactly right here,
 *   because those two causes are indistinguishable from this side.
 * - `DUPLICATE` — two or more orders at one symbol/side/price. The only finding
 *   that can cost money by itself, since both can fill.
 *
 * ## Missing orders are diagnosed, not inferred from an empty book
 *
 * A ladder with nothing resting is not evidence of a fault: a flat ladder with
 * no fireable rung correctly rests nothing. So `missing` is derived from a
 * *specific* claim the ladder makes and the broker contradicts — a HELD lot
 * with no resting sell, or a fireable rung with no resting buy — never from the
 * absence of orders in general. Placing on an empty book would open positions
 * the ladder never decided to open.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BROKER_ADAPTER,
  BrokerAdapter,
  OpenOrder,
  OrderSide,
} from '../broker/broker-adapter.interface';
import { CoordinatorService } from '../strategies/coordinator.service';
import {
  DIP_LADDER_ID_PREFIX,
  DipLadderStrategy,
} from '../strategies/dip-ladder/dip-ladder.strategy';
import { LotStatus } from '../strategies/dip-ladder/lot';
import { RungStatus } from '../strategies/dip-ladder/rung';
import { SymbolHaltService } from './symbol-halt.service';

/** Rounds to cents so a broker price and a ladder price compare equal. */
function roundPrice(value: number): number {
  return Math.round(value * 100) / 100;
}

export enum OrderFindingKind {
  MATCHED = 'MATCHED',
  UNBACKED = 'UNBACKED',
  ORPHAN = 'ORPHAN',
  DUPLICATE = 'DUPLICATE',
}

export interface MatchedOrder {
  kind: OrderFindingKind.MATCHED;
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  filledQuantity: number;
  limitPrice: number;
  /** What claims this order: a rung level for a BUY, a lot id for a SELL. */
  claimedBy: string;
}

export interface UnbackedRung {
  kind: OrderFindingKind.UNBACKED;
  symbol: string;
  /** The ladder's record the broker does not corroborate. */
  clientOrderId: string;
  /** Rung price for an entry; null when the claim came from a lot. */
  rungPrice: number | null;
  lotId: string | null;
  side: OrderSide;
}

export interface OrphanOrder {
  kind: OrderFindingKind.ORPHAN;
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  filledQuantity: number;
  limitPrice: number;
}

/**
 * Two or more orders at one symbol, side, and price.
 *
 * `tracked` and `untracked` split them by whether the ladder claims the order
 * through a `workingOrderId`. That split is what makes a safe cancellation
 * possible: where exactly one is tracked, the untracked ones are unambiguously
 * the extras. Where none or several are tracked, the group is reported and left
 * alone — the system cannot tell which order the ladder depends on, and
 * guessing would cancel the one it is relying on.
 */
export interface DuplicateGroup {
  kind: OrderFindingKind.DUPLICATE;
  symbol: string;
  side: OrderSide;
  limitPrice: number;
  tracked: string[];
  untracked: string[];
  /** True when exactly one order is tracked, so the extras are unambiguous. */
  resolvable: boolean;
}

/**
 * An order the ladder claims should rest and the broker does not list.
 *
 * Carries everything needed to place it, but is **not** itself an instruction
 * to place: `POST /orders/place-missing` re-derives its own candidates and puts
 * every one through the risk manager. This is the operator's preview.
 */
export interface MissingOrder {
  symbol: string;
  strategyId: string;
  side: OrderSide;
  quantity: number;
  limitPrice: number;
  /** Why the ladder believes this should be resting. */
  reason: string;
  lotId: string | null;
  rungPrice: number | null;
}

export interface OrderDiagnosis {
  ranAt: string;
  /**
   * False when `getOpenOrders()` threw.
   *
   * Every list is empty in that case, and they must not be read as findings —
   * "cannot ask" and "nothing resting" lead to opposite actions, the same
   * distinction the engine's per-bar duplicate guard draws with `UNAVAILABLE`.
   */
  brokerReachable: boolean;
  reason: string | null;
  matched: MatchedOrder[];
  unbacked: UnbackedRung[];
  orphans: OrphanOrder[];
  duplicates: DuplicateGroup[];
  missing: MissingOrder[];
  /** Symbols skipped because they are halted — their ladder state is empty. */
  skippedSymbols: string[];
}

@Injectable()
export class OrderDiagnosisService {
  private readonly logger = new Logger(OrderDiagnosisService.name);

  constructor(
    private readonly coordinator: CoordinatorService,
    private readonly halts: SymbolHaltService,
    @Inject(BROKER_ADAPTER) private readonly broker: BrokerAdapter,
  ) {}

  /**
   * Compares the broker's open orders against every registered ladder.
   *
   * Nothing here mutates state. A halted symbol is skipped rather than
   * diagnosed: a halt leaves live strategy state empty by design, so every one
   * of its orders would be reported as an orphan and every rung as missing —
   * findings that describe the halt rather than the orders.
   */
  async diagnose(now: string): Promise<OrderDiagnosis> {
    const empty: OrderDiagnosis = {
      ranAt: now,
      brokerReachable: true,
      reason: null,
      matched: [],
      unbacked: [],
      orphans: [],
      duplicates: [],
      missing: [],
      skippedSymbols: [],
    };

    let openOrders: OpenOrder[];

    try {
      openOrders = await this.broker.getOpenOrders();
    } catch (error) {
      // Reported as unreachable rather than as "no orders". Collapsing the two
      // would tell an operator the book is empty during an outage, which is the
      // reading most likely to prompt exactly the wrong action.
      return {
        ...empty,
        brokerReachable: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    const diagnosis: OrderDiagnosis = { ...empty };

    // Every order the ladders collectively claim, so an order can be tested for
    // orphanhood against all strategies rather than only the one being walked.
    const claims = new Map<string, { symbol: string; claimedBy: string }>();

    for (const snapshot of this.coordinator.snapshots()) {
      if (!snapshot.id.startsWith(DIP_LADDER_ID_PREFIX)) {
        continue;
      }

      const symbol = snapshot.symbols[0];

      if (!symbol) {
        continue;
      }

      if (this.halts.isHalted(symbol)) {
        diagnosis.skippedSymbols.push(symbol);
        continue;
      }

      const state = this.coordinator.getState(snapshot.id);

      if (!state) {
        continue;
      }

      const lots = DipLadderStrategy.lotsOf(state) ?? [];
      const rungs = DipLadderStrategy.rungsOf(state) ?? [];
      const restingIds = new Set(openOrders.map((order) => order.clientOrderId));

      for (const rung of rungs) {
        if (!rung.workingOrderId) {
          continue;
        }

        if (restingIds.has(rung.workingOrderId)) {
          claims.set(rung.workingOrderId, {
            symbol,
            claimedBy: `rung ${rung.price.toFixed(2)}`,
          });
        } else {
          diagnosis.unbacked.push({
            kind: OrderFindingKind.UNBACKED,
            symbol,
            clientOrderId: rung.workingOrderId,
            rungPrice: rung.price,
            lotId: null,
            side: 'BUY',
          });
        }
      }

      for (const lot of lots) {
        if (lot.status !== LotStatus.HELD || !lot.workingOrderId) {
          continue;
        }

        if (restingIds.has(lot.workingOrderId)) {
          claims.set(lot.workingOrderId, { symbol, claimedBy: `lot ${lot.id}` });
        } else {
          diagnosis.unbacked.push({
            kind: OrderFindingKind.UNBACKED,
            symbol,
            clientOrderId: lot.workingOrderId,
            rungPrice: lot.rungPrice,
            lotId: lot.id,
            side: 'SELL',
          });
        }
      }

      // **Missing orders — derived from a claim, never from an empty book.**
      //
      // A HELD lot with no `workingOrderId` is an unprotected position: the
      // ladder decided on its exit target when the lot opened, and no order is
      // carrying that decision. This is the gap with real money behind it.
      const symbolOrders = openOrders.filter((order) => order.symbol === symbol);

      for (const lot of lots) {
        if (lot.status !== LotStatus.HELD || lot.workingOrderId) {
          continue;
        }

        // The broker is the authority, not the (absent) in-memory mark: a sell
        // at this price and quantity already covers these shares whatever the
        // lot record says. Same price+quantity match as `restingSellIdFor`, and
        // deliberately coarse for the same reason — a declined placement is
        // recoverable, a position sold twice is not.
        const covered = symbolOrders.some(
          (order) =>
            order.side === 'SELL' &&
            roundPrice(order.limitPrice) === roundPrice(lot.exitTarget) &&
            order.quantity === lot.quantity,
        );

        if (covered) {
          continue;
        }

        diagnosis.missing.push({
          symbol,
          strategyId: snapshot.id,
          side: 'SELL',
          quantity: lot.quantity,
          limitPrice: lot.exitTarget,
          reason: `lot ${lot.id} is held since ${lot.openedAt} with no resting sell`,
          lotId: lot.id,
          rungPrice: lot.rungPrice,
        });
      }

      // A rung the ladder marked WORKING whose order the broker does not list
      // is *not* reported as missing — it is `UNBACKED`, and releasing it is
      // reconciliation's job. Re-placing at a level whose status still says
      // WORKING would race that release. Only a rung the ladder considers
      // genuinely fireable, and which has no order resting at its price, is a
      // candidate.
      for (const rung of rungs) {
        if (rung.lotId !== null || rung.workingOrderId !== null) {
          continue;
        }

        if (rung.status === RungStatus.WORKING || rung.status === RungStatus.HELD) {
          continue;
        }

        const occupied = symbolOrders.some(
          (order) =>
            order.side === 'BUY' && roundPrice(order.limitPrice) === roundPrice(rung.price),
        );

        if (occupied) {
          continue;
        }

        diagnosis.missing.push({
          symbol,
          strategyId: snapshot.id,
          side: 'BUY',
          quantity: 0, // Sized by the risk manager at placement, never here.
          limitPrice: rung.price,
          reason: `rung ${rung.price.toFixed(2)} is ${rung.status} with no resting buy`,
          lotId: null,
          rungPrice: rung.price,
        });
      }
    }

    // Orders at the broker that no ladder claims.
    const diagnosedSymbols = new Set(
      this.coordinator
        .snapshots()
        .filter((s) => s.id.startsWith(DIP_LADDER_ID_PREFIX))
        .map((s) => s.symbols[0])
        .filter((s): s is string => Boolean(s) && !this.halts.isHalted(s)),
    );

    for (const order of openOrders) {
      if (!diagnosedSymbols.has(order.symbol)) {
        // Not this system's symbol, or the symbol is halted and was skipped.
        // Reporting it as an orphan would invite cancelling an order belonging
        // to something the engine deliberately is not reasoning about.
        continue;
      }

      const claim = claims.get(order.clientOrderId);

      if (claim) {
        diagnosis.matched.push({
          kind: OrderFindingKind.MATCHED,
          clientOrderId: order.clientOrderId,
          symbol: order.symbol,
          side: order.side,
          quantity: order.quantity,
          filledQuantity: order.filledQuantity,
          limitPrice: order.limitPrice,
          claimedBy: claim.claimedBy,
        });
      } else {
        diagnosis.orphans.push({
          kind: OrderFindingKind.ORPHAN,
          clientOrderId: order.clientOrderId,
          symbol: order.symbol,
          side: order.side,
          quantity: order.quantity,
          filledQuantity: order.filledQuantity,
          limitPrice: order.limitPrice,
        });
      }
    }

    diagnosis.duplicates = this.groupDuplicates(openOrders, diagnosedSymbols, claims);

    this.logger.log(
      `order diagnosis: ${diagnosis.matched.length} matched, ${diagnosis.unbacked.length} unbacked, ` +
        `${diagnosis.orphans.length} orphan(s), ${diagnosis.duplicates.length} duplicate group(s), ` +
        `${diagnosis.missing.length} missing`,
    );

    return diagnosis;
  }

  /**
   * Groups orders sharing symbol, side, and price.
   *
   * A partially filled order is **excluded from a duplicate group**. It has
   * already put shares on the books, so it is not interchangeable with an
   * untouched order at the same price and cancelling it would strand the
   * remainder mid-fill — the case `routeFill` handles deliberately by
   * cancelling and opening a lot for what filled. Leaving it out means a group
   * containing one is reported as whatever remains, and where that is a single
   * order it is not a duplicate at all.
   */
  private groupDuplicates(
    openOrders: OpenOrder[],
    diagnosedSymbols: Set<string>,
    claims: Map<string, { symbol: string; claimedBy: string }>,
  ): DuplicateGroup[] {
    const groups = new Map<string, OpenOrder[]>();

    for (const order of openOrders) {
      if (!diagnosedSymbols.has(order.symbol) || order.filledQuantity > 0) {
        continue;
      }

      const key = `${order.symbol}|${order.side}|${roundPrice(order.limitPrice)}`;
      groups.set(key, [...(groups.get(key) ?? []), order]);
    }

    const duplicates: DuplicateGroup[] = [];

    for (const orders of groups.values()) {
      if (orders.length < 2) {
        continue;
      }

      const tracked = orders
        .filter((order) => claims.has(order.clientOrderId))
        .map((order) => order.clientOrderId);
      const untracked = orders
        .filter((order) => !claims.has(order.clientOrderId))
        .map((order) => order.clientOrderId);

      duplicates.push({
        kind: OrderFindingKind.DUPLICATE,
        symbol: orders[0].symbol,
        side: orders[0].side,
        limitPrice: roundPrice(orders[0].limitPrice),
        tracked,
        untracked,
        // Exactly one tracked order makes the extras unambiguous. Zero tracked
        // means the ladder depends on none of them and cannot say which an
        // operator placed; more than one means it depends on several and
        // cancelling any would break a claim it holds. Both are reported.
        resolvable: tracked.length === 1 && untracked.length > 0,
      });
    }

    return duplicates;
  }
}

/** The outcome of cancelling the extras in one duplicate group. */
export interface DuplicateResolution {
  ranAt: string;
  cancelled: { clientOrderId: string; symbol: string; limitPrice: number; side: OrderSide }[];
  /** Groups left alone, each with the reason it could not be resolved safely. */
  skipped: { limitPrice: number; symbol: string; side: OrderSide; reason: string }[];
  failed: { clientOrderId: string; reason: string }[];
}

/**
 * Cancels the redundant orders in a duplicate group.
 *
 * ## This is the one place the engine destroys an order, and why that is allowed
 *
 * `reconcileOpenOrders` states the standing rule: an order the engine cannot
 * explain is reported, never cancelled, because cancelling one an operator
 * placed by hand would be the system overruling a human decision it does not
 * understand. That reasoning turns on *inexplicability* — and a duplicate is
 * the case where it does not hold. When exactly one order at a price is tied to
 * a rung or lot through `workingOrderId`, the ladder is demonstrably depending
 * on that one, and the others are surplus exposure at a level already covered.
 * Two orders at one rung both fill, which is the failure this exists to stop.
 *
 * The rule is preserved everywhere it still applies:
 *
 * - **Only untracked extras are cancelled**, never the tracked order. The
 *   ladder's own claim is what survives.
 * - **An ambiguous group is skipped**, not guessed at. Zero tracked orders
 *   means the ladder depends on none of them and cannot say which an operator
 *   placed by hand; more than one means it depends on several. Both are
 *   reported and left resting.
 * - **A partially filled order is never in a group at all** — `groupDuplicates`
 *   excludes it, so this cannot strand a fill mid-flight.
 * - **The diagnosis is re-run inside this call.** Acting on ids from the
 *   request would let a stale preview cancel an order that has since filled or
 *   become the tracked one; only groups that are *currently* resolvable are
 *   touched.
 *
 * A cancellation failure is reported, never retried in a loop: the order is
 * still resting, and reconciliation on the next run will see it again.
 */
@Injectable()
export class DuplicateOrderService {
  private readonly logger = new Logger(DuplicateOrderService.name);

  constructor(
    private readonly diagnosis: OrderDiagnosisService,
    @Inject(BROKER_ADAPTER) private readonly broker: BrokerAdapter,
  ) {}

  async resolveDuplicates(now: string): Promise<DuplicateResolution> {
    const result: DuplicateResolution = { ranAt: now, cancelled: [], skipped: [], failed: [] };
    const current = await this.diagnosis.diagnose(now);

    if (!current.brokerReachable) {
      // Nothing is cancelled on an unreadable book. The diagnosis reports no
      // duplicates in this state, and treating that emptiness as "resolved"
      // would report success for a check that never ran.
      result.skipped.push({
        limitPrice: 0,
        symbol: '-',
        side: 'BUY',
        reason: `the broker could not be reached: ${current.reason ?? 'unknown'}`,
      });

      return result;
    }

    for (const group of current.duplicates) {
      if (!group.resolvable) {
        result.skipped.push({
          limitPrice: group.limitPrice,
          symbol: group.symbol,
          side: group.side,
          reason:
            group.tracked.length === 0
              ? 'no order in this group is tracked by the ladder, so which one to keep cannot be ' +
                'determined — resolve it in TWS'
              : `${group.tracked.length} orders here are tracked by the ladder, so cancelling any ` +
                'would break a claim it holds — resolve it in TWS',
        });
        continue;
      }

      for (const clientOrderId of group.untracked) {
        try {
          await this.broker.cancel(clientOrderId);
          result.cancelled.push({
            clientOrderId,
            symbol: group.symbol,
            limitPrice: group.limitPrice,
            side: group.side,
          });
        } catch (error) {
          result.failed.push({
            clientOrderId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    this.logger.log(
      `duplicate resolution: cancelled ${result.cancelled.length}, ` +
        `skipped ${result.skipped.length} group(s), ${result.failed.length} failure(s)`,
    );

    return result;
  }
}
