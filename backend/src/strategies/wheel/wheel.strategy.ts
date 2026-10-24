/**
 * Pure wheel decisions. Bar/tick hooks remain inert; the scheduled runtime
 * supplies immutable option quotes and confirmed ownership to evaluate().
 * Every emitted SELL opens risk and must pass cash/share coverage controls.
 */

import { ScaffoldStrategy } from '../scaffold';
import { JsonValue } from '../types';
import { OrderIntent, OrderType, StrategyContext, StrategyState, TimeInForce } from '../types';
import { OptionQuote, validStandardOption } from '../../domain/options';
import { OptionRight } from '../../domain/contract';
import { WheelConfig } from './config';
import { DateTime } from 'luxon';

export interface WheelEvaluation {
  config: WheelConfig;
  quotes: readonly OptionQuote[];
  underlyingPrice: number;
  ownedShares: number;
  stockCost: number;
  cashAvailable: number;
  hasExposure: boolean;
}

export const WHEEL_STRATEGY_ID = 'wheel';

export enum WheelPhase {
  /** Selling cash-secured puts, holding no shares. */
  CASH_SECURED_PUT = 'CASH_SECURED_PUT',
  /** Put assigned; selling covered calls against the assigned shares. */
  COVERED_CALL = 'COVERED_CALL',
}

export function wheelSessionOpen(at: string): boolean {
  const now = DateTime.fromISO(at).setZone('America/New_York');
  return (
    now.isValid &&
    now.weekday <= 5 &&
    now.hour * 60 + now.minute >= 600 &&
    now.hour * 60 + now.minute < 930
  );
}

export class WheelStrategy extends ScaffoldStrategy {
  readonly id = WHEEL_STRATEGY_ID;

  protected initialData(): Record<string, JsonValue> {
    return { phase: WheelPhase.CASH_SECURED_PUT, assignedShares: 0 };
  }

  evaluate(ctx: StrategyContext, _state: StrategyState): OrderIntent[] {
    const input = ctx.wheel;
    const now = DateTime.fromISO(ctx.now).setZone('America/New_York');
    if (!input || !wheelSessionOpen(ctx.now) || input.hasExposure) return [];
    const { config, ownedShares, stockCost, cashAvailable, underlyingPrice } = input;
    const right = ownedShares >= 100 ? OptionRight.CALL : OptionRight.PUT;
    // Do not start a put cycle against a residual odd lot.
    if (right === OptionRight.PUT && ownedShares !== 0) return [];
    const candidates = input.quotes
      .filter((q) => {
        const c = q.contract;
        const expiry = DateTime.fromISO(c.expiry ?? '', { zone: 'America/New_York' });
        const dte = expiry.startOf('day').diff(now.startOf('day'), 'days').days;
        const age = now.toMillis() - DateTime.fromISO(q.receivedAt).toMillis();
        return (
          validStandardOption(c) &&
          c.symbol === config.symbol &&
          c.right === right &&
          dte >= config.minDte &&
          dte <= config.maxDte &&
          age >= 0 &&
          age <= config.maxQuoteAgeSeconds * 1000 &&
          Number.isFinite(q.bid) &&
          Number.isFinite(q.ask) &&
          q.bid >= config.minPremium &&
          q.ask >= q.bid &&
          (q.ask - q.bid) / q.bid <= config.maxSpreadPercent &&
          Number.isFinite(q.openInterest) &&
          q.openInterest >= config.minOpenInterest &&
          Number.isFinite(q.delta) &&
          (right === OptionRight.PUT ? q.delta < 0 : q.delta > 0) &&
          Math.abs(q.delta) <= config.targetDelta &&
          (right === OptionRight.PUT
            ? c.strike! < underlyingPrice && c.strike! * 100 <= cashAvailable
            : c.strike! >= Math.max(stockCost, underlyingPrice))
        );
      })
      .sort(
        (a, b) =>
          Math.abs(b.delta) - Math.abs(a.delta) ||
          a.contract.expiry!.localeCompare(b.contract.expiry!) ||
          a.contract.strike! - b.contract.strike!,
      );
    const quote = candidates[0];
    if (!quote) return [];
    const quantity = Math.min(
      config.maxContracts,
      right === OptionRight.PUT
        ? Math.floor(cashAvailable / (quote.contract.strike! * 100))
        : Math.floor(ownedShares / 100),
    );
    if (quantity < 1) return [];
    return [
      {
        strategyId: this.id,
        contract: quote.contract,
        side: 'SELL',
        quantity,
        orderType: OrderType.LIMIT,
        limitPrice: quote.bid,
        timeInForce: TimeInForce.DAY,
        timestamp: ctx.now,
        reason: right === OptionRight.PUT ? 'cash-secured wheel put' : 'share-covered wheel call',
        metadata: {
          exposureEffect: 'OPEN',
          collateralPerContract: right === OptionRight.PUT ? quote.contract.strike! * 100 : 0,
        },
      },
    ];
  }
}
