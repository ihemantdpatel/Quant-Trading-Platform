/**
 * A registered-but-disabled strategy's real, persisted position must stay
 * visible on the dashboard — the same reasoning as the halted-symbol
 * fallback in `engine.integration.spec.ts`, for a different cause.
 *
 * `initializeAll` only initializes **enabled** strategies at boot, so a
 * disabled strategy's live state is empty by construction — not because it
 * is flat, but because nothing ever populated it this process. A symbol it
 * traded before being switched off does not stop existing just because the
 * strategy is off, and before this fix it rendered as flat: not halted, so
 * outside the halted fallback, and absent from live state, so absent from
 * the live read too.
 *
 * This suite deliberately does **not** call `coordinator.enable`/`disable`
 * in its own setup, unlike the other API integration suites — the point is
 * to exercise the app's actual default boot configuration (the dip ladder
 * disabled, the grid strategy enabled on TQQQ), where this gap is real today.
 */

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../app.module';
import {
  LOT_REPOSITORY,
  LotRepository,
  RUNG_REPOSITORY,
  RungRepository,
} from '../repositories/repository.interfaces';
import { LotStatus } from '../strategies/dip-ladder/lot';
import { RungStatus } from '../strategies/dip-ladder/rung';

jest.setTimeout(120_000);

describe('a disabled strategy stays visible on the dashboard', () => {
  let app: INestApplication;
  let lots: LotRepository;
  let rungs: RungRepository;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    lots = app.get(LOT_REPOSITORY);
    rungs = app.get(RUNG_REPOSITORY);

    // Stands in for a real position the ladder opened in an earlier process,
    // before it was switched off — seeded directly into the database rather
    // than through a replay, since the whole point is that nothing this boot
    // ever ran the ladder to produce it.
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

  it('serves the disabled ladder’s persisted lots on GET /lots, flagged unverified/DISABLED', async () => {
    const response = await request(app.getHttpServer()).get('/lots').expect(200);

    const lot = response.body.find((l: { id: string }) => l.id === 'TQQQ-lot-1');

    expect(lot).toBeDefined();
    expect(lot.unverified).toBe(true);
    expect(lot.unverifiedReason).toBe('DISABLED');
  });

  it('serves the disabled ladder’s persisted rungs on GET /rungs, none of them fireable', async () => {
    const response = await request(app.getHttpServer()).get('/rungs').expect(200);

    const rung = response.body.find((r: { price: number }) => r.price === 95);

    expect(rung).toBeDefined();
    expect(rung.unverified).toBe(true);
    expect(rung.unverifiedReason).toBe('DISABLED');
    // A disabled strategy trades in neither direction — reporting this armed
    // would tell an operator the ladder is live at a price it will never
    // fire at.
    expect(rung.fireable).toBe(false);
  });

  it('does not affect a symbol the enabled strategy actually trades', async () => {
    // The grid strategy is enabled by default and trades the same symbol —
    // the fallback must be scoped to the ladder's own registration, not blot
    // out every reading for TQQQ.
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
