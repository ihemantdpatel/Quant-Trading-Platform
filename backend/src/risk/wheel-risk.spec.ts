import { optionContract, OptionRight } from '../domain/contract';
import { ExecutionMode } from '../config/execution-mode';
import { RiskManagerService } from './risk-manager.service';
import { buildRiskConfig } from './risk.config';
import { RiskIntent, RiskOutcome, intentNotional, reducesExposure } from './types';
import { withIntentDeployed, NO_CAPITAL_DEPLOYED } from './capital-cap';
const intent: RiskIntent = {
  strategyId: 'wheel',
  symbol: 'QQQ',
  side: 'SELL',
  quantity: 2,
  limitPrice: 2,
  timestamp: '2026-10-23T14:15:00Z',
  reason: 'cash secured put',
  exposureEffect: 'OPEN',
  coverage: { cash: 160000, shares: 100 },
  capitalPerUnit: 50000,
  contract: optionContract({
    symbol: 'QQQ',
    strike: 500,
    expiry: '2026-11-20',
    right: OptionRight.PUT,
  }),
};
const risk = () =>
  new RiskManagerService(buildRiskConfig({ accountEquity: 175000 }), ExecutionMode.PAPER);
describe('wheel risk semantics', () => {
  it('charges strike times multiplier and SELL OPEN consumes capital', () => {
    expect(intentNotional(intent)).toBe(100000);
    expect(reducesExposure(intent)).toBe(false);
    expect(withIntentDeployed(NO_CAPITAL_DEPLOYED, intent, 1).total).toBe(50000);
    expect(reducesExposure({ ...intent, exposureEffect: 'CLOSE' })).toBe(true);
  });
  it('resizes whole contracts under the shared global ceiling', () => {
    const decision = risk().evaluate(intent, {
      deployed: { total: 40000, bySymbol: {}, byStrategy: {} },
      pnl: { realized: 0, unrealized: 0 },
    });
    expect(decision.outcome).toBe(RiskOutcome.RESIZED);
    expect(decision.approvedQuantity).toBe(1);
  });
  it.each([
    { coverage: undefined },
    { coverage: { cash: NaN, shares: 100 } },
    { coverage: { cash: 0, shares: 100 } },
    { coverage: { cash: 100000, shares: NaN } },
    { exposureEffect: undefined },
    { side: 'BUY' as const },
    { capitalPerUnit: 2 },
    { quantity: 0.5 },
    { contract: { ...intent.contract!, multiplier: 10 } },
  ])('refuses ambiguous options %j', (bad) =>
    expect(risk().evaluate({ ...intent, ...bad }).approvedQuantity).toBe(0),
  );
  it.each([NaN, -1, Infinity])('rejects invalid collateral %s', (capitalPerUnit) => {
    expect(
      risk().evaluate({ ...intent, contract: undefined, capitalPerUnit }).approvedQuantity,
    ).toBe(0);
  });
  it('refuses calls without enough owned shares', () => {
    expect(
      risk().evaluate({
        ...intent,
        quantity: 2,
        capitalPerUnit: 0,
        contract: { ...intent.contract!, right: OptionRight.CALL },
      }).approvedQuantity,
    ).toBe(0);
  });
  it('allows covered calls to reuse stock capital already counted by the snapshot', () => {
    expect(
      risk().evaluate({
        ...intent,
        quantity: 1,
        capitalPerUnit: 0,
        contract: { ...intent.contract!, right: OptionRight.CALL },
      }).approvedQuantity,
    ).toBe(1);
  });
});
