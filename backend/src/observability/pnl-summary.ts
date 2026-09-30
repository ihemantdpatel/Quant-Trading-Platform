/**
 * Realized P&L summaries for the daily and monthly emails — pure, no I/O.
 *
 * **A trade is one closed grid lot**: its own buy fill paired with its own sell.
 * That is the unit the grid already records, and the only one where "gain" is
 * well-defined without guessing at a pairing. The dip ladder is retired and its
 * `Lot` rows are not read here.
 *
 * **Gross per trade, commissions separately.** A `GridLot` carries no
 * commission, and joining each lot back to its entry and exit `Fill`s would need
 * order ids the lot does not keep. Commissions are therefore summed cash-basis —
 * every fill whose timestamp falls in the period, entries for still-held lots
 * included — and net is gross less that. Exact, if pessimistic on a day that
 * opens more than it closes.
 *
 * Days are ET calendar dates. Timestamps are stored in mixed offsets (`…Z` on
 * older rows, `…-04:00` on newer), so every one is normalized to ET before it is
 * bucketed; comparing the raw strings would file an evening close under the next
 * day.
 */

import { DateTime } from 'luxon';
import { Fill } from '../broker/broker-adapter.interface';
import { ET_ZONE } from '../market-data/types';
import { GridLot, GridLotStatus } from '../strategies/grid/lot';

/** A grid lot with the strategy and symbol its repository row carries. */
export interface AttributedGridLot {
  strategyId: string;
  symbol: string;
  lot: GridLot;
}

export interface TradeRow {
  lotId: string;
  symbol: string;
  strategyId: string;
  quantity: number;
  buyPrice: number;
  sellPrice: number;
  openedAt: string;
  closedAt: string;
  /** `(sellPrice − buyPrice) × quantity`, rounded to cents. */
  gain: number;
}

export interface HeldRow {
  symbol: string;
  strategyId: string;
  lots: number;
  quantity: number;
}

export interface PnlTotals {
  trades: number;
  gross: number;
  commissions: number;
  net: number;
}

export interface DayTotals extends PnlTotals {
  /** ET date, `yyyy-MM-dd`. */
  date: string;
}

export interface StrategyTotals {
  symbol: string;
  strategyId: string;
  trades: number;
  gross: number;
}

export interface DailyPnl {
  date: string;
  trades: TradeRow[];
  totals: PnlTotals;
  held: HeldRow[];
  monthToDate: PnlTotals;
}

export interface PeriodPnl {
  /** Inclusive ET dates, `yyyy-MM-dd`. */
  from: string;
  to: string;
  /** Days with at least one closed trade or commission, ascending. */
  days: DayTotals[];
  byStrategy: StrategyTotals[];
  totals: PnlTotals;
}

export interface PnlInputs {
  lots: AttributedGridLot[];
  fills: Fill[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-\d{2}$/;

/** Rounds to cents; `EPSILON` keeps `1.005` from rounding down. */
export function cents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** The ET calendar date of an ISO timestamp in any offset. */
export function etDateOf(timestamp: string): string {
  const parsed = DateTime.fromISO(timestamp, { setZone: true });

  if (!parsed.isValid) {
    throw new Error(`unparseable timestamp "${timestamp}"`);
  }

  return parsed.setZone(ET_ZONE).toISODate()!;
}

export function isIsoDate(value: string): boolean {
  return ISO_DATE.test(value) && DateTime.fromISO(value, { zone: ET_ZONE }).isValid;
}

export function isIsoMonth(value: string): boolean {
  return ISO_MONTH.test(value) && DateTime.fromISO(`${value}-01`, { zone: ET_ZONE }).isValid;
}

/** First and last ET date of a `yyyy-MM` month. */
export function monthRange(month: string): { from: string; to: string } {
  const start = DateTime.fromISO(`${month}-01`, { zone: ET_ZONE });
  return { from: start.toISODate()!, to: start.endOf('month').toISODate()! };
}

/** Closed trades whose ET close date lies in `[from, to]`, in close order. */
export function tradesBetween(lots: AttributedGridLot[], from: string, to: string): TradeRow[] {
  return lots
    .filter(
      ({ lot }) =>
        lot.status === GridLotStatus.CLOSED && lot.closedAt !== null && lot.exitPrice !== null,
    )
    .map(({ strategyId, symbol, lot }) => ({
      date: etDateOf(lot.closedAt!),
      row: {
        lotId: lot.id,
        symbol,
        strategyId,
        quantity: lot.quantity,
        buyPrice: lot.fillPrice,
        sellPrice: lot.exitPrice!,
        openedAt: lot.openedAt,
        closedAt: lot.closedAt!,
        gain: cents((lot.exitPrice! - lot.fillPrice) * lot.quantity),
      },
    }))
    .filter(({ date }) => date >= from && date <= to)
    .map(({ row }) => row)
    .sort(
      (a, b) =>
        DateTime.fromISO(a.closedAt).toMillis() - DateTime.fromISO(b.closedAt).toMillis() ||
        a.lotId.localeCompare(b.lotId),
    );
}

function commissionsByDate(fills: Fill[], from: string, to: string): Map<string, number> {
  const byDate = new Map<string, number>();

  for (const fill of fills) {
    const date = etDateOf(fill.timestamp);

    if (date >= from && date <= to) {
      byDate.set(date, (byDate.get(date) ?? 0) + fill.commission);
    }
  }

  return byDate;
}

function totalsOf(trades: TradeRow[], commissions: number): PnlTotals {
  // Summing the already-rounded per-trade gains keeps the total equal to the
  // column a reader adds up by eye.
  const gross = cents(trades.reduce((sum, trade) => sum + trade.gain, 0));
  const paid = cents(commissions);
  return { trades: trades.length, gross, commissions: paid, net: cents(gross - paid) };
}

/** Realized P&L over an inclusive ET date range, bucketed by day. */
export function buildPeriodPnl(inputs: PnlInputs, from: string, to: string): PeriodPnl {
  const trades = tradesBetween(inputs.lots, from, to);
  const commissions = commissionsByDate(inputs.fills, from, to);

  const tradesByDate = new Map<string, TradeRow[]>();
  for (const trade of trades) {
    const date = etDateOf(trade.closedAt);
    tradesByDate.set(date, [...(tradesByDate.get(date) ?? []), trade]);
  }

  const dates = [...new Set([...tradesByDate.keys(), ...commissions.keys()])].sort();
  const days = dates.map((date) => ({
    date,
    ...totalsOf(tradesByDate.get(date) ?? [], commissions.get(date) ?? 0),
  }));

  const byKey = new Map<string, StrategyTotals>();
  for (const trade of trades) {
    const existing = byKey.get(trade.strategyId) ?? {
      symbol: trade.symbol,
      strategyId: trade.strategyId,
      trades: 0,
      gross: 0,
    };
    existing.trades += 1;
    existing.gross = cents(existing.gross + trade.gain);
    byKey.set(trade.strategyId, existing);
  }

  const commissionTotal = [...commissions.values()].reduce((sum, value) => sum + value, 0);

  return {
    from,
    to,
    days,
    byStrategy: [...byKey.values()].sort((a, b) => a.strategyId.localeCompare(b.strategyId)),
    totals: totalsOf(trades, commissionTotal),
  };
}

/** One ET day's trades, its held positions, and the month to date. */
export function buildDailyPnl(inputs: PnlInputs, date: string): DailyPnl {
  const day = buildPeriodPnl(inputs, date, date);
  const monthStart = DateTime.fromISO(date, { zone: ET_ZONE }).startOf('month').toISODate()!;

  const heldByStrategy = new Map<string, HeldRow>();
  for (const { strategyId, symbol, lot } of inputs.lots) {
    if (lot.status !== GridLotStatus.HELD) {
      continue;
    }
    const row = heldByStrategy.get(strategyId) ?? { symbol, strategyId, lots: 0, quantity: 0 };
    row.lots += 1;
    row.quantity += lot.quantity;
    heldByStrategy.set(strategyId, row);
  }

  return {
    date,
    trades: tradesBetween(inputs.lots, date, date),
    totals: day.totals,
    held: [...heldByStrategy.values()].sort((a, b) => a.strategyId.localeCompare(b.strategyId)),
    monthToDate: buildPeriodPnl(inputs, monthStart, date).totals,
  };
}
