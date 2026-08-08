/**
 * Startup reconciliation — **IB is truth for positions, the DB is truth for lot
 * composition** (`PRD.md:321`).
 *
 * This runs the four ordered steps from `PRD.md:323`, once per strategy, before
 * any strategy hook fires:
 *
 * 1. query the broker for actual positions
 * 2. load persisted state from the database
 * 3. reconcile — the lot-sum assertion
 * 4. on discrepancy: log, alert, refuse to trade that symbol
 *
 * ## Why restore is not a separate step
 *
 * A restore that happened before reconciliation would put lots into live
 * strategy state and *then* ask whether they are correct — and a bar arriving
 * in that window would trade on unverified state. So state is loaded into a
 * local, checked, and only written into the coordinator once the assertion
 * passes. A symbol that fails reconciliation resumes with an **empty ladder and
 * a halt**, not with the suspect lots: halted means no intents either way, and
 * leaving the unverified composition in place would be the guess `PRD.md:347`
 * forbids.
 *
 * ## What a failure never does
 *
 * It never liquidates, never adjusts lots to fit the broker's number, and never
 * releases itself. Halting is the whole response. `CLAUDE.md` is explicit that
 * a technical fault must not become a realized loss, and a reconciliation
 * mismatch is the case where "fixing it automatically" is most tempting and
 * most dangerous.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { BROKER_ADAPTER, BrokerAdapter, BrokerPosition } from '../broker/broker-adapter.interface';
import {
  LOT_REPOSITORY,
  LotRepository,
  RUNG_REPOSITORY,
  RungRepository,
  STRATEGY_STATE_SNAPSHOT_REPOSITORY,
  StrategyStateSnapshotRepository,
} from '../repositories/repository.interfaces';
import { CoordinatorService } from '../strategies/coordinator.service';
import {
  DIP_LADDER_ID_PREFIX,
  DIP_LADDER_STATE_VERSION,
  DipLadderStateData,
} from '../strategies/dip-ladder/dip-ladder.strategy';
import { Lot } from '../strategies/dip-ladder/lot';
import { Rung } from '../strategies/dip-ladder/rung';
import { JsonValue } from '../strategies/types';
import { assertLotSum, LotSumVerdict, ReconciliationStatus } from './lot-sum-assertion';
import { SymbolHaltService } from './symbol-halt.service';

/** Halt codes, so the dashboard can distinguish causes without parsing prose. */
export const HALT_LOT_SUM_MISMATCH = 'LOT_SUM_MISMATCH';
export const HALT_STATE_VERSION_MISMATCH = 'STATE_VERSION_MISMATCH';
export const HALT_BROKER_UNAVAILABLE = 'BROKER_UNAVAILABLE';

export interface SymbolReconciliation {
  strategyId: string;
  symbol: string;
  verdict: LotSumVerdict;
  /** True when persisted state was loaded into the live strategy. */
  resumed: boolean;
  /** How many held lots were restored. Zero on a halt. */
  restoredLots: number;
  restoredRungs: number;
  /** Set when the snapshot's version was not the one this build understands. */
  snapshotVersion: number | null;
}

export interface ReconciliationReport {
  ranAt: string;
  /** True only when every symbol reconciled. */
  clean: boolean;
  symbols: SymbolReconciliation[];
  haltedSymbols: string[];
}

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  private lastReport: ReconciliationReport | null = null;

  constructor(
    private readonly coordinator: CoordinatorService,
    private readonly halts: SymbolHaltService,
    @Inject(BROKER_ADAPTER) private readonly broker: BrokerAdapter,
    @Inject(LOT_REPOSITORY) private readonly lots: LotRepository,
    @Inject(RUNG_REPOSITORY) private readonly rungs: RungRepository,
    @Inject(STRATEGY_STATE_SNAPSHOT_REPOSITORY)
    private readonly snapshots: StrategyStateSnapshotRepository,
  ) {}

  /**
   * Reconciles every registered ladder and restores the ones that pass.
   *
   * Runs to completion across all symbols even when one halts: a mismatch on
   * TQQQ is not a reason to leave SOXL unreconciled and therefore unable to
   * trade (`stories.md:558`).
   */
  async reconcileAll(now: string): Promise<ReconciliationReport> {
    // Step 1 — the broker is asked *first*, before any state is loaded. If it
    // cannot answer, nothing is trustworthy and every symbol halts; resuming a
    // ladder against an unknown position is the failure this whole story exists
    // to prevent.
    const positions = await this.brokerPositions();

    const results: SymbolReconciliation[] = [];

    for (const snapshot of this.coordinator.snapshots()) {
      if (!snapshot.id.startsWith(DIP_LADDER_ID_PREFIX)) {
        // Scaffolds hold no lots. Nothing to reconcile until Story 16 gives
        // them real behaviour, and inventing a verdict for them would put
        // meaningless rows on the dashboard.
        continue;
      }

      const symbol = snapshot.symbols[0];

      if (!symbol) {
        continue;
      }

      results.push(await this.reconcileSymbol(snapshot.id, symbol, positions, now));
    }

    const report: ReconciliationReport = {
      ranAt: now,
      clean: results.every((result) => result.verdict.reconciled),
      symbols: results,
      haltedSymbols: this.halts.haltedSymbols(),
    };

    this.lastReport = report;

    this.logger.log(
      report.clean
        ? `reconciliation clean across ${results.length} symbol(s) — ladders resumed`
        : `reconciliation FAILED for ${report.haltedSymbols.join(', ')} — those symbols are halted`,
    );

    return report;
  }

  private async reconcileSymbol(
    strategyId: string,
    symbol: string,
    positions: BrokerPosition[] | null,
    now: string,
  ): Promise<SymbolReconciliation> {
    // Step 2 — load persisted state. Lots and rungs come from their own tables
    // (authoritative on composition); the snapshot supplies only the anchor
    // scalars that live nowhere else.
    const persistedLots = await this.lots.findBySymbol(symbol);
    const persistedRungs = await this.rungs.findBySymbol(symbol);
    const snapshot = await this.snapshots.findLatest(strategyId);

    if (positions === null) {
      return this.haltWith(
        strategyId,
        symbol,
        HALT_BROKER_UNAVAILABLE,
        {
          symbol,
          status: ReconciliationStatus.UNTRACKED_AT_BROKER,
          lotQuantity: persistedLots.reduce(
            (sum, lot) => (lot.status === 'HELD' ? sum + lot.quantity : sum),
            0,
          ),
          brokerQuantity: 0,
          heldLotCount: persistedLots.filter((lot) => lot.status === 'HELD').length,
          reconciled: false,
          reason: `${symbol}: broker unreachable at startup — cannot verify the position, halted`,
        },
        now,
        snapshot?.version ?? null,
      );
    }

    // A symbol the broker does not list is flat, which is a real answer and not
    // missing data.
    const brokerQuantity = positions.find((p) => p.symbol === symbol)?.quantity ?? 0;

    // **Version is checked before the state is trusted** (`stories.md:514`).
    // Rejected rather than coerced: a snapshot written by a different schema
    // may have fields that no longer mean what they used to, and a misread
    // anchor prices every future rung wrong.
    if (snapshot !== null && snapshot.version !== DIP_LADDER_STATE_VERSION) {
      return this.haltWith(
        strategyId,
        symbol,
        HALT_STATE_VERSION_MISMATCH,
        {
          ...assertLotSum(symbol, persistedLots, brokerQuantity),
          reconciled: false,
          reason:
            `${symbol}: snapshot version ${snapshot.version} is not the supported ` +
            `version ${DIP_LADDER_STATE_VERSION} — refusing to load state that may not mean ` +
            'what this build assumes',
        },
        now,
        snapshot.version,
      );
    }

    // Step 3 — the assertion itself.
    const verdict = assertLotSum(symbol, persistedLots, brokerQuantity);

    if (!verdict.reconciled) {
      // Step 4 — log, alert, refuse to trade this symbol.
      return this.haltWith(
        strategyId,
        symbol,
        HALT_LOT_SUM_MISMATCH,
        verdict,
        now,
        snapshot?.version ?? null,
      );
    }

    // Reconciled. Only now is state written into the live strategy.
    const restored = this.restore(
      strategyId,
      persistedLots,
      persistedRungs,
      snapshot?.data ?? null,
    );

    this.logger.log(
      `${symbol}: reconciled — ${verdict.reason}. ` +
        `Restored ${restored.lots} lot(s) and ${restored.rungs} rung(s).`,
    );

    return {
      strategyId,
      symbol,
      verdict,
      resumed: true,
      restoredLots: restored.lots,
      restoredRungs: restored.rungs,
      snapshotVersion: snapshot?.version ?? null,
    };
  }

  /**
   * Writes persisted state into the coordinator's live strategy state.
   *
   * Called **only** after the assertion passes. Lots and rungs come from their
   * own tables rather than from the snapshot's copy, so there is exactly one
   * authority per fact and a stale duplicate inside the snapshot cannot win.
   */
  private restore(
    strategyId: string,
    lots: Lot[],
    rungs: Rung[],
    snapshotData: Record<string, unknown> | null,
  ): { lots: number; rungs: number } {
    const state = this.coordinator.getState(strategyId);

    if (!state) {
      // The strategy is registered but was never initialized — nothing to
      // restore into. Not an error: `initializeAll` runs before this in the
      // startup sequence, so this is only reachable for a disabled strategy.
      return { lots: 0, rungs: 0 };
    }

    const data = state.data as unknown as DipLadderStateData;

    data.lots = lots as DipLadderStateData['lots'];
    data.rungs = rungs as DipLadderStateData['rungs'];

    if (snapshotData) {
      // The anchor scalars. Restored individually rather than by replacing
      // `state.data` wholesale, because lots and rungs have already been set
      // from their authoritative tables above and must not be overwritten by
      // the snapshot's possibly-older copy.
      data.firstEntryPrice = numberOrNull(snapshotData.firstEntryPrice);
      data.lotSequence =
        typeof snapshotData.lotSequence === 'number' ? snapshotData.lotSequence : 0;
      data.previousSessionClose = numberOrNull(snapshotData.previousSessionClose);
      data.runningClose = numberOrNull(snapshotData.runningClose);
      data.sessionOpen = numberOrNull(snapshotData.sessionOpen);
      data.sessionDate =
        typeof snapshotData.sessionDate === 'string' ? snapshotData.sessionDate : null;
    }

    this.coordinator.setState(strategyId, state);

    return { lots: lots.length, rungs: rungs.length };
  }

  private haltWith(
    strategyId: string,
    symbol: string,
    code: string,
    verdict: LotSumVerdict,
    now: string,
    snapshotVersion: number | null,
  ): SymbolReconciliation {
    this.halts.halt(symbol, code, verdict.reason, now);

    return {
      strategyId,
      symbol,
      verdict,
      // Deliberately not resumed and deliberately nothing restored: a halted
      // symbol trades neither way, and loading unverified lots would leave the
      // exit path reading composition nobody confirmed.
      resumed: false,
      restoredLots: 0,
      restoredRungs: 0,
      snapshotVersion,
    };
  }

  /**
   * Broker positions, or null when the broker cannot answer.
   *
   * Null rather than an empty array — those mean opposite things. An empty
   * array is "the account is flat", which reconciles against an empty ladder;
   * a failed query is "unknown", which must halt. Collapsing them would let an
   * unreachable broker look like a clean flat account and resume trading.
   */
  private async brokerPositions(): Promise<BrokerPosition[] | null> {
    try {
      return await this.broker.getPositions();
    } catch (error) {
      this.logger.error(
        `broker position query failed at startup: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  lastReconciliation(): ReconciliationReport | null {
    return this.lastReport;
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

/** Re-exported so callers building a snapshot record do not import the strategy. */
export type LadderSnapshotData = Record<string, JsonValue>;
