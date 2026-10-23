/**
 * The P&L email routes over HTTP, on the assembled app.
 *
 * The summary arithmetic and rendering are proven in `observability/`; what
 * only the assembled app shows is the wiring — the routes reach the account's
 * position snapshots and fills through the real repository binding, the
 * dashboard's realized-P&L route agrees with the email, and the email routes
 * answer 503 rather than pretending to send when SMTP is not configured.
 */

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../app.module';
import { MAILER, RecordingMailer } from '../observability/mailer';
import {
  FILL_REPOSITORY,
  FillRepository,
  POSITION_SNAPSHOT_REPOSITORY,
  PositionSnapshotRepository,
} from '../repositories/repository.interfaces';

jest.setTimeout(60_000);

async function boot(mailer: RecordingMailer | null): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAILER)
    .useValue(mailer)
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('P&L email routes', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app.close();
  });

  describe('with a mailer', () => {
    let mailer: RecordingMailer;

    beforeEach(async () => {
      mailer = new RecordingMailer();
      app = await boot(mailer);
      await app.get<PositionSnapshotRepository>(POSITION_SNAPSHOT_REPOSITORY).saveBatch([
        {
          takenAt: '2026-09-24T16:20:00.000-04:00',
          symbol: 'TQQQ',
          quantity: 50,
          averageCost: 70,
        },
      ]);
      await app.get<FillRepository>(FILL_REPOSITORY).save({
        clientOrderId: 'co-1',
        brokerOrderId: '1',
        fillId: 'f1',
        symbol: 'TQQQ',
        side: 'SELL',
        quantity: 50,
        price: 70.5,
        commission: 0,
        timestamp: '2026-09-25T11:00:00.000-04:00',
      });
    });

    it('serves the dashboard the same realized P&L the email reports', async () => {
      const response = await request(app.getHttpServer())
        .get('/reports/pnl/realized?date=2026-09-25')
        .expect(200);

      expect(response.body.totals).toEqual({ trades: 1, gross: 25, commissions: 0, net: 25 });
      expect(response.body.sells[0]).toMatchObject({ averageCost: 70, realized: 25 });
      expect(response.body.monthToDate.net).toBe(25);
      expect(response.body.coverage.tracked).toBe(true);

      await request(app.getHttpServer()).get('/reports/pnl/realized?date=2026-9-25').expect(422);
    });

    it('sends a day', async () => {
      const response = await request(app.getHttpServer())
        .post('/reports/email/daily?date=2026-09-25')
        .expect(200);

      expect(response.body.sent).toContain(
        'Daily P&L · Fri, Sep 25, 2026 (session close): +$25.00 (1 sell)',
      );
      expect(mailer.sent).toHaveLength(1);
    });

    it('sends a month', async () => {
      const response = await request(app.getHttpServer())
        .post('/reports/email/monthly?month=2026-09')
        .expect(200);

      expect(response.body.sent).toContain(
        'Monthly P&L · September 2026 (Sep 1 – Sep 30, 2026): +$25.00 (1 sell)',
      );
    });

    it('defaults to today and to the previous month', async () => {
      await request(app.getHttpServer()).post('/reports/email/daily').expect(200);
      await request(app.getHttpServer()).post('/reports/email/monthly').expect(200);

      expect(mailer.sent).toHaveLength(2);
    });

    it('refuses a malformed date or month', async () => {
      await request(app.getHttpServer()).post('/reports/email/daily?date=2026-9-25').expect(422);
      await request(app.getHttpServer()).post('/reports/email/monthly?month=2026-13').expect(422);
      expect(mailer.sent).toHaveLength(0);
    });

    it('answers 502 when SMTP refuses the send', async () => {
      mailer.failWith = new Error('535 bad credentials');

      const response = await request(app.getHttpServer())
        .post('/reports/email/daily?date=2026-09-25')
        .expect(502);

      expect(response.body.message).toContain('535 bad credentials');
    });
  });

  it('answers 503 when email is not configured', async () => {
    app = await boot(null);

    await request(app.getHttpServer()).post('/reports/email/daily?date=2026-09-25').expect(503);
  });
});
