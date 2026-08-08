/**
 * Story 7 parameter-edit suite (`stories.md:458`).
 *
 * The four backend tests Story 7 names, all circling one rule: **a parameter
 * edit applies to future rungs only** (`PRD.md:386`). A held lot's exit target
 * is frozen at the parameters in force when it filled, and no endpoint may
 * retarget a filled rung.
 *
 * This is the most dangerous control on the dashboard. The kill switch and mode
 * switch can only ever make the system do *less*; a parameter edit changes how
 * it decides. Getting it wrong means an edit silently moves a live position
 * into or out of an exit condition — which on a 3x ETF with no stop-loss is a
 * realized loss caused by a UI interaction.
 */

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../app.module';
import { Bar, BarSize } from '../market-data/types';
import { CoordinatorService } from '../strategies/coordinator.service';
import { DipLadderStrategy } from '../strategies/dip-ladder/dip-ladder.strategy';
import { LotStatus } from '../strategies/dip-ladder/lot';
import { RungStatus } from '../strategies/dip-ladder/rung';
import { ParameterService } from '../strategies/dip-ladder/parameter.service';
import { DIP_LADDER_SYMBOL } from '../strategies/strategies.module';

jest.setTimeout(120_000);

const LADDER_ID = `dip-ladder:${DIP_LADDER_SYMBOL}`;

/**
 * A regular-session 5-minute bar inside the 09:45–16:00 firing window.
 *
 * Hand-built rather than drawn from a fixture: these tests need price to hit
 * exact rung and target levels on demand, and searching a fixture for a bar
 * that happens to do that would make the assertions depend on fixture data
 * rather than on the rule under test.
 */
function bar(timestamp: string, close: number, open = close): Bar {
  return {
    symbol: DIP_LADDER_SYMBOL,
    barSize: BarSize.FIVE_MIN,
    timestamp,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: 1_000,
  };
}

describe('Story 7: live parameter editing', () => {
  let app: INestApplication;
  let coordinator: CoordinatorService;
  let parameters: ParameterService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    coordinator = app.get(CoordinatorService);
    parameters = app.get(ParameterService);
  });

  afterEach(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  /**
   * Drives bars straight through the ladder strategy.
   *
   * Deliberately bypasses the engine: this suite is about the strategy's own
   * lot and rung state, and the risk manager would resize quantities in ways
   * that are irrelevant to — and would obscure — the frozen-target rule.
   */
  function feed(...bars: Bar[]): void {
    const strategy = coordinator.getStrategy(LADDER_ID) as DipLadderStrategy;
    const state = coordinator.getState(LADDER_ID)!;

    for (const b of bars) {
      strategy.onBar(b, state);
    }
  }

  const ladderState = () => coordinator.getState(LADDER_ID)!;
  const lots = () => DipLadderStrategy.lotsOf(ladderState());
  const rungs = () => DipLadderStrategy.rungsOf(ladderState());

  describe('a held lot keeps the target it filled with', () => {
    it('does not alter the exit target of any currently-held lot', async () => {
      // Open at 100 → bootstrap anchor 100 → first rung 5% below at 95.
      feed(bar('2024-03-04T09:45:00-05:00', 100));
      feed(bar('2024-03-04T09:50:00-05:00', 94));

      const held = lots().filter((lot) => lot.status === LotStatus.HELD);
      expect(held).toHaveLength(1);

      // Target = fill 95.00 + 5% = 99.75, frozen at open.
      const before = held[0];
      expect(before.fillPrice).toBe(95);
      expect(before.exitTarget).toBe(99.75);

      // Double the take-profit. A full recompute would move this lot's target
      // to 99.75 → 104.75 and strand it far above the price that would have
      // exited it.
      const response = await http()
        .post(`/parameters/${LADDER_ID}`)
        .send({ parameters: { takeProfitPercent: 0.1 }, reason: 'widen target' })
        .expect(200);

      expect(response.body.parameters.takeProfitPercent).toBe(0.1);

      const after = lots().find((lot) => lot.id === before.id)!;
      expect(after.exitTarget).toBe(99.75);
      expect(after.fillPrice).toBe(95);

      // The endpoint reports the frozen targets back, so the caller can see it.
      expect(response.body.frozenLotTargets).toContainEqual({
        lotId: before.id,
        exitTarget: 99.75,
      });
    });

    it('exits a held lot at its original target even after the target parameter changes', async () => {
      feed(bar('2024-03-04T09:45:00-05:00', 100));
      feed(bar('2024-03-04T09:50:00-05:00', 94));

      const lot = lots().find((l) => l.status === LotStatus.HELD)!;
      expect(lot.exitTarget).toBe(99.75);

      await http()
        .post(`/parameters/${LADDER_ID}`)
        .send({ parameters: { takeProfitPercent: 0.2 } })
        .expect(200);

      // Price reaches the ORIGINAL target, not the widened one. The lot must
      // still exit — a full recompute would have left it held here.
      feed(bar('2024-03-04T09:55:00-05:00', 99.8));

      const closed = lots().find((l) => l.id === lot.id)!;
      expect(closed.status).toBe(LotStatus.CLOSED);
      expect(closed.exitPrice).toBe(99.75);
    });
  });

  describe('a re-armed rung picks up current parameters on its next fire', () => {
    it('applies the new take-profit to the lot opened after re-arming', async () => {
      feed(bar('2024-03-04T09:45:00-05:00', 100));
      feed(bar('2024-03-04T09:50:00-05:00', 94));

      const first = lots().find((l) => l.status === LotStatus.HELD)!;
      expect(first.rungPrice).toBe(95);
      expect(first.exitTarget).toBe(99.75);

      // Exit it: the rung re-arms at its ORIGINAL price of 95.
      feed(bar('2024-03-04T09:55:00-05:00', 99.8));

      const reArmed = rungs().find((r) => r.price === 95)!;
      expect(reArmed.status).toBe(RungStatus.RE_ARMED);
      expect(reArmed.completedCycles).toBe(1);

      // Now edit, while the rung sits empty and re-armed.
      await http()
        .post(`/parameters/${LADDER_ID}`)
        .send({ parameters: { takeProfitPercent: 0.1 } })
        .expect(200);

      // Fire the same rung again. `lastExitAt` blocks a same-bar re-fire, so
      // this must be a later bar.
      feed(bar('2024-03-04T10:00:00-05:00', 94));

      const second = lots().find((l) => l.status === LotStatus.HELD)!;
      expect(second.id).not.toBe(first.id);
      expect(second.rungPrice).toBe(95);

      // The new lot at the SAME rung price carries the NEW target: 95 + 10%.
      expect(second.exitTarget).toBe(104.5);

      // And the first lot, now closed, still records the old one.
      expect(lots().find((l) => l.id === first.id)!.exitTarget).toBe(99.75);
    });

    it('applies new spacing only to rungs created after the edit', async () => {
      feed(bar('2024-03-04T09:45:00-05:00', 100));
      feed(bar('2024-03-04T09:50:00-05:00', 94));

      // First rung at 5% below the 100 anchor.
      expect(rungs().map((r) => r.price)).toEqual([95]);

      await http()
        .post(`/parameters/${LADDER_ID}`)
        .send({ parameters: { spacingPercent: 0.1 } })
        .expect(200);

      // The ladder extends from the lowest held lot (95) using the NEW 10%
      // spacing → 85.50, not the 90.25 the old 5% would have produced.
      feed(bar('2024-03-04T10:00:00-05:00', 85));

      const prices = rungs()
        .map((r) => r.price)
        .sort((a, b) => b - a);
      expect(prices).toEqual([95, 85.5]);
    });
  });

  describe('full recompute is rejected', () => {
    it.each([
      ['exitTarget', { exitTarget: 120 }],
      ['lots', { lots: [] }],
      ['rungs', { rungs: [] }],
      ['recomputeTargets', { recomputeTargets: true }],
      ['fillPrice', { fillPrice: 90 }],
    ])('refuses to accept %s as an editable parameter', async (name, payload) => {
      const response = await http()
        .post(`/parameters/${LADDER_ID}`)
        .send({ parameters: payload })
        .expect(422);

      expect(response.body.message).toContain('not editable at runtime');
      expect(response.body.message).toContain(name);
      expect(response.body.detail[name]).toBeDefined();
    });

    it('names the frozen-target rule as the reason a retarget is refused', async () => {
      const response = await http()
        .post(`/parameters/${LADDER_ID}`)
        .send({ parameters: { exitTarget: 120 } })
        .expect(422);

      expect(response.body.detail.exitTarget).toContain('full recompute is not permitted');
    });

    it('leaves held lots untouched when an edit is rejected', async () => {
      feed(bar('2024-03-04T09:45:00-05:00', 100));
      feed(bar('2024-03-04T09:50:00-05:00', 94));

      const before = lots().map((l) => ({ id: l.id, exitTarget: l.exitTarget }));

      await http()
        .post(`/parameters/${LADDER_ID}`)
        // A valid field alongside an invalid one: the whole edit must fail, not
        // partially apply.
        .send({ parameters: { takeProfitPercent: 0.1, exitTarget: 120 } })
        .expect(422);

      expect(lots().map((l) => ({ id: l.id, exitTarget: l.exitTarget }))).toEqual(before);
      // The valid field must not have been applied either.
      expect(parameters.parametersOf(LADDER_ID)!.takeProfitPercent).toBe(0.05);
    });

    it('refuses symbolCapital, which is the Story 13 open item and not an HTTP setting', async () => {
      const response = await http()
        .post(`/parameters/${LADDER_ID}`)
        .send({ parameters: { symbolCapital: 250_000 } })
        .expect(422);

      expect(response.body.detail.symbolCapital).toContain('PRD.md:500');

      // And it is genuinely still unset, so the Story 5 assertion still bites.
      expect(parameters.configOf(LADDER_ID)!.symbolCapital).toBe(100_000);

      await http().post('/mode').send({ mode: 'PAPER' }).expect(422);
    });

    it('rejects a value that is the right field but out of range', async () => {
      await http()
        .post(`/parameters/${LADDER_ID}`)
        .send({ parameters: { takeProfitPercent: -0.05 } })
        .expect(422);

      expect(parameters.parametersOf(LADDER_ID)!.takeProfitPercent).toBe(0.05);
    });
  });

  describe('append-only change log', () => {
    it('records every change with old value, new value, and timestamp', async () => {
      await http()
        .post(`/parameters/${LADDER_ID}`)
        .send({ parameters: { takeProfitPercent: 0.08 }, reason: 'wider target in chop' })
        .expect(200);

      const { body } = await http().get('/parameters/changes').expect(200);

      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({
        strategyId: LADDER_ID,
        parameter: 'takeProfitPercent',
        oldValue: 0.05,
        newValue: 0.08,
        reason: 'wider target in chop',
      });
      expect(Date.parse(body[0].timestamp)).not.toBeNaN();
    });

    it('captures the strategy state at the time of the change', async () => {
      feed(bar('2024-03-04T09:45:00-05:00', 100));
      feed(bar('2024-03-04T09:50:00-05:00', 94));

      await http()
        .post(`/parameters/${LADDER_ID}`)
        .send({ parameters: { takeProfitPercent: 0.08 } })
        .expect(200);

      const { body } = await http().get('/parameters/changes').expect(200);
      const recorded = body[0].stateAtChange;

      // One held lot, with the target it had *at that moment*.
      expect(recorded.data.lots).toHaveLength(1);
      expect(recorded.data.lots[0].exitTarget).toBe(99.75);
    });

    it('is append-only: a later edit adds a record and rewrites none', async () => {
      await http()
        .post(`/parameters/${LADDER_ID}`)
        .send({ parameters: { takeProfitPercent: 0.08 } })
        .expect(200);
      await http()
        .post(`/parameters/${LADDER_ID}`)
        .send({ parameters: { takeProfitPercent: 0.06 } })
        .expect(200);

      const { body } = await http().get('/parameters/changes').expect(200);

      expect(body).toHaveLength(2);
      // The first record still says what it always said.
      expect(body[0]).toMatchObject({ oldValue: 0.05, newValue: 0.08 });
      expect(body[1]).toMatchObject({ oldValue: 0.08, newValue: 0.06 });
    });

    it('writes one record per changed field, sharing a change id', async () => {
      await http()
        .post(`/parameters/${LADDER_ID}`)
        .send({ parameters: { takeProfitPercent: 0.08, spacingPercent: 0.07 } })
        .expect(200);

      const { body } = await http().get('/parameters/changes').expect(200);

      expect(body).toHaveLength(2);
      expect(new Set(body.map((c: { changeId: string }) => c.changeId)).size).toBe(1);
      expect(body.map((c: { parameter: string }) => c.parameter).sort()).toEqual([
        'spacingPercent',
        'takeProfitPercent',
      ]);
    });

    it('records nothing when a submitted value matches the current one', async () => {
      await http()
        .post(`/parameters/${LADDER_ID}`)
        .send({ parameters: { takeProfitPercent: 0.05 } })
        .expect(200);

      await http().get('/parameters/changes').expect(200).expect([]);
    });

    it('records nothing when an edit is rejected', async () => {
      await http()
        .post(`/parameters/${LADDER_ID}`)
        .send({ parameters: { exitTarget: 120 } })
        .expect(422);

      await http().get('/parameters/changes').expect(200).expect([]);
    });
  });

  describe('GET /parameters', () => {
    it('lists the editable parameters for the ladder', async () => {
      const { body } = await http().get('/parameters').expect(200);

      expect(body).toHaveLength(1);
      expect(body[0].strategyId).toBe(LADDER_ID);
      expect(body[0].parameters).toMatchObject({
        spacingPercent: 0.05,
        takeProfitPercent: 0.05,
        maxConcurrentRungs: 5,
        escalationFactor: 1,
      });
      // The two values that must never appear on an editable surface.
      expect(body[0].parameters.symbolCapital).toBeUndefined();
      expect(body[0].parameters.symbol).toBeUndefined();
    });

    it('404s for a strategy that carries no ladder parameters', async () => {
      await http().get('/parameters/grid').expect(404);
    });
  });
});
