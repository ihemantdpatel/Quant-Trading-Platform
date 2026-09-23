/**
 * Restart-safety for the grid strategy — parallel to `ReconciliationService`,
 * on its own, much smaller surface.
 *
 * **Strictly additive and parallel**, with one deliberate exception: this
 * service reads (never writes) the ladder's own `LOT_REPOSITORY` to learn how
 * much of the broker's reported position the ladder's held lots already
 * claim — see `siblingHeldQuantity`. The broker reports one net position per
 * symbol regardless of which strategy accumulated it, and the two strategies
 * trade the same symbol by design (`GRID_SYMBOL` in `strategies.module.ts`),
 * so a real position left behind by disabling the ladder must not read as an
 * *unexplained* grid mismatch. Beyond that read, nothing here touches `Lot`,
 * `Rung`, `DipLadderStrategy`, or `ReconciliationService`'s ladder-specific
 * write paths, so the already-running ladder is otherwise unaffected by this
 * feature's existence.
 *
 * **Deliberately no repair path and no rebuild tiers.** A lot-sum mismatch
 * halts for an operator, exactly like the ladder's reconciliation did before
 * `LotRebuildService` existed — this is a design decision for the grid
 * strategy's first version, not an oversight.
 *
 * **`recoverGridExitFills` is the one exception**, the grid counterpart to
 * `ReconciliationService.recoverExitFills` — a real incident (2026-09-22,
 * TQQQ) showed the gap is not hypothetical: a grid lot's resting sell filled
 * at the broker, nothing routed the fill live, and the stale `HELD` lot then
 * produced both a `GRID_LOT_SUM_MISMATCH` here and a misleading negative
 * `siblingHeldQuantity` reading on the ladder's own reconciliation for the
 * same symbol. Unlike the rebuild tiers, this is not a guess: it only closes
 * a lot when the `Fill` table holds this system's own record of the exact
 * exit, so it stays in keeping with "no repair path" for anything that isn't
 * evidence already on hand.
 *
 * **`reconcileOrderHistory` (stale `Order` row correction) is deliberately
 * not duplicated here.** That method operates on the `Order` table generically
 * — by `clientOrderId`, with no strategy or symbol filter — so
 * `ReconciliationService.reconcileOrderHistory` already corrects grid orders'
 * stale rows whenever it runs. The dip ladder is unconditionally enabled in
 * `EngineModule` (never behind a flag), so that call always runs alongside
 * this service's own reconciliation; duplicating it here would just be a
 * second, redundant broker round trip.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BROKER_ADAPTER,
  BrokerAdapter,
  BrokerPosition,
  OpenOrder,
} from '../broker/broker-adapter.interface';
import {
  FILL_REPOSITORY,
  FillRepository,
  GRID_LOT_REPOSITORY,
  GridLotRepository,
  LOT_REPOSITORY,
  LotRepository,
} from '../repositories/repository.interfaces';
import { CoordinatorService } from '../strategies/coordinator.service';
import { GRID_ID_PREFIX, GridStateData, GridStrategy } from '../strategies/grid/grid.strategy';
import { closeGridLot, GridLot, GridLotStatus } from '../strategies/grid/lot';
import {
  assertGridLotSum,
  GridLotSumVerdict,
  GridReconciliationStatus,
} from './grid-lot-sum-assertion';
import { SymbolHaltService } from './symbol-halt.service';

export const GRID_HALT_LOT_SUM_MISMATCH = 'GRID_LOT_SUM_MISMATCH';
export const GRID_HALT_BROKER_UNAVAILABLE = 'GRID_BROKER_UNAVAILABLE';

export interface GridSymbolReconciliation {
  strategyId: string;
  symbol: string;
  verdict: GridLotSumVerdict;
  resumed: boolean;
  restoredLots: number;
  /**
   * HELD lots closed by `recoverGridExitFills` before the assertion ran,
   * using a `Fill` this system already recorded for that lot's own exit
   * order. Reported even on a halt — the verdict above is computed from the
   * post-recovery lots, so a symbol that still does not reconcile after
   * recovery genuinely has a second, different problem.
   */
  recoveredExits: number;
}

export interface GridReconciliationReport {
  ranAt: string;
  clean: boolean;
  symbols: GridSymbolReconciliation[];
  haltedSymbols: string[];
  /** Sum of `GridSymbolReconciliation.recoveredExits` across every symbol. */
  recoveredExits: number;
}

/**
 * Deliberately not a `GridReconciliationReport` — same reasoning as
 * `OrderReconciliationReport` vs. `ReconciliationReport`: this run asserts
 * nothing about positions, so it must not carry `clean`/`haltedSymbols`.
 */
export interface GridOrderReconciliationReport {
  ranAt: string;
  symbols: string[];
  brokerReachable: boolean;
}

@Injectable()
export class GridReconciliationService {
  private readonly logger = new Logger(GridReconciliationService.name);
  private lastReport: GridReconciliationReport | null = null;
  private lastOrderReconciliation: GridOrderReconciliationReport | null = null;

  constructor(
    private readonly coordinator: CoordinatorService,
    private readonly halts: SymbolHaltService,
    @Inject(BROKER_ADAPTER) private readonly broker: BrokerAdapter,
    @Inject(GRID_LOT_REPOSITORY) private readonly gridLots: GridLotRepository,
    // The ladder's own lots for the *same* symbol — the mirror of
    // `ReconciliationService`'s own `GRID_LOT_REPOSITORY` read. See
    // `siblingHeldQuantity`.
    @Inject(LOT_REPOSITORY) private readonly ladderLots: LotRepository,
    // Read by `recoverGridExitFills` — the same `Fill` table the ladder's
    // `recoverExitFills` reads, populated only from a real IB `execDetails`
    // event, never synthesized.
    @Inject(FILL_REPOSITORY) private readonly fills: FillRepository,
  ) {}

  /**
   * The full sequence: query the broker, load persisted lots, assert the sum,
   * halt on mismatch, otherwise restore and reconcile open orders. Mirrors
   * `ReconciliationService.reconcileAll`'s shape at a smaller scale.
   */
  async reconcileAll(now: string): Promise<GridReconciliationReport> {
    const positions = await this.brokerPositions();
    const openOrders = await this.brokerOpenOrders();

    const results: GridSymbolReconciliation[] = [];

    for (const snapshot of this.coordinator.snapshots()) {
      if (!snapshot.id.startsWith(GRID_ID_PREFIX)) {
        continue;
      }

      const symbol = snapshot.symbols[0];

      if (!symbol) {
        continue;
      }

      results.push(await this.reconcileSymbol(snapshot.id, symbol, positions, openOrders, now));
    }

    const report: GridReconciliationReport = {
      ranAt: now,
      clean: results.every((result) => result.verdict.reconciled),
      symbols: results,
      haltedSymbols: this.halts.haltedSymbols(),
      recoveredExits: results.reduce((sum, result) => sum + result.recoveredExits, 0),
    };

    this.lastReport = report;

    this.logger.log(
      report.clean
        ? `grid reconciliation clean across ${results.length} symbol(s) — resumed`
        : `grid reconciliation FAILED for ${report.symbols
            .filter((s) => !s.verdict.reconciled)
            .map((s) => s.symbol)
            .join(', ')} — those symbols are halted`,
    );

    return report;
  }

  /**
   * Reconciles resting orders only, leaving positions untouched — the grid
   * counterpart to `ReconciliationService.reconcileOrders`, run on the same
   * post-close/5-minute-poll schedule so an expired DAY sell clears its
   * lot's `workingOrderId` during and after a session.
   */
  async reconcileOrders(now: string): Promise<GridOrderReconciliationReport> {
    const openOrders = await this.brokerOpenOrders();
    const symbols: string[] = [];

    for (const snapshot of this.coordinator.snapshots()) {
      if (!snapshot.id.startsWith(GRID_ID_PREFIX)) {
        continue;
      }

      const symbol = snapshot.symbols[0];

      if (!symbol) {
        continue;
      }

      await this.reconcileOpenOrders(snapshot.id, symbol, openOrders);
      symbols.push(symbol);
    }

    const report: GridOrderReconciliationReport = {
      ranAt: now,
      symbols,
      brokerReachable: openOrders !== null,
    };

    this.lastOrderReconciliation = report;

    this.logger.log(
      openOrders === null
        ? 'grid order reconciliation skipped — broker unreachable, ledger left as persisted'
        : `grid order reconciliation complete across ${symbols.length} symbol(s)`,
    );

    return report;
  }

  lastOrderReconcile(): GridOrderReconciliationReport | null {
    return this.lastOrderReconciliation;
  }

  lastReconciliation(): GridReconciliationReport | null {
    return this.lastReport;
  }

  private async reconcileSymbol(
    strategyId: string,
    symbol: string,
    positions: BrokerPosition[] | null,
    openOrders: OpenOrder[] | null,
    now: string,
  ): Promise<GridSymbolReconciliation> {
    const persistedLots = await this.gridLots.findByStrategy(strategyId);

    if (positions === null) {
      return this.haltWith(
        strategyId,
        symbol,
        GRID_HALT_BROKER_UNAVAILABLE,
        {
          symbol,
          status: GridReconciliationStatus.UNTRACKED_AT_BROKER,
          lotQuantity: persistedLots.reduce(
            (sum, lot) => (lot.status === GridLotStatus.HELD ? sum + lot.quantity : sum),
            0,
          ),
          brokerQuantity: 0,
          heldLotCount: persistedLots.filter((lot) => lot.status === GridLotStatus.HELD).length,
          reconciled: false,
          reason: `${symbol}: broker unreachable at startup — cannot verify the grid position, halted`,
        },
        now,
        0,
      );
    }

    // Adjusted for the ladder's own holdings on this symbol — see
    // `siblingHeldQuantity` and the file header comment.
    const rawBrokerQuantity = positions.find((p) => p.symbol === symbol)?.quantity ?? 0;
    const brokerQuantity = rawBrokerQuantity - (await this.siblingHeldQuantity(symbol));

    // Recover any HELD lot whose resting exit already filled at the broker
    // before asserting the sum — see `recoverGridExitFills`. A lot closed
    // here is exactly the shape of gap the assertion below would otherwise
    // halt on, and the fix is evidence this system already recorded, not a
    // guess.
    const recovery = await this.recoverGridExitFills(strategyId, symbol, persistedLots, openOrders);

    const verdict = assertGridLotSum(symbol, recovery.lots, brokerQuantity);

    if (!verdict.reconciled) {
      return this.haltWith(
        strategyId,
        symbol,
        GRID_HALT_LOT_SUM_MISMATCH,
        verdict,
        now,
        recovery.recovered,
      );
    }

    const restoredLots = this.restore(strategyId, recovery.lots);

    // Resting orders are reconciled *after* the lot-sum assertion passes, not
    // instead of it — same split as the ladder's version.
    await this.reconcileOpenOrders(strategyId, symbol, openOrders);

    this.logger.log(
      `${symbol}: grid reconciled — ${verdict.reason}. Restored ${restoredLots} lot(s)` +
        (recovery.recovered > 0 ? ` (recovered ${recovery.recovered} exit fill(s)).` : '.'),
    );

    return {
      strategyId,
      symbol,
      verdict,
      resumed: true,
      restoredLots,
      recoveredExits: recovery.recovered,
    };
  }

  /**
   * Closes a HELD grid lot whose resting exit already filled at the broker
   * but was never routed live — the grid counterpart to
   * `ReconciliationService.recoverExitFills`, minus the rung reconstruction:
   * grid keeps no persisted rung ledger (see the file header comment), so
   * there is nothing to re-arm.
   *
   * A lot closes only when both hold:
   *
   * 1. its `workingOrderId` names an order that is **not** currently resting
   *    at the broker (`openOrders` says so), and
   * 2. this system's `Fill` table — populated only from a real IB
   *    `execDetails` event, never synthesized — holds fill(s) for that exact
   *    `clientOrderId` summing to **exactly** the lot's quantity.
   *
   * Nothing here infers a price or invents a quantity; both come from the
   * fill itself. Anything short of an exact match — no fill at all, or one
   * that does not cover the whole lot (a genuine partial exit needs the live
   * path's lot-splitting, not a guess made here) — is left untouched, exactly
   * as before this method existed: `reconcileOpenOrders` below still releases
   * a `workingOrderId` the broker confirms gone *without* a matching fill
   * (cancelled, rejected, expired), which is a different, safe kind of gone.
   */
  private async recoverGridExitFills(
    strategyId: string,
    symbol: string,
    lots: GridLot[],
    openOrders: OpenOrder[] | null,
  ): Promise<{ lots: GridLot[]; recovered: number }> {
    // `null` is "could not ask", not "nothing resting" — the same distinction
    // `reconcileOpenOrders` makes below, for the same reason: treating it as
    // "definitely not resting" could close a lot whose exit is still working.
    if (openOrders === null) {
      return { lots, recovered: 0 };
    }

    const restingSellIds = new Set(
      openOrders
        .filter((order) => order.symbol === symbol && order.side === 'SELL')
        .map((order) => order.clientOrderId),
    );

    let nextLots = lots;
    let recovered = 0;

    for (const lot of lots) {
      if (lot.status !== GridLotStatus.HELD || !lot.workingOrderId) {
        continue;
      }

      if (restingSellIds.has(lot.workingOrderId)) {
        continue;
      }

      const exitFills = await this.fills.findByClientOrderId(lot.workingOrderId);
      const filledQuantity = exitFills.reduce((sum, fill) => sum + fill.quantity, 0);

      if (exitFills.length === 0 || filledQuantity !== lot.quantity) {
        continue;
      }

      // Several rows would mean the broker filled this one order in more than
      // one print; the exact-quantity match above already rules out a true
      // partial sitting here, so the last print is the one that completed it.
      const fill = exitFills[exitFills.length - 1];

      const closed = closeGridLot(lot, fill.price, fill.timestamp);
      nextLots = nextLots.map((candidate) => (candidate.id === lot.id ? closed : candidate));
      recovered += 1;

      this.logger.warn(
        `${symbol}: recovered grid exit fill for ${lot.id} — order ${lot.workingOrderId} ` +
          `filled ${fill.quantity} @ ${fill.price.toFixed(2)} but was never routed live; closed ` +
          `with realized ${((fill.price - lot.fillPrice) * lot.quantity).toFixed(2)}`,
      );
    }

    if (recovered > 0) {
      await this.gridLots.saveAll(nextLots, strategyId, symbol);
    }

    return { lots: nextLots, recovered };
  }

  /**
   * Writes persisted grid lots into the coordinator's live strategy state.
   *
   * `lotSequence` is re-derived from the restored ids rather than carried in
   * a snapshot — grid keeps no `StrategyStateSnapshot` row at all (see the
   * feature plan's "authority split" section); this is the same technique
   * `EngineService.restoreClientOrderSequence` already uses for `Order` ids.
   * `sessionDate` is deliberately left at whatever `initialize()` set
   * (`null`) — losing it just means the next live bar is treated as a fresh
   * session-open trigger, which re-emits the same desired intents.
   */
  private restore(strategyId: string, lots: GridLot[]): number {
    const state = this.coordinator.getState(strategyId);

    if (!state) {
      // Registered but never initialized — nothing to restore into. Only
      // reachable for a disabled strategy, mirroring the ladder's `restore`.
      return 0;
    }

    const data = state.data as unknown as GridStateData;

    data.lots = lots as GridStateData['lots'];
    data.lotSequence = Math.max(data.lotSequence, deriveLotSequence(lots));

    this.coordinator.setState(strategyId, state);

    return lots.length;
  }

  /**
   * Releases a lot's `workingOrderId` when its resting sell is no longer at
   * the broker (DAY expiry, or an operator's manual cancel), and rebuilds the
   * engine's in-memory working-order registry via `onOpenOrdersReconciled`.
   *
   * There is no BUY-side equivalent: grid keeps no persisted "pending buy"
   * bookkeeping the way a `Rung` provides, so there is nothing to release or
   * adopt on that side (an accepted v1 limitation — see the feature plan).
   */
  private async reconcileOpenOrders(
    strategyId: string,
    symbol: string,
    openOrders: OpenOrder[] | null,
  ): Promise<void> {
    const state = this.coordinator.getState(strategyId);

    if (openOrders === null) {
      this.logger.warn(
        `${symbol}: open orders could not be read from the broker — grid lot state left as ` +
          'persisted. A lot whose sell expired will stay unprotected until the next ' +
          'successful reconciliation.',
      );

      return;
    }

    if (!state) {
      // Disabled, not halted — the mirror of `ReconciliationService`'s own
      // `releaseStaleDisabledSells`. Operates on the persisted `GridLot` row
      // directly since there is no live state to mutate.
      await this.releaseStaleDisabledSells(strategyId, symbol, openOrders);
      return;
    }

    const lots = GridStrategy.lotsOf(state) ?? [];
    const restingForSymbol = openOrders.filter((order) => order.symbol === symbol);
    const restingSellIds = new Set(
      restingForSymbol.filter((order) => order.side === 'SELL').map((order) => order.clientOrderId),
    );

    let released = 0;

    for (const lot of lots) {
      if (
        lot.status === GridLotStatus.HELD &&
        lot.workingOrderId &&
        !restingSellIds.has(lot.workingOrderId)
      ) {
        GridStrategy.clearWorkingOrder(state, lot.workingOrderId);
        released += 1;
      }
    }

    if (released > 0) {
      this.logger.log(
        `${symbol}: grid open-order reconciliation — released ${released} lot working-order ` +
          'mark(s) whose sell is no longer at the broker',
      );
    }

    this.onOpenOrdersReconciled?.(strategyId, symbol, restingForSymbol);
  }

  /** The disabled-strategy counterpart to the release above — see `ReconciliationService.releaseStaleDisabledSells`. */
  private async releaseStaleDisabledSells(
    strategyId: string,
    symbol: string,
    openOrders: OpenOrder[],
  ): Promise<void> {
    const lots = await this.gridLots.findByStrategy(strategyId);
    const restingSellIds = new Set(
      openOrders
        .filter((order) => order.symbol === symbol && order.side === 'SELL')
        .map((order) => order.clientOrderId),
    );

    let released = 0;
    const updated = lots.map((lot) => {
      if (
        lot.status === GridLotStatus.HELD &&
        lot.workingOrderId &&
        !restingSellIds.has(lot.workingOrderId)
      ) {
        released += 1;
        return { ...lot, workingOrderId: null };
      }

      return lot;
    });

    if (released > 0) {
      await this.gridLots.saveAll(updated, strategyId, symbol);
      this.logger.log(
        `${symbol}: released ${released} disabled grid instance's lot working-order mark(s) ` +
          'whose sell is no longer at the broker',
      );
    }
  }

  private haltWith(
    strategyId: string,
    symbol: string,
    code: string,
    verdict: GridLotSumVerdict,
    now: string,
    recoveredExits: number,
  ): GridSymbolReconciliation {
    this.halts.halt(symbol, code, verdict.reason, now);

    return {
      strategyId,
      symbol,
      verdict,
      resumed: false,
      restoredLots: 0,
      recoveredExits,
    };
  }

  /**
   * Shares of `symbol` already claimed by the ladder's own held lots — the
   * mirror of `ReconciliationService.siblingHeldQuantity`. Not wrapped in a
   * try/catch for the same reason that one is not: this is a plain database
   * read, not a broker call, and failing open to `0` would let the grid
   * strategy treat ladder-held shares as its own to explain — a false
   * `MATCHED` verdict on unverified evidence, exactly what a lot-sum
   * assertion must never produce.
   */
  private async siblingHeldQuantity(symbol: string): Promise<number> {
    const held = await this.ladderLots.findHeld(symbol);
    return held.reduce((sum, lot) => sum + lot.quantity, 0);
  }

  private async brokerPositions(): Promise<BrokerPosition[] | null> {
    try {
      return await this.broker.getPositions();
    } catch (error) {
      this.logger.error(
        `broker position query failed for the grid strategy: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private async brokerOpenOrders(): Promise<OpenOrder[] | null> {
    try {
      return await this.broker.getOpenOrders();
    } catch (error) {
      this.logger.error(
        `broker open-order query failed for the grid strategy: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /**
   * Set by the engine so it can rebuild its in-memory working-order registry
   * from what the broker actually holds — the grid counterpart to
   * `ReconciliationService.onOpenOrdersReconciled`.
   */
  onOpenOrdersReconciled:
    ((strategyId: string, symbol: string, orders: OpenOrder[]) => void) | null = null;
}

/**
 * The highest sequence number embedded in a set of restored lot ids —
 * `${symbol}-grid-lot-N` for an ordinary open, `...-rM` appended for a split
 * remainder. Both patterns are searched because a split remainder's id does
 * not repeat the original lot's number.
 */
function deriveLotSequence(lots: GridLot[]): number {
  let max = 0;

  for (const lot of lots) {
    for (const match of lot.id.matchAll(/-grid-lot-(\d+)|-r(\d+)/g)) {
      const n = Number(match[1] ?? match[2]);

      if (n > max) {
        max = n;
      }
    }
  }

  return max;
}
