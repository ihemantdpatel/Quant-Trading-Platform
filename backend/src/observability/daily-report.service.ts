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
    /**
     * **Entry** intents stamped outside 09:45–16:00 ET. Any is an anomaly.
     *
     * Exits are excluded by design — the window governs firing, not exiting,
     * and a lot at its frozen take-profit target may exit at any point in the
     * regular session.
     */
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

    // Every lot the ladder could have been holding at any point in the session,
    // not just those still held at its end: the anchor moves *within* a session
    // as lots open and close, so a lot opened and exited mid-session still
    // determined where rungs sat while it was held.
    const lotsTouchingSession = allLots.filter(
      (lot) =>
        sessionDateOf(lot.openedAt) <= sessionDate &&
        (lot.closedAt === null || sessionDateOf(lot.closedAt) >= sessionDate),
    );

    const rungVerification = await this.verifyRungs(
      sessionDate,
      sessionIntents,
      lotsTouchingSession,
    );

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
      /*
        **Entries only.** The firing window constrains firing, not exiting
        (`session-window.ts`): `onBar` runs `selectExit` before the window is
        consulted, so a lot that reaches its take-profit target during the
        09:30–09:45 opening auction exits then, deliberately. A lot only ever
        exits in profit and its target is frozen at fill, so nothing about that
        exit depends on opening-auction pricing being reliable.

        Counting exits here made every session containing an early take-profit
        raise `INTENT_OUTSIDE_FIRING_WINDOW` — a false anomaly against a rule
        the engine was honouring, and during a soak that is worse than silence:
        the week restarts on any unexplained anomaly.
      */
      outsideFiringWindow: records.filter(
        (r) => r.intent.side === 'BUY' && !isWithinFiringWindow(r.intent.timestamp),
      ).length,
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
   * The bootstrap inputs come from the session's persisted snapshot scalars —
   * the same `previousSessionClose` / `sessionOpen` pair the strategy anchored
   * from. `resolveAnchor` then applies the same precedence rule the ladder does:
   * progression off the lowest held lot whenever anything is held, bootstrap
   * otherwise.
   *
   * **The anchor is recomputed at every intent, not once for the session.** It
   * is a function of what is held *at that moment*, and the ladder re-evaluates
   * it on every bar — so a session that opens flat and fills four rungs uses
   * four different anchors, each one progressing off the lot the previous entry
   * created. Computing a single anchor for the whole session only agrees with
   * the engine when the held set never changes during it, and reports every
   * entry after the first as a false mismatch when it does.
   *
   * Rungs are walked downward one spacing unit at a time, exactly as the ladder
   * extends, up to `maxConcurrentRungs`. An intent matching none of the prices
   * expected *at its own timestamp* is `unexplained` — the signal that state and
   * rules have diverged.
   */
  private async verifyRungs(
    sessionDate: string,
    sessionIntents: OrderIntentRecord[],
    lotsTouchingSession: Lot[],
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

    // Intents in the order the engine emitted them. The anchor depends on what
    // was held when each fired, so an out-of-order walk would price rungs
    // against a held set from the future.
    const ordered = [...sessionIntents].sort((a, b) => {
      if (a.intent.timestamp === b.intent.timestamp) {
        return 0;
      }

      return a.intent.timestamp < b.intent.timestamp ? -1 : 1;
    });

    // Lots the ladder was already holding when the session opened. Lots opened
    // *during* the session are added below as their own entries are verified,
    // so each one only ever influences the rungs that came after it.
    const held = new Map<string, Lot>(
      lotsTouchingSession
        .filter((lot) => sessionDateOf(lot.openedAt) < sessionDate)
        .map((lot) => [lot.id, lot]),
    );

    /*
      Opens and closes merged into one chronologically ordered stream.

      Two separate cursors cannot express this. A lot that opens at 10:00 and
      closes at 10:30 would have its close applied while the walk was still
      before its open — deleting an id `held` does not yet contain, then adding
      it moments later and never removing it. The lot stays held for the rest of
      the session, its rung never reads as free, and every re-entry at that
      level is reported unexplained. Interleaving by timestamp is what keeps
      `held` a faithful picture of the moment.

      Opens sort before closes at equal timestamps only in the sense that both
      are applied by `<=`/`<` below; the ordering that matters is that a lot's
      own open always precedes its own close, which holds by construction.
    */
    const events: { at: string; kind: 'OPEN' | 'CLOSE'; lot: Lot }[] = [];

    for (const lot of lotsTouchingSession) {
      if (sessionDateOf(lot.openedAt) === sessionDate) {
        events.push({ at: lot.openedAt, kind: 'OPEN', lot });
      }

      if (lot.closedAt !== null && sessionDateOf(lot.closedAt) === sessionDate) {
        events.push({ at: lot.closedAt, kind: 'CLOSE', lot });
      }
    }

    // Closes before opens at the same instant, matching `onBar`: exits are
    // applied first so the bar's entry sees the rung its exit just freed.
    events.sort((a, b) => {
      if (a.at !== b.at) {
        return a.at < b.at ? -1 : 1;
      }

      return a.kind === b.kind ? 0 : a.kind === 'CLOSE' ? -1 : 1;
    });

    let eventCursor = 0;

    /*
      Rung levels the ladder had created by this point in the session.

      **A rung outlives the lot that occupied it.** When a lot takes profit its
      rung re-arms at its original price and may fire again, so an entry can
      land at a level the anchor no longer points to — and under RESTING
      placement `highestFireableRung` chooses such a level without regard to
      where the bar closed. Modelling only "one spacing unit below the current
      anchor" therefore explains the ladder's *first* entry at each level and
      none of the repeats, which is most of a cycling session.

      Seeded from the levels of lots already held entering the session, since
      those rungs demonstrably exist. Recomputed levels are added as the walk
      derives them, never read back from the ladder's own rung list — that
      readback is the comparison this service exists to avoid.
    */
    const knownRungs = new Set<number>(
      [...held.values()].map((lot) => roundToCents(lot.rungPrice)),
    );

    /** The ladder as it stood at `timestamp`, from the lots held by then. */
    const ladderAt = (timestamp: string) => {
      while (eventCursor < events.length) {
        const event = events[eventCursor];

        // An exit at this instant has already freed its rung; an open at this
        // instant has not yet happened from the entry's point of view, because
        // an entry cannot anchor off the position it is itself creating.
        const applies = event.kind === 'CLOSE' ? event.at <= timestamp : event.at < timestamp;

        if (!applies) {
          break;
        }

        if (event.kind === 'CLOSE') {
          held.delete(event.lot.id);
        } else {
          held.set(event.lot.id, event.lot);
          knownRungs.add(roundToCents(event.lot.rungPrice));
        }

        eventCursor += 1;
      }

      const anchor = resolveAnchor(
        [...held.values()],
        scalars.previousSessionClose,
        scalars.sessionOpen,
      );

      // The next level the ladder would extend to, which is where an entry
      // goes when no existing rung is free.
      const extension = nextRungPrice(anchor.price, this.ladderConfig);

      // Levels currently free: a known rung with no lot sitting on it. These
      // are the re-arm targets, and under RESTING they take precedence over
      // extending — `evaluateBar` consults them first.
      const occupied = new Set([...held.values()].map((lot) => roundToCents(lot.rungPrice)));
      const free = [...knownRungs].filter((price) => !occupied.has(price));

      return { anchor, extension, free };
    };

    /*
      **The reported anchor is the session's opening one**, resolved before any
      of the session's own lots exist.

      The anchor genuinely moves during a session, and the walk below follows
      every step of it — that movement is what `unexplained` is judged against.
      What is *reported* is deliberately the opening value, for two reasons: a
      lot opened during the session is a consequence of the rungs being checked,
      so anchoring the summary off it would let the output justify itself; and
      an operator comparing two reports needs a figure that means the same thing
      in both, which a mid-session-dependent value would not.

      The consequence to know when reading a report: `expected` describes the
      ladder as the session *opened*, so on a session that filled several rungs
      it will not match the dashboard's rung list at the close. `unexplained` is
      the field that accounts for the whole session.
    */
    // Resolved from the lots held *entering* the session, before any of its own
    // opens or closes are applied — `ladderAt` is deliberately not used here,
    // since the session's first intent may already sit after an exit that
    // changed what was held.
    const openingAnchor = resolveAnchor(
      [...held.values()],
      scalars.previousSessionClose,
      scalars.sessionOpen,
    );

    const unexplained: UnexplainedIntent[] = [];
    const seen = new Set<number>();

    for (const record of ordered) {
      const at = ladderAt(record.intent.timestamp);

      // A sell exits at a lot's own frozen target, which is not a rung price —
      // rung verification is about entries, so exits are not "unexplained".
      if (record.intent.side === 'SELL') {
        continue;
      }

      const price = roundToCents(record.intent.limitPrice);

      // Explained by either of the two paths `evaluateBar` can take: firing an
      // existing free rung, or extending the ladder one unit below the anchor.
      if (price === at.extension || at.free.includes(price)) {
        seen.add(price);
        knownRungs.add(price);
        continue;
      }

      unexplained.push({
        limitPrice: record.intent.limitPrice,
        timestamp: record.intent.timestamp,
        reason: record.intent.reason,
      });
    }

    const spacing = roundToCents(
      openingAnchor.price - nextRungPrice(openingAnchor.price, this.ladderConfig),
    );

    const expectedPrices: number[] = [];
    let price = openingAnchor.price;

    for (let level = 1; level <= this.ladderConfig.maxConcurrentRungs; level += 1) {
      price = nextRungPrice(price, this.ladderConfig);
      expectedPrices.push(price);
    }

    return {
      anchor: openingAnchor.price,
      anchorBasis: openingAnchor.basis,
      spacingDistance: spacing,
      expected: expectedPrices.map((rungPrice, index) => ({
        level: index + 1,
        price: rungPrice,
        intentSeen: seen.has(rungPrice),
      })),
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

    // SHADOW is retired and refused at boot (`execution-mode.ts`), so a report
    // claiming that mode describes a session this build could not have run.
    // Kept because reports are read from persisted evidence and a session
    // recorded before the retirement can still be requested by date — and if
    // one ever appeared for *today*, the mode plumbing is wrong in a way an
    // operator must see rather than have silently normalized.
    if (report.mode === ExecutionMode.SHADOW) {
      anomalies.push({
        code: 'RETIRED_MODE',
        detail:
          'session recorded in SHADOW, which is retired and refused at startup. ' +
          `${report.intents.submitted} intent(s) were marked submitted. Either this is a ` +
          'historic session predating the retirement, or the mode configuration is wrong.',
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
