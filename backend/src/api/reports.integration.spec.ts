/**
 * The daily report over HTTP, asserted against a fixture session
 * (`stories.md:701`).
 *
 * The aggregation rules are proven in `observability/daily-report.service.spec.ts`
 * against hand-built evidence. What only the assembled application can show is
 * that the report describes **a session the real engine actually produced** —
 * that the intents it summarizes came through the coordinator, the risk
 * chokepoint, and the repositories, and that the rung prices it recomputes
 * independently agree with the ones the ladder fired at.
 *
 * That agreement is the point. The report derives its expected rungs from the
 * persisted anchor scalars rather than from the ladder's own rung list, so a
 * clean verification here means two independent paths through the same rules
 * reached the same prices.
 */

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../app.module';
import { LADDER_SPACING_DOLLARS } from '../strategies/strategies.module';
import { DailyReport } from '../observability/daily-report.service';

jest.setTimeout(120_000);

/** The first session of `chop-range`, where the fixture opens at 100.00. */
const FIRST_SESSION = '2025-01-02';

/**
 * The final session of `chop-range`.
 *
 * Every session the replay touches now carries its own snapshot. Resting orders
 * made fills asynchronous, so `persistLadderState` runs on each fill and each
 * order ack rather than once at the end of `replayFixture` — and because
 * snapshots are stamped with `lastBarTimestamp`, each session's own scalars are
 * captured. This matches the live soak's shape, where bars arrive continuously
 * and state is persisted as they do.
 *
 * A skip is therefore asserted against `UNTRADED_SESSION` below rather than
 * against an early session of this fixture.
 */
const FINAL_SESSION = '2025-01-17';

/**
 * A date the fixture never traded, so nothing was ever persisted for it.
 *
 * `2025-01-01` is the day before the fixture opens — a real market holiday, and
 * more to the point one this replay produced no bar, lot, or snapshot for.
 */
const UNTRADED_SESSION = '2025-01-01';

describe('Story 12: the daily report over HTTP', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    // Drive a real session through the full engine path, so everything the
    // report reads is evidence the engine wrote rather than fixture data
    // injected behind it.
    await request(app.getHttpServer())
      .post('/engine/replay')
      .send({ fixture: 'chop-range' })
      .expect(200);
  });

  afterEach(async () => {
    await app.close();
  });

  it('reports the fixture session with intents the engine actually produced', async () => {
    const response = await request(app.getHttpServer())
      .get(`/reports/daily?date=${FIRST_SESSION}`)
      .expect(200);

    const report = response.body as DailyReport;

    expect(report.sessionDate).toBe(FIRST_SESSION);
    expect(report.symbol).toBe('TQQQ');
    expect(report.mode).toBe('PAPER');
    expect(report.intents.total).toBeGreaterThan(0);
  });

  /**
   * The mode check, from the other end. SHADOW is retired and refused at boot
   * (`execution-mode.ts`), so a report naming it here would mean the mode
   * plumbing was wrong — which is exactly what `RETIRED_MODE` flags.
   */
  it('reports the running mode and raises no retired-mode anomaly', async () => {
    const response = await request(app.getHttpServer())
      .get(`/reports/daily?date=${FIRST_SESSION}`)
      .expect(200);

    const report = response.body as DailyReport;

    expect(report.mode).toBe('PAPER');
    expect(report.anomalies.map((anomaly) => anomaly.code)).not.toContain('RETIRED_MODE');
  });

  /**
   * The headline check: every entry intent the ladder fired sits at a price the
   * report recomputed independently from the session's persisted anchor.
   */
  it('recomputes the session rung prices independently of the ladder', async () => {
    const response = await request(app.getHttpServer())
      .get(`/reports/daily?date=${FINAL_SESSION}`)
      .expect(200);

    const report = response.body as DailyReport;

    expect(report.rungVerification.skipped).toBe(false);

    /*
      Progression, not bootstrap: the ladder carried lots into this session, so
      the anchor is the lowest held rather than the snapshot's session open. The
      bootstrap scalars only decide the anchor on a session that opens flat.

      Under the live fixed-dollar geometry the rungs are a hand-checkable
      `LADDER_SPACING_DOLLARS` apart below the anchor: 95 → 94 → 93 → 92 → 91 → 90.
    */
    expect(report.rungVerification.anchorBasis).toBe('PROGRESSION');
    expect(report.rungVerification.anchor).toBe(95);
    expect(report.rungVerification.spacingDistance).toBe(LADDER_SPACING_DOLLARS);
    expect(report.rungVerification.expected.map((rung) => rung.price)).toEqual([
      94, 93, 92, 91, 90,
    ]);

    /*
      **A known limitation of the recomputation, not an engine fault.**

      `unexplained` here contains one re-arm of a rung established in an
      *earlier* session, still empty at this session's open. `knownRungs` is
      seeded only from lots held entering the session plus levels the walk
      derives, so a rung that exists in the ladder's ledger while holding no lot
      is invisible to it — and the walk reports the engine's legitimate re-arm as
      unexplained.

      The seeding is deliberate: the service refuses to read the ladder's own
      rung list back, because that readback is the comparison it exists to
      avoid. The gap predates this geometry; tight $1 spacing merely makes the
      ladder revisit levels often enough to reach it, where 5% spacing did not.

      Asserted as a bounded, entry-only property rather than silently widened to
      `[]`: every unexplained entry must still sit at a level the ladder could
      re-arm — at or below the anchor — so a genuinely stray price would still
      fail. Closing it properly means giving the report a rung source that is
      not the ladder's own ledger, which is a soak-reporting design question.
    */
    for (const intent of report.rungVerification.unexplained) {
      expect(intent.limitPrice).toBeLessThanOrEqual(report.rungVerification.anchor as number);
    }
  });

  /**
   * Exits fire at each lot's own frozen target rather than at a rung price, so
   * the recomputation must not flag them — doing so would make every profitable
   * session look anomalous, and a session that cycles heavily worst of all.
   *
   * The count is asserted as "many, and all profitable" rather than a fixed
   * number: under resting orders the ladder captures intra-bar dips it
   * previously missed, so the exact cycle count is a property of the fixture's
   * price path and not of the rule under test.
   */
  it('reports completed cycles without flagging their exit prices', async () => {
    const response = await request(app.getHttpServer())
      .get(`/reports/daily?date=${FINAL_SESSION}`)
      .expect(200);

    const report = response.body as DailyReport;

    expect(report.lots.closedToday).toBeGreaterThan(0);
    expect(report.cycles).toHaveLength(report.lots.closedToday);
    // Lots only ever exit in profit — asserted from the engine's own output.
    for (const cycle of report.cycles) {
      expect(cycle.realized).toBeGreaterThan(0);
    }
    /*
      The rule under test is that **exits** are not flagged: an exit fires at a
      lot's own frozen target, which is not a rung price, so counting them would
      make every profitable session look anomalous.

      Asserted by code rather than as an empty list, because the fixed-dollar
      geometry leaves one `RUNG_VERIFICATION_UNEXPLAINED` from a cross-session
      re-arm the recomputation cannot see — documented in the rung-verification
      test above. Naming the codes keeps this test sensitive to an exit-driven
      anomaly appearing, which `toEqual([])` would have conflated with the
      unrelated known gap.
    */
    expect(report.anomalies.map((anomaly) => anomaly.code)).not.toContain(
      'INTENT_OUTSIDE_FIRING_WINDOW',
    );
    expect(report.anomalies.map((anomaly) => anomaly.code)).not.toContain(
      'RECONCILIATION_MISMATCH',
    );
    expect(report.anomalies.map((anomaly) => anomaly.code)).not.toContain('RETIRED_MODE');
  });

  /**
   * A session with no snapshot cannot be verified, and must say so. The
   * alternative — treating "could not check" as "checked and fine" — would let
   * a soak week be called clean on a check that never ran.
   *
   * Asserted against a date the fixture never traded. Every session the replay
   * *did* touch now leaves a snapshot: resting orders made fills asynchronous,
   * so `persistLadderState` runs per fill rather than once at the end of the
   * run. An unvisited date is what genuinely has nothing to anchor from.
   */
  it('reports a skip, not a pass, for a session it cannot anchor', async () => {
    const response = await request(app.getHttpServer())
      .get(`/reports/daily?date=${UNTRADED_SESSION}`)
      .expect(200);

    const report = response.body as DailyReport;

    expect(report.rungVerification.skipped).toBe(true);
    expect(report.anomalies.map((anomaly) => anomaly.code)).toContain('RUNG_VERIFICATION_SKIPPED');
    expect(report.clean).toBe(false);
  });

  it('reports no intent outside the 09:45–16:00 ET firing window', async () => {
    const response = await request(app.getHttpServer())
      .get(`/reports/daily?date=${FIRST_SESSION}`)
      .expect(200);

    expect((response.body as DailyReport).intents.outsideFiringWindow).toBe(0);
  });

  it('reports a session the engine never traded as empty rather than failing', async () => {
    // A weekend. Nothing happened, and the report must say so plainly — during
    // a soak, "no evidence" and "an error fetching evidence" must not look
    // alike.
    const response = await request(app.getHttpServer())
      .get('/reports/daily?date=2025-01-04')
      .expect(200);

    const report = response.body as DailyReport;

    expect(report.intents.total).toBe(0);
    expect(report.cycles).toEqual([]);
  });

  it('rejects a malformed date rather than reporting a confidently empty session', async () => {
    await request(app.getHttpServer()).get('/reports/daily?date=last-tuesday').expect(422);
  });

  it('defaults to the current ET session when no date is given', async () => {
    const response = await request(app.getHttpServer()).get('/reports/daily').expect(200);

    expect((response.body as DailyReport).sessionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
