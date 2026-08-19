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
  it('recomputes the session rung prices and finds no unexplained intent', async () => {
    const response = await request(app.getHttpServer())
      .get(`/reports/daily?date=${FINAL_SESSION}`)
      .expect(200);

    const report = response.body as DailyReport;

    expect(report.rungVerification.skipped).toBe(false);

    /*
      Progression, not bootstrap: the ladder carried four lots into this session
      (95, 90.25, 85.74, 77.38 — all of which exit during it), so the anchor is
      the lowest of them rather than the snapshot's session open. The bootstrap
      scalars only decide the anchor on a session that opens flat.

      Rungs are then a hand-checkable 5% apart below it:
      77.38 → 73.51 → 69.83 → 66.34 → 63.02 → 59.87.
    */
    expect(report.rungVerification.anchorBasis).toBe('PROGRESSION');
    expect(report.rungVerification.anchor).toBe(77.38);
    expect(report.rungVerification.spacingDistance).toBe(3.87);
    expect(report.rungVerification.expected.map((rung) => rung.price)).toEqual([
      73.51, 69.83, 66.34, 63.02, 59.87,
    ]);

    // The headline property, and the one that survives any change of fixture
    // shape: every entry the ladder fired sits at a price the recomputation
    // reached independently.
    expect(report.rungVerification.unexplained).toEqual([]);
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
    expect(report.anomalies).toEqual([]);
    expect(report.clean).toBe(true);
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
