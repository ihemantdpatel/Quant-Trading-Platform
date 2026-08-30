/**
 * Typed client for the Story 6 engine API (`stories.md:454`).
 *
 * **There is no mock layer** (`stories.md:448`). The dashboard is built against
 * the real running backend, so what the browser shows is what the engine
 * decided — a mocked API would let the UI drift from the contract silently, and
 * the whole point of Story 7 is to validate the engine by watching it.
 *
 * Every type here mirrors a backend response shape. They are declared rather
 * than imported because `ui/` and `backend/` are separate packages with
 * separate tsconfigs; the integration suite over Supertest is what holds the
 * two in agreement.
 */

/**
 * Base URL of the engine API.
 *
 * **Resolved on the server, never in the browser.** Every caller is server-side
 * — the loaders below run in Server Components and `actions.ts` is
 * `'use server'` — so this must be reachable from wherever the Next.js server
 * process runs, which under Docker Compose is the `ui` container.
 *
 * That distinction is why `API_URL` is preferred over `NEXT_PUBLIC_API_URL`:
 * inside a container `localhost:3000` is the *UI* container, where nothing
 * listens, while the backend is reachable by its compose service name. The
 * `NEXT_PUBLIC_` fallback is kept for running the UI outside Docker (`npm run
 * dev` against a local backend), where localhost is correct.
 *
 * Do not move this read into a Client Component: `API_URL` has no
 * `NEXT_PUBLIC_` prefix and is deliberately not inlined into the client bundle,
 * where a service name would not resolve from a browser anyway.
 */
const API_URL = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export type ExecutionMode = 'SHADOW' | 'PAPER' | 'LIVE';
export type LotStatus = 'HELD' | 'CLOSED';
export type RungStatus = 'HELD' | 'WORKING' | 'RE_ARMED' | 'PENDING';
export type ConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'FAILED';
export type OrderStatus = 'SUBMITTED' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED';

export interface Lot {
  id: string;
  symbol: string;
  rungPrice: number;
  fillPrice: number;
  quantity: number;
  openedAt: string;
  /** Frozen at fill from the parameters then in force (`PRD.md:386`). */
  exitTarget: number;
  status: LotStatus;
  closedAt: string | null;
  exitPrice: number | null;
  /** Realized P&L for a closed lot; null while held. */
  realized: number | null;
  /**
   * True when this row was read from the database because its symbol is
   * halted, rather than from live strategy state.
   *
   * A halt restores nothing into the ladder, so these are the only records of
   * the position that remain — and they have **not** been verified against the
   * broker, which is the whole reason the symbol is halted. Optional so an
   * older backend omitting the field reads as verified.
   */
  unverified?: boolean;
}

export interface Rung {
  price: number;
  status: RungStatus;
  lotId: string | null;
  /** `clientOrderId` of the limit order resting at this price, or null. */
  workingOrderId: string | null;
  completedCycles: number;
  lastExitAt: string | null;
  held: boolean;
  fireable: boolean;
  /** As on `Lot` — persisted rather than live, because the symbol is halted. */
  unverified?: boolean;
}

export interface Position {
  symbol: string;
  quantity: number;
  averageCost: number;
}

export interface Order {
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

export interface Fill {
  clientOrderId: string;
  brokerOrderId: string;
  fillId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  commission: number;
  timestamp: string;
}

export interface RiskEvent {
  type: 'REJECTION' | 'RESIZE' | 'HALT' | 'KILL_SWITCH' | 'STARTUP_ASSERTION';
  reason: string;
  detail: string;
  timestamp: string;
  approvedQuantity: number | null;
}

export interface EngineAlert {
  severity: 'WARNING' | 'CRITICAL';
  code: string;
  detail: string;
  timestamp: string;
  /**
   * When the reported condition ended, or `null` while it still holds.
   *
   * Optional because an older backend omits the field entirely; absent is read
   * as unresolved, which keeps such an alert visible rather than silently
   * hiding a live fault.
   */
  resolvedAt?: string | null;
}

/** The most recent bar close for one symbol, with the epoch ms it arrived. */
export interface LastPrice {
  symbol: string;
  price: number;
  /** Epoch ms the bar arrived — the basis for showing the price's age. */
  at: number;
}

export interface Status {
  mode: ExecutionMode;
  broker: {
    name: string;
    connected: boolean;
    state: ConnectionState;
    reconnectAttempts: number;
    lastError: string | null;
    /**
     * The last bar close per symbol. Present only when IB is the bound broker
     * — the mock broker has no live feed, and an absent field must render as
     * "no price" rather than as a zero.
     */
    lastPrices?: LastPrice[];
  };
  halts: {
    killSwitch: { engaged: boolean; reason: string | null; changedAt: string | null };
    dailyLossBreaker: { halted: boolean };
    entryHalt: { halted: boolean; reason: string | null };
    /** Per-symbol reconciliation halts (Story 9). Absent on older backends. */
    symbols?: SymbolHalt[];
  };
  alerts: EngineAlert[];
  strategies: { id: string; enabled: boolean }[];
  /** Null until the startup sequence has run. */
  reconciliation?: ReconciliationReport | null;
  /**
   * The post-close order reconciliation's last run. Null until it has fired.
   *
   * Optional so an older backend without the scheduled job renders unchanged
   * rather than breaking the dashboard.
   */
  orderReconciliation?: OrderReconciliationReport | null;
}

/**
 * The result of an orders-only reconciliation — the scheduled post-close job.
 *
 * Carries no `clean` or `haltedSymbols`: that run asserts nothing about
 * positions, so it has no verdict to report about them.
 */
export interface OrderReconciliationReport {
  ranAt: string;
  symbols: string[];
  /** False when the broker could not be asked; the ledger is then untouched. */
  brokerReachable: boolean;
  ordersUpdated: number;
}

/**
 * A symbol the engine refuses to trade until an operator resolves it.
 *
 * Distinct from `entryHalt`, which stops new entries but still permits exits.
 * A reconciliation halt stops **both**, because lot composition is unverified
 * and selling would mean picking a lot from records that disagree with the
 * broker.
 */
export interface SymbolHalt {
  symbol: string;
  code: string;
  reason: string;
  at: string;
}

export interface ReconciliationReport {
  ranAt: string;
  clean: boolean;
  haltedSymbols: string[];
  symbols: {
    strategyId: string;
    symbol: string;
    resumed: boolean;
    restoredLots: number;
    restoredRungs: number;
    verdict: { status: string; lotQuantity: number; brokerQuantity: number; reason: string };
  }[];
}

export interface StrategySummary {
  id: string;
  enabled: boolean;
  symbols: string[];
  initialized: boolean;
}

export interface LadderParameters {
  spacingMode: 'PERCENTAGE' | 'ATR' | 'FIXED_DOLLAR';
  spacingPercent: number;
  atrMultiple: number;
  atrPeriod: number;
  /** Absolute rung distance. Used when `spacingMode` is FIXED_DOLLAR. */
  spacingDollars: number;
  takeProfitPercent: number;
  /**
   * Absolute per-lot take-profit. **Supersedes `takeProfitPercent` when set**,
   * so the percentage field is inert while this holds a value — which is why
   * the editor greys it out rather than showing a number that does nothing.
   */
  takeProfitDollars: number | null;
  exitMode: 'PER_LOT' | 'AVERAGE_COST';
  sizePerRung: number;
  /** Fixed shares per rung. Supersedes `sizePerRung` when set. */
  fixedQuantity: number | null;
  escalationFactor: number;
  maxConcurrentRungs: number;
  hardFloorPercent: number;
}

export interface ParameterSet {
  strategyId: string;
  parameters: LadderParameters;
}

export interface ParameterChange {
  id: string;
  changeId: string;
  strategyId: string;
  parameter: keyof LadderParameters;
  oldValue: string | number;
  newValue: string | number;
  timestamp: string;
  reason: string | null;
}

/** Everything one dashboard render needs. */
/**
 * What the shared layout needs: the always-visible operator controls.
 *
 * Deliberately just `/status` — the layout renders on every tab, so anything
 * fetched here is fetched on all of them.
 */
export interface StatusData {
  status: Status | null;
  /** Set when the backend could not be reached at all. */
  error: string | null;
}

/**
 * Which reads failed on this load, keyed by the data they supply.
 *
 * Distinguishes "unavailable" from "empty" — an empty array renders the same
 * as a successful read of nothing, which during an outage tells an operator
 * the ladder is flat when it may be fully extended.
 */
export interface Unavailable {
  status: boolean;
  lots: boolean;
  rungs: boolean;
  positions: boolean;
  orders: boolean;
  fills: boolean;
  riskEvents: boolean;
  strategies: boolean;
}

/** What the Execution tab renders: current engine state, no configuration. */
export interface ExecutionData {
  status: Status | null;
  lots: Lot[];
  rungs: Rung[];
  positions: Position[];
  orders: Order[];
  fills: Fill[];
  riskEvents: RiskEvent[];
  strategies: StrategySummary[];
  /** Set only when **every** read failed — a total backend outage. */
  error: string | null;
  /** Per-endpoint failure flags; absent on loaders that fetch as one unit. */
  unavailable?: Unavailable;
}

/** What the Parameters tab renders. `lots` is only for the held-lot count. */
export interface ParametersData {
  parameters: ParameterSet[];
  parameterChanges: ParameterChange[];
  lots: Lot[];
  /** Set when the backend could not be reached at all. */
  error: string | null;
}

/**
 * A GET against the engine.
 *
 * `cache: 'no-store'` because every one of these endpoints reports live engine
 * state; a cached ladder is a *wrong* ladder, and this is a control surface for
 * a system that places real orders.
 */
async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    cache: 'no-store',
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    throw new ApiError(`GET ${path} failed`, response.status, await safeBody(response));
  }

  return (await response.json()) as T;
}

/**
 * What rests at the broker versus what the ladder believes rests there.
 *
 * Read-only: produced by `GET /orders/diagnosis`, which writes nothing and can
 * halt nothing. This is what an operator reads *before* deciding whether to
 * place or cancel anything.
 */
export interface OrderDiagnosis {
  ranAt: string;
  /**
   * False when the broker could not be asked.
   *
   * Every list below is empty in that case and must not be read as findings —
   * "cannot ask" and "nothing resting" lead to opposite actions.
   */
  brokerReachable: boolean;
  reason: string | null;
  matched: {
    clientOrderId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    quantity: number;
    filledQuantity: number;
    limitPrice: number;
    claimedBy: string;
  }[];
  unbacked: {
    symbol: string;
    clientOrderId: string;
    rungPrice: number | null;
    lotId: string | null;
    side: 'BUY' | 'SELL';
  }[];
  orphans: {
    clientOrderId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    quantity: number;
    filledQuantity: number;
    limitPrice: number;
  }[];
  duplicates: {
    symbol: string;
    side: 'BUY' | 'SELL';
    limitPrice: number;
    tracked: string[];
    untracked: string[];
    /** True when exactly one order is tracked, so the extras are unambiguous. */
    resolvable: boolean;
  }[];
  missing: {
    symbol: string;
    strategyId: string;
    side: 'BUY' | 'SELL';
    quantity: number;
    limitPrice: number;
    reason: string;
    lotId: string | null;
    rungPrice: number | null;
  }[];
  skippedSymbols: string[];
}

/** Reads the order diagnosis. Nothing about this call changes engine state. */
export async function loadOrderDiagnosis(): Promise<OrderDiagnosis> {
  return get<OrderDiagnosis>('/orders/diagnosis');
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function safeBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * A POST control action.
 *
 * Returns the parsed body on both success and failure rather than throwing on
 * 4xx: a refused mode switch carries the *reasons* it was refused
 * (`stories.md:445`), and those must reach the operator, not be swallowed by an
 * exception.
 */
export async function post<T>(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: T | null; error: unknown }> {
  try {
    const response = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body ?? {}),
    });

    const parsed = await safeBody(response);

    return {
      ok: response.ok,
      status: response.status,
      data: response.ok ? (parsed as T) : null,
      error: response.ok ? null : parsed,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: { message: error instanceof Error ? error.message : String(error) },
    };
  }
}

/**
 * The reads are split per tab rather than fetched as one blob.
 *
 * Each loader is its own failure domain. A `/parameters` outage must not blank
 * the ladder, and — the reason this matters most — nothing a *page* fails to
 * load may take down the layout, because the layout is where the kill switch
 * lives. One `Promise.all` spanning every endpoint made all three tabs fail
 * together, which on a control surface is the wrong coupling.
 *
 * Within a loader the reads are still concurrent: they are independent, and
 * serializing them would multiply latency for no benefit.
 *
 * None of them throw. A total backend outage returns an `error` and empty
 * collections, so a page still renders its shell — a dashboard that blanks out
 * when the backend hiccups hides the controls an operator most needs during
 * exactly that kind of event.
 */
function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Status alone, for the shared layout.
 *
 * The Execution tab reads `/status` again through `loadExecution`. That second
 * read is deliberate: sharing one fetch would mean the layout's kill switch and
 * the page's status bar succeed or fail together, which is the coupling this
 * split exists to remove.
 */
export async function loadStatus(): Promise<StatusData> {
  try {
    return { status: await get<Status>('/status'), error: null };
  } catch (error) {
    return { status: null, error: failure(error) };
  }
}

/**
 * Current engine state for the Execution tab (`/`).
 *
 * **Every endpoint is its own failure domain.** These reads were a single
 * `Promise.all`, which meant one rejection discarded the seven results that had
 * already resolved and blanked the whole tab. `/positions` is the one that
 * fails in normal operation — it is the only read here that needs the broker,
 * and a Gateway that is down or not logged in rejects it — so a broker outage
 * emptied the lots, rungs, orders, fills, and risk events that were all sitting
 * there in hand and needed no broker at all.
 *
 * That is the same coupling the per-tab loader split exists to remove, and it
 * was still present *inside* this loader. `allSettled` keeps whatever answered:
 * a failed panel reports itself while the rest of the dashboard stays readable,
 * which is what an operator needs during exactly this kind of event.
 *
 * `error` is now reserved for a **total** outage — every read failing — so the
 * BACKEND_UNREACHABLE banner keeps meaning what it says rather than firing
 * whenever a single endpoint is unavailable.
 */
export async function loadExecution(): Promise<ExecutionData> {
  const [status, lots, rungs, positions, orders, fills, riskEvents, strategies] =
    await Promise.allSettled([
      get<Status>('/status'),
      get<Lot[]>('/lots'),
      get<Rung[]>('/rungs'),
      get<Position[]>('/positions'),
      get<Order[]>('/orders'),
      get<Fill[]>('/fills'),
      get<RiskEvent[]>('/risk-events'),
      get<StrategySummary[]>('/strategies'),
    ]);

  const settled = [status, lots, rungs, positions, orders, fills, riskEvents, strategies];
  const allFailed = settled.every((result) => result.status === 'rejected');

  return {
    status: valueOr(status, null),
    lots: valueOr(lots, []),
    rungs: valueOr(rungs, []),
    positions: valueOr(positions, []),
    orders: valueOr(orders, []),
    fills: valueOr(fills, []),
    riskEvents: valueOr(riskEvents, []),
    strategies: valueOr(strategies, []),
    // Only when nothing at all answered. A single failed endpoint is reported
    // by its own panel, not as "the backend is unreachable" — that banner
    // would be wrong, and a wrong banner on a control surface is worse than a
    // missing one.
    error: allFailed ? failure(reasonOf(status)) : null,
    // Which reads failed, so a panel can say "unavailable" rather than
    // rendering an empty list that looks exactly like "nothing here".
    unavailable: {
      status: status.status === 'rejected',
      lots: lots.status === 'rejected',
      rungs: rungs.status === 'rejected',
      positions: positions.status === 'rejected',
      orders: orders.status === 'rejected',
      fills: fills.status === 'rejected',
      riskEvents: riskEvents.status === 'rejected',
      strategies: strategies.status === 'rejected',
    },
  };
}

function valueOr<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === 'fulfilled' ? result.value : fallback;
}

function reasonOf(result: PromiseSettledResult<unknown>): unknown {
  return result.status === 'rejected' ? result.reason : null;
}

/**
 * Ladder parameters and their audit trail, for the Parameters tab.
 *
 * `/lots` is fetched only to count held lots for the editor's warning — the
 * count is part of how the "future rungs only" rule is communicated, so it has
 * to be accurate rather than approximated.
 */
export async function loadParameters(): Promise<ParametersData> {
  const empty: ParametersData = { parameters: [], parameterChanges: [], lots: [], error: null };

  try {
    const [parameters, parameterChanges, lots] = await Promise.all([
      get<ParameterSet[]>('/parameters'),
      get<ParameterChange[]>('/parameters/changes'),
      get<Lot[]>('/lots'),
    ]);

    return { parameters, parameterChanges, lots, error: null };
  } catch (error) {
    return { ...empty, error: failure(error) };
  }
}

// ---------------------------------------------------------------------------
// Derived display values
//
// Computed here rather than in components so the arithmetic is testable on its
// own and identical everywhere it appears.
// ---------------------------------------------------------------------------

/**
 * Quantity-weighted blended average cost across held lots — **reference only**
 * (`PRD.md:378`).
 *
 * Mirrors `average-cost.ts` on the backend, which states the rule this figure
 * must never break: no exit decision reads it. It is rendered with its label
 * attached precisely so nobody mistakes it for a target.
 */
export function blendedAverageCost(lots: Lot[]): number | null {
  const held = lots.filter((lot) => lot.status === 'HELD');
  const quantity = held.reduce((sum, lot) => sum + lot.quantity, 0);

  if (quantity === 0) {
    return null;
  }

  return round(held.reduce((sum, lot) => sum + lot.fillPrice * lot.quantity, 0) / quantity);
}

/** Distance from a mark price up to a lot's own target, as a fraction. */
export function distanceToTarget(lot: Lot, mark: number | null): number | null {
  if (mark === null || mark <= 0) {
    return null;
  }

  return (lot.exitTarget - mark) / mark;
}

/** Realized P&L across completed lot cycles. */
export function totalRealized(lots: Lot[]): number {
  return round(lots.reduce((sum, lot) => sum + (lot.realized ?? 0), 0));
}

export function totalHeldQuantity(lots: Lot[]): number {
  return lots.filter((lot) => lot.status === 'HELD').reduce((sum, lot) => sum + lot.quantity, 0);
}

export function totalDeployedCost(lots: Lot[]): number {
  return round(
    lots
      .filter((lot) => lot.status === 'HELD')
      .reduce((sum, lot) => sum + lot.fillPrice * lot.quantity, 0),
  );
}

/**
 * The most recent traded price the engine has seen, or null.
 *
 * Taken from the last fill rather than a quote: `SHADOW` submits nothing, so
 * there are frequently no fills at all, and reporting null is honest where
 * inventing a mark would put a fabricated number next to real targets.
 */
export function lastMarkPrice(fills: Fill[]): number | null {
  return fills.length > 0 ? fills[fills.length - 1].price : null;
}

/**
 * The live bar price for one symbol, or null when there is none.
 *
 * Distinct from `lastMarkPrice`, which reports the last *fill* — a price that
 * can be hours old and is absent entirely on a flat ladder. This is what the
 * feed last delivered, which is what the ladder is evaluating against.
 */
export function livePrice(status: Status | null, symbol: string): LastPrice | null {
  return status?.broker.lastPrices?.find((p) => p.symbol === symbol) ?? null;
}

/**
 * A compact age for a live price, e.g. `12s` or `4m`.
 *
 * Rendered beside the price rather than suppressing a stale one: a blank tells
 * an operator nothing, while a price labelled five minutes old tells them both
 * the number and how far to trust it.
 */
export function priceAge(at: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);

  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

/** Lot age as a human string, relative to now. */
export function lotAge(openedAt: string, now: number = Date.now()): string {
  const opened = Date.parse(openedAt);

  if (Number.isNaN(opened)) {
    return '—';
  }

  const minutes = Math.max(0, Math.floor((now - opened) / 60_000));

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${hours}h ${minutes % 60}m`;
  }

  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function formatCurrency(value: number | null): string {
  if (value === null) {
    return '—';
  }

  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function formatPercent(value: number | null, digits = 2): string {
  if (value === null) {
    return '—';
  }

  return `${(value * 100).toFixed(digits)}%`;
}

// ---------------------------------------------------------------------------
// Backtest (Story 11)
// ---------------------------------------------------------------------------

export interface BacktestRun {
  id: string;
  strategyId: string;
  symbol: string;
  barSize: string;
  rangeStart: string;
  rangeEnd: string;
  parameters: Record<string, unknown>;
  /** True when the run used synthesized 3x history (`stories.md:619`). */
  synthetic: boolean;
  createdAt: string;
}

export interface BacktestResultRow {
  runId: string;
  metric: string;
  value: number;
  detail?: Record<string, unknown> | null;
}

export interface BacktestListing {
  runs: BacktestRun[];
  count: number;
  error: string | null;
}

/**
 * Persisted backtest runs.
 *
 * Returns an `error` rather than throwing, for the same reason `loadDashboard`
 * does: the page must render its shell even when the backend is unreachable.
 */
export async function loadBacktests(): Promise<BacktestListing> {
  try {
    const listing = await get<{ runs: BacktestRun[]; count: number }>('/backtest');

    return { ...listing, error: null };
  } catch (error) {
    return {
      runs: [],
      count: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function loadBacktestRun(
  id: string,
): Promise<{ run: BacktestRun; results: BacktestResultRow[] } | null> {
  try {
    return await get<{ run: BacktestRun; results: BacktestResultRow[] }>(
      `/backtest/${encodeURIComponent(id)}`,
    );
  } catch {
    return null;
  }
}

/** Metric rows keyed by name, for lookup by a view. */
export function metricsByName(results: BacktestResultRow[]): Record<string, BacktestResultRow> {
  return Object.fromEntries(results.map((row) => [row.metric, row]));
}

/**
 * Formats a holding period in milliseconds as a human duration.
 *
 * Separate from `lotAge` because that one measures against the current clock;
 * this one renders a stored span, which must not change between renders.
 */
export function formatDuration(ms: number | null): string {
  if (ms === null || ms < 0) {
    return '—';
  }

  const hours = Math.floor(ms / (60 * 60 * 1000));

  if (hours < 24) {
    return `${hours}h`;
  }

  return `${Math.floor(hours / 24)}d`;
}
