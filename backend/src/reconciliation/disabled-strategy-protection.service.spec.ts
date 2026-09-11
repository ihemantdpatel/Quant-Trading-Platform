/**
 * `DisabledStrategyProtectionService` — automatic protective-sell placement
 * for a disabled strategy's real lots.
 *
 * Two concerns, mirroring `post-close-reconcile.spec.ts`'s own split: the
 * **schedule arithmetic** (shared shape with `PostCloseReconcileService`, so
 * lightly re-proven here rather than assumed identical), and the **safety
 * envelope** — an unreachable broker or a strategy that is still enabled
 * must never result in an order this job should not have placed.
 */

import { DateTime } from 'luxon';
import { ET_ZONE } from '../market-data/types';
import { CoordinatorService, StrategySnapshot } from '../strategies/coordinator.service';
import {
  DEFAULT_DISABLED_STRATEGY_PROTECTION_CONFIG,
  DisabledStrategyProtectionService,
  MissingOrderCandidateLike,
  MissingOrderPlacer,
} from './disabled-strategy-protection.service';
import { OrderDiagnosis, OrderDiagnosisService } from './order-diagnosis.service';
import { OrderOnlyReconciler } from './order-reconciler';

const et = (iso: string): DateTime => DateTime.fromISO(iso, { zone: ET_ZONE });

function emptyDiagnosis(overrides: Partial<OrderDiagnosis> = {}): OrderDiagnosis {
  return {
    ranAt: '2025-01-20T16:30:00.000-05:00',
    brokerReachable: true,
    reason: null,
    matched: [],
    unbacked: [],
    orphans: [],
    duplicates: [],
    missing: [],
    skippedSymbols: [],
    ...overrides,
  };
}

function snapshot(id: string, enabled: boolean): StrategySnapshot {
  return { id, enabled, symbols: ['TQQQ'], initialized: enabled, state: null };
}

function harness(
  options: {
    diagnosis?: Partial<OrderDiagnosis>;
    snapshots?: StrategySnapshot[];
    placeResult?: {
      placed: { candidate: MissingOrderCandidateLike; quantity: number; resized: boolean }[];
      declined: { candidate: MissingOrderCandidateLike; reason: string }[];
    };
  } = {},
) {
  const ladderReconcileOrders = jest
    .fn<Promise<{ brokerReachable: boolean; symbols: string[] }>, [string]>()
    .mockResolvedValue({ brokerReachable: true, symbols: ['TQQQ'] });
  const gridReconcileOrders = jest
    .fn<Promise<{ brokerReachable: boolean; symbols: string[] }>, [string]>()
    .mockResolvedValue({ brokerReachable: true, symbols: ['TQQQ'] });

  const diagnose = jest
    .fn<Promise<OrderDiagnosis>, [string]>()
    .mockResolvedValue(emptyDiagnosis(options.diagnosis));

  const snapshots = jest
    .fn<StrategySnapshot[], []>()
    .mockReturnValue(options.snapshots ?? [snapshot('dip-ladder:TQQQ', false)]);

  const placeMissingOrders = jest
    .fn<
      Promise<{
        placed: { candidate: MissingOrderCandidateLike; quantity: number; resized: boolean }[];
        declined: { candidate: MissingOrderCandidateLike; reason: string }[];
      }>,
      [MissingOrderCandidateLike[]]
    >()
    .mockResolvedValue(options.placeResult ?? { placed: [], declined: [] });

  const service = new DisabledStrategyProtectionService(
    { reconcileOrders: ladderReconcileOrders } as unknown as OrderOnlyReconciler,
    { reconcileOrders: gridReconcileOrders } as unknown as OrderOnlyReconciler,
    { diagnose } as unknown as OrderDiagnosisService,
    { snapshots } as unknown as CoordinatorService,
    { placeMissingOrders } as unknown as MissingOrderPlacer,
  );

  jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

  return {
    service,
    ladderReconcileOrders,
    gridReconcileOrders,
    diagnose,
    snapshots,
    placeMissingOrders,
  };
}

const disabledLadderMissingSell = {
  strategyId: 'dip-ladder:TQQQ',
  symbol: 'TQQQ',
  side: 'SELL' as const,
  quantity: 100,
  limitPrice: 99.75,
  reason: 'lot lot-1 is held with no resting sell',
  lotId: 'lot-1',
  rungPrice: 95,
};

describe('nextRunAt', () => {
  it('schedules the delay after today’s close when the day is still young', () => {
    const { service } = harness();

    const next = service.nextRunAt(et('2025-01-20T10:00:00'));

    expect(next.toFormat('yyyy-MM-dd HH:mm')).toBe(
      `2025-01-20 16:${DEFAULT_DISABLED_STRATEGY_PROTECTION_CONFIG.delayMinutesAfterClose}`,
    );
  });

  it('rolls to the next day once this evening’s run has passed', () => {
    const { service } = harness();

    const next = service.nextRunAt(et('2025-01-20T20:00:00'));

    expect(next.toFormat('yyyy-MM-dd')).toBe('2025-01-21');
  });

  it('skips a weekend, landing on Monday', () => {
    const { service } = harness();

    // Friday evening, after that day's run.
    const next = service.nextRunAt(et('2025-01-24T20:00:00'));

    expect(next.weekday).toBe(1);
    expect(next.toFormat('yyyy-MM-dd')).toBe('2025-01-27');
  });
});

describe('runNow', () => {
  it('reconciles both strategies’ orders before diagnosing, so a stale mark is fresh first', async () => {
    const { service, ladderReconcileOrders, gridReconcileOrders, diagnose } = harness();

    await service.runNow(et('2025-01-20T16:30:00'));

    expect(ladderReconcileOrders).toHaveBeenCalledTimes(1);
    expect(gridReconcileOrders).toHaveBeenCalledTimes(1);
    expect(diagnose).toHaveBeenCalledTimes(1);
  });

  it('places nothing when nothing is missing', async () => {
    const { service, placeMissingOrders } = harness({ diagnosis: { missing: [] } });

    await service.runNow(et('2025-01-20T16:30:00'));

    expect(placeMissingOrders).not.toHaveBeenCalled();
  });

  it('places a missing sell for a disabled strategy', async () => {
    const { service, placeMissingOrders } = harness({
      diagnosis: { missing: [disabledLadderMissingSell] },
      snapshots: [snapshot('dip-ladder:TQQQ', false), snapshot('grid:TQQQ', true)],
    });

    await service.runNow(et('2025-01-20T16:30:00'));

    expect(placeMissingOrders).toHaveBeenCalledWith([
      {
        strategyId: 'dip-ladder:TQQQ',
        symbol: 'TQQQ',
        side: 'SELL',
        quantity: 100,
        limitPrice: 99.75,
        reason: 'lot lot-1 is held with no resting sell',
        lotId: 'lot-1',
      },
    ]);
  });

  it('never places for a strategy that is currently enabled', async () => {
    // An enabled strategy already re-rests its own missing orders through
    // the normal bar path — this job's whole reason for existing is the
    // strategy that has none.
    const { service, placeMissingOrders } = harness({
      diagnosis: {
        missing: [{ ...disabledLadderMissingSell, strategyId: 'grid:TQQQ' }],
      },
      snapshots: [snapshot('dip-ladder:TQQQ', false), snapshot('grid:TQQQ', true)],
    });

    await service.runNow(et('2025-01-20T16:30:00'));

    expect(placeMissingOrders).not.toHaveBeenCalled();
  });

  it('never places a BUY, even if one somehow appears in the diagnosis', async () => {
    // Defense in depth: `OrderDiagnosisService`'s own database fallback never
    // produces a BUY for a disabled strategy, but this filter does not trust
    // that alone.
    const { service, placeMissingOrders } = harness({
      diagnosis: {
        missing: [
          {
            strategyId: 'dip-ladder:TQQQ',
            symbol: 'TQQQ',
            side: 'BUY',
            quantity: 0,
            limitPrice: 95,
            reason: 'rung 95.00 is PENDING with no resting buy',
            lotId: null,
            rungPrice: 95,
          },
        ],
      },
    });

    await service.runNow(et('2025-01-20T16:30:00'));

    expect(placeMissingOrders).not.toHaveBeenCalled();
  });

  it('skips placement when the broker is unreachable', async () => {
    const { service, placeMissingOrders } = harness({
      diagnosis: { brokerReachable: false, reason: 'socket closed', missing: [] },
    });

    await service.runNow(et('2025-01-20T16:30:00'));

    expect(placeMissingOrders).not.toHaveBeenCalled();
  });

  it('runs at most once per session date', async () => {
    const { service, diagnose } = harness({ diagnosis: { missing: [] } });

    await service.runNow(et('2025-01-20T16:30:00'));
    await service.runNow(et('2025-01-20T16:31:00'));

    expect(diagnose).toHaveBeenCalledTimes(1);
  });

  it('catches an error rather than letting it escape the timer callback', async () => {
    const { service, diagnose } = harness();
    diagnose.mockRejectedValue(new Error('boom'));

    await expect(service.runNow(et('2025-01-20T16:30:00'))).resolves.toBeUndefined();
  });
});
