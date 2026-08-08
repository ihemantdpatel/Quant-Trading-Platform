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
 * The final session of `chop-range`, and **the only one with a snapshot**.
 *
 * `EngineService.persistLadderState` runs once at the end of a replay rather
 * than per session, so a twelve-day fixture leaves exactly one snapshot,
 * stamped with the last bar. That is fine for replay — the whole fixture is one
 * batch — but it means only this session has the anchor scalars the rung
 * recomputation needs.
 *
 * The live soak does not have this shape: bars arrive continuously and state is
 * persisted as they do, so each session gets its own snapshot. The distinction
 * matters when reading these tests as evidence about soak behaviour — what is
 * asserted here is that verification works against a session that *has* a
 * snapshot, and correctly reports a skip for one that does not.
 */
const FINAL_SESSION = '2025-01-17';

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
    expect(report.mode).toBe('SHADOW');
    expect(report.intents.total).toBeGreaterThan(0);
  });

  /**
   * The mode guarantee, checked from the other end. `SHADOW` submits nothing
   * whichever broker is bound, so a report that ever showed a submission here
   * would mean the guarantee had been broken somewhere upstream.
   */
  it('shows zero submissions and raises no SHADOW anomaly', async () => {
    const response = await request(app.getHttpServer())
      .get(`/reports/daily?date=${FIRST_SESSION}`)
      .expect(200);

    const report = response.body as DailyReport;

    expect(report.intents.submitted).toBe(0);
    expect(report.anomalies.map((anomaly) => anomaly.code)).not.toContain('SUBMISSION_IN_SHADOW');
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
    // The session's own snapshot anchor, with rungs a hand-checkable 5% apart:
    // 88.00 → 83.60 → 79.42 → 75.45 → 71.68 → 68.10.
    expect(report.rungVerification.anchor).toBe(88);
    expect(report.rungVerification.spacingDistance).toBe(4.4);
    expect(report.rungVerification.expected.map((rung) => rung.price)).toEqual([
      83.6, 79.42, 75.45, 71.68, 68.1,
    ]);
    expect(report.rungVerification.unexplained).toEqual([]);
  });

  /**
   * The session's two intents are exits, which fire at each lot's own frozen
   * target rather than at a rung price. Flagging those would make every
   * profitable session look anomalous.
   */
  it('reports completed cycles without flagging their exit prices', async () => {
    const response = await request(app.getHttpServer())
      .get(`/reports/daily?date=${FINAL_SESSION}`)
      .expect(200);

    const report = response.body as DailyReport;

    expect(report.lots.closedToday).toBe(2);
    expect(report.cycles).toHaveLength(2);
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
   */
  it('reports a skip, not a pass, for a session it cannot anchor', async () => {
    const response = await request(app.getHttpServer())
      .get(`/reports/daily?date=${FIRST_SESSION}`)
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
