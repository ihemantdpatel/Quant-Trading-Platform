/**
 * Story 9 over HTTP (`stories.md:543`).
 *
 * The reconciliation behaviour itself is proven in
 * `reconciliation/reconciliation.service.spec.ts`. This file asserts the two
 * things only the assembled application can show: that startup reconciliation
 * actually runs when the app boots, and that a halt is **visible to an
 * operator** on the endpoints the dashboard reads.
 *
 * A halt nobody can see is nearly as bad as no halt at all — the symbol stops
 * trading and the reason is buried in a log.
 */

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../app.module';
import { BROKER_ADAPTER } from '../broker/broker-adapter.interface';
import { MockBrokerAdapter } from '../broker/mock/mock-broker.adapter';
import { SymbolHaltService } from '../reconciliation/symbol-halt.service';
import { LOT_REPOSITORY, LotRepository } from '../repositories/repository.interfaces';
import { LotStatus } from '../strategies/dip-ladder/lot';

jest.setTimeout(120_000);

describe('Story 9: reconciliation over HTTP', () => {
  let app: INestApplication;
  let broker: MockBrokerAdapter;
  let halts: SymbolHaltService;
  let lots: LotRepository;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    broker = app.get<MockBrokerAdapter>(BROKER_ADAPTER);
    halts = app.get(SymbolHaltService);
    lots = app.get(LOT_REPOSITORY);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('a clean boot', () => {
    it('runs reconciliation during startup and reports it on GET /status', async () => {
      // The app boots flat with an empty ladder, which reconciles. What matters
      // is that a report exists at all — a null here would mean the startup
      // sequence never ran and every symbol was trading unverified.
      const response = await request(app.getHttpServer()).get('/status').expect(200);

      expect(response.body.reconciliation).not.toBeNull();
      expect(response.body.reconciliation.clean).toBe(true);
      expect(response.body.halts.symbols).toEqual([]);
    });

    it('exposes GET /halts with nothing halted', async () => {
      const response = await request(app.getHttpServer()).get('/halts').expect(200);

      expect(response.body.symbols).toEqual([]);
      expect(response.body.reconciliation.clean).toBe(true);
    });
  });

  describe('an active halt', () => {
    /**
     * Halts the symbol the way reconciliation would.
     *
     * Raised through the shared `SymbolHaltService` rather than by rebooting
     * the app with seeded state: the app reconciles inside `app.init()`, so
     * injecting a mismatch beforehand would mean building a second module
     * graph. What this file is testing is the *surface*, and the surface reads
     * the same registry either way.
     */
    const haltTQQQ = (): void => {
      jest.spyOn(halts['logger'], 'error').mockImplementation(() => undefined);
      halts.halt(
        'TQQQ',
        'LOT_SUM_MISMATCH',
        'TQQQ: lot sum 300 does not equal broker net position 200',
        '2025-01-20T09:25:00.000-05:00',
      );
    };

    it('surfaces the halt with its reason on GET /status', async () => {
      haltTQQQ();

      const response = await request(app.getHttpServer()).get('/status').expect(200);

      expect(response.body.halts.symbols).toHaveLength(1);
      expect(response.body.halts.symbols[0]).toEqual(
        expect.objectContaining({ symbol: 'TQQQ', code: 'LOT_SUM_MISMATCH' }),
      );
      expect(response.body.halts.symbols[0].reason).toContain('does not equal broker net position');
    });

    it('stops the symbol producing intents on a replay', async () => {
      haltTQQQ();

      const response = await request(app.getHttpServer())
        .post('/engine/replay')
        .send({ fixture: 'chop-range' })
        .expect(200);

      expect(response.body.intentsGenerated).toBe(0);
      expect(response.body.submitted).toBe(0);

      // And nothing was sold to resolve it.
      expect(await request(app.getHttpServer()).get('/orders').expect(200)).toMatchObject({
        body: [],
      });
    });

    it('leaves GET /lots empty rather than showing unverified composition', async () => {
      haltTQQQ();
      await request(app.getHttpServer()).post('/engine/replay').send({ fixture: 'chop-range' });

      const response = await request(app.getHttpServer()).get('/lots').expect(200);

      expect(response.body).toEqual([]);
    });

    it('resumes trading only after the halt is released', async () => {
      haltTQQQ();
      jest.spyOn(halts['logger'], 'warn').mockImplementation(() => undefined);

      await request(app.getHttpServer())
        .post('/halts/TQQQ/release')
        .expect(200)
        .expect({ symbol: 'TQQQ', halted: false });

      const response = await request(app.getHttpServer())
        .post('/engine/replay')
        .send({ fixture: 'chop-range' })
        .expect(200);

      expect(response.body.intentsGenerated).toBeGreaterThan(0);
    });

    it('answers 404 when releasing a symbol that is not halted', async () => {
      await request(app.getHttpServer()).post('/halts/TQQQ/release').expect(404);
    });

    it('is not cleared by POST /engine/reset', async () => {
      // Reset returns the engine to a known state for the next replay. It is
      // deliberately not a way to dismiss a mismatch nobody resolved.
      haltTQQQ();

      await request(app.getHttpServer()).post('/engine/reset').expect(200);

      const response = await request(app.getHttpServer()).get('/status').expect(200);
      expect(response.body.halts.symbols).toHaveLength(1);
    });

    it('does not destroy the persisted lots an operator needs', async () => {
      // Run a replay first so there is state, then halt and replay again. The
      // second replay must not overwrite the stored lots with the halted
      // ladder's empty view.
      await request(app.getHttpServer()).post('/engine/replay').send({ fixture: 'chop-range' });

      const before = await lots.findBySymbol('TQQQ');
      expect(before.length).toBeGreaterThan(0);

      haltTQQQ();
      await request(app.getHttpServer()).post('/engine/replay').send({ fixture: 'chop-range' });

      expect(await lots.findBySymbol('TQQQ')).toHaveLength(before.length);
    });
  });

  describe('the broker still reports its own position', () => {
    it('shows the untouched position on GET /positions while the symbol is halted', async () => {
      // The clearest statement of "we halted, we did not liquidate": the
      // account still holds the shares, and the dashboard shows them.
      jest.spyOn(halts['logger'], 'error').mockImplementation(() => undefined);
      broker.seedPosition({ symbol: 'TQQQ', quantity: 200, averageCost: 92 });
      halts.halt('TQQQ', 'LOT_SUM_MISMATCH', 'mismatch', '2025-01-20T09:25:00.000-05:00');

      await request(app.getHttpServer()).post('/engine/replay').send({ fixture: 'chop-range' });

      const response = await request(app.getHttpServer()).get('/positions').expect(200);

      expect(response.body).toEqual([{ symbol: 'TQQQ', quantity: 200, averageCost: 92 }]);
    });
  });

  describe('an unhalted symbol is unaffected', () => {
    it('still produces intents and lots when nothing is halted', async () => {
      // Guards against a halt check so broad it suppresses every symbol, which
      // would make every test above pass while breaking normal operation.
      const replayed = await request(app.getHttpServer())
        .post('/engine/replay')
        .send({ fixture: 'chop-range' })
        .expect(200);

      expect(replayed.body.intentsGenerated).toBeGreaterThan(0);

      const response = await request(app.getHttpServer()).get('/lots').expect(200);

      expect(response.body.length).toBeGreaterThan(0);
      // `chop-range` exists to cycle rungs, so by the last bar the lots it
      // opened have closed again — asserting on `CLOSED` rather than `HELD`
      // reflects what the fixture actually produces.
      expect(response.body.some((lot: { status: string }) => lot.status === LotStatus.CLOSED)).toBe(
        true,
      );
    });
  });
});
