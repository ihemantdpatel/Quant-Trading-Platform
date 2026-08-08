/**
 * In-memory repository implementations.
 *
 * Real implementations of the Story 6 interfaces, not stubs: the engine, the
 * API, and the Story 7 dashboard all run against these. Story 8 adds Prisma
 * implementations of the *same* interfaces and runs them through the *same*
 * test suite (`stories.md:508`), so these remain the reference behaviour rather
 * than becoming dead code.
 *
 * Two properties are maintained deliberately, because Prisma must reproduce
 * them and a divergence would be a silent recovery bug:
 *
 * - **Everything is stored as a deep copy.** A caller mutating a lot it saved
 *   must not retroactively alter stored state — a database would not permit it,
 *   so neither does this.
 * - **Lots are returned in FIFO order** (`openedAt`, then `id` to break ties),
 *   matching the ordering `lot.ts` defines. Which lot gets sold depends on it.
 */

import { Injectable } from '@nestjs/common';
import { Fill, OrderStatus } from '../../broker/broker-adapter.interface';
import { Bar, BarSize } from '../../market-data/types';
import { RiskEvent, RiskEventSink } from '../../risk/risk-event';
import { Lot, LotStatus } from '../../strategies/dip-ladder/lot';
import { ParameterChange } from '../../strategies/dip-ladder/parameter-change';
import { Rung } from '../../strategies/dip-ladder/rung';
import {
  BacktestRepository,
  BacktestResultRecord,
  BacktestRunRecord,
  BarRepository,
  FillRepository,
  LotRepository,
  OrderIntentRecord,
  OrderIntentRepository,
  OrderRecord,
  OrderRepository,
  ParameterChangeRepository,
  RiskEventRepository,
  RungRepository,
  StrategyStateSnapshotRecord,
  StrategyStateSnapshotRepository,
} from '../repository.interfaces';

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

@Injectable()
export class InMemoryOrderIntentRepository implements OrderIntentRepository {
  private readonly records: OrderIntentRecord[] = [];

  async save(record: OrderIntentRecord): Promise<void> {
    this.records.push(copy(record));
  }

  async findAll(): Promise<OrderIntentRecord[]> {
    return copy(this.records);
  }

  async findBySymbol(symbol: string): Promise<OrderIntentRecord[]> {
    return copy(this.records.filter((r) => r.intent.contract.symbol === symbol));
  }

  async markSubmitted(id: string, clientOrderId: string): Promise<void> {
    const record = this.records.find((r) => r.id === id);

    if (record) {
      record.submitted = true;
      record.clientOrderId = clientOrderId;
    }
  }

  async clear(): Promise<void> {
    this.records.length = 0;
  }
}

@Injectable()
export class InMemoryOrderRepository implements OrderRepository {
  private readonly orders = new Map<string, OrderRecord>();

  async save(order: OrderRecord): Promise<void> {
    this.orders.set(order.clientOrderId, copy(order));
  }

  async updateStatus(
    clientOrderId: string,
    status: OrderStatus,
    rejectReason?: string,
  ): Promise<void> {
    const order = this.orders.get(clientOrderId);

    if (order) {
      order.status = status;
      order.rejectReason = rejectReason ?? order.rejectReason;
    }
  }

  async findAll(): Promise<OrderRecord[]> {
    return copy([...this.orders.values()]);
  }

  async findByClientOrderId(clientOrderId: string): Promise<OrderRecord | null> {
    const order = this.orders.get(clientOrderId);
    return order ? copy(order) : null;
  }

  async clear(): Promise<void> {
    this.orders.clear();
  }
}

@Injectable()
export class InMemoryFillRepository implements FillRepository {
  private readonly fills: Fill[] = [];

  async save(fill: Fill): Promise<void> {
    this.fills.push(copy(fill));
  }

  async findAll(): Promise<Fill[]> {
    return copy(this.fills);
  }

  async findByClientOrderId(clientOrderId: string): Promise<Fill[]> {
    return copy(this.fills.filter((fill) => fill.clientOrderId === clientOrderId));
  }

  async clear(): Promise<void> {
    this.fills.length = 0;
  }
}

@Injectable()
export class InMemoryLotRepository implements LotRepository {
  /** Keyed by symbol, then lot id — a lot is unique within its symbol. */
  private readonly lots = new Map<string, Map<string, Lot>>();

  async save(lot: Lot, symbol: string): Promise<void> {
    const bySymbol = this.lots.get(symbol) ?? new Map<string, Lot>();
    bySymbol.set(lot.id, copy(lot));
    this.lots.set(symbol, bySymbol);
  }

  async saveAll(lots: Lot[], symbol: string): Promise<void> {
    // Replaces the symbol's whole set: the strategy's state is authoritative
    // on lot composition, so a lot absent from it no longer exists.
    this.lots.set(symbol, new Map(lots.map((lot) => [lot.id, copy(lot)])));
  }

  async findAll(): Promise<Lot[]> {
    return fifo([...this.lots.values()].flatMap((bySymbol) => [...bySymbol.values()]));
  }

  async findBySymbol(symbol: string): Promise<Lot[]> {
    return fifo([...(this.lots.get(symbol)?.values() ?? [])]);
  }

  async findHeld(symbol: string): Promise<Lot[]> {
    return (await this.findBySymbol(symbol)).filter((lot) => lot.status === LotStatus.HELD);
  }

  async clear(): Promise<void> {
    this.lots.clear();
  }
}

/**
 * FIFO order: oldest first, ties broken by id so the ordering is total and
 * stable. Mirrors `lot.ts:fifoQueueAtRung` — the two must not diverge, or a
 * restart would change which lot is sold.
 */
function fifo(lots: Lot[]): Lot[] {
  return copy(lots).sort((a, b) =>
    a.openedAt === b.openedAt ? compare(a.id, b.id) : compare(a.openedAt, b.openedAt),
  );
}

function compare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

@Injectable()
export class InMemoryRungRepository implements RungRepository {
  private readonly rungs = new Map<string, Rung[]>();

  async saveAll(rungs: Rung[], symbol: string): Promise<void> {
    this.rungs.set(symbol, copy(rungs));
  }

  async findBySymbol(symbol: string): Promise<Rung[]> {
    return copy(this.rungs.get(symbol) ?? []);
  }

  async findAll(): Promise<Rung[]> {
    return copy([...this.rungs.values()].flat());
  }

  async clear(): Promise<void> {
    this.rungs.clear();
  }
}

/**
 * Cached bars, keyed by `symbol|barSize|timestamp`.
 *
 * A Map keyed on the bar's identity rather than an array, because `saveAll` is
 * an upsert: overlapping gap-fill ranges re-deliver edge bars routinely, and an
 * append would store the same instant twice. The Prisma implementation gets the
 * same property from the `bar_identity` unique constraint.
 */
@Injectable()
export class InMemoryBarRepository implements BarRepository {
  private readonly bars = new Map<string, Bar>();

  async saveAll(bars: Bar[]): Promise<void> {
    for (const bar of bars) {
      this.bars.set(barKey(bar.symbol, bar.barSize, bar.timestamp), copy(bar));
    }
  }

  async findRange(
    symbol: string,
    barSize: BarSize,
    from: string,
    to: string,
    includeSynthetic = false,
  ): Promise<Bar[]> {
    return this.select(symbol, barSize, includeSynthetic)
      .filter((bar) => bar.timestamp >= from && bar.timestamp <= to)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  async findLatest(symbol: string, barSize: BarSize): Promise<Bar | null> {
    const bars = this.select(symbol, barSize, true).sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp),
    );

    return bars.length === 0 ? null : bars[bars.length - 1];
  }

  async findEarliest(symbol: string, barSize: BarSize): Promise<Bar | null> {
    const bars = this.select(symbol, barSize, true).sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp),
    );

    return bars.length === 0 ? null : bars[0];
  }

  async countInRange(symbol: string, barSize: BarSize, from: string, to: string): Promise<number> {
    return (await this.findRange(symbol, barSize, from, to)).length;
  }

  async clear(): Promise<void> {
    this.bars.clear();
  }

  private select(symbol: string, barSize: BarSize, includeSynthetic: boolean): Bar[] {
    return [...this.bars.values()]
      .filter(
        (bar) =>
          bar.symbol === symbol &&
          bar.barSize === barSize &&
          (includeSynthetic || bar.synthetic !== true),
      )
      .map((bar) => copy(bar));
  }
}

function barKey(symbol: string, barSize: BarSize, timestamp: string): string {
  return `${symbol}|${barSize}|${timestamp}`;
}

/**
 * Also implements `RiskEventSink`, so the risk manager writes straight through
 * to the repository the API serves.
 *
 * Doing this here rather than adding an adapter class keeps a single object as
 * both the write path and the read path: an event the risk manager emitted is
 * visible on `GET /risk-events` with no synchronization step that could be
 * skipped. `emit` is deliberately synchronous — it is the sink interface the
 * risk manager already depends on, and making the chokepoint await a write
 * would put I/O latency inside a risk decision.
 */
/**
 * Append-only parameter change log.
 *
 * `append` copies on write and `findAll` copies on read, so a caller holding a
 * returned record cannot mutate the stored one. That matters more here than
 * elsewhere: this repository *is* the audit trail, and an audit trail a caller
 * can edit by reference is not one.
 *
 * Records are returned in insertion order — the order the edits happened, which
 * is what makes the log readable as a history.
 */
@Injectable()
export class InMemoryParameterChangeRepository implements ParameterChangeRepository {
  private readonly changes: ParameterChange[] = [];

  async append(change: ParameterChange): Promise<void> {
    // Rejects a duplicate id rather than appending a second record for it.
    // MySQL enforces this with a primary key at Story 8, and the shared
    // contract suite asserts it for both implementations — an append-only log
    // that silently accepts a rewritten record is not one.
    if (this.changes.some((existing) => existing.id === change.id)) {
      throw new Error(`ParameterChange ${change.id} already exists — the log is append-only`);
    }

    this.changes.push(copy(change));
  }

  async findAll(): Promise<ParameterChange[]> {
    return copy(this.changes);
  }

  async findByStrategy(strategyId: string): Promise<ParameterChange[]> {
    return copy(this.changes.filter((change) => change.strategyId === strategyId));
  }

  async clear(): Promise<void> {
    this.changes.length = 0;
  }
}

@Injectable()
export class InMemoryRiskEventRepository implements RiskEventRepository, RiskEventSink {
  private readonly events: RiskEvent[] = [];

  emit(event: RiskEvent): void {
    this.events.push(copy(event));
  }

  async save(event: RiskEvent): Promise<void> {
    this.events.push(copy(event));
  }

  async findAll(): Promise<RiskEvent[]> {
    return copy(this.events);
  }

  async clear(): Promise<void> {
    this.events.length = 0;
  }
}

/**
 * Strategy state snapshots, newest last.
 *
 * Append-only in the same sense the Prisma table is: `save` adds a row rather
 * than replacing one, so a snapshot written mid-crash does not destroy the last
 * good one. `findLatest` reads from the end.
 */
@Injectable()
export class InMemoryStrategyStateSnapshotRepository implements StrategyStateSnapshotRepository {
  private readonly snapshots: StrategyStateSnapshotRecord[] = [];

  async save(snapshot: StrategyStateSnapshotRecord): Promise<void> {
    this.snapshots.push(copy(snapshot));
  }

  async findLatest(strategyId: string): Promise<StrategyStateSnapshotRecord | null> {
    // Newest by `capturedAt`, **not** by insertion order. Those differ whenever
    // snapshots are written out of chronological order, which recovery does:
    // a restart can save a fresh snapshot while an older one from the crashed
    // process is still the last row. Prisma sorts on the same column, and the
    // shared suite fails if these two disagree.
    //
    // Ties break toward the later insertion — the Prisma side breaks them on a
    // descending autoincrement id, which is the same rule.
    let latest: StrategyStateSnapshotRecord | null = null;

    for (const snapshot of this.snapshots) {
      if (snapshot.strategyId !== strategyId) {
        continue;
      }

      if (latest === null || snapshot.capturedAt >= latest.capturedAt) {
        latest = snapshot;
      }
    }

    return latest === null ? null : copy(latest);
  }

  async findAll(strategyId: string): Promise<StrategyStateSnapshotRecord[]> {
    return copy(this.snapshots.filter((snapshot) => snapshot.strategyId === strategyId));
  }

  async clear(): Promise<void> {
    this.snapshots.length = 0;
  }
}

/**
 * Backtest runs and their metrics (Story 11).
 *
 * `saveResults` **replaces** the metrics for a run rather than appending, so
 * re-persisting a run that was recomputed cannot leave two contradictory values
 * for the same metric. The Prisma side gets the same property from the
 * `(runId, metric)` unique constraint, and the shared suite asserts it on both.
 */
@Injectable()
export class InMemoryBacktestRepository implements BacktestRepository {
  private readonly runs: BacktestRunRecord[] = [];
  private readonly results: BacktestResultRecord[] = [];

  async saveRun(run: BacktestRunRecord): Promise<void> {
    const index = this.runs.findIndex((existing) => existing.id === run.id);

    if (index >= 0) {
      this.runs[index] = copy(run);
      return;
    }

    this.runs.push(copy(run));
  }

  async saveResults(results: BacktestResultRecord[]): Promise<void> {
    for (const result of results) {
      const index = this.results.findIndex(
        (existing) => existing.runId === result.runId && existing.metric === result.metric,
      );

      if (index >= 0) {
        this.results[index] = copy(result);
        continue;
      }

      this.results.push(copy(result));
    }
  }

  async findRun(id: string): Promise<BacktestRunRecord | null> {
    const run = this.runs.find((existing) => existing.id === id);

    return run ? copy(run) : null;
  }

  async findAllRuns(): Promise<BacktestRunRecord[]> {
    // Newest first — a sweep produces many runs and the most recent is the one
    // an operator is looking for.
    return copy([...this.runs].sort((a, b) => compareDesc(a.createdAt, b.createdAt)));
  }

  async findResults(runId: string): Promise<BacktestResultRecord[]> {
    return copy(this.results.filter((result) => result.runId === runId));
  }

  async clear(): Promise<void> {
    this.runs.length = 0;
    this.results.length = 0;
  }
}

function compareDesc(a: string, b: string): number {
  if (a < b) return 1;
  if (a > b) return -1;
  return 0;
}
