/**
 * `GET/POST /risk-limits` — live editing of `RiskConfig.perSymbolLimits`.
 *
 * The unit-level rules (validation, the audit trail, restore-from-history)
 * are covered by `risk/risk-parameter.service.spec.ts`. What this suite
 * proves is the property that actually matters to an operator: an edit here
 * changes what `RiskManagerService` approves, immediately, with no restart —
 * the same "no matter what the compiled figure said, this is the ceiling in
 * force" guarantee `parameters.integration.spec.ts` proves for the ladder's
 * own config.
 */

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../app.module';
import { PAPER_SYMBOL_CAPITAL } from '../config/capital.config';
import { EMPTY_ACCOUNT, RiskManagerService } from '../risk/risk-manager.service';
import { RiskOutcome, RiskReason } from '../risk/types';
import { DIP_LADDER_SYMBOL } from '../strategies/strategies.module';

describe('live editing of the risk layer per-symbol capital limit', () => {
  let app: INestApplication;
  let riskManager: RiskManagerService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    riskManager = app.get(RiskManagerService);
  });

  afterEach(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  const buyIntent = (quantity: number) => ({
    strategyId: `dip-ladder:${DIP_LADDER_SYMBOL}`,
    symbol: DIP_LADDER_SYMBOL,
    side: 'BUY' as const,
    quantity,
    limitPrice: 100,
    timestamp: '2024-03-04T10:00:00.000-05:00',
    reason: 'test',
  });

  it('reports the compiled figure before any edit', async () => {
    const response = await http().get('/risk-limits').expect(200);

    expect(response.body[DIP_LADDER_SYMBOL]).toBe(PAPER_SYMBOL_CAPITAL[DIP_LADDER_SYMBOL]);
  });

  // 800 shares at $100 = $80,000 notional — past the compiled $40,000 TQQQ
  // allocation, but comfortably under the account-wide global cap (60% of
  // the $175,000 compiled equity = $105,000), so the per-symbol limit is the
  // *sole* binding ceiling and raising it alone is what changes the outcome.
  const REQUESTED_QUANTITY = 800;

  it('resizes a BUY that exceeds the compiled per-symbol limit, naming it as the binding reason', () => {
    const decision = riskManager.evaluate(buyIntent(REQUESTED_QUANTITY), EMPTY_ACCOUNT);

    expect(decision.outcome).toBe(RiskOutcome.RESIZED);
    expect(decision.reason).toBe(RiskReason.PER_SYMBOL_LIMIT);
    expect(decision.approvedQuantity).toBeLessThan(REQUESTED_QUANTITY);
  });

  it('raises the ceiling immediately — no restart, no re-fetch of any config object', async () => {
    const before = riskManager.evaluate(buyIntent(REQUESTED_QUANTITY), EMPTY_ACCOUNT);
    expect(before.approvedQuantity).toBeLessThan(REQUESTED_QUANTITY);

    const response = await http()
      .post(`/risk-limits/${DIP_LADDER_SYMBOL}`)
      .send({ limit: 100_000, reason: 'account funded to a larger balance' })
      .expect(200);

    expect(response.body).toMatchObject({
      symbol: DIP_LADDER_SYMBOL,
      oldValue: PAPER_SYMBOL_CAPITAL[DIP_LADDER_SYMBOL],
      newValue: 100_000,
      changed: true,
    });

    const after = riskManager.evaluate(buyIntent(REQUESTED_QUANTITY), EMPTY_ACCOUNT);
    expect(after.outcome).toBe(RiskOutcome.APPROVED);
    expect(after.approvedQuantity).toBe(REQUESTED_QUANTITY);
  });

  it('records the edit on the append-only audit log', async () => {
    await http()
      .post(`/risk-limits/${DIP_LADDER_SYMBOL}`)
      .send({ limit: 180_000, reason: 'account funded to a larger balance' })
      .expect(200);

    const response = await http().get('/risk-limits/changes').expect(200);

    expect(response.body).toEqual([
      expect.objectContaining({
        symbol: DIP_LADDER_SYMBOL,
        oldValue: PAPER_SYMBOL_CAPITAL[DIP_LADDER_SYMBOL],
        newValue: 180_000,
        reason: 'account funded to a larger balance',
      }),
    ]);
  });

  it('refuses a non-positive limit with a 422, leaving the compiled figure in force', async () => {
    await http().post(`/risk-limits/${DIP_LADDER_SYMBOL}`).send({ limit: -1 }).expect(422);

    const response = await http().get('/risk-limits').expect(200);
    expect(response.body[DIP_LADDER_SYMBOL]).toBe(PAPER_SYMBOL_CAPITAL[DIP_LADDER_SYMBOL]);
  });
});
