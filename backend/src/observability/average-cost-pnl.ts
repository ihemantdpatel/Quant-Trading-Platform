/**
 * Realized P&L on IB's **average-cost** basis — pure, no I/O.
 *
 * IB keeps one average cost per position: a buy re-averages it, and a sell
 * realizes `(sell − average) × quantity` without changing it. Buy 100 @ 80,
 * 100 @ 79.5, 100 @ 79, sell 100 @ 79.5 → the average is 79.5 and the sell
 * realizes **$0**. Pairing that sell with the grid lot it closed (bought @ 79)
 * would report +$50 — a figure IB never shows and the account never earned.
 * The grid still *trades* per lot; only the reporting follows IB.
 *
 * **Counted by us, from one opening balance.** The `Fill` table has no record
 * of shares bought before it existed, so the first `PositionSnapshot` — IB's
 * own `(quantity, averageCost)` — is taken once as the opening balance. From
 * there every recorded fill moves the average and nothing else does: later
 * snapshots are a **check**, never a reset. Re-anchoring at each snapshot made
 * the figure IB's rather than ours, and quietly absorbed any fill this system
 * had failed to record; now a snapshot whose quantity disagrees with the count
 * is reported (`mismatches`) and the count is left as it is, so a missed fill
 * stays visible until someone records it.
 *
 * Commissions follow IB: a buy's commission is folded into the average, a
 * sell's is subtracted from what it realizes.
 */

import { DateTime } from 'luxon';
import { Fill } from '../broker/broker-adapter.interface';
import { PositionSnapshotRecord } from '../repositories/repository.interfaces';

export interface SellRow {
  fillId: string;
  symbol: string;
  timestamp: string;
  quantity: number;
  price: number;
  /** The position's average cost at the moment of this sell. */
  averageCost: number;
  commission: number;
  /** `(price − averageCost) × covered quantity`, rounded to cents. */
  gross: number;
  /** `gross − commission`. */
  realized: number;
  /**
   * Shares sold beyond the holding the replay knew of — nonzero only when a buy
   * is missing from the record. They realize nothing here rather than a
   * fabricated gain against a cost of zero.
   */
  uncovered: number;
}

/** A snapshot whose quantity disagreed with our count arriving at it. */
export interface BasisMismatch {
  symbol: string;
  takenAt: string;
  replayedQuantity: number;
  brokerQuantity: number;
  /** Our average at that instant, beside IB's, so the two can be compared. */
  replayedAverageCost: number;
  brokerAverageCost: number;
}

export interface Holding {
  symbol: string;
  quantity: number;
  averageCost: number;
}

export interface AverageCostLedger {
  /** The opening balance's time; null when no snapshot exists and nothing is tracked. */
  trackedSince: string | null;
  sells: SellRow[];
  mismatches: BasisMismatch[];
  /** Nonzero positions after the last event replayed, by symbol. */
  holdings: Holding[];
}

/** Rounds to cents; `EPSILON` keeps `1.005` from rounding down. */
export function cents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function millis(timestamp: string): number {
  const parsed = DateTime.fromISO(timestamp, { setZone: true });

  if (!parsed.isValid) {
    throw new Error(`unparseable timestamp "${timestamp}"`);
  }

  return parsed.toMillis();
}

interface Position {
  quantity: number;
  averageCost: number;
}

type LedgerEvent =
  | { kind: 'fill'; at: number; fill: Fill }
  | { kind: 'snapshot'; at: number; takenAt: string; rows: PositionSnapshotRecord[] };

/**
 * Counts fills forward from the opening snapshot, through `until` (inclusive)
 * when given, checking each later snapshot against the count.
 *
 * Fills before the first snapshot are skipped: their starting basis is unknown,
 * and guessing one would report a number IB never computed.
 */
export function buildLedger(
  snapshots: PositionSnapshotRecord[],
  fills: Fill[],
  until?: string,
): AverageCostLedger {
  const limit = until === undefined ? Infinity : millis(until);

  const batches = new Map<string, PositionSnapshotRecord[]>();
  for (const row of snapshots) {
    batches.set(row.takenAt, [...(batches.get(row.takenAt) ?? []), row]);
  }

  const events: LedgerEvent[] = [
    ...[...batches].map(([takenAt, rows]): LedgerEvent => ({
      kind: 'snapshot',
      at: millis(takenAt),
      takenAt,
      rows,
    })),
    ...fills.map((fill): LedgerEvent => ({ kind: 'fill', at: millis(fill.timestamp), fill })),
  ]
    .filter((event) => event.at <= limit)
    // A fill stamped at the snapshot's own instant is already inside IB's
    // answer, so it is applied first and the snapshot then confirms it.
    .sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === 'fill' ? -1 : 1));

  const firstSnapshot = events.find((event) => event.kind === 'snapshot');
  const trackedSince = firstSnapshot?.kind === 'snapshot' ? firstSnapshot.takenAt : null;
  const positions = new Map<string, Position>();
  const sells: SellRow[] = [];
  const mismatches: BasisMismatch[] = [];
  let tracking = false;

  for (const event of events) {
    if (event.kind === 'snapshot') {
      const reported = new Map(event.rows.map((row) => [row.symbol, row]));

      for (const symbol of new Set([...positions.keys(), ...reported.keys()])) {
        // A symbol IB did not list is flat at this instant — the snapshot
        // writer lists every symbol it has seen, so absence is IB's answer.
        const row = reported.get(symbol);
        const brokerQuantity = row?.quantity ?? 0;
        const brokerAverageCost = brokerQuantity === 0 ? 0 : (row?.averageCost ?? 0);

        if (!tracking) {
          positions.set(symbol, { quantity: brokerQuantity, averageCost: brokerAverageCost });
          continue;
        }

        const replayed = positions.get(symbol) ?? { quantity: 0, averageCost: 0 };
        if (replayed.quantity !== brokerQuantity) {
          mismatches.push({
            symbol,
            takenAt: event.takenAt,
            replayedQuantity: replayed.quantity,
            brokerQuantity,
            replayedAverageCost: replayed.averageCost,
            brokerAverageCost,
          });
        }
      }

      tracking = true;
      continue;
    }

    if (!tracking) {
      continue;
    }

    const { fill } = event;
    const position = positions.get(fill.symbol) ?? { quantity: 0, averageCost: 0 };

    if (fill.side === 'BUY') {
      const quantity = position.quantity + fill.quantity;
      positions.set(fill.symbol, {
        quantity,
        averageCost:
          (position.averageCost * position.quantity +
            fill.price * fill.quantity +
            fill.commission) /
          quantity,
      });
      continue;
    }

    const covered = Math.min(fill.quantity, position.quantity);
    const gross = cents((fill.price - position.averageCost) * covered);
    sells.push({
      fillId: fill.fillId,
      symbol: fill.symbol,
      timestamp: fill.timestamp,
      quantity: fill.quantity,
      price: fill.price,
      averageCost: position.averageCost,
      commission: fill.commission,
      gross,
      realized: cents(gross - fill.commission),
      uncovered: fill.quantity - covered,
    });

    const remaining = position.quantity - covered;
    positions.set(fill.symbol, {
      quantity: remaining,
      averageCost: remaining === 0 ? 0 : position.averageCost,
    });
  }

  const holdings = [...positions]
    .filter(([, position]) => position.quantity !== 0)
    .map(([symbol, position]) => ({ symbol, ...position }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  return { trackedSince, sells, mismatches, holdings };
}
