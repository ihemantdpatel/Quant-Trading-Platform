/**
 * The daily soak report (Story 12).
 *
 * These cover the two jobs the report has during a soak week: summarizing a
 * session from persisted evidence, and **noticing** the things that would
 * restart the week. The anomaly cases matter most — a report that aggregates
 * correctly but stays silent on a mismatch is worse than no report, because it
 * reports confidence it has not earned.
 *
 * The rung-verification cases deliberately feed the service evidence that
 * disagrees with the ladder's rules (an intent at a price no rung explains) and
 * assert it says so. Feeding it only self-consistent evidence would be a test
 * that cannot fail.
 */

import { Fill } from '../broker/broker-adapter.interface';
import { ExecutionMode } from '../config/execution-mode';
import { equityContract } from '../domain/contract';
import { ReconciliationReport } from '../reconciliation/reconciliation.service';
import { SymbolHaltService } from '../reconciliation/symbol-halt.service';
import {
  InMemoryFillRepository,
  InMemoryLotRepository,
  InMemoryOrderIntentRepository,
  InMemoryRiskEventRepository,
  InMemoryStrategyStateSnapshotRepository,
} from '../repositories/in-memory/in-memory.repositories';
import { OrderIntentRecord } from '../repositories/repository.interfaces';
import { RiskEvent, RiskEventType } from '../risk/risk-event';
import { RiskOutcome, RiskReason } from '../risk/types';
import { buildDipLadderConfig, DipLadderConfig } from '../strategies/dip-ladder/config';
import { DIP_LADDER_ID_PREFIX } from '../strategies/dip-ladder/dip-ladder.strategy';
import { Lot, LotStatus } from '../strategies/dip-ladder/lot';
import { OrderType, TimeInForce } from '../strategies/types';
import { DailyReportService } from './daily-report.service';

const SYMBOL = 'TQQQ';
const SESSION = '2026-03-10';
const NOW = '2026-03-10T21:00:00.000Z';

/**
 * An ET wall-clock time on the session under test.
 *
 * `2026-03-10` falls after that year's DST transition (March 8), so ET is
 * UTC−4. Stamping these `-05:00` would shift every timestamp an hour earlier
 * and silently move bars across the firing-window boundary — the exact class
 * of bug `session-window.ts` routes through the IANA database to avoid.
 */
const ET_OFFSET = '-04:00';

function etTime(time: string): string {
  return `${SESSION}T${time}${ET_OFFSET}`;
}

interface Harness {
  service: DailyReportService;
  intents: InMemoryOrderIntentRepository;
  fills: InMemoryFillRepository;
  lots: InMemoryLotRepository;
  riskEvents: InMemoryRiskEventRepository;
  snapshots: InMemoryStrategyStateSnapshotRepository;
  halts: SymbolHaltService;
  reconciliation: { report: ReconciliationReport | null };
}

function harness(
  options: {
    mode?: ExecutionMode;
    config?: Partial<DipLadderConfig>;
  } = {},
): Harness {
  const intents = new InMemoryOrderIntentRepository();
  const fills = new InMemoryFillRepository();
  const lots = new InMemoryLotRepository();
  const riskEvents = new InMemoryRiskEventRepository();
  const snapshots = new InMemoryStrategyStateSnapshotRepository();
  const halts = new SymbolHaltService();

  // A mutable holder so a test can set the reconciliation outcome after
  // construction without rebuilding the service.
  const reconciliation: { report: ReconciliationReport | null } = { report: null };

  const service = new DailyReportService(
    { executionMode: options.mode ?? ExecutionMode.PAPER } as never,
    { lastReconciliation: () => reconciliation.report },
    halts,
    buildDipLadderConfig(SYMBOL, options.config),
    'DURABLE',
    intents,
    fills,
    lots,
    riskEvents,
    snapshots,
  );

  return { service, intents, fills, lots, riskEvents, snapshots, halts, reconciliation };
}

/**
 * The anchor scalars a session leaves behind. 100 open with no prior close
 * bootstraps the anchor to 100, so the 5% default spacing puts rungs at 95,
 * 90.25, 85.74, 81.45, 77.38 — the values these tests hand-calculate against.
 */
async function saveAnchorSnapshot(
  h: Harness,
  data: Record<string, unknown> = { sessionOpen: 100, previousSessionClose: null },
): Promise<void> {
  await h.snapshots.save({
    strategyId: `${DIP_LADDER_ID_PREFIX}${SYMBOL}`,
    version: 1,
    symbols: [SYMBOL],
    data,
    capturedAt: etTime('16:00:00'),
  });
}

function intentRecord(overrides: Partial<OrderIntentRecord> = {}): OrderIntentRecord {
  const base: OrderIntentRecord = {
    id: `intent-${Math.random().toString(36).slice(2)}`,
    intent: {
      strategyId: `${DIP_LADDER_ID_PREFIX}${SYMBOL}`,
      contract: equityContract(SYMBOL),
      side: 'BUY',
      quantity: 10,
      orderType: OrderType.LIMIT,
      limitPrice: 95,
      timeInForce: TimeInForce.DAY,
      timestamp: etTime('10:00:00'),
      reason: 'rung 1',
    },
    decision: {
      outcome: RiskOutcome.APPROVED,
      reason: RiskReason.WITHIN_LIMITS,
      detail: 'approved',
      intent: {} as never,
      approvedQuantity: 10,
    },
    submitted: false,
    clientOrderId: null,
    createdAt: etTime('10:00:00'),
  };

  return {
    ...base,
    ...overrides,
    intent: { ...base.intent, ...(overrides.intent ?? {}) },
  };
}

function lot(overrides: Partial<Lot> = {}): Lot {
  return {
    id: `${SYMBOL}-lot-1`,
    rungPrice: 95,
    fillPrice: 95,
    quantity: 10,
    openedAt: etTime('10:00:00'),
    exitTarget: 99.75,
    status: LotStatus.HELD,
    closedAt: null,
    exitPrice: null,
    workingOrderId: null,
    ...overrides,
  };
}

describe('DailyReportService', () => {
  describe('session scoping', () => {
    it('counts only evidence stamped on the requested ET session', async () => {
      const h = harness();
      await saveAnchorSnapshot(h);

      await h.intents.save(intentRecord());
      // The previous session — must not be counted in this report.
      await h.intents.save(
        intentRecord({ intent: { timestamp: '2026-03-09T10:00:00-04:00' } as never }),
      );

      const report = await h.service.build(SESSION, NOW);

      expect(report.intents.total).toBe(1);
      expect(report.sessionDate).toBe(SESSION);
    });

    /**
     * The report must describe the session as it stood *then*, not as things
     * turned out later. A lot opened Tuesday and closed Friday was held when
     * Tuesday ended, and Friday must not rewrite Tuesday's report.
     */
    it('counts a lot closed in a later session as held at this session end', async () => {
      const h = harness();
      await saveAnchorSnapshot(h);

      await h.lots.save(
        lot({
          openedAt: etTime('10:00:00'),
          closedAt: '2026-03-13T11:00:00-04:00',
          exitPrice: 99.75,
          status: LotStatus.CLOSED,
        }),
        SYMBOL,
      );

      const report = await h.service.build(SESSION, NOW);

      expect(report.lots.openedToday).toBe(1);
      expect(report.lots.closedToday).toBe(0);
      expect(report.lots.heldAtSessionEnd).toBe(1);
    });
  });

  describe('aggregation', () => {
    it('summarizes intents by risk outcome', async () => {
      const h = harness();
      await saveAnchorSnapshot(h);

      await h.intents.save(intentRecord());
      await h.intents.save(
        intentRecord({
          decision: { outcome: RiskOutcome.RESIZED, approvedQuantity: 4 } as never,
        }),
      );
      await h.intents.save(
        intentRecord({
          decision: { outcome: RiskOutcome.REJECTED, approvedQuantity: 0 } as never,
        }),
      );

      const report = await h.service.build(SESSION, NOW);

      expect(report.intents).toMatchObject({
        total: 3,
        approved: 1,
        resized: 1,
        rejected: 1,
        submitted: 0,
      });
    });

    it('reports completed cycles with realized P&L', async () => {
      const h = harness();
      await saveAnchorSnapshot(h);

      await h.lots.save(
        lot({
          fillPrice: 95,
          exitPrice: 99.75,
          quantity: 10,
          status: LotStatus.CLOSED,
          closedAt: etTime('14:00:00'),
        }),
        SYMBOL,
      );

      const report = await h.service.build(SESSION, NOW);

      expect(report.cycles).toHaveLength(1);
      // (99.75 − 95) × 10, to the cent.
      expect(report.cycles[0].realized).toBe(47.5);
      expect(report.lots.realizedToday).toBe(47.5);
    });

    it('sums fill quantity and commission', async () => {
      const h = harness();
      await saveAnchorSnapshot(h);

      const fill = (overrides: Partial<Fill>): Fill => ({
        clientOrderId: 'c-1',
        brokerOrderId: 'b-1',
        fillId: `f-${Math.random()}`,
        symbol: SYMBOL,
        side: 'BUY',
        quantity: 10,
        price: 95,
        commission: 1.005,
        timestamp: etTime('10:00:00'),
        ...overrides,
      });

      await h.fills.save(fill({}));
      await h.fills.save(fill({ quantity: 5, commission: 0.5 }));

      const report = await h.service.build(SESSION, NOW);

      expect(report.fills).toEqual({ count: 2, quantity: 15, commission: 1.51 });
    });

    it('groups risk events by type', async () => {
      const h = harness();
      await saveAnchorSnapshot(h);

      const event = (type: RiskEventType): RiskEvent => ({
        type,
        reason: RiskReason.WITHIN_LIMITS,
        detail: 'd',
        timestamp: etTime('10:00:00'),
        intent: null,
        approvedQuantity: null,
      });

      await h.riskEvents.save(event(RiskEventType.REJECTION));
      await h.riskEvents.save(event(RiskEventType.REJECTION));
      await h.riskEvents.save(event(RiskEventType.RESIZE));

      const report = await h.service.build(SESSION, NOW);

      expect(report.riskEvents.total).toBe(3);
      expect(report.riskEvents.byType).toEqual({ REJECTION: 2, RESIZE: 1 });
    });
  });

  describe('rung verification', () => {
    it('recomputes rung prices from the snapshot anchor and matches emitted intents', async () => {
      const h = harness();
      await saveAnchorSnapshot(h);

      await h.intents.save(intentRecord({ intent: { limitPrice: 95 } as never }));

      const report = await h.service.build(SESSION, NOW);

      expect(report.rungVerification.skipped).toBe(false);
      expect(report.rungVerification.anchor).toBe(100);
      expect(report.rungVerification.spacingDistance).toBe(5);
      // Hand-calculated: 5% below each preceding level, rounded to cents.
      expect(report.rungVerification.expected.map((rung) => rung.price)).toEqual([
        95, 90.25, 85.74, 81.45, 77.38,
      ]);
      expect(report.rungVerification.expected[0].intentSeen).toBe(true);
      expect(report.rungVerification.unexplained).toEqual([]);
      expect(report.clean).toBe(true);
    });

    it('flags an entry intent at a price no rung explains', async () => {
      const h = harness();
      await saveAnchorSnapshot(h);

      // 97 is not a rung price for an anchor of 100 at 5% spacing.
      await h.intents.save(intentRecord({ intent: { limitPrice: 97 } as never }));

      const report = await h.service.build(SESSION, NOW);

      expect(report.rungVerification.unexplained).toHaveLength(1);
      expect(report.rungVerification.unexplained[0].limitPrice).toBe(97);
      expect(report.anomalies.map((a) => a.code)).toContain('RUNG_PRICE_MISMATCH');
      expect(report.clean).toBe(false);
    });

    /**
     * An exit fires at a lot's own frozen target, which is deliberately not a
     * rung price. Treating one as unexplained would make every profitable
     * session look anomalous.
     */
    it('does not flag a sell intent at a non-rung price', async () => {
      const h = harness();
      await saveAnchorSnapshot(h);

      await h.intents.save(intentRecord({ intent: { side: 'SELL', limitPrice: 99.75 } as never }));

      const report = await h.service.build(SESSION, NOW);

      expect(report.rungVerification.unexplained).toEqual([]);
    });

    it('anchors off the lowest lot held entering the session, not the session open', async () => {
      const h = harness();
      await saveAnchorSnapshot(h);

      // Held from a prior session: the ladder must extend from this exposure
      // rather than re-base to an open sitting above it.
      await h.lots.save(lot({ rungPrice: 80, openedAt: '2026-03-09T10:00:00-04:00' }), SYMBOL);

      const report = await h.service.build(SESSION, NOW);

      expect(report.rungVerification.anchorBasis).toBe('PROGRESSION');
      expect(report.rungVerification.anchor).toBe(80);
      expect(report.rungVerification.expected[0].price).toBe(76);
    });

    /**
     * A lot opened *during* the session is a consequence of the rungs being
     * checked. Anchoring off it would let the output justify itself.
     */
    it('ignores lots opened during the session when resolving the anchor', async () => {
      const h = harness();
      await saveAnchorSnapshot(h);

      await h.lots.save(lot({ rungPrice: 80, openedAt: etTime('10:00:00') }), SYMBOL);

      const report = await h.service.build(SESSION, NOW);

      expect(report.rungVerification.anchorBasis).toBe('BOOTSTRAP');
      expect(report.rungVerification.anchor).toBe(100);
    });

    /**
     * A report about Tuesday must anchor from Tuesday's snapshot, not from the
     * newest one on file. Using the latest would recompute every rung of a past
     * session against a later session's open and report a full day of false
     * mismatches — which during a soak is worse than reporting nothing, because
     * it trains an operator to ignore the check.
     */
    it('anchors from the reported session snapshot, not the most recent one', async () => {
      const h = harness();

      await saveAnchorSnapshot(h);
      // A later session, captured after the one under report.
      await h.snapshots.save({
        strategyId: `${DIP_LADDER_ID_PREFIX}${SYMBOL}`,
        version: 1,
        symbols: [SYMBOL],
        data: { sessionOpen: 88, previousSessionClose: 88 },
        capturedAt: '2026-03-13T16:00:00-04:00',
      });

      const report = await h.service.build(SESSION, NOW);

      expect(report.rungVerification.anchor).toBe(100);
      expect(report.rungVerification.expected[0].price).toBe(95);
    });

    it('skips — and says so — when no snapshot carries anchor scalars', async () => {
      const h = harness();

      const report = await h.service.build(SESSION, NOW);

      expect(report.rungVerification.skipped).toBe(true);
      expect(report.rungVerification.skipReason).toContain(
        `no strategy state snapshot with anchor scalars captured on ${SESSION}`,
      );
      // A check that did not run must never read as a pass.
      expect(report.anomalies.map((a) => a.code)).toContain('RUNG_VERIFICATION_SKIPPED');
      expect(report.clean).toBe(false);
    });

    it('skips rather than coercing when the snapshot lacks a numeric session open', async () => {
      const h = harness();
      await saveAnchorSnapshot(h, { previousSessionClose: 100 });

      const report = await h.service.build(SESSION, NOW);

      expect(report.rungVerification.skipped).toBe(true);
      expect(report.rungVerification.anchor).toBeNull();
    });

    /**
     * The anchor moves *within* a session as lots open.
     *
     * A session that starts flat and fills two rungs anchors three different
     * ways: bootstrap for the first entry, then progression off each new lot.
     * Computing one anchor for the whole session explains the first entry and
     * reports every later one as a false mismatch — which during a soak reads
     * as the strategy having gone wrong when nothing has.
     */
    it('re-anchors as lots open during the session', async () => {
      const h = harness();
      await saveAnchorSnapshot(h);

      // Bootstrap anchor 100 → first rung 95.
      await h.lots.saveAll(
        [
          lot({ id: `${SYMBOL}-lot-1`, rungPrice: 95, openedAt: etTime('10:00:00') }),
          // Progression off the 95 lot → 90.25, filled later in the session.
          lot({ id: `${SYMBOL}-lot-2`, rungPrice: 90.25, openedAt: etTime('11:00:00') }),
        ],
        SYMBOL,
      );

      await h.intents.save(
        intentRecord({ intent: { limitPrice: 95, timestamp: etTime('10:00:00') } as never }),
      );
      await h.intents.save(
        intentRecord({ intent: { limitPrice: 90.25, timestamp: etTime('11:00:00') } as never }),
      );

      const report = await h.service.build(SESSION, NOW);

      // Both entries verify, though they anchored differently: the first off
      // the bootstrap open, the second off the lot the first one created. A
      // single session-wide anchor explains one of them and flags the other.
      expect(report.rungVerification.unexplained).toEqual([]);
      // The *reported* anchor stays the session's opening one — see the note in
      // `verifyRungs`. Only the internal walk moves.
      expect(report.rungVerification.anchorBasis).toBe('BOOTSTRAP');
      expect(report.rungVerification.anchor).toBe(100);
    });

    /**
     * A rung outlives the lot that occupied it (`PRD.md:78`).
     *
     * When a lot exits, its rung re-arms **at its original price** and may fire
     * again — that repeated cycling in a range is the whole point of per-lot
     * exits. The re-entry sits at a level the current anchor no longer points
     * to, so a recomputation that only ever expects "one spacing unit below the
     * anchor" flags every second cycle onward as unexplained.
     */
    it('explains a re-entry at a rung that re-armed earlier in the session', async () => {
      const h = harness();
      await saveAnchorSnapshot(h);

      await h.lots.saveAll(
        [
          // Fires 95, takes profit, and the rung re-arms at 95.
          lot({
            id: `${SYMBOL}-lot-1`,
            rungPrice: 95,
            openedAt: etTime('10:00:00'),
            status: LotStatus.CLOSED,
            closedAt: etTime('10:30:00'),
            exitPrice: 99.75,
          }),
          // The same level fires again an hour later.
          lot({ id: `${SYMBOL}-lot-2`, rungPrice: 95, openedAt: etTime('11:30:00') }),
        ],
        SYMBOL,
      );

      await h.intents.save(
        intentRecord({ intent: { limitPrice: 95, timestamp: etTime('10:00:00') } as never }),
      );
      await h.intents.save(
        intentRecord({ intent: { limitPrice: 95, timestamp: etTime('11:30:00') } as never }),
      );

      const report = await h.service.build(SESSION, NOW);

      expect(report.rungVerification.unexplained).toEqual([]);
    });
  });

  describe('anomaly detection', () => {
    it('flags a session recorded in the retired SHADOW mode', async () => {
      // SHADOW is refused at startup (`execution-mode.ts`), so a report naming
      // it is either a historic session or a mode-plumbing fault. Either way an
      // operator must see it rather than have it normalized away.
      const h = harness({ mode: ExecutionMode.SHADOW });
      await saveAnchorSnapshot(h);

      await h.intents.save(intentRecord({ submitted: true, clientOrderId: 'c-1' }));

      const report = await h.service.build(SESSION, NOW);

      expect(report.anomalies.map((a) => a.code)).toContain('RETIRED_MODE');
      expect(report.clean).toBe(false);
    });

    it('flags an intent stamped outside the firing window', async () => {
      const h = harness();
      await saveAnchorSnapshot(h);

      // 09:40 ET — inside the session but before firing opens at 09:45.
      await h.intents.save(intentRecord({ intent: { timestamp: etTime('09:40:00') } as never }));

      const report = await h.service.build(SESSION, NOW);

      expect(report.intents.outsideFiringWindow).toBe(1);
      expect(report.anomalies.map((a) => a.code)).toContain('INTENT_OUTSIDE_FIRING_WINDOW');
    });

    /**
     * The window constrains firing, not exiting (`session-window.ts`).
     *
     * `onBar` evaluates exits before consulting the window, so a lot reaching
     * its frozen take-profit target during the opening auction exits then — by
     * design, and safely, since the target was fixed at fill and a lot only
     * ever exits in profit. Counting that as an anomaly raises a false alarm on
     * every session with an early take-profit, and any unexplained anomaly
     * restarts the soak week.
     */
    it('does not flag an exit stamped before the firing window opens', async () => {
      const h = harness();
      await saveAnchorSnapshot(h);

      await h.intents.save(
        intentRecord({
          intent: { side: 'SELL', limitPrice: 99.75, timestamp: etTime('09:40:00') } as never,
        }),
      );

      const report = await h.service.build(SESSION, NOW);

      expect(report.intents.outsideFiringWindow).toBe(0);
      expect(report.anomalies.map((a) => a.code)).not.toContain('INTENT_OUTSIDE_FIRING_WINDOW');
    });

    it('flags an unclean reconciliation', async () => {
      const h = harness();
      await saveAnchorSnapshot(h);

      h.reconciliation.report = {
        ranAt: etTime('09:00:00'),
        clean: false,
        symbols: [],
        haltedSymbols: [SYMBOL],
        ordersUpdated: 0,
      };

      const report = await h.service.build(SESSION, NOW);

      expect(report.reconciliation.clean).toBe(false);
      expect(report.anomalies.map((a) => a.code)).toContain('RECONCILIATION_MISMATCH');
    });

    it('flags an active symbol halt', async () => {
      const h = harness();
      await saveAnchorSnapshot(h);

      h.halts.halt(SYMBOL, 'LOT_SUM_MISMATCH', 'injected', etTime('09:00:00'));

      const report = await h.service.build(SESSION, NOW);

      expect(report.anomalies.map((a) => a.code)).toContain('ACTIVE_SYMBOL_HALT');
      expect(report.activeHalts).toHaveLength(1);
    });

    /**
     * Lots only ever exit in profit — no stop, no loss-booking exit at any
     * level. This asserts the property from observed evidence rather than
     * trusting the rule, so a regression that introduced a losing exit would
     * surface in the soak report rather than only in a strategy unit test.
     */
    it('flags a lot that closed below its fill price', async () => {
      const h = harness();
      await saveAnchorSnapshot(h);

      await h.lots.save(
        lot({
          fillPrice: 95,
          exitPrice: 90,
          status: LotStatus.CLOSED,
          closedAt: etTime('14:00:00'),
        }),
        SYMBOL,
      );

      const report = await h.service.build(SESSION, NOW);

      expect(report.anomalies.map((a) => a.code)).toContain('LOT_CLOSED_AT_LOSS');
      expect(report.clean).toBe(false);
    });

    it('reports a clean session when nothing is wrong', async () => {
      const h = harness();
      await saveAnchorSnapshot(h);

      h.reconciliation.report = {
        ranAt: etTime('09:00:00'),
        clean: true,
        symbols: [],
        haltedSymbols: [],
        ordersUpdated: 0,
      };
      await h.intents.save(intentRecord({ intent: { limitPrice: 95 } as never }));

      const report = await h.service.build(SESSION, NOW);

      expect(report.anomalies).toEqual([]);
      expect(report.clean).toBe(true);
    });
  });
});
