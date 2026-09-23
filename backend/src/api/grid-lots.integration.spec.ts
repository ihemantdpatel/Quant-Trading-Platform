/**
 * `GET /grid/lots` over HTTP — the grid counterpart to the `/lots` coverage
 * in `reports.integration.spec.ts`/`engine.integration.spec.ts`.
 *
 * The current operator default boots the grid strategy enabled on TQQQ and
 * the dip ladder disabled (`engine.module.ts`), so this suite runs the
 * assembled app with **no** strategy overrides — this is the config an
 * operator actually runs today, and the one place that default is exercised
 * over HTTP rather than constructed by hand.
 */

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../app.module';
import { SymbolHaltService } from '../reconciliation/symbol-halt.service';

jest.setTimeout(120_000);

describe('grid strategy: lots over HTTP', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('serves the grid strategy’s own lots, shaped like /lots minus a rung', async () => {
    await request(app.getHttpServer())
      .post('/engine/replay')
      .send({ fixture: 'chop-range' })
      .expect(200);

    const response = await request(app.getHttpServer()).get('/grid/lots').expect(200);

    const lots = response.body as {
      id: string;
      symbol: string;
      fillPrice: number;
      quantity: number;
      openedAt: string;
      exitTarget: number;
      status: string;
      unverified: boolean;
    }[];

    expect(lots.length).toBeGreaterThan(0);
    expect(lots.every((lot) => lot.symbol === 'TQQQ')).toBe(true);
    expect(lots.every((lot) => lot.unverified === false)).toBe(true);
    expect(lots.every((lot) => typeof lot.exitTarget === 'number')).toBe(true);
    // No rung concept at all — the field must not leak through.
    expect(lots.every((lot) => !('rungPrice' in lot))).toBe(true);
  });

  it('reports an empty list rather than failing before anything has traded', async () => {
    const response = await request(app.getHttpServer()).get('/grid/lots').expect(200);

    expect(response.body).toEqual([]);
  });

  /**
   * The grid counterpart to `engine.integration.spec.ts`'s "a halted symbol
   * stays visible on the dashboard" — a halt restores nothing into the grid
   * strategy's live state either, so its lots must come from `GridLot`
   * instead, flagged `unverified`/`HALTED` rather than rendering as flat.
   */
  it('serves the grid strategy’s persisted lots for a halted symbol, flagged unverified/HALTED', async () => {
    await request(app.getHttpServer())
      .post('/engine/replay')
      .send({ fixture: 'chop-range' })
      .expect(200);

    const before = await request(app.getHttpServer()).get('/grid/lots').expect(200);
    expect(before.body.length).toBeGreaterThan(0);

    app
      .get(SymbolHaltService)
      .halt('TQQQ', 'LOT_SUM_MISMATCH', 'test halt', new Date().toISOString());

    const response = await request(app.getHttpServer()).get('/grid/lots').expect(200);

    expect(response.body.length).toBeGreaterThan(0);
    expect(response.body.every((lot: { unverified: boolean }) => lot.unverified === true)).toBe(
      true,
    );
    expect(
      response.body.every((lot: { unverifiedReason: string }) => lot.unverifiedReason === 'HALTED'),
    ).toBe(true);
  });
});
