/**
 * Records IB's own `(quantity, averageCost)` per symbol — the anchors
 * average-cost realized P&L is replayed from (`average-cost-pnl.ts`) — and the
 * commissions IB reports after each execution.
 *
 * **Observes only.** Both services reach the broker through
 * `BROKER_POSITION_READER`, a port narrowed to two reads and two
 * subscriptions, so nothing here can place, cancel, or route anything. A
 * snapshot is the same `getPositions()` question reconciliation already asks,
 * and a commission update writes one column no trading decision reads.
 */

import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { DateTime } from 'luxon';
import { BrokerPosition } from '../broker/broker-adapter.interface';
import { CommissionCorrection } from '../broker/ib/ib-socket';
import { AppConfigService } from '../config/app-config.service';
import { ET_ZONE } from '../market-data/types';
import {
  FILL_REPOSITORY,
  FillRepository,
  POSITION_SNAPSHOT_REPOSITORY,
  PositionSnapshotRecord,
  PositionSnapshotRepository,
} from '../repositories/repository.interfaces';

/** The only broker surface this module may touch. */
export interface PositionReader {
  isConnected(): boolean;
  getPositions(): Promise<BrokerPosition[]>;
  /** Fires on every transition to CONNECTED. */
  onConnected(handler: () => void): () => void;
  /** IB's late commission reports; never fires under a broker without them. */
  onCommission(handler: (report: CommissionCorrection) => void): () => void;
}

export const BROKER_POSITION_READER = Symbol('BROKER_POSITION_READER');

/** Symbols always included in a snapshot even when flat, e.g. the grid's. */
export const SNAPSHOT_SYMBOLS = Symbol('SNAPSHOT_SYMBOLS');

/** After the 16:15 post-close reconcile, before the 16:30 email. */
export const SNAPSHOT_AT = { hour: 16, minute: 20 };
export const SNAPSHOT_TICK_MS = 60_000;

/** The next weekday 16:20 ET strictly after `now`. */
export function nextSnapshotRun(now: DateTime): DateTime {
  let candidate = now.setZone(ET_ZONE).set({ ...SNAPSHOT_AT, second: 0, millisecond: 0 });

  if (candidate <= now) {
    candidate = candidate.plus({ days: 1 });
  }
  // Luxon weekdays: 6 = Saturday, 7 = Sunday.
  while (candidate.weekday > 5) {
    candidate = candidate.plus({ days: 1 });
  }

  return candidate;
}

/**
 * One snapshot batch: IB's positions, plus a zero row for every other symbol
 * this account has traded or snapshotted. The zero rows matter — a flat symbol
 * IB simply omits would otherwise be indistinguishable from one nobody asked
 * about, and the count could not be checked against flat.
 */
export function snapshotRows(
  takenAt: string,
  positions: BrokerPosition[],
  knownSymbols: Iterable<string>,
): PositionSnapshotRecord[] {
  const rows = new Map<string, PositionSnapshotRecord>();

  for (const symbol of knownSymbols) {
    rows.set(symbol, { takenAt, symbol, quantity: 0, averageCost: 0 });
  }
  for (const position of positions) {
    rows.set(position.symbol, {
      takenAt,
      symbol: position.symbol,
      quantity: position.quantity,
      averageCost: position.averageCost,
    });
  }

  return [...rows.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

type Clock = () => DateTime;

/**
 * Snapshots at 16:20 ET on weekdays and on every connect.
 *
 * The connect snapshot is what starts tracking on the first boot (the opening
 * balance), and afterwards it checks the count after an outage — exactly when
 * fills are likeliest to have gone unrecorded. A wall-clock ticker rather than a long timer, for the reason
 * `PnlEmailScheduler` gives: Docker Desktop's monotonic clock stops while the
 * host sleeps.
 *
 * **A broker that cannot be asked writes nothing.** "Could not ask" is not
 * "flat", and a flat snapshot written during an outage would report every
 * position as a missing fill — or, as the first snapshot, open it at zero.
 */
@Injectable()
export class PositionSnapshotService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PositionSnapshotService.name);
  private ticker: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private nextRun: DateTime | null = null;
  private running = false;
  private clock: Clock = () => DateTime.now().setZone(ET_ZONE);

  constructor(
    @Inject(BROKER_POSITION_READER) private readonly broker: PositionReader,
    @Inject(POSITION_SNAPSHOT_REPOSITORY) private readonly snapshots: PositionSnapshotRepository,
    @Inject(FILL_REPOSITORY) private readonly fills: FillRepository,
    private readonly appConfig: AppConfigService,
    @Optional() @Inject(SNAPSHOT_SYMBOLS) private readonly alwaysSymbols: string[] = [],
  ) {}

  onApplicationBootstrap(): void {
    // Under the mock broker there is no IB average to anchor to.
    if (!this.appConfig.usesIbBroker) {
      return;
    }
    this.start();
  }

  start(clock?: Clock): void {
    if (clock) {
      this.clock = clock;
    }
    if (this.ticker !== null) {
      return;
    }
    this.unsubscribe = this.broker.onConnected(() => void this.takeSnapshot());
    this.nextRun = nextSnapshotRun(this.clock());
    this.ticker = setInterval(() => this.tick(), SNAPSHOT_TICK_MS);

    // The broker may have connected before this subscription existed.
    if (this.broker.isConnected()) {
      void this.takeSnapshot();
    }
  }

  onModuleDestroy(): void {
    this.stop();
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.nextRun = null;
  }

  tick(): void {
    const now = this.clock();
    if (this.nextRun === null || now < this.nextRun) {
      return;
    }
    // Re-armed from the present, so a long sleep produces one late snapshot,
    // not one per missed day.
    this.nextRun = nextSnapshotRun(now);
    void this.takeSnapshot();
  }

  /** The batch written, or null when nothing was (unreachable, or already running). */
  async takeSnapshot(): Promise<PositionSnapshotRecord[] | null> {
    if (this.running) {
      return null;
    }
    this.running = true;

    try {
      if (!this.broker.isConnected()) {
        this.logger.warn('position snapshot skipped: broker not connected');
        return null;
      }

      const positions = await this.broker.getPositions();
      const [previous, fills] = await Promise.all([this.snapshots.findAll(), this.fills.findAll()]);
      const known = new Set([
        ...this.alwaysSymbols,
        ...previous.map((row) => row.symbol),
        ...fills.map((fill) => fill.symbol),
      ]);
      const rows = snapshotRows(this.clock().toISO()!, positions, known);

      await this.snapshots.saveBatch(rows);
      this.logger.log(
        `position snapshot: ${rows.map((r) => `${r.symbol} ${r.quantity}@${r.averageCost}`).join(', ') || 'none'}`,
      );
      return rows;
    } catch (error) {
      // Logged, never rethrown — a timer callback must not turn a failed read
      // into an unhandled rejection.
      this.logger.error(
        `position snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    } finally {
      this.running = false;
    }
  }
}

/** Delays before re-trying a commission whose fill is not yet recorded. */
export const COMMISSION_RETRY_MS = [2_000, 10_000, 60_000];

/**
 * IB sends `Double.MAX_VALUE` as "not known yet"; anything this large is not a
 * commission. Rebates can be negative, so only the magnitude is bounded.
 */
const MAX_PLAUSIBLE_COMMISSION = 1_000_000;

/**
 * Writes IB's commission reports onto their fills.
 *
 * The report usually arrives before the engine has finished saving the fill it
 * belongs to, so an unknown fill is retried a few times rather than dropped at
 * once. A report that never finds its fill — one the engine could not
 * attribute, and so never records — is dropped; there is no row to correct.
 */
@Injectable()
export class CommissionRecorderService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CommissionRecorderService.name);
  private unsubscribe: (() => void) | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    @Inject(BROKER_POSITION_READER) private readonly broker: PositionReader,
    @Inject(FILL_REPOSITORY) private readonly fills: FillRepository,
  ) {}

  onApplicationBootstrap(): void {
    this.unsubscribe = this.broker.onCommission((report) => void this.record(report));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
  }

  async record(report: CommissionCorrection, attempt = 0): Promise<void> {
    if (
      report.fillId === '' ||
      !Number.isFinite(report.commission) ||
      Math.abs(report.commission) >= MAX_PLAUSIBLE_COMMISSION
    ) {
      return;
    }

    try {
      if (await this.fills.updateCommission(report.fillId, report.commission)) {
        return;
      }
    } catch (error) {
      this.logger.error(
        `could not record commission for ${report.fillId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (attempt >= COMMISSION_RETRY_MS.length) {
      this.logger.debug(`no recorded fill ${report.fillId} for its commission; dropped`);
      return;
    }

    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.record(report, attempt + 1);
    }, COMMISSION_RETRY_MS[attempt]);
    timer.unref?.();
    this.timers.add(timer);
  }
}
