/**
 * Prisma implementations of the Story 6 repository interfaces.
 *
 * These implement the **same** interfaces as the in-memory repositories and are
 * exercised by the **same** test suite (`repository-contract.suite.ts`), which
 * is what makes the swap at `stories.md:508` a claim rather than a hope. Two
 * properties the in-memory versions maintain by hand are reproduced here
 * because a divergence would be a silent recovery bug:
 *
 * - **Deep-copy isolation** comes free: rows are materialised fresh on every
 *   read, so a caller mutating a returned object cannot reach stored state.
 *   That was the in-memory implementation *imitating a database*; here it is
 *   simply what a database does.
 * - **FIFO lot ordering** does not come free. It is an explicit
 *   `ORDER BY openedAt, id` — ties broken by id so the ordering is total, since
 *   one bar can fill two rungs and an unstable order would change which lot is
 *   sold after a restart.
 *
 * ## On `upsert` rather than `create`
 *
 * Saves are idempotent by id. The engine persists ladder state by rewriting the
 * current set (`engine.service.ts:persistLadderState`), and a crash-and-replay
 * must not fail on a primary-key collision for a row whose content is
 * identical. Recovery that throws on retry is not recovery.
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Fill, OrderStatus } from '../../broker/broker-adapter.interface';
import { Bar, BarSize } from '../../market-data/types';
import { RiskEvent, RiskEventType } from '../../risk/risk-event';
import { RiskDecision, RiskIntent, RiskReason } from '../../risk/types';
import { Lot, LotStatus } from '../../strategies/dip-ladder/lot';
import { EditableParameter, ParameterChange } from '../../strategies/dip-ladder/parameter-change';
import { Rung, RungStatus } from '../../strategies/dip-ladder/rung';
import { JsonValue, OrderIntent, StrategyState } from '../../strategies/types';
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
import { toDecimal, toDecimalOrNull, toNumber, toNumberOrNull } from './decimal';
import { PrismaService } from './prisma.service';

/**
 * Prisma types `Json` columns as `JsonValue | null` and rejects `undefined`.
 * These two helpers are the only place that impedance mismatch is handled, so
 * the mapping functions below stay readable.
 */
function toJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function fromJson<T>(value: Prisma.JsonValue): T {
  return value as T;
}

@Injectable()
export class PrismaOrderIntentRepository implements OrderIntentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async save(record: OrderIntentRecord): Promise<void> {
    const intent = record.intent;

    // The whole intent is stored as JSON *and* its queried fields as columns.
    // The duplication is deliberate: `findBySymbol` must be an indexed lookup
    // rather than a JSON scan, while the record still replays exactly —
    // including `contract` and `metadata`, which no column models.
    const data = {
      strategyId: intent.strategyId,
      symbol: intent.contract.symbol,
      side: intent.side,
      quantity: intent.quantity,
      orderType: intent.orderType,
      limitPrice: toDecimal(intent.limitPrice),
      timeInForce: intent.timeInForce,
      timestamp: intent.timestamp,
      reason: intent.reason,
      intent: toJson(intent),
      decision: record.decision === null ? Prisma.DbNull : toJson(record.decision),
      submitted: record.submitted,
      clientOrderId: record.clientOrderId,
      createdAt: record.createdAt,
    };

    await this.prisma.orderIntent.upsert({
      where: { id: record.id },
      create: { id: record.id, ...data },
      update: data,
    });
  }

  async findAll(): Promise<OrderIntentRecord[]> {
    // Ordered by the insertion-ordered `createdAt` then id: the in-memory
    // implementation returns insertion order, and the shared suite asserts it.
    const rows = await this.prisma.orderIntent.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    return rows.map(toIntentRecord);
  }

  async findBySymbol(symbol: string): Promise<OrderIntentRecord[]> {
    const rows = await this.prisma.orderIntent.findMany({
      where: { symbol },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    return rows.map(toIntentRecord);
  }

  async markSubmitted(id: string, clientOrderId: string): Promise<void> {
    // `updateMany` rather than `update`: the interface specifies that marking
    // an unknown id is a no-op, not a throw (the in-memory version simply finds
    // nothing). `update` would raise P2025 on a missing row.
    await this.prisma.orderIntent.updateMany({
      where: { id },
      data: { submitted: true, clientOrderId },
    });
  }

  async clear(): Promise<void> {
    await this.prisma.orderIntent.deleteMany();
  }
}

function toIntentRecord(row: {
  id: string;
  intent: Prisma.JsonValue;
  decision: Prisma.JsonValue | null;
  submitted: boolean;
  clientOrderId: string | null;
  createdAt: string;
}): OrderIntentRecord {
  return {
    id: row.id,
    intent: fromJson<OrderIntent>(row.intent),
    decision: row.decision === null ? null : fromJson<RiskDecision>(row.decision),
    submitted: row.submitted,
    clientOrderId: row.clientOrderId,
    createdAt: row.createdAt,
  };
}

@Injectable()
export class PrismaOrderRepository implements OrderRepository {
  constructor(private readonly prisma: PrismaService) {}

  async save(order: OrderRecord): Promise<void> {
    const data = {
      brokerOrderId: order.brokerOrderId,
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity,
      limitPrice: toDecimal(order.limitPrice),
      status: order.status,
      rejectReason: order.rejectReason,
      strategyId: order.strategyId,
      createdAt: order.createdAt,
    };

    await this.prisma.order.upsert({
      where: { clientOrderId: order.clientOrderId },
      create: { clientOrderId: order.clientOrderId, ...data },
      update: data,
    });
  }

  async updateStatus(
    clientOrderId: string,
    status: OrderStatus,
    rejectReason?: string,
  ): Promise<void> {
    // Matches the in-memory contract exactly: an omitted reason **preserves**
    // the existing one rather than nulling it, so a later CANCELLED does not
    // erase the reason the order was REJECTED for.
    await this.prisma.order.updateMany({
      where: { clientOrderId },
      data: rejectReason === undefined ? { status } : { status, rejectReason },
    });
  }

  async findAll(): Promise<OrderRecord[]> {
    const rows = await this.prisma.order.findMany({
      orderBy: [{ createdAt: 'asc' }, { clientOrderId: 'asc' }],
    });

    return rows.map(toOrderRecord);
  }

  async findByClientOrderId(clientOrderId: string): Promise<OrderRecord | null> {
    const row = await this.prisma.order.findUnique({ where: { clientOrderId } });

    return row === null ? null : toOrderRecord(row);
  }

  async clear(): Promise<void> {
    await this.prisma.order.deleteMany();
  }
}

function toOrderRecord(row: {
  clientOrderId: string;
  brokerOrderId: string | null;
  symbol: string;
  side: string;
  quantity: number;
  limitPrice: Prisma.Decimal;
  status: string;
  rejectReason: string | null;
  strategyId: string;
  createdAt: string;
}): OrderRecord {
  return {
    clientOrderId: row.clientOrderId,
    brokerOrderId: row.brokerOrderId,
    symbol: row.symbol,
    side: row.side as OrderRecord['side'],
    quantity: row.quantity,
    limitPrice: toNumber(row.limitPrice),
    status: row.status as OrderStatus,
    rejectReason: row.rejectReason,
    strategyId: row.strategyId,
    createdAt: row.createdAt,
  };
}

@Injectable()
export class PrismaFillRepository implements FillRepository {
  constructor(private readonly prisma: PrismaService) {}

  async save(fill: Fill): Promise<void> {
    const data = {
      clientOrderId: fill.clientOrderId,
      brokerOrderId: fill.brokerOrderId,
      symbol: fill.symbol,
      side: fill.side,
      quantity: fill.quantity,
      price: toDecimal(fill.price),
      commission: toDecimal(fill.commission),
      timestamp: fill.timestamp,
    };

    await this.prisma.fill.upsert({
      where: { fillId: fill.fillId },
      create: { fillId: fill.fillId, ...data },
      update: data,
    });
  }

  async findAll(): Promise<Fill[]> {
    const rows = await this.prisma.fill.findMany({
      orderBy: [{ timestamp: 'asc' }, { fillId: 'asc' }],
    });

    return rows.map(toFill);
  }

  async findByClientOrderId(clientOrderId: string): Promise<Fill[]> {
    const rows = await this.prisma.fill.findMany({
      where: { clientOrderId },
      orderBy: [{ timestamp: 'asc' }, { fillId: 'asc' }],
    });

    return rows.map(toFill);
  }

  async findByFillId(fillId: string): Promise<Fill | null> {
    // `fillId` is the primary key (`schema.prisma:127`), so this is a point
    // lookup — it sits on the fill path and runs once per execution IB reports.
    const row = await this.prisma.fill.findUnique({ where: { fillId } });

    return row ? toFill(row) : null;
  }

  async clear(): Promise<void> {
    await this.prisma.fill.deleteMany();
  }
}

function toFill(row: {
  clientOrderId: string;
  brokerOrderId: string | null;
  fillId: string;
  symbol: string;
  side: string;
  quantity: number;
  price: Prisma.Decimal;
  commission: Prisma.Decimal;
  timestamp: string;
}): Fill {
  return {
    clientOrderId: row.clientOrderId,
    // The domain type declares this non-null; the column is nullable only
    // because a fill can be recorded before the broker id is known.
    brokerOrderId: row.brokerOrderId ?? '',
    fillId: row.fillId,
    symbol: row.symbol,
    side: row.side as Fill['side'],
    quantity: row.quantity,
    price: toNumber(row.price),
    commission: toNumber(row.commission),
    timestamp: row.timestamp,
  };
}

@Injectable()
export class PrismaLotRepository implements LotRepository {
  constructor(private readonly prisma: PrismaService) {}

  async save(lot: Lot, symbol: string): Promise<void> {
    const data = lotData(lot, symbol);

    await this.prisma.lot.upsert({
      where: { id: lot.id },
      create: { id: lot.id, ...data },
      update: data,
    });
  }

  /**
   * Replaces the symbol's whole set.
   *
   * In a **transaction**, because this is a delete-then-insert: a crash between
   * the two would leave the ladder with no lots at all, which Story 9 would
   * read as "the DB says flat" against a broker reporting a real position —
   * turning a clean restart into a halted symbol. Atomicity is what keeps the
   * two statements from being observable separately.
   */
  async saveAll(lots: Lot[], symbol: string): Promise<void> {
    const ids = lots.map((lot) => lot.id);

    await this.prisma.$transaction([
      // A lot absent from the strategy's state no longer exists: the strategy
      // is authoritative on lot composition (`in-memory.repositories.ts:140`).
      this.prisma.lot.deleteMany({
        where: ids.length === 0 ? { symbol } : { symbol, id: { notIn: ids } },
      }),
      ...lots.map((lot) => {
        const data = lotData(lot, symbol);
        return this.prisma.lot.upsert({
          where: { id: lot.id },
          create: { id: lot.id, ...data },
          update: data,
        });
      }),
    ]);
  }

  async findAll(): Promise<Lot[]> {
    const rows = await this.prisma.lot.findMany({ orderBy: FIFO_ORDER });

    return rows.map(toLot);
  }

  async findBySymbol(symbol: string): Promise<Lot[]> {
    const rows = await this.prisma.lot.findMany({ where: { symbol }, orderBy: FIFO_ORDER });

    return rows.map(toLot);
  }

  async findHeld(symbol: string): Promise<Lot[]> {
    const rows = await this.prisma.lot.findMany({
      where: { symbol, status: LotStatus.HELD },
      orderBy: FIFO_ORDER,
    });

    return rows.map(toLot);
  }

  async clear(): Promise<void> {
    await this.prisma.lot.deleteMany();
  }
}

/**
 * FIFO: oldest first, ties broken by id.
 *
 * Mirrors `lot.ts:fifoQueueAtRung` and the in-memory `fifo()`. All three must
 * agree — which lot gets sold depends on it, and a restart that changed the
 * answer would sell the wrong lot at the wrong target.
 */
const FIFO_ORDER: Prisma.LotOrderByWithRelationInput[] = [{ openedAt: 'asc' }, { id: 'asc' }];

function lotData(lot: Lot, symbol: string) {
  return {
    symbol,
    rungPrice: toDecimal(lot.rungPrice),
    fillPrice: toDecimal(lot.fillPrice),
    quantity: lot.quantity,
    openedAt: lot.openedAt,
    exitTarget: toDecimal(lot.exitTarget),
    status: lot.status,
    closedAt: lot.closedAt,
    exitPrice: toDecimalOrNull(lot.exitPrice),
  };
}

function toLot(row: {
  id: string;
  rungPrice: Prisma.Decimal;
  fillPrice: Prisma.Decimal;
  quantity: number;
  openedAt: string;
  exitTarget: Prisma.Decimal;
  status: string;
  closedAt: string | null;
  exitPrice: Prisma.Decimal | null;
}): Lot {
  return {
    id: row.id,
    rungPrice: toNumber(row.rungPrice),
    fillPrice: toNumber(row.fillPrice),
    quantity: row.quantity,
    openedAt: row.openedAt,
    exitTarget: toNumber(row.exitTarget),
    status: row.status as LotStatus,
    closedAt: row.closedAt,
    exitPrice: toNumberOrNull(row.exitPrice),
  };
}

@Injectable()
export class PrismaRungRepository implements RungRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Transactional for the same reason as `PrismaLotRepository.saveAll`: a
   * half-written rung set would lose the levels that re-arming depends on. */
  async saveAll(rungs: Rung[], symbol: string): Promise<void> {
    const prices = rungs.map((rung) => toDecimal(rung.price));

    await this.prisma.$transaction([
      this.prisma.rung.deleteMany({
        where: prices.length === 0 ? { symbol } : { symbol, price: { notIn: prices } },
      }),
      ...rungs.map((rung) => {
        const data = {
          status: rung.status,
          lotId: rung.lotId,
          workingOrderId: rung.workingOrderId,
          completedCycles: rung.completedCycles,
          lastExitAt: rung.lastExitAt,
        };

        return this.prisma.rung.upsert({
          // A rung is identified by its level within a symbol — the composite
          // key that makes "this level already holds a lot" answerable.
          where: { symbol_price: { symbol, price: toDecimal(rung.price) } },
          create: { symbol, price: toDecimal(rung.price), ...data },
          update: data,
        });
      }),
    ]);
  }

  async findBySymbol(symbol: string): Promise<Rung[]> {
    const rows = await this.prisma.rung.findMany({
      where: { symbol },
      orderBy: { price: 'desc' },
    });

    return rows.map(toRung);
  }

  async findAll(): Promise<Rung[]> {
    const rows = await this.prisma.rung.findMany({
      orderBy: [{ symbol: 'asc' }, { price: 'desc' }],
    });

    return rows.map(toRung);
  }

  async clear(): Promise<void> {
    await this.prisma.rung.deleteMany();
  }
}

function toRung(row: {
  price: Prisma.Decimal;
  status: string;
  lotId: string | null;
  workingOrderId: string | null;
  completedCycles: number;
  lastExitAt: string | null;
}): Rung {
  return {
    price: toNumber(row.price),
    status: row.status as RungStatus,
    lotId: row.lotId,
    workingOrderId: row.workingOrderId,
    completedCycles: row.completedCycles,
    lastExitAt: row.lastExitAt,
  };
}

/**
 * Cached bars — the store that makes IB's pacing limits survivable
 * (`PRD.md:293`).
 *
 * Two details carry weight:
 *
 * - **`saveAll` upserts on `bar_identity`.** Gap-fill ranges overlap at their
 *   edges deliberately (a boundary bar is safer re-fetched than missed), so
 *   re-ingesting one must be a no-op. The unique constraint is what guarantees
 *   it at the database rather than in application logic that could be bypassed.
 * - **`instrumentId` is resolved, not assumed.** A backfill for a symbol the
 *   seed never inserted — QQQ, needed only for the synthetic series — would
 *   otherwise fail on the foreign key. Creating it on demand keeps the FK
 *   meaningful without making the seed a prerequisite for ingesting data.
 */
@Injectable()
export class PrismaBarRepository implements BarRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** `symbol` → instrument id, so a long backfill resolves the FK once. */
  private readonly instrumentIds = new Map<string, number>();

  async saveAll(bars: Bar[]): Promise<void> {
    if (bars.length === 0) {
      return;
    }

    for (const bar of bars) {
      const instrumentId = await this.instrumentId(bar.symbol);
      const data = {
        open: toDecimal(bar.open),
        high: toDecimal(bar.high),
        low: toDecimal(bar.low),
        close: toDecimal(bar.close),
        volume: BigInt(Math.round(bar.volume)),
        synthetic: bar.synthetic === true,
      };

      await this.prisma.bar.upsert({
        where: {
          bar_identity: { symbol: bar.symbol, barSize: bar.barSize, timestamp: bar.timestamp },
        },
        create: {
          instrumentId,
          symbol: bar.symbol,
          barSize: bar.barSize,
          timestamp: bar.timestamp,
          ...data,
        },
        update: data,
      });
    }
  }

  async findRange(
    symbol: string,
    barSize: BarSize,
    from: string,
    to: string,
    includeSynthetic = false,
  ): Promise<Bar[]> {
    const rows = await this.prisma.bar.findMany({
      where: {
        symbol,
        barSize,
        timestamp: { gte: from, lte: to },
        // Real bars only unless asked otherwise: a synthetic series is
        // approximate and optimistic, and must never be mixed in silently
        // (`stories.md:619`).
        ...(includeSynthetic ? {} : { synthetic: false }),
      },
      orderBy: { timestamp: 'asc' },
    });

    return rows.map(toBar);
  }

  async findLatest(symbol: string, barSize: BarSize): Promise<Bar | null> {
    const row = await this.prisma.bar.findFirst({
      where: { symbol, barSize },
      orderBy: { timestamp: 'desc' },
    });

    return row === null ? null : toBar(row);
  }

  async findEarliest(symbol: string, barSize: BarSize): Promise<Bar | null> {
    const row = await this.prisma.bar.findFirst({
      where: { symbol, barSize },
      orderBy: { timestamp: 'asc' },
    });

    return row === null ? null : toBar(row);
  }

  async countInRange(symbol: string, barSize: BarSize, from: string, to: string): Promise<number> {
    return this.prisma.bar.count({
      where: { symbol, barSize, timestamp: { gte: from, lte: to }, synthetic: false },
    });
  }

  async clear(): Promise<void> {
    await this.prisma.bar.deleteMany();
    this.instrumentIds.clear();
  }

  private async instrumentId(symbol: string): Promise<number> {
    const cached = this.instrumentIds.get(symbol);

    if (cached !== undefined) {
      return cached;
    }

    const existing = await this.prisma.instrument.findFirst({ where: { symbol } });

    if (existing) {
      this.instrumentIds.set(symbol, existing.id);
      return existing.id;
    }

    const created = await this.prisma.instrument.create({
      data: { symbol, secType: 'STK', exchange: 'SMART', currency: 'USD', multiplier: 1 },
    });

    this.instrumentIds.set(symbol, created.id);

    return created.id;
  }
}

function toBar(row: {
  symbol: string;
  barSize: string;
  timestamp: string;
  open: Prisma.Decimal;
  high: Prisma.Decimal;
  low: Prisma.Decimal;
  close: Prisma.Decimal;
  volume: bigint;
  synthetic: boolean;
}): Bar {
  return {
    symbol: row.symbol,
    barSize: row.barSize as BarSize,
    timestamp: row.timestamp,
    open: toNumber(row.open),
    high: toNumber(row.high),
    low: toNumber(row.low),
    close: toNumber(row.close),
    volume: Number(row.volume),
    // Only set when true, so a real bar round-trips to exactly the shape the
    // in-memory repository returns — the contract suite compares them directly.
    ...(row.synthetic ? { synthetic: true } : {}),
  };
}

@Injectable()
export class PrismaRiskEventRepository implements RiskEventRepository {
  constructor(private readonly prisma: PrismaService) {}

  async save(event: RiskEvent): Promise<void> {
    await this.prisma.riskEvent.create({
      data: {
        type: event.type,
        reason: event.reason,
        detail: event.detail,
        timestamp: event.timestamp,
        intent: event.intent === null ? Prisma.DbNull : toJson(event.intent),
        approvedQuantity: event.approvedQuantity,
      },
    });
  }

  async findAll(): Promise<RiskEvent[]> {
    // Insertion order, via the autoincrement id. Sorting by `timestamp` would
    // reorder events that share a bar timestamp — several rejections on one bar
    // is the normal case, not an edge case.
    const rows = await this.prisma.riskEvent.findMany({ orderBy: { id: 'asc' } });

    return rows.map((row) => ({
      type: row.type as RiskEventType,
      reason: row.reason as RiskReason,
      detail: row.detail,
      timestamp: row.timestamp,
      intent: row.intent === null ? null : fromJson<RiskIntent>(row.intent),
      approvedQuantity: row.approvedQuantity,
    }));
  }

  async clear(): Promise<void> {
    await this.prisma.riskEvent.deleteMany();
  }
}

/**
 * Append-only parameter change log (`PRD.md:392`).
 *
 * `append` is a plain `create` — deliberately **not** an upsert, unlike every
 * other repository here. An upsert would silently overwrite an existing record,
 * which is the exact operation this log exists to make impossible; a duplicate
 * id must fail loudly. The database enforces the rest with BEFORE UPDATE and
 * BEFORE DELETE triggers (`migrations/…_parameter_change_append_only`), so the
 * property holds even against a client that bypasses this class.
 */
@Injectable()
export class PrismaParameterChangeRepository implements ParameterChangeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async append(change: ParameterChange): Promise<void> {
    await this.prisma.parameterChange.create({
      data: {
        id: change.id,
        changeId: change.changeId,
        strategyId: change.strategyId,
        parameter: change.parameter,
        oldValue: toJson(change.oldValue),
        newValue: toJson(change.newValue),
        timestamp: change.timestamp,
        stateAtChange: change.stateAtChange === null ? Prisma.DbNull : toJson(change.stateAtChange),
        reason: change.reason,
      },
    });
  }

  async findAll(): Promise<ParameterChange[]> {
    const rows = await this.prisma.parameterChange.findMany({
      orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
    });

    return rows.map(toParameterChange);
  }

  async findByStrategy(strategyId: string): Promise<ParameterChange[]> {
    const rows = await this.prisma.parameterChange.findMany({
      where: { strategyId },
      orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
    });

    return rows.map(toParameterChange);
  }

  /**
   * Deliberately a no-op.
   *
   * `clear` exists on the interface as a replay affordance for
   * `POST /engine/reset`, but **`engine.reset()` does not call it** — the audit
   * trail survives a reset by design. Honouring it here would mean issuing a
   * DELETE the append-only trigger rejects, so a reset would throw. Silently
   * doing nothing is wrong in the other direction, so the divergence is stated
   * here and asserted in the shared suite, which grants this repository an
   * explicit exemption rather than pretending the behaviours match.
   */
  async clear(): Promise<void> {
    // Intentionally empty — see above.
  }
}

/**
 * Versioned strategy state snapshots.
 *
 * Two details are load-bearing:
 *
 * 1. **The parent `StrategyInstance` row is upserted alongside the snapshot.**
 *    The schema puts a foreign key there (`schema.prisma:240`), and a snapshot
 *    that failed because nothing had registered the instance would lose the
 *    anchor at exactly the moment recovery needs it. The two writes share a
 *    transaction so a snapshot never exists without its parent.
 * 2. **`save` appends; it never updates.** A crash mid-write leaves the
 *    previous good snapshot intact and readable, which is the whole reason this
 *    table keeps history instead of holding one row per strategy.
 */
@Injectable()
export class PrismaStrategyStateSnapshotRepository implements StrategyStateSnapshotRepository {
  constructor(private readonly prisma: PrismaService) {}

  async save(snapshot: StrategyStateSnapshotRecord): Promise<void> {
    const instance = {
      name: snapshot.strategyId,
      symbols: snapshot.symbols as unknown as Prisma.InputJsonValue,
      updatedAt: snapshot.capturedAt,
    };

    await this.prisma.$transaction([
      this.prisma.strategyInstance.upsert({
        where: { id: snapshot.strategyId },
        // `enabled` is set only on create. A snapshot records what the strategy
        // *held*, not whether an operator has it switched on — overwriting the
        // flag here would let a state write silently re-enable a disabled
        // strategy.
        create: { id: snapshot.strategyId, enabled: true, ...instance },
        update: instance,
      }),
      this.prisma.strategyStateSnapshot.create({
        data: {
          strategyId: snapshot.strategyId,
          version: snapshot.version,
          symbols: snapshot.symbols as unknown as Prisma.InputJsonValue,
          data: snapshot.data as unknown as Prisma.InputJsonValue,
          capturedAt: snapshot.capturedAt,
        },
      }),
    ]);
  }

  async findLatest(strategyId: string): Promise<StrategyStateSnapshotRecord | null> {
    // Ordered by `capturedAt` then `id`: two snapshots can share a capture
    // timestamp when a replay writes faster than the clock ticks, and the
    // autoincrement id is the tiebreak that makes "newest" total rather than
    // arbitrary. Without it recovery could load an older anchor at random.
    const row = await this.prisma.strategyStateSnapshot.findFirst({
      where: { strategyId },
      orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }],
    });

    return row === null ? null : toSnapshot(row);
  }

  async findAll(strategyId: string): Promise<StrategyStateSnapshotRecord[]> {
    const rows = await this.prisma.strategyStateSnapshot.findMany({
      where: { strategyId },
      orderBy: [{ capturedAt: 'asc' }, { id: 'asc' }],
    });

    return rows.map(toSnapshot);
  }

  async clear(): Promise<void> {
    await this.prisma.strategyStateSnapshot.deleteMany();
  }
}

function toSnapshot(row: {
  strategyId: string;
  version: number;
  symbols: Prisma.JsonValue;
  data: Prisma.JsonValue;
  capturedAt: string;
}): StrategyStateSnapshotRecord {
  return {
    strategyId: row.strategyId,
    version: row.version,
    symbols: fromJson<string[]>(row.symbols),
    data: fromJson<Record<string, unknown>>(row.data),
    capturedAt: row.capturedAt,
  };
}

function toParameterChange(row: {
  id: string;
  changeId: string;
  strategyId: string;
  parameter: string;
  oldValue: Prisma.JsonValue;
  newValue: Prisma.JsonValue;
  timestamp: string;
  stateAtChange: Prisma.JsonValue | null;
  reason: string | null;
}): ParameterChange {
  return {
    id: row.id,
    changeId: row.changeId,
    strategyId: row.strategyId,
    parameter: row.parameter as EditableParameter,
    oldValue: fromJson<JsonValue>(row.oldValue),
    newValue: fromJson<JsonValue>(row.newValue),
    timestamp: row.timestamp,
    stateAtChange: row.stateAtChange === null ? null : fromJson<StrategyState>(row.stateAtChange),
    reason: row.reason,
  };
}

/**
 * Backtest runs and their metrics (Story 11).
 *
 * `saveResults` upserts on `(runId, metric)` — the unique constraint the schema
 * already declares. Re-persisting a recomputed run therefore replaces its
 * metrics rather than accumulating two contradictory values for the same name,
 * matching the in-memory implementation the shared suite runs against both.
 *
 * Metric values are `DECIMAL(24,8)` and converted at this boundary, exactly as
 * money is elsewhere (`decimal.ts`). Ratios like win rate and drawdown need the
 * extra fractional places that column provides, and carrying them as `Decimal`
 * any further up would push persistence vocabulary into the statistics layer.
 */
@Injectable()
export class PrismaBacktestRepository implements BacktestRepository {
  constructor(private readonly prisma: PrismaService) {}

  async saveRun(run: BacktestRunRecord): Promise<void> {
    const data = {
      strategyId: run.strategyId,
      symbol: run.symbol,
      barSize: run.barSize,
      rangeStart: run.rangeStart,
      rangeEnd: run.rangeEnd,
      parameters: run.parameters as unknown as Prisma.InputJsonValue,
      synthetic: run.synthetic,
      createdAt: run.createdAt,
    };

    await this.prisma.backtestRun.upsert({
      where: { id: run.id },
      create: { id: run.id, ...data },
      update: data,
    });
  }

  async saveResults(results: BacktestResultRecord[]): Promise<void> {
    if (results.length === 0) {
      return;
    }

    await this.prisma.$transaction(
      results.map((result) =>
        this.prisma.backtestResult.upsert({
          where: {
            backtest_result_metric: { runId: result.runId, metric: result.metric },
          },
          create: {
            id: `${result.runId}:${result.metric}`,
            runId: result.runId,
            metric: result.metric,
            value: toDecimal(result.value),
            detail: (result.detail ?? Prisma.DbNull) as Prisma.InputJsonValue,
          },
          update: {
            value: toDecimal(result.value),
            detail: (result.detail ?? Prisma.DbNull) as Prisma.InputJsonValue,
          },
        }),
      ),
    );
  }

  async findRun(id: string): Promise<BacktestRunRecord | null> {
    const row = await this.prisma.backtestRun.findUnique({ where: { id } });

    return row === null ? null : toBacktestRun(row);
  }

  async findAllRuns(): Promise<BacktestRunRecord[]> {
    // Newest first, tie-broken by id so ordering is total — a sweep writes many
    // runs inside one second and an arbitrary order would make the list shuffle
    // between reads.
    const rows = await this.prisma.backtestRun.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    return rows.map(toBacktestRun);
  }

  async findResults(runId: string): Promise<BacktestResultRecord[]> {
    const rows = await this.prisma.backtestResult.findMany({
      where: { runId },
      orderBy: { metric: 'asc' },
    });

    return rows.map((row) => ({
      runId: row.runId,
      metric: row.metric,
      value: toNumber(row.value),
      detail: row.detail === null ? null : fromJson<Record<string, unknown>>(row.detail),
    }));
  }

  async clear(): Promise<void> {
    // Results cascade from the run relation, but deleting them explicitly keeps
    // this correct if that relation is ever relaxed.
    await this.prisma.backtestResult.deleteMany();
    await this.prisma.backtestRun.deleteMany();
  }
}

function toBacktestRun(row: {
  id: string;
  strategyId: string;
  symbol: string;
  barSize: string;
  rangeStart: string;
  rangeEnd: string;
  parameters: Prisma.JsonValue;
  synthetic: boolean;
  createdAt: string;
}): BacktestRunRecord {
  return {
    id: row.id,
    strategyId: row.strategyId,
    symbol: row.symbol,
    barSize: row.barSize as BarSize,
    rangeStart: row.rangeStart,
    rangeEnd: row.rangeEnd,
    parameters: fromJson<Record<string, unknown>>(row.parameters),
    synthetic: row.synthetic,
    createdAt: row.createdAt,
  };
}
