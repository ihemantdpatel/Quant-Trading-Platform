/**
 * The dip ladder is retired: the assembled app never registers it, so
 * nothing can enable, reconcile, rebuild into, or display it.
 *
 * Disabling it was not enough. A registered-but-disabled ladder still had its
 * lot-sum assertion run on every reconciliation, so broker shares the grid
 * had failed to record were adopted as *ladder* lots by the Tier 2 rebuild
 * (2026-09-29 and 2026-10-01) and shown on the dashboard as dip-ladder
 * holdings. And `POST /strategies/dip-ladder:TQQQ/enable` could bring it back
 * beside the grid on the same symbol.
 *
 * This suite exercises the app's actual default boot and deliberately never
 * calls `registerRetiredLadderForTest`.
 */

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../app.module';
import { BROKER_ADAPTER } from '../broker/broker-adapter.interface';
import { MockBrokerAdapter } from '../broker/mock/mock-broker.adapter';
import {
  LOT_REPOSITORY,
  LotRepository,
  RUNG_REPOSITORY,
  RungRepository,
} from '../repositories/repository.interfaces';
import { LotStatus } from '../strategies/dip-ladder/lot';
import { RungStatus } from '../strategies/dip-ladder/rung';

jest.setTimeout(120_000);

describe('the retired dip ladder', () => {
  let app: INestApplication;
  let lots: LotRepository;
  let rungs: RungRepository;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    lots = app.get(LOT_REPOSITORY);
    rungs = app.get(RUNG_REPOSITORY);

    // Stands in for ladder rows left in the database from before retirement.
    await lots.saveAll(
      [
        {
          id: 'TQQQ-lot-1',
          rungPrice: 95,
          fillPrice: 95,
          quantity: 100,
          openedAt: '2025-01-20T09:45:00.000-05:00',
          exitTarget: 99.75,
          status: LotStatus.HELD,
          closedAt: null,
          exitPrice: null,
          workingOrderId: null,
        },
      ],
      'TQQQ',
    );
    await rungs.saveAll(
      [
        {
          price: 95,
          status: RungStatus.HELD,
          lotId: 'TQQQ-lot-1',
          workingOrderId: null,
          completedCycles: 0,
          lastExitAt: null,
        },
      ],
      'TQQQ',
    );
  });

  afterEach(async () => {
    await app.close();
  });

  it('is not registered, so GET /strategies does not list it', async () => {
    const response = await request(app.getHttpServer()).get('/strategies').expect(200);
    const ids = response.body.map((entry: { id: string }) => entry.id);

    expect(ids).toContain('grid:TQQQ');
    expect(ids.some((id: string) => id.startsWith('dip-ladder'))).toBe(false);
  });

  it('cannot be re-enabled over HTTP', async () => {
    await request(app.getHttpServer()).post('/strategies/dip-ladder:TQQQ/enable').expect(404);
  });

  it('does not serve leftover ladder rows on GET /lots or GET /rungs', async () => {
    const lotsResponse = await request(app.getHttpServer()).get('/lots').expect(200);
    const rungsResponse = await request(app.getHttpServer()).get('/rungs').expect(200);

    expect(lotsResponse.body).toEqual([]);
    expect(rungsResponse.body).toEqual([]);
  });

  it('never synthesizes ladder lots for broker shares the grid does not explain', async () => {
    await lots.clear();

    // 92 shares at the broker and no grid lot for them: the shape that made
    // the Tier 2 rebuild write ladder lots before retirement.
    app.get<MockBrokerAdapter>(BROKER_ADAPTER).seedPosition({
      symbol: 'TQQQ',
      quantity: 92,
      averageCost: 78.1,
    });

    await request(app.getHttpServer()).post('/reconcile').expect(200);

    expect(await lots.findBySymbol('TQQQ')).toEqual([]);
  });

  it('leaves the grid strategy trading the symbol', async () => {
    await request(app.getHttpServer())
      .post('/engine/replay')
      .send({ fixture: 'chop-range' })
      .expect(200);

    const response = await request(app.getHttpServer()).get('/grid/lots').expect(200);

    expect(response.body.length).toBeGreaterThan(0);
    expect(response.body.every((lot: { unverified: boolean }) => lot.unverified === false)).toBe(
      true,
    );
  });
});
