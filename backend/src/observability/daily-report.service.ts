/**
 * The daily soak report (`stories.md:695`).
 *
 * Story 12 runs `SHADOW` against live IB for a full trading week and requires
 * two things of every session: that the intents match hand-calculated rung
 * prices, and that reconciliation is clean. This service produces the artifact
 * that answers both, one ET session at a time.
 *
 * ## Why it reads storage rather than counting as it goes
 *
 * Accumulating counters as bars arrive would be cheaper, but the soak
 * deliberately includes mid-session restarts (`stories.md:700`) — and a
 * counter-based report would silently under-report exactly the sessions
 * containing the event under scrutiny. A report assembled from persisted
 * evidence covers the whole session regardless of how many processes served
 * it, so "restart day looks quiet" cannot be an artifact of the instrument.
 *
 * The consequence is that a durable report needs `DATABASE_URL`: under the
 * in-memory repositories the evidence dies with the process. That is the soak's
 * configuration anyway, but the report states its `storage` mode rather than
 * leaving a reader to assume completeness — a day summarized from memory may be
 * one process's slice of it.
 *
 * ## The rung check is a recomputation, not a readback
 *
 * `expectedRungs` is derived from the same pure modules the strategy uses
 * (`resolveAnchor`, `nextRungPrice`) but driven from **persisted evidence** —
 * the snapshot's anchor scalars and the lots actually recorded — rather than
 * from live strategy state. Reading the ladder's own rung list back and
 * comparing it to itself would be a test that cannot fail (`CLAUDE.md`), and
 * would report confidence it had not earned. Driving the same arithmetic from
 * independent inputs is what makes a disagreement meaningful: it means the
 * ladder's state and the ladder's rules have diverged.
 *
 * This service computes and never mutates. It holds no broker and issues no
 * orders — it is an observer of a system whose default posture is to submit
 * nothing.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Fill } from '../broker/broker-adapter.interface';
import { ExecutionMode } from '../config/execution-mode';
import { AppConfigService } from '../config/app-config.service';
import { ReconciliationReport } from '../reconciliation/reconciliation.service';
import { SymbolHalt, SymbolHaltService } from '../reconciliation/symbol-halt.service';
import { STORAGE_MODE, StorageMode } from '../repositories/repositories.module';
import {
  FILL_REPOSITORY,
  FillRepository,
  LOT_REPOSITORY,
  LotRepository,
  ORDER_INTENT_REPOSITORY,
  OrderIntentRecord,
  OrderIntentRepository,
  RISK_EVENT_REPOSITORY,
  RiskEventRepository,
  STRATEGY_STATE_SNAPSHOT_REPOSITORY,
  StrategyStateSnapshotRepository,
} from '../repositories/repository.interfaces';
import { RiskEvent } from '../risk/risk-event';
import { RiskOutcome } from '../risk/types';
import { DipLadderConfig } from '../strategies/dip-ladder/config';
import { Lot } from '../strategies/dip-ladder/lot';
import { resolveAnchor } from '../strategies/dip-ladder/anchor';
import { DIP_LADDER_ID_PREFIX } from '../strategies/dip-ladder/dip-ladder.strategy';
import { isWithinFiringWindow, sessionDateOf } from '../strategies/dip-ladder/session-window';
import { nextRungPrice, roundToCents } from '../strategies/dip-ladder/spacing';
import { DIP_LADDER_CONFIG } from '../strategies/strategies.module';

/**
 * The read-only slice of reconciliation this report needs.
 *
 * A one-method port rather than `ReconciliationService` itself, because that
 * service holds the broker adapter. Depending on it here would pull a broker
 * into the observability graph and quietly undo the property
 * `observability.module.ts` exists to state: nothing in this module can place
 * an order, because there is nothing here to place one with.
 */
export interface ReconciliationReadModel {
  lastReconciliation(): ReconciliationReport | null;
}

export const RECONCILIATION_READ_MODEL = Symbol('RECONCILIATION_READ_MODEL');

/**
 * A rung price the report derived independently, with whether an intent was
 * seen at it.
 */
export interface ExpectedRung {
  /** One-based depth below the anchor. Rung 1 is the first level down. */
  level: number;
  price: number;
  /** True when the session produced an intent at this price. */
  intentSeen: boolean;
}

/** An intent the session emitted at a price no expected rung accounts for. */
export interface UnexplainedIntent {
  limitPrice: number;
  timestamp: string;
  reason: string;
}

/**
 * The rung-price verification for one session — the automated form of Story
 * 12's daily hand-check.
 */
export interface RungVerification {
  /** Null when the session left no snapshot to anchor from — see `skipped`. */
  anchor: number | null;
  anchorBasis: string | null;
  spacingDistance: number | null;
  expected: ExpectedRung[];
  /** Intents at prices the recomputation does not explain. Any entry is an anomaly. */
  unexplained: UnexplainedIntent[];
  /**
   * True when verification could not run — no snapshot for the session, so
   * there is no independent anchor to recompute from. Deliberately distinct
   * from "ran and found nothing wrong": a check that did not run must never
   * read as a pass.
   */
  skipped: boolean;
  skipReason: string | null;
}

/** A lot cycle that completed during the session, with its realized P&L. */
export interface CompletedCycle {
  lotId: string;
  rungPrice: number;
  fillPrice: number;
  exitPrice: number;
  quantity: number;
  realized: number;
  openedAt: string;
  closedAt: string;
}

/**
 * An observation that warrants an entry in `docs/soak-log.md`.
 *
 * The soak's exit criterion is "zero reconciliation errors" and any
 * unexplained anomaly restarts the week (`stories.md:704`), so the report
 * names anomalies explicitly rather than leaving them to be inferred from
 * counts an operator has to compare by eye.
 */
export interface ReportAnomaly {
  code: string;
  detail: string;
}

export interface DailyReport {
  /** ET session date, `yyyy-MM-dd`. */
  sessionDate: string;
  generatedAt: string;
  mode: ExecutionMode;
  /** Whether the evidence came from MySQL or from this process's memory. */
  storage: StorageMode;
  symbol: string;
  intents: {
    total: number;
    approved: number;
    resized: number;
    rejected: number;
    /** Non-zero in SHADOW would mean the mode guarantee had been violated. */
    submitted: number;
    /** Intents stamped outside 09:45–16:00 ET. Any is an anomaly. */
    outsideFiringWindow: number;
  };
  fills: {
    count: number;
    quantity: number;
    commission: number;
  };
  lots: {
    openedToday: number;
    closedToday: number;
    heldAtSessionEnd: number;
    realizedToday: number;
  };
  cycles: CompletedCycle[];
  riskEvents: {
    total: number;
    byType: Record<string, number>;
  };
  rungVerification: RungVerification;
  reconciliation: {
    /** Null when reconciliation has not run in this process. */
    lastRanAt: string | null;
    clean: boolean | null;
    haltedSymbols: string[];
  };
  activeHalts: SymbolHalt[];
  anomalies: ReportAnomaly[];
  /** True when the session produced no anomaly of any kind — the soak's daily gate. */
  clean: boolean;
}

@Injectable()
export class DailyReportService {
  private readonly logger = new Logger(DailyReportService.name);

  constructor(
    private readonly appConfig: AppConfigService,
    @Inject(RECONCILIATION_READ_MODEL)
    private readonly reconciliation: ReconciliationReadModel,
    private readonly symbolHalts: SymbolHaltService,
    @Inject(DIP_LADDER_CONFIG) private readonly ladderConfig: DipLadderConfig,
    @Inject(STORAGE_MODE) private readonly storageMode: StorageMode,
    @Inject(ORDER_INTENT_REPOSITORY) private readonly intents: OrderIntentRepository,
    @Inject(FILL_REPOSITORY) private readonly fills: FillRepository,
    @Inject(LOT_REPOSITORY) private readonly lots: LotRepository,
    @Inject(RISK_EVENT_REPOSITORY) private readonly riskEvents: RiskEventRepository,
    @Inject(STRATEGY_STATE_SNAPSHOT_REPOSITORY)
    private readonly snapshots: StrategyStateSnapshotRepository,
  ) {}

  /**
   * Builds the report for one ET session.
   *
   * `now` is passed rather than read from a clock so the report is a pure
   * function of its inputs — the same evidence always yields the same report,
   * which is what lets a fixture session be asserted field-by-field.
   */
  async build(sessionDate: string, now: string): Promise<DailyReport> {
    const symbol = this.ladderConfig.symbol;

    const [allIntents, allFills, allLots, allRiskEvents] = await Promise.all([
      this.intents.findAll(),
      this.fills.findAll(),
      this.lots.findBySymbol(symbol),
      this.riskEvents.findAll(),
    ]);

    const sessionIntents = allIntents.filter(
      (record) => sessionDateOf(record.intent.timestamp) === sessionDate,
    );
    const sessionFills = allFills.filter((fill) => sessionDateOf(fill.timestamp) === sessionDate);
    const sessionRiskEvents = allRiskEvents.filter(
      (event) => sessionDateOf(event.timestamp) === sessionDate,
    );

    const openedToday = allLots.filter((lot) => sessionDateOf(lot.openedAt) === sessionDate);
    const closedToday = allLots.filter(
      (lot) => lot.closedAt !== null && sessionDateOf(lot.closedAt) === sessionDate,
    );

    // Held *as of the end of this session*, not held now. A lot opened during
    // the session and closed three days later was still held when this session
    // ended, and a report about Tuesday must not be rewritten by Friday.
    const heldAtSessionEnd = allLots.filter(
      (lot) =>
        sessionDateOf(lot.openedAt) <= sessionDate &&
        (lot.closedAt === null || sessionDateOf(lot.closedAt) > sessionDate),
    );

    const cycles = closedToday
      .filter((lot) => lot.exitPrice !== null && lot.closedAt !== null)
      .map((lot) => this.toCycle(lot));

    const rungVerification = await this.verifyRungs(sessionDate, sessionIntents, heldAtSessionEnd);

    const report: DailyReport = {
      sessionDate,
      generatedAt: now,
      mode: this.appConfig.executionMode,
      storage: this.storageMode,
      symbol,
      intents: this.summarizeIntents(sessionIntents),
      fills: {
        count: sessionFills.length,
        quantity: sessionFills.reduce((total, fill) => total + fill.quantity, 0),
        commission: roundToCents(
          sessionFills.reduce((total: number, fill: Fill) => total + fill.commission, 0),
        ),
      },
      lots: {
        openedToday: openedToday.length,
        closedToday: closedToday.length,
        heldAtSessionEnd: heldAtSessionEnd.length,
        realizedToday: roundToCents(cycles.reduce((total, cycle) => total + cycle.realized, 0)),
      },
      cycles,
      riskEvents: this.summarizeRiskEvents(sessionRiskEvents),
      rungVerification,
      reconciliation: {
        lastRanAt: this.reconciliation.lastReconciliation()?.ranAt ?? null,
        clean: this.reconciliation.lastReconciliation()?.clean ?? null,
        haltedSymbols: this.reconciliation.lastReconciliation()?.haltedSymbols ?? [],
      },
      activeHalts: this.symbolHalts.active(),
      anomalies: [],
      clean: true,
    };

    report.anomalies = this.detectAnomalies(report);
    report.clean = report.anomalies.length === 0;

    if (!report.clean) {
      // Logged at error so a soak week's anomalies are greppable without
      // reading every report — the week restarts on any unexplained one.
      this.logger.error(
        `session ${sessionDate} reported ${report.anomalies.length} anomaly/anomalies: ` +
          report.anomalies.map((anomaly) => `[${anomaly.code}] ${anomaly.detail}`).join('; '),
      );
    }

    return report;
  }

  private toCycle(lot: Lot): CompletedCycle {
    return {
      lotId: lot.id,
      rungPrice: lot.rungPrice,
      fillPrice: lot.fillPrice,
      exitPrice: lot.exitPrice!,
      quantity: lot.quantity,
      realized: roundToCents((lot.exitPrice! - lot.fillPrice) * lot.quantity),
      openedAt: lot.openedAt,
      closedAt: lot.closedAt!,
    };
  }

  private summarizeIntents(records: OrderIntentRecord[]): DailyReport['intents'] {
    return {
      total: records.length,
      approved: records.filter((r) => r.decision?.outcome === RiskOutcome.APPROVED).length,
      resized: records.filter((r) => r.decision?.outcome === RiskOutcome.RESIZED).length,
      rejected: records.filter((r) => r.decision?.outcome === RiskOutcome.REJECTED).length,
      submitted: records.filter((r) => r.submitted).length,
      outsideFiringWindow: records.filter((r) => !isWithinFiringWindow(r.intent.timestamp)).length,
    };
  }

  private summarizeRiskEvents(events: RiskEvent[]): DailyReport['riskEvents'] {
    const byType: Record<string, number> = {};

    for (const event of events) {
      byType[event.type] = (byType[event.type] ?? 0) + 1;
    }

    return { total: events.length, byType };
  }

  /**
   * Recomputes the session's expected rung prices and compares them against the
   * intents actually emitted.
   *
   * The anchor comes from the session's persisted snapshot scalars — the same
   * `previousSessionClose` / `sessionOpen` pair the strategy anchored from —
   * and from the lots held entering the session. `resolveAnchor` then applies
   * the same precedence rule the ladder does: progression off the lowest held
   * lot whenever anything is held, bootstrap otherwise.
   *
   * Rungs are walked downward one spacing unit at a time, exactly as the ladder
   * extends, up to `maxConcurrentRungs`. An intent matching none of those prices
   * is `unexplained` — the signal that state and rules have diverged.
   */
  private async verifyRungs(
    sessionDate: string,
    sessionIntents: OrderIntentRecord[],
    heldAtSessionEnd: Lot[],
  ): Promise<RungVerification> {
    const empty: RungVerification = {
      anchor: null,
      anchorBasis: null,
      spacingDistance: null,
      expected: [],
      unexplained: [],
      skipped: true,
      skipReason: null,
    };

    // Built from the shared prefix rather than a literal, so the id here cannot
    // drift from the one the strategy registers under and silently turn every
    // session's verification into a skip.
    const all = await this.snapshots.findAll(`${DIP_LADDER_ID_PREFIX}${this.ladderConfig.symbol}`);

    // **The snapshot from the reported session, not the newest one.**
    //
    // `findLatest` would return the state as of now, whose `sessionOpen`
    // belongs to whatever session ran most recently. Verifying Tuesday against
    // Friday's anchor recomputes every rung wrong and reports a whole session
    // of false mismatches — which during a soak is worse than reporting
    // nothing, because it trains an operator to ignore the check.
    //
    // Snapshots are append-per-save, so a session has several; the last one
    // captured that day carries the session's settled scalars.
    const sessionSnapshots = all.filter(
      (snapshot) => sessionDateOf(snapshot.capturedAt) === sessionDate,
    );

    const snapshot = sessionSnapshots.reduce<(typeof all)[number] | null>(
      (latest, candidate) =>
        latest === null || candidate.capturedAt >= latest.capturedAt ? candidate : latest,
      null,
    );

    const scalars = this.anchorScalars(snapshot?.data);

    if (!scalars) {
      return {
        ...empty,
        skipReason:
          `no strategy state snapshot with anchor scalars captured on ${sessionDate} — ` +
          'rung prices cannot be recomputed independently',
      };
    }

    // Lots that were already open when the session began are what the ladder
    // anchored from. A lot opened *during* the session is a consequence of the
    // rungs being verified, so including it would let the output justify itself.
    const heldEnteringSession = heldAtSessionEnd.filter(
      (lot) => sessionDateOf(lot.openedAt) < sessionDate,
    );

    const anchor = resolveAnchor(
      heldEnteringSession,
      scalars.previousSessionClose,
      scalars.sessionOpen,
    );

    const spacing = roundToCents(anchor.price - nextRungPrice(anchor.price, this.ladderConfig));

    const expected: ExpectedRung[] = [];
    let price = anchor.price;

    for (let level = 1; level <= this.ladderConfig.maxConcurrentRungs; level += 1) {
      price = nextRungPrice(price, this.ladderConfig);
      expected.push({ level, price, intentSeen: false });
    }

    const unexplained: UnexplainedIntent[] = [];

    for (const record of sessionIntents) {
      const match = expected.find((rung) => rung.price === roundToCents(record.intent.limitPrice));

      if (match) {
        match.intentSeen = true;
        continue;
      }

      // A sell exits at a lot's own frozen target, which is not a rung price —
      // rung verification is about entries, so exits are not "unexplained".
      if (record.intent.side === 'SELL') {
        continue;
      }

      unexplained.push({
        limitPrice: record.intent.limitPrice,
        timestamp: record.intent.timestamp,
        reason: record.intent.reason,
      });
    }

    return {
      anchor: anchor.price,
      anchorBasis: anchor.basis,
      spacingDistance: spacing,
      expected,
      unexplained,
      skipped: false,
      skipReason: null,
    };
  }

  /**
   * Pulls the anchor scalars out of a snapshot's opaque `data`.
   *
   * Returns null unless both are present and numeric. The snapshot is stored as
   * `Record<string, unknown>` and a partially-written or older-version one must
   * produce a *skipped* verification rather than an anchor derived from a
   * coerced `undefined` — a wrong anchor prices every expected rung wrong and
   * would report a whole session of false mismatches.
   */
  private anchorScalars(
    data: Record<string, unknown> | undefined,
  ): { previousSessionClose: number | null; sessionOpen: number } | null {
    if (!data) {
      return null;
    }

    const sessionOpen = data.sessionOpen;
    const previousSessionClose = data.previousSessionClose;

    if (typeof sessionOpen !== 'number') {
      return null;
    }

    return {
      sessionOpen,
      previousSessionClose: typeof previousSessionClose === 'number' ? previousSessionClose : null,
    };
  }

  /**
   * Turns the session's figures into named anomalies.
   *
   * Each corresponds to a property the soak is meant to prove. They are
   * detected here rather than at each computation site so the full list is
   * readable in one place — an operator triaging a week needs to know what the
   * report is capable of noticing.
   */
  private detectAnomalies(report: DailyReport): ReportAnomaly[] {
    const anomalies: ReportAnomaly[] = [];

    // The mode guarantee. In SHADOW nothing is submitted whichever broker is
    // bound (`CLAUDE.md`), so a non-zero count here is the most serious thing
    // this report can find.
    if (report.mode === ExecutionMode.SHADOW && report.intents.submitted > 0) {
      anomalies.push({
        code: 'SUBMISSION_IN_SHADOW',
        detail:
          `${report.intents.submitted} intent(s) recorded as submitted while in SHADOW. ` +
          'Nothing may reach a broker in this mode.',
      });
    }

    if (report.intents.outsideFiringWindow > 0) {
      anomalies.push({
        code: 'INTENT_OUTSIDE_FIRING_WINDOW',
        detail:
          `${report.intents.outsideFiringWindow} intent(s) stamped outside 09:45–16:00 ET. ` +
          'The firing window is a hard rule (`PRD.md:96`).',
      });
    }

    if (report.rungVerification.unexplained.length > 0) {
      anomalies.push({
        code: 'RUNG_PRICE_MISMATCH',
        detail:
          `${report.rungVerification.unexplained.length} entry intent(s) at prices the ` +
          `recomputed ladder does not explain (anchor ${report.rungVerification.anchor}): ` +
          report.rungVerification.unexplained.map((i) => i.limitPrice).join(', '),
      });
    }

    if (report.rungVerification.skipped) {
      // Not a failure of the engine, but the day's rung check did not happen —
      // and a soak week cannot be called clean on the strength of a check that
      // never ran.
      anomalies.push({
        code: 'RUNG_VERIFICATION_SKIPPED',
        detail: report.rungVerification.skipReason ?? 'rung verification did not run',
      });
    }

    if (report.reconciliation.clean === false) {
      anomalies.push({
        code: 'RECONCILIATION_MISMATCH',
        detail:
          'the last reconciliation did not reconcile cleanly; halted symbols: ' +
          (report.reconciliation.haltedSymbols.join(', ') || 'none recorded'),
      });
    }

    if (report.activeHalts.length > 0) {
      anomalies.push({
        code: 'ACTIVE_SYMBOL_HALT',
        detail: report.activeHalts
          .map((halt) => `${halt.symbol} [${halt.code}] since ${halt.at}`)
          .join('; '),
      });
    }

    // A lot that closed below its own fill price would mean a loss-booking exit
    // existed, which no code path may produce (`CLAUDE.md`). Reported from
    // observed evidence rather than trusted from the rule.
    const losing = report.cycles.filter((cycle) => cycle.realized < 0);

    if (losing.length > 0) {
      anomalies.push({
        code: 'LOT_CLOSED_AT_LOSS',
        detail:
          `${losing.length} lot(s) closed below their fill price: ` +
          losing.map((cycle) => `${cycle.lotId} (${cycle.realized})`).join(', ') +
          '. Lots only ever exit in profit.',
      });
    }

    return anomalies;
  }
}
