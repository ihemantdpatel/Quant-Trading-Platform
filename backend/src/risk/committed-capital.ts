import { BrokerPosition, OpenOrder } from '../broker/broker-adapter.interface';
import { SecurityType } from '../domain/contract';
import { DeployedCapital } from './capital-cap';

/** Gross commitments: a short premium must never offset stock or put collateral. */
export function committedCapital(
  positions: BrokerPosition[],
  orders: OpenOrder[],
): DeployedCapital {
  const shares: Record<string, number> = {};
  const calls: Record<string, number> = {};
  for (const p of positions) {
    if (p.contract?.secType === SecurityType.OPTION) {
      if (p.contract.right === 'C' && p.quantity < 0)
        calls[p.symbol] = (calls[p.symbol] ?? 0) + Math.abs(p.quantity) * p.contract.multiplier;
    } else shares[p.symbol] = (shares[p.symbol] ?? 0) + p.quantity;
  }
  for (const o of orders) {
    if (o.side !== 'SELL') continue;
    const remaining = Math.max(0, o.quantity - o.filledQuantity);
    if (o.contract?.secType === SecurityType.OPTION) {
      if (o.contract.right === 'C')
        calls[o.symbol] = (calls[o.symbol] ?? 0) + remaining * o.contract.multiplier;
    } else shares[o.symbol] = (shares[o.symbol] ?? 0) - remaining;
  }
  if (
    Object.entries(calls).some(([symbol, required]) => required > Math.max(0, shares[symbol] ?? 0))
  ) {
    throw new Error('uncovered call exposure: cannot establish gross account commitments');
  }
  const bySymbol: Record<string, number> = {};
  const add = (symbol: string, value: number): void => {
    bySymbol[symbol] = (bySymbol[symbol] ?? 0) + value;
  };
  for (const p of positions) {
    const c = p.contract;
    const value =
      c?.secType === SecurityType.OPTION
        ? p.quantity < 0 && c.right === 'P'
          ? Math.abs(p.quantity) * c.strike! * c.multiplier
          : p.quantity > 0
            ? p.quantity * p.averageCost
            : 0
        : Math.abs(p.quantity * p.averageCost);
    add(p.symbol, value);
  }
  for (const o of orders) {
    const remaining = Math.max(0, o.quantity - o.filledQuantity);
    const c = o.contract;
    if (c?.secType === SecurityType.OPTION) {
      if (o.side === 'SELL' && c.right === 'P') add(o.symbol, remaining * c.strike! * c.multiplier);
      if (o.side === 'BUY') add(o.symbol, remaining * o.limitPrice * c.multiplier);
    } else if (o.side === 'BUY') add(o.symbol, remaining * o.limitPrice);
  }
  return { total: Object.values(bySymbol).reduce((a, b) => a + b, 0), bySymbol, byStrategy: {} };
}
