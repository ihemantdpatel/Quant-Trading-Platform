/**
 * Realized P&L summaries for the daily and monthly emails and the dashboard —
 * pure, no I/O.
 *
 * **Average cost, by IB's method from our own count** (`average-cost-pnl.ts`). A trade is
 * one SELL fill, realizing `(sell − average cost) × quantity − commission`. It
 * is not one closed grid lot: pairing a sell with the lot it closed reports a
 * gain IB never shows. That makes the figure per **symbol**, across every
 * strategy, since IB keeps one average per position — a per-strategy split of
 * one average would be invented.
 *
 * Buy commissions are inside the average, so `commissions` here are the sells'
 * only; counting buys again would charge them twice.
 *
 * Days are ET calendar dates. Timestamps are stored in mixed offsets (`…Z` on
 * older rows, `…-04:00` on newer), so every one is normalized to ET before it is
 * bucketed; comparing the raw strings would file an evening close under the next
 * day.
 */

import { DateTime } from 'luxon';
import { Fill } from '../broker/broker-adapter.interface';
import { ET_ZONE } from '../market-data/types';
import { PositionSnapshotRecord } from '../repositories/repository.interfaces';
import { BasisMismatch, buildLedger, cents, Holding, SellRow } from './average-cost-pnl';

export { cents };

export interface PnlTotals {
  /** SELL fills realized. */
  trades: number;
  gross: number;
  commissions: number;
  net: number;
}

export interface DayTotals extends PnlTotals {
  /** ET date, `yyyy-MM-dd`. */
  date: string;
}

export interface SymbolTotals {
  symbol: string;
  trades: number;
  net: number;
}

/**
 * How much of a period the average-cost replay can speak for. Nothing before
 * the first IB snapshot is tracked, and an untracked day is reported as such —
 * never as a quiet $0.
 */
export interface Coverage {
  trackedSince: string | null;
  /** False when the whole period ends before tracking began. */
  tracked: boolean;
  /** True when tracking began after the period started. */
  partial: boolean;
}

export interface DailyPnl {
  date: string;
  sells: SellRow[];
  totals: PnlTotals;
  /** Positions at the end of the day, by symbol. */
  held: Holding[];
  monthToDate: PnlTotals;
  coverage: Coverage;
  monthCoverage: Coverage;
  mismatches: BasisMismatch[];
}

export interface PeriodPnl {
  /** Inclusive ET dates, `yyyy-MM-dd`. */
  from: string;
  to: string;
  /** Days with at least one sell, ascending. */
  days: DayTotals[];
  bySymbol: SymbolTotals[];
  totals: PnlTotals;
  coverage: Coverage;
  mismatches: BasisMismatch[];
}

export interface PnlInputs {
  snapshots: PositionSnapshotRecord[];
  fills: Fill[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-\d{2}$/;

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

function endOfEtDay(date: string): string {
  return DateTime.fromISO(date, { zone: ET_ZONE }).endOf('day').toISO()!;
}

function coverageOf(trackedSince: string | null, from: string, to: string): Coverage {
  if (trackedSince === null) {
    return { trackedSince, tracked: false, partial: false };
  }

  const since = DateTime.fromISO(trackedSince, { setZone: true });
  const start = DateTime.fromISO(from, { zone: ET_ZONE }).startOf('day');
  const end = DateTime.fromISO(to, { zone: ET_ZONE }).endOf('day');

  return { trackedSince, tracked: since <= end, partial: since > start && since <= end };
}

function totalsOf(sells: SellRow[]): PnlTotals {
  // Summing the already-rounded per-sell figures keeps each total equal to the
  // column a reader adds up by eye.
  return {
    trades: sells.length,
    gross: cents(sells.reduce((sum, sell) => sum + sell.gross, 0)),
    commissions: cents(sells.reduce((sum, sell) => sum + sell.commission, 0)),
    net: cents(sells.reduce((sum, sell) => sum + sell.realized, 0)),
  };
}

function inRange(timestamp: string, from: string, to: string): boolean {
  const date = etDateOf(timestamp);
  return date >= from && date <= to;
}

/** Realized P&L over an inclusive ET date range, bucketed by day and symbol. */
export function buildPeriodPnl(inputs: PnlInputs, from: string, to: string): PeriodPnl {
  const ledger = buildLedger(inputs.snapshots, inputs.fills, endOfEtDay(to));
  const sells = ledger.sells.filter((sell) => inRange(sell.timestamp, from, to));

  const byDate = new Map<string, SellRow[]>();
  const bySymbol = new Map<string, SellRow[]>();
  for (const sell of sells) {
    const date = etDateOf(sell.timestamp);
    byDate.set(date, [...(byDate.get(date) ?? []), sell]);
    bySymbol.set(sell.symbol, [...(bySymbol.get(sell.symbol) ?? []), sell]);
  }

  return {
    from,
    to,
    days: [...byDate.keys()].sort().map((date) => ({ date, ...totalsOf(byDate.get(date)!) })),
    bySymbol: [...bySymbol.keys()].sort().map((symbol) => {
      const totals = totalsOf(bySymbol.get(symbol)!);
      return { symbol, trades: totals.trades, net: totals.net };
    }),
    totals: totalsOf(sells),
    coverage: coverageOf(ledger.trackedSince, from, to),
    mismatches: ledger.mismatches.filter((m) => inRange(m.takenAt, from, to)),
  };
}

/** One ET day's sells, its closing positions, and the month to date. */
export function buildDailyPnl(inputs: PnlInputs, date: string): DailyPnl {
  const ledger = buildLedger(inputs.snapshots, inputs.fills, endOfEtDay(date));
  const sells = ledger.sells.filter((sell) => etDateOf(sell.timestamp) === date);
  const monthStart = DateTime.fromISO(date, { zone: ET_ZONE }).startOf('month').toISODate()!;
  const month = ledger.sells.filter((sell) => inRange(sell.timestamp, monthStart, date));

  return {
    date,
    sells,
    totals: totalsOf(sells),
    held: ledger.holdings,
    monthToDate: totalsOf(month),
    coverage: coverageOf(ledger.trackedSince, date, date),
    monthCoverage: coverageOf(ledger.trackedSince, monthStart, date),
    mismatches: ledger.mismatches.filter((m) => etDateOf(m.takenAt) === date),
  };
}
