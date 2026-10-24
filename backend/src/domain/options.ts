import { DateTime } from 'luxon';
import { Contract, SecurityType } from './contract';

/** Broker identity survives different strikes/expiries on the same underlying. */
export function contractKey(c: Contract): string {
  return [
    c.symbol,
    c.secType,
    c.currency,
    c.expiry ?? '',
    c.right ?? '',
    c.strike ?? '',
    c.multiplier,
  ].join('|');
}

export interface OptionQuote {
  contract: Contract;
  bid: number;
  ask: number;
  delta: number;
  openInterest: number;
  receivedAt: string;
}

export interface OptionScan {
  symbol: string;
  right: 'P' | 'C';
  minDte: number;
  maxDte: number;
  underlyingPrice: number;
  strikeLimit?: number;
  quotes: OptionQuote[];
}

export function validStandardOption(c: Contract): boolean {
  return (
    c.secType === SecurityType.OPTION &&
    c.currency === 'USD' &&
    c.multiplier === 100 &&
    Number.isFinite(c.strike) &&
    c.strike! > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(c.expiry ?? '') &&
    (c.right === 'P' || c.right === 'C')
  );
}

/** IB liquidHours contains explicit holiday closures and early-close intervals. */
export function liquidSessionOpen(hours: string, zone: string, at: string): boolean {
  const now = DateTime.fromISO(at).setZone(zone);
  return hours.split(';').some((part) => {
    const [start, end] = part.split('-');
    if (!end) return false;
    const from = DateTime.fromFormat(start, 'yyyyMMdd:HHmm', { zone });
    const to = DateTime.fromFormat(end, 'yyyyMMdd:HHmm', { zone });
    return (
      from.isValid &&
      to.isValid &&
      now.toMillis() >= from.toMillis() &&
      now.toMillis() < to.toMillis()
    );
  });
}

/** Sample a useful OTM range rather than scanning only near-ATM one-dollar strikes. */
export function scanStrikes(
  strikes: number[],
  price: number,
  right: 'P' | 'C',
  strikeLimit?: number,
): number[] {
  const eligible = strikes.filter(
    (s) =>
      Number.isFinite(s) &&
      s > 0 &&
      (right === 'P'
        ? s < price && s <= (strikeLimit ?? price)
        : s >= Math.max(price, strikeLimit ?? price)),
  );
  const selected = new Set<number>();
  for (const distance of [0.01, 0.02, 0.03, 0.04, 0.05, 0.075, 0.1, 0.15]) {
    const target =
      right === 'P' ? price * (1 - distance) : Math.max(price * (1 + distance), strikeLimit ?? 0);
    const candidate = eligible
      .slice()
      .sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || a - b)[0];
    if (candidate !== undefined) selected.add(candidate);
  }
  return [...selected];
}
