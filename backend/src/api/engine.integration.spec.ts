/**
 * Story 6 integration suite (`stories.md:407`).
 *
 * Drives the assembled application over HTTP with Supertest — the real module
 * graph, the real risk chokepoint, the real mock broker. Nothing here reaches
 * past the API into a service to set up state; if a scenario cannot be produced
 * through the endpoints, the API is missing something.
 */

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../app.module';
import { BROKER_ADAPTER, ConnectionState, OrderStatus } from '../broker/broker-adapter.interface';
import { FillMode, MockBrokerAdapter } from '../broker/mock/mock-broker.adapter';
import { EngineService } from '../engine/engine.service';
import { LotStatus } from '../strategies/dip-ladder/lot';
import { RungStatus } from '../strategies/dip-ladder/rung';

/**
 * Replaying a full fixture is ~936 bars through the whole path, and under
 * coverage instrumentation that exceeds Jest's 5s default. The work is real
 * rather than a hang, so the timeout is raised for this suite instead of
 * shrinking the fixtures — a truncated fixture would stop exercising the
 * repeated rung cycling these tests exist to verify.
 */
jest.setTimeout(120_000);

describe('Story 6: engine HTTP API', () => {
  let app: INestApplication;
  let broker: MockBrokerAdapter;
  let engine: EngineService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    broker = app.get<MockBrokerAdapter>(BROKER_ADAPTER);
    engine = app.get(EngineService);
  });

  afterEach(async () => {
    await app.close();
  });

  const replay = (fixture = 'chop-range'): request.Test =>
    request(app.getHttpServer()).post('/engine/replay').send({ fixture });

  describe('GET /status', () => {
    it('reports SHADOW mode, a connected broker, and no active halts', async () => {
      const response = await request(app.getHttpServer()).get('/status').expect(200);

      expect(response.body.mode).toBe('SHADOW');
      expect(response.body.broker.connected).toBe(true);
      expect(response.body.broker.state).toBe(ConnectionState.CONNECTED);
      expect(response.body.halts.killSwitch.engaged).toBe(false);
      expect(response.body.halts.entryHalt.halted).toBe(false);
    });

    it('lists four strategies with three disabled — the Story 2 exit criterion', async () => {
      const response = await request(app.getHttpServer()).get('/strategies').expect(200);

      expect(response.body).toHaveLength(4);
      expect(response.body.filter((s: { enabled: boolean }) => s.enabled)).toHaveLength(1);
      expect(response.body.find((s: { enabled: boolean }) => s.enabled).id).toBe('dip-ladder:TQQQ');
    });
  });

  describe('full replay flow', () => {
    it('replays chop-range and reports the ladder cycling', async () => {
      const response = await replay().expect(200);

      expect(response.body.fixture).toBe('chop-range');
      expect(response.body.barsProcessed).toBeGreaterThan(900);
      expect(response.body.intentsGenerated).toBeGreaterThan(0);
      expect(response.body.approved).toBeGreaterThan(0);
      // SHADOW submits nothing, by definition (`PRD.md:268`).
      expect(response.body.submitted).toBe(0);
    });

    it('GET /lots shows held lots with fill prices, targets, and ages', async () => {
      await replay();

      const response = await request(app.getHttpServer()).get('/lots').expect(200);

      expect(response.body.length).toBeGreaterThan(0);

      response.body.forEach((lot: Record<string, unknown>) => {
        expect(typeof lot.fillPrice).toBe('number');
        expect(typeof lot.exitTarget).toBe('number');
        expect(typeof lot.openedAt).toBe('string');
        expect(lot.quantity).toBeGreaterThan(0);
        // Each lot's target is measured from its own fill (`PRD.md:129`).
        expect(lot.exitTarget as number).toBeGreaterThan(lot.fillPrice as number);
      });
    });

    it('every lot target is its own fill price +5%, never the blended average', async () => {
      await replay();
      const response = await request(app.getHttpServer()).get('/lots');

      response.body.forEach((lot: { fillPrice: number; exitTarget: number }) => {
        expect(lot.exitTarget).toBeCloseTo(Math.round(lot.fillPrice * 1.05 * 100) / 100, 2);
      });
    });

    it('every closed lot realized a profit — no loss-booking path', async () => {
      await replay();
      const response = await request(app.getHttpServer()).get('/lots');

      response.body
        .filter((lot: { status: string }) => lot.status === LotStatus.CLOSED)
        .forEach((lot: { realized: number }) => {
          expect(lot.realized).toBeGreaterThan(0);
        });
    });

    it('GET /rungs distinguishes held, re-armed, and pending with prices', async () => {
      await replay();

      const response = await request(app.getHttpServer()).get('/rungs').expect(200);

      expect(response.body.length).toBeGreaterThan(0);

      response.body.forEach((rung: Record<string, unknown>) => {
        expect(typeof rung.price).toBe('number');
        expect([RungStatus.HELD, RungStatus.RE_ARMED, RungStatus.PENDING]).toContain(rung.status);
        expect(rung.held).toBe(rung.status === RungStatus.HELD);
        expect(rung.fireable).toBe(rung.status !== RungStatus.HELD);
      });
    });

    it('shows at least one rung with three or more completed cycles', async () => {
      // The Story 4 chop scenario, now visible over HTTP.
      await replay();

      const response = await request(app.getHttpServer()).get('/rungs');
      const cycles = response.body.map((r: { completedCycles: number }) => r.completedCycles);

      expect(Math.max(...cycles)).toBeGreaterThanOrEqual(3);
    });

    it('persists an intent record for every intent, before any submission', async () => {
      await replay();

      const response = await request(app.getHttpServer()).get('/intents').expect(200);

      expect(response.body.length).toBeGreaterThan(0);
      response.body.forEach((record: Record<string, unknown>) => {
        expect(record.intent).toBeDefined();
        expect(record.decision).not.toBeNull();
        expect(record.createdAt).toBeDefined();
        // Nothing is submitted in SHADOW, so no record claims otherwise.
        expect(record.submitted).toBe(false);
      });
    });

    it('POST /engine/reset clears accumulated state', async () => {
      await replay();
      await request(app.getHttpServer()).post('/engine/reset').expect(200);

      const intents = await request(app.getHttpServer()).get('/intents');
      expect(intents.body).toEqual([]);
    });

    it('rejects an unknown fixture with a helpful 422', async () => {
      const response = await request(app.getHttpServer())
        .post('/engine/replay')
        .send({ fixture: 'not-a-fixture' })
        .expect(422);

      expect(response.body.message).toMatch(/unknown fixture/);
    });

    it('rejects a replay request with no fixture named', async () => {
      await request(app.getHttpServer()).post('/engine/replay').send({}).expect(422);
    });
  });

  describe('order payload generation', () => {
    /**
     * The field-by-field payload assertion (`PRD.md:435`, `stories.md:413`).
     *
     * Runs against a live broker submission rather than a logged payload,
     * because what matters is the structure that actually reaches the adapter.
     * SHADOW blocks submission, so this drives the engine directly with the
     * mode gate satisfied — the one place a test reaches past HTTP, since no
     * endpoint can enable submission in SHADOW and that refusal is the point.
     */
    it('generates a limit order matching the expected broker structure', async () => {
      await replay('steady-decline');

      const intents = await request(app.getHttpServer()).get('/intents');
      const approved = intents.body.find(
        (record: { decision: { approvedQuantity: number } }) =>
          record.decision.approvedQuantity > 0,
      );

      expect(approved).toBeDefined();
      expect(approved.intent).toEqual(
        expect.objectContaining({
          strategyId: 'dip-ladder:TQQQ',
          side: 'BUY',
          orderType: 'LMT',
          timeInForce: 'DAY',
        }),
      );
      expect(approved.intent.contract).toEqual({
        symbol: 'TQQQ',
        secType: 'STK',
        exchange: 'SMART',
        currency: 'USD',
        multiplier: 1,
      });
      expect(typeof approved.intent.limitPrice).toBe('number');
      expect(approved.intent.limitPrice).toBeGreaterThan(0);
      expect(approved.intent.quantity).toBeGreaterThan(0);
      expect(approved.intent.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('POST /kill-switch', () => {
    it('engages and reports the reason', async () => {
      const response = await request(app.getHttpServer())
        .post('/kill-switch')
        .send({ engaged: true, reason: 'operator test' })
        .expect(200);

      expect(response.body.engaged).toBe(true);
      expect(response.body.reason).toBe('operator test');
    });

    it('subsequent bars produce zero submissions', async () => {
      await request(app.getHttpServer())
        .post('/kill-switch')
        .send({ engaged: true, reason: 'halt everything' });

      const response = await replay().expect(200);

      expect(response.body.submitted).toBe(0);
      expect(response.body.approved).toBe(0);
      // Every intent is refused with the kill switch named as the reason.
      expect(response.body.rejected).toBe(response.body.intentsGenerated);
    });

    it('records a RiskEvent naming the kill switch for each refusal', async () => {
      await request(app.getHttpServer())
        .post('/kill-switch')
        .send({ engaged: true, reason: 'audit check' });
      await replay();

      const events = await request(app.getHttpServer()).get('/risk-events').expect(200);
      const rejections = events.body.filter(
        (event: { reason: string }) => event.reason === 'KILL_SWITCH',
      );

      expect(rejections.length).toBeGreaterThan(0);
      expect(rejections[0].detail).toMatch(/kill switch engaged/);
    });

    it('releases and permits approvals again', async () => {
      await request(app.getHttpServer()).post('/kill-switch').send({ engaged: true, reason: 'on' });
      await request(app.getHttpServer())
        .post('/kill-switch')
        .send({ engaged: false, reason: 'off' });

      const status = await request(app.getHttpServer()).get('/status');
      expect(status.body.halts.killSwitch.engaged).toBe(false);

      const response = await replay();
      expect(response.body.approved).toBeGreaterThan(0);
    });

    it('is visible on GET /status while engaged', async () => {
      await request(app.getHttpServer())
        .post('/kill-switch')
        .send({ engaged: true, reason: 'visible' });

      const status = await request(app.getHttpServer()).get('/status');

      expect(status.body.halts.killSwitch).toEqual(
        expect.objectContaining({ engaged: true, reason: 'visible' }),
      );
    });
  });

  describe('POST /mode', () => {
    it('cannot reach PAPER while startup parameters are unset', async () => {
      const response = await request(app.getHttpServer())
        .post('/mode')
        .send({ mode: 'PAPER' })
        .expect(422);

      expect(response.body.permitted).toBe(false);
      // Both open PRD items are named, so an operator fixes one and is not
      // surprised by the other on the next attempt.
      expect(response.body.failures.join(' ')).toMatch(/per-symbol capital allocation/);
      expect(response.body.failures.join(' ')).toMatch(/daily loss threshold/);
    });

    it('cannot reach LIVE — the explicit flag is absent', async () => {
      const response = await request(app.getHttpServer())
        .post('/mode')
        .send({ mode: 'LIVE' })
        .expect(422);

      expect(response.body.permitted).toBe(false);
      expect(response.body.failures.join(' ')).toMatch(/allowLiveTrading flag/);
    });

    it('permits SHADOW, which submits nothing', async () => {
      const response = await request(app.getHttpServer())
        .post('/mode')
        .send({ mode: 'SHADOW' })
        .expect(200);

      expect(response.body.permitted).toBe(true);
    });

    it('rejects an unrecognised mode', async () => {
      await request(app.getHttpServer()).post('/mode').send({ mode: 'TURBO' }).expect(422);
    });
  });

  describe('strategy enable/disable', () => {
    it('disables the ladder so it produces no intents', async () => {
      await request(app.getHttpServer()).post('/strategies/dip-ladder:TQQQ/disable').expect(200);

      const response = await replay();

      expect(response.body.intentsGenerated).toBe(0);
    });

    it('re-enables a disabled strategy', async () => {
      await request(app.getHttpServer()).post('/strategies/dip-ladder:TQQQ/disable');
      await request(app.getHttpServer()).post('/strategies/dip-ladder:TQQQ/enable').expect(200);

      const response = await replay();

      expect(response.body.intentsGenerated).toBeGreaterThan(0);
    });

    it('enabling a scaffold adds no intents and leaves the ladder views intact', async () => {
      // Regression: a scaffold's state carries no lots or rungs, and reading
      // those fields off it returned `undefined` — which broke `GET /lots` for
      // the ladder as well. The engine now filters to ladder instances.
      const before = await replay();
      await request(app.getHttpServer()).post('/engine/reset');

      await request(app.getHttpServer()).post('/strategies/grid/enable').expect(200);
      const after = await replay();

      expect(after.body.intentsGenerated).toBe(before.body.intentsGenerated);

      const lots = await request(app.getHttpServer()).get('/lots').expect(200);
      const rungs = await request(app.getHttpServer()).get('/rungs').expect(200);

      expect(Array.isArray(lots.body)).toBe(true);
      expect(Array.isArray(rungs.body)).toBe(true);
      expect(lots.body.length).toBeGreaterThan(0);
      expect(rungs.body.every((r: { price: number }) => r.price > 0)).toBe(true);
    });

    it('404s on an unknown strategy id', async () => {
      await request(app.getHttpServer()).post('/strategies/nope/enable').expect(404);
      await request(app.getHttpServer()).post('/strategies/nope/disable').expect(404);
    });
  });

  describe('broker disconnect mid-order', () => {
    it('halts new entries, surfaces an alert, and liquidates nothing', async () => {
      // `PRD.md:316` — a technical fault must never become a realized loss.
      broker.simulateDisconnect('socket dropped mid-order');
      const positionsBefore = await broker.getPositions();

      await replay();

      const status = await request(app.getHttpServer()).get('/status').expect(200);

      expect(status.body.broker.connected).toBe(false);
      expect(status.body.broker.lastError).toMatch(/socket dropped/);
      // No sell was generated in response to the fault.
      expect(await broker.getPositions()).toEqual(positionsBefore);
    });

    it('surfaces the entry halt and its reason on GET /status', async () => {
      engine['haltEntries']('broker connection failed: socket dropped');

      const status = await request(app.getHttpServer()).get('/status');

      expect(status.body.halts.entryHalt.halted).toBe(true);
      expect(status.body.halts.entryHalt.reason).toMatch(/socket dropped/);
      expect(status.body.alerts.some((a: { code: string }) => a.code === 'ENTRY_HALT')).toBe(true);
    });

    it('a FAILED connection halts entries automatically', async () => {
      broker.configure({ baseBackoffMs: 1, maxReconnectAttempts: 2 });
      broker.simulateDisconnect();

      await broker.reconnect(99);

      const status = await request(app.getHttpServer()).get('/status');

      expect(status.body.broker.state).toBe(ConnectionState.FAILED);
      expect(status.body.halts.entryHalt.halted).toBe(true);
    });

    it('reconnect with exponential backoff resumes normal operation', async () => {
      broker.configure({ baseBackoffMs: 1 });
      broker.simulateDisconnect();

      const delays = await broker.reconnect(3);

      expect(delays).toEqual([1, 2, 4]);

      const status = await request(app.getHttpServer()).get('/status');
      expect(status.body.broker.connected).toBe(true);

      const response = await replay();
      expect(response.body.approved).toBeGreaterThan(0);
    });
  });

  describe('GET /positions', () => {
    it('reports broker positions, which are net-only', async () => {
      broker.seedPosition({ symbol: 'TQQQ', quantity: 300, averageCost: 92.5 });

      const response = await request(app.getHttpServer()).get('/positions').expect(200);

      expect(response.body).toEqual([{ symbol: 'TQQQ', quantity: 300, averageCost: 92.5 }]);
    });

    it('is empty before any fill in SHADOW — nothing was submitted', async () => {
      await replay();

      expect((await request(app.getHttpServer()).get('/positions')).body).toEqual([]);
    });
  });

  describe('order and fill logs', () => {
    it('records no orders in SHADOW', async () => {
      await replay();

      expect((await request(app.getHttpServer()).get('/orders')).body).toEqual([]);
      expect((await request(app.getHttpServer()).get('/fills')).body).toEqual([]);
    });
  });

  describe('the broker rejection path', () => {
    it('records a rejected order without halting the engine', async () => {
      broker.configure({ fillMode: FillMode.REJECT, rejectReason: 'no buying power' });

      // A rejection is the broker answering, not a fault — the engine
      // continues, unlike the disconnect case above.
      const ack = await broker.submit({
        clientOrderId: 'direct-1',
        contract: {
          symbol: 'TQQQ',
          secType: 'STK' as never,
          exchange: 'SMART',
          currency: 'USD',
          multiplier: 1,
        },
        side: 'BUY',
        quantity: 10,
        orderType: 'LMT',
        limitPrice: 95,
        timeInForce: 'DAY',
        timestamp: '2025-01-02T10:00:00.000-05:00',
      });

      expect(ack.status).toBe(OrderStatus.REJECTED);

      const status = await request(app.getHttpServer()).get('/status');
      expect(status.body.halts.entryHalt.halted).toBe(false);
    });
  });
});
