/**
 * The P&L email routes over HTTP, on the assembled app.
 *
 * The summary arithmetic and rendering are proven in `observability/`; what
 * only the assembled app shows is the wiring — the routes reach the account's
 * grid lots through the real repository binding, and answer 503 rather than
 * pretending to send when SMTP is not configured.
 */

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../app.module';
import { MAILER, RecordingMailer } from '../observability/mailer';
import { GRID_LOT_REPOSITORY, GridLotRepository } from '../repositories/repository.interfaces';
import { GridLotStatus } from '../strategies/grid/lot';

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
      await app.get<GridLotRepository>(GRID_LOT_REPOSITORY).save(
        {
          id: 'g1',
          fillPrice: 70,
          quantity: 50,
          openedAt: '2026-09-25T10:00:00.000-04:00',
          sellTarget: 70.5,
          status: GridLotStatus.CLOSED,
          closedAt: '2026-09-25T11:00:00.000-04:00',
          exitPrice: 70.5,
          workingOrderId: null,
        },
        'grid:TQQQ',
        'TQQQ',
      );
    });

    it('sends a day', async () => {
      const response = await request(app.getHttpServer())
        .post('/reports/email/daily?date=2026-09-25')
        .expect(200);

      expect(response.body.sent).toContain(
        'Daily P&L · Fri, Sep 25, 2026 (session close): +$25.00 (1 trade)',
      );
      expect(mailer.sent).toHaveLength(1);
    });

    it('sends a month', async () => {
      const response = await request(app.getHttpServer())
        .post('/reports/email/monthly?month=2026-09')
        .expect(200);

      expect(response.body.sent).toContain(
        'Monthly P&L · September 2026 (Sep 1 – Sep 30, 2026): +$25.00 (1 trade)',
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
