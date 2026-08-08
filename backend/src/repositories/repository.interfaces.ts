/**
 * Repository interfaces — **the contract Prisma implements at Story 8 with no
 * call-site changes** (`stories.md:487`).
 *
 * Every method is `async` even though the in-memory implementations resolve
 * immediately. That is deliberate: if these were synchronous, every call site
 * would have to change when MySQL arrives, which is precisely the "no
 * call-site changes" property this interface exists to provide.
 *
 * The shapes are storage-neutral and fully serializable. `OrderIntentRecord`
 * in particular exists because **an intent must be persisted before submission**
 * (`PRD.md:366`) — that write is what makes the crash window between "order
 * sent" and "fill recorded" recoverable at Story 9.
 */

import { Fill, OrderStatus } from '../broker/broker-adapter.interface';
import { Bar, BarSize } from '../market-data/types';
import { RiskEvent } from '../risk/risk-event';
import { RiskDecision } from '../risk/types';
import { Lot } from '../strategies/dip-ladder/lot';
import { ParameterChange } from '../strategies/dip-ladder/parameter-change';
import { Rung } from '../strategies/dip-ladder/rung';
import { OrderIntent } from '../strategies/types';

/**
 * A persisted intent, with the risk decision that was made about it.
 *
 * Written **before** the order is submitted, so a crash between submission and
 * fill leaves a record that recovery can reason about rather than a silent gap.
 */
export interface OrderIntentRecord {
  id: string;
  intent: OrderIntent;
  /** Null only in the instant between persistence and evaluation. */
  decision: RiskDecision | null;
  /** True when the engine actually handed this to a broker. */
  submitted: boolean;
  /** Set when submitted. Correlates to `BrokerOrder.clientOrderId`. */
  clientOrderId: string | null;
  createdAt: string;
}

export interface OrderRecord {
  clientOrderId: string;
  brokerOrderId: string | null;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  limitPrice: number;
  status: OrderStatus;
  rejectReason: string | null;
  strategyId: string;
  createdAt: string;
}

export interface OrderIntentRepository {
  save(record: OrderIntentRecord): Promise<void>;
  findAll(): Promise<OrderIntentRecord[]>;
  findBySymbol(symbol: string): Promise<OrderIntentRecord[]>;
  markSubmitted(id: string, clientOrderId: string): Promise<void>;
  clear(): Promise<void>;
}

export interface OrderRepository {
  save(order: OrderRecord): Promise<void>;
  updateStatus(clientOrderId: string, status: OrderStatus, rejectReason?: string): Promise<void>;
  findAll(): Promise<OrderRecord[]>;
  findByClientOrderId(clientOrderId: string): Promise<OrderRecord | null>;
  clear(): Promise<void>;
}

export interface FillRepository {
  save(fill: Fill): Promise<void>;
  findAll(): Promise<Fill[]>;
  findByClientOrderId(clientOrderId: string): Promise<Fill[]>;
  clear(): Promise<void>;
}

/**
 * Lots, ordered by `openedAt` — **FIFO ordering must survive the persistence
 * round trip** (`stories.md:515`), because which lot is sold depends on it and
 * an unstable order would make that nondeterministic after a restart.
 */
export interface LotRepository {
  save(lot: Lot, symbol: string): Promise<void>;
  saveAll(lots: Lot[], symbol: string): Promise<void>;
  findAll(): Promise<Lot[]>;
  findBySymbol(symbol: string): Promise<Lot[]>;
  findHeld(symbol: string): Promise<Lot[]>;
  clear(): Promise<void>;
}

export interface RungRepository {
  saveAll(rungs: Rung[], symbol: string): Promise<void>;
  findBySymbol(symbol: string): Promise<Rung[]>;
  findAll(): Promise<Rung[]>;
  clear(): Promise<void>;
}

export interface RiskEventRepository {
  save(event: RiskEvent): Promise<void>;
  findAll(): Promise<RiskEvent[]>;
  clear(): Promise<void>;
}

/**
 * Cached historical bars — **the store IB's pacing limits make mandatory**
 * (`PRD.md:293`).
 *
 * All history is served from here; IB is called only for gaps. That is a
 * correctness requirement rather than an optimization, because exceeding IB's
 * limits does not fail cleanly — it silently throttles or drops the connection.
 *
 * `save` is an **upsert keyed by (symbol, barSize, timestamp)**. Gap-fill
 * requests overlap at their edges by design (a range boundary is safer
 * re-fetched than missed), so ingesting the same bar twice must be a no-op
 * rather than a duplicate row that would double a volume sum or produce two
 * closes for one instant.
 *
 * **Synthetic bars are stored alongside real ones but never mixed silently**
 * (`stories.md:619`). `findRange` returns real bars only unless synthetic ones
 * are explicitly asked for, so a backtest cannot quietly include a series that
 * excludes the expense ratio and financing costs real leveraged ETFs pay.
 */
export interface BarRepository {
  saveAll(bars: Bar[]): Promise<void>;
  /**
   * Bars within an inclusive range, ascending by timestamp.
   *
   * Excludes synthetic bars unless `includeSynthetic` is set — see above.
   */
  findRange(
    symbol: string,
    barSize: BarSize,
    from: string,
    to: string,
    includeSynthetic?: boolean,
  ): Promise<Bar[]>;
  /** The newest cached bar for a symbol/size, or null. Drives incremental fill. */
  findLatest(symbol: string, barSize: BarSize): Promise<Bar | null>;
  /** The oldest cached bar, so a backfill knows how far it has already reached. */
  findEarliest(symbol: string, barSize: BarSize): Promise<Bar | null>;
  countInRange(symbol: string, barSize: BarSize, from: string, to: string): Promise<number>;
  clear(): Promise<void>;
}

/**
 * A versioned snapshot of a strategy's state.
 *
 * Lots and rungs have their own tables and are the authoritative record of lot
 * composition. This carries what those tables do not: the ladder's **anchor
 * scalars** — `sessionOpen`, `previousSessionClose`, `firstEntryPrice`,
 * `lotSequence`. Without them a restart reloads the lots but forgets where the
 * ladder was measuring from, and Story 9's exit criterion names the anchor
 * explicitly (`stories.md:567`).
 *
 * `version` is checked before the state is trusted. A snapshot the running code
 * does not understand is **rejected**, never coerced — its fields may no longer
 * mean what they used to, and a misread anchor prices every future rung wrong.
 */
export interface StrategyStateSnapshotRecord {
  strategyId: string;
  version: number;
  symbols: string[];
  data: Record<string, unknown>;
  capturedAt: string;
}

/**
 * Strategy state snapshots — **append-a-row-per-save, not update-in-place.**
 *
 * A crash can interrupt a write. Keeping history means recovery can fall back
 * to the previous good snapshot rather than finding one half-written record and
 * no alternative. `findLatest` returns the newest by capture time.
 */
export interface StrategyStateSnapshotRepository {
  save(snapshot: StrategyStateSnapshotRecord): Promise<void>;
  findLatest(strategyId: string): Promise<StrategyStateSnapshotRecord | null>;
  findAll(strategyId: string): Promise<StrategyStateSnapshotRecord[]>;
  clear(): Promise<void>;
}

/**
 * Parameter changes — **append-only** (`PRD.md:392`).
 *
 * There is deliberately no `update` and no `deleteOne`. The absence is the
 * enforcement at this layer: a caller cannot rewrite history through an
 * interface that offers no way to. Story 8 adds the database-level constraint
 * (`stories.md:494`) so the property survives the Prisma swap rather than
 * resting on this interface alone.
 *
 * `clear` exists only because `POST /engine/reset` must return the whole engine
 * to a known state for the next replay; it is a test and replay affordance, not
 * an edit path, and it cannot remove a single record selectively.
 */
export interface ParameterChangeRepository {
  append(change: ParameterChange): Promise<void>;
  findAll(): Promise<ParameterChange[]>;
  findByStrategy(strategyId: string): Promise<ParameterChange[]>;
  clear(): Promise<void>;
}

/**
 * A persisted backtest run and its metrics (Story 11).
 *
 * `parameters` carries **the full parameter set the run used**, rather than a
 * reference to whatever the config says today. A backtest is evidence, and
 * evidence that silently re-interprets itself when a default changes is worse
 * than none: a sweep comparing spacing 4% against 6% is meaningless if reading
 * the results back resolves both to the current value.
 *
 * Results are stored as `(metric, value, detail)` rows rather than as columns.
 * The metric set grows — Story 13 will want figures nobody has named yet — and
 * a column per statistic would make each new one a migration. `detail` carries
 * the metrics that are not a single number, such as rung distribution.
 */
export interface BacktestRunRecord {
  id: string;
  strategyId: string;
  symbol: string;
  barSize: BarSize;
  rangeStart: string;
  rangeEnd: string;
  parameters: Record<string, unknown>;
  /** True when the run used synthetic 3x history (`stories.md:619`). */
  synthetic: boolean;
  createdAt: string;
}

export interface BacktestResultRecord {
  runId: string;
  metric: string;
  value: number;
  detail?: Record<string, unknown> | null;
}

/**
 * Backtest persistence — **so results are comparable across parameter sets**
 * (`stories.md:645`).
 *
 * There is deliberately no `update`. A backtest run is a record of what
 * happened when specific parameters met specific bars; editing one would
 * detach the result from the inputs that produced it. Re-running is how a
 * result changes, and that is a new run with a new id.
 */
export interface BacktestRepository {
  saveRun(run: BacktestRunRecord): Promise<void>;
  saveResults(results: BacktestResultRecord[]): Promise<void>;
  findRun(id: string): Promise<BacktestRunRecord | null>;
  findAllRuns(): Promise<BacktestRunRecord[]>;
  findResults(runId: string): Promise<BacktestResultRecord[]>;
  clear(): Promise<void>;
}

/** DI tokens. Story 8 rebinds these to Prisma implementations. */
export const BAR_REPOSITORY = Symbol('BAR_REPOSITORY');
export const ORDER_INTENT_REPOSITORY = Symbol('ORDER_INTENT_REPOSITORY');
export const ORDER_REPOSITORY = Symbol('ORDER_REPOSITORY');
export const FILL_REPOSITORY = Symbol('FILL_REPOSITORY');
export const LOT_REPOSITORY = Symbol('LOT_REPOSITORY');
export const RUNG_REPOSITORY = Symbol('RUNG_REPOSITORY');
export const RISK_EVENT_REPOSITORY = Symbol('RISK_EVENT_REPOSITORY');
export const PARAMETER_CHANGE_REPOSITORY = Symbol('PARAMETER_CHANGE_REPOSITORY');
export const STRATEGY_STATE_SNAPSHOT_REPOSITORY = Symbol('STRATEGY_STATE_SNAPSHOT_REPOSITORY');
export const BACKTEST_REPOSITORY = Symbol('BACKTEST_REPOSITORY');
