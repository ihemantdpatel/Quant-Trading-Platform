/**
 * `GET/POST /accounts` — creating an account from the dashboard.
 *
 * The rules themselves are covered by `config/account-definition.spec.ts`; this
 * proves the route applies them, masks the IB id on the way out, and refuses
 * outright when there is no database for the supervisor to read.
 *
 * `STORAGE_MODE` is overridden to `DURABLE` over the in-memory repositories so
 * the create path runs without MySQL; the Prisma write is the database suite's.
 */

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../app.module';
import { MANAGED_CLIENT_ID_BASE, MANAGED_PORT_BASE } from '../config/account-definition';
import { STORAGE_MODE } from '../repositories/repositories.module';

const FORM = {
  alias: 'second',
  label: 'Second paper account',
  mode: 'PAPER',
  ibAccountId: 'DU7654321',
  equity: 100_000,
  symbolCapital: { TQQQ: 25_000 },
  dailyLossThreshold: 3_000,
  reason: 'second paper account for the soak',
};

async function boot(storage: 'DURABLE' | 'IN_MEMORY'): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(STORAGE_MODE)
    .useValue(storage)
    .compile();

  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('creating accounts', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  describe('with durable storage', () => {
    beforeEach(async () => {
      app = await boot('DURABLE');
    });

    it('creates an account, allocates its client id and port, and masks its IB id', async () => {
      const created = await http().post('/accounts').send(FORM).expect(201);

      expect(created.body).toMatchObject({
        alias: 'second',
        mode: 'PAPER',
        ibAccountId: 'DU•••321',
        ibClientId: MANAGED_CLIENT_ID_BASE,
        port: MANAGED_PORT_BASE,
      });

      const listed = await http().get('/accounts').expect(200);
      expect(listed.body).toHaveLength(1);
      expect(JSON.stringify(listed.body)).not.toContain('DU7654321');
    });

    it('refuses a second account with the same alias or IB id', async () => {
      await http().post('/accounts').send(FORM).expect(201);

      const again = await http()
        .post('/accounts')
        .send({ ...FORM, alias: 'third' })
        .expect(422);

      expect(again.body.failures.join(' ')).toMatch(/already traded by "second"/);
      await http().post('/accounts').send(FORM).expect(422);
    });

    it('refuses the code-registry alias', async () => {
      const response = await http()
        .post('/accounts')
        .send({ ...FORM, alias: 'nuuixl118' })
        .expect(422);

      expect(response.body.failures.join(' ')).toMatch(/accounts\.config\.ts/);
    });

    it('reports every invalid field', async () => {
      const response = await http()
        .post('/accounts')
        .send({ ...FORM, alias: 'Bad Alias', equity: -1 })
        .expect(422);

      expect(response.body.failures).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^alias:/),
          expect.stringMatching(/^equity:/),
        ]),
      );
    });
  });

  describe('without durable storage', () => {
    beforeEach(async () => {
      app = await boot('IN_MEMORY');
    });

    it('refuses to create an account no supervisor would ever start', async () => {
      const response = await http().post('/accounts').send(FORM).expect(503);

      expect(response.body.message).toMatch(/durable storage/);
      await http().get('/accounts').expect(200, []);
    });
  });
});
