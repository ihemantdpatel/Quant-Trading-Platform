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
/** The environment variables these read — narrower than `ProcessEnv`, so tests can pass a literal. */
type Env = Record<string, string | undefined>;

function defaultApiUrl(env: Env = process.env): string {
  return env.API_URL ?? env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
}

/**
 * Every account daemon the dashboard offers — one backend process per IB
 * account (`backend/src/config/accounts.config.ts`).
 *
 * `ACCOUNT_BACKENDS` is a comma-separated list of **URLs only**. Which account
 * each one trades is asked of the daemon itself (`GET /account`) rather than
 * written beside the URL here: a hand-maintained URL→account map could label
 * one account's lots with another's name after a single typo, and on a control
 * surface that is how an operator engages the wrong kill switch.
 *
 * Unset, it is the one backend `API_URL` names — the single-account setup that
 * predates accounts.
 */
export function accountBackendUrls(env: Env = process.env): string[] {
  const listed = (env.ACCOUNT_BACKENDS ?? '')
    .split(',')
    .map((url) => url.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  return listed.length > 0 ? [...new Set(listed)] : [defaultApiUrl(env)];
}

/**
 * An account created from the dashboard (`GET /accounts` on the primary
 * backend). The supervisor runs a daemon for each, on `port` inside the backend
 * container.
 */
export interface ManagedAccount {
  alias: string;
  label: string;
  mode: ExecutionMode;
  currency: string;
  equity: number;
  symbolCapital: Record<string, number>;
  dailyLossThreshold: number;
  dailyLossBasis: string;
  /** Masked (`DU•••321`). */
  ibAccountId: string | null;
  ibClientId: number;
  port: number;
  createdAt: string;
}

/**
 * The dashboard-created accounts, as the primary backend lists them.
 *
 * The primary is `API_URL` — the one daemon every deployment has, whose
 * registry the supervisor reads. Throws when it cannot be asked; callers decide
 * what "unknown" means for them.
 */
export async function loadManagedAccounts(env: Env = process.env): Promise<ManagedAccount[]> {
  const listed = await get<unknown>(defaultApiUrl(env), '/accounts', ACCOUNT_PROBE_TIMEOUT_MS);

  // Only entries with a usable port: an older backend without the route, or a
  // malformed row, must add nothing to discovery rather than a bogus URL.
  return Array.isArray(listed)
    ? (listed as ManagedAccount[]).filter(
        (account) =>
          typeof account?.alias === 'string' && Number.isInteger(account.port) && account.port > 0,
      )
    : [];
}

/**
 * Where a dashboard-created account's daemon answers: the primary backend's
 * host, on the account's own port. The supervisor runs every daemon in the
 * backend container, so the host that reaches the primary reaches them all —
 * and no port needs publishing beyond the compose network.
 */
export function managedAccountUrl(primaryUrl: string, port: number): string {
  const url = new URL(primaryUrl);
  url.port = String(port);
  return url.toString().replace(/\/+$/, '');
}

/**
 * Every backend URL to probe: `ACCOUNT_BACKENDS` plus one per dashboard-created
 * account.
 *
 * A registry that cannot be read adds nothing rather than failing discovery:
 * the configured backends must still be listed — kill-all depends on them —
 * and the primary being unreachable already shows as its own entry.
 */
async function discoverBackendUrls(env: Env = process.env): Promise<string[]> {
  const configured = accountBackendUrls(env);

  let managed: ManagedAccount[] = [];

  try {
    managed = await loadManagedAccounts(env);
  } catch {
    managed = [];
  }

  const primary = defaultApiUrl(env);
  const urls = managed.map((account) => managedAccountUrl(primary, account.port));

  return [...new Set([...configured, ...urls])];
}

/** What a daemon says about itself on `GET /account`. */
export interface AccountInfo {
  alias: string;
  label: string;
  /** Masked (`DU•••567`) — a label for telling accounts apart, never the full id. */
  ibAccountId: string | null;
  mode: ExecutionMode;
  allowedModes: ExecutionMode[];
  broker: { name: string; connected: boolean };
  /** Kill switch engaged, entries halted, or any symbol halted. */
  halted: boolean;
}

/**
 * One configured backend and what it answered.
 *
 * `account` is null when the daemon could not be asked. It is kept in the list
 * rather than dropped: "unreachable" and "not configured" must look different
 * on a control surface, the same reason `GET /positions` answers 503 rather
 * than `[]`.
 */
export interface AccountEntry {
  url: string;
  account: AccountInfo | null;
  error: string | null;
}

/**
 * How long the switcher waits on one daemon. Short, because the layout renders
 * this on every refresh and one hung daemon must not stall the dashboard for
 * every other account.
 */
const ACCOUNT_PROBE_TIMEOUT_MS = 3_000;

/**
 * Asks every configured daemon who it is. Never throws.
 *
 * **Two daemons claiming one alias are both marked in error** rather than one
 * being picked. That is a misconfiguration in which two processes trade — and
 * write — the same account's rows, and the dashboard must not quietly show one
 * of them as though nothing were wrong.
 */
export async function loadAccounts(): Promise<AccountEntry[]> {
  const urls = await discoverBackendUrls();

  const entries = await Promise.all(
    urls.map(async (url): Promise<AccountEntry> => {
      try {
        const account = await get<AccountInfo>(url, '/account', ACCOUNT_PROBE_TIMEOUT_MS);
        return { url, account, error: null };
      } catch (error) {
        return { url, account: null, error: failure(error) };
      }
    }),
  );

  const claims = new Map<string, number>();

  for (const entry of entries) {
    if (entry.account) {
      claims.set(entry.account.alias, (claims.get(entry.account.alias) ?? 0) + 1);
    }
  }

  return entries.map((entry) =>
    entry.account && (claims.get(entry.account.alias) ?? 0) > 1
      ? {
          ...entry,
          error: `more than one backend reports account "${entry.account.alias}"`,
        }
      : entry,
  );
}

export class AccountUnavailableError extends Error {
  constructor(readonly account: string) {
    super(`account "${account}" is not served by any reachable backend`);
    this.name = 'AccountUnavailableError';
  }
}

/**
 * The base URL of the daemon trading `account`.
 *
 * Resolved afresh on every call, never cached: a daemon that restarts on a
 * different port, or a second daemon wrongly started under the same alias,
 * must change the answer immediately — a stale mapping would send a control
 * action to the wrong process.
 */
async function baseUrlFor(account: string): Promise<string> {
  const entry = (await loadAccounts()).find(
    (candidate) => candidate.account?.alias === account && candidate.error === null,
  );

  if (!entry) {
    throw new AccountUnavailableError(account);
  }

  return entry.url;
}

/**
 * Any reachable backend, for the reads that belong to no account — backtests
 * and the bar cache are shared, so every daemon serves the same answer.
 */
async function anyBaseUrl(): Promise<string> {
  const entries = await loadAccounts();
  return (entries.find((entry) => entry.account !== null) ?? entries[0]).url;
}

export type ExecutionMode = 'SHADOW' | 'PAPER' | 'LIVE';
export type LotStatus = 'HELD' | 'CLOSED';
export type RungStatus = 'HELD' | 'WORKING' | 'RE_ARMED' | 'PENDING';
export type ConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'FAILED';
export type OrderStatus = 'SUBMITTED' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED';

/**
 * The fields `LotTable`/`TradeHistoryTable` (and the arithmetic below) need
 * from a held or closed position, regardless of which strategy produced it.
 *
 * `Lot` (the dip ladder) and `GridLot` both satisfy this — that structural
 * overlap is what lets those two components render either strategy's
 * positions without an adapter layer. `rungPrice` is the one field that does
 * not generalize: a grid lot has no rung, so it is optional here and the
 * column that renders it is conditional (`LotTable`'s `showRungColumn`).
 */
export interface LotLike {
  id: string;
  symbol: string;
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
   * A halt restores nothing into the strategy, so these are the only records
   * of the position that remain — and they have **not** been verified against
   * the broker, which is the whole reason the symbol is halted. Optional so an
   * older backend omitting the field reads as verified.
   */
  unverified?: boolean;
  /** The dip ladder's level this lot filled at. Absent for a grid lot. */
  rungPrice?: number;
  /**
   * Which strategy opened this lot — attached client-side when merging
   * `Lot[]` and `GridLot[]` into one shared holdings view (`page.tsx`).
   * Absent on either raw type; a symbol's current holdings are one fact
   * about the broker account, not two separate ones split by strategy, so
   * this is the tag that lets a combined table still say which is which.
   */
  strategy?: string;
}

export interface Lot extends LotLike {
  rungPrice: number;
}

/**
 * A grid strategy's lot, from `GET /grid/lots`. No `rungPrice` — the grid
 * strategy keeps no persisted level ledger to fill from (`GridStrategy`'s own
 * doc comment) — and `workingOrderId`, the resting-sell handle `Rung` gives
 * the ladder for free via `Lot.workingOrderId`-equivalent bookkeeping.
 */
export interface GridLot extends LotLike {
  workingOrderId: string | null;
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
   * The dip ladder's post-close order reconciliation last run. Null until it
   * has fired.
   *
   * Optional so an older backend without the scheduled job renders unchanged
   * rather than breaking the dashboard.
   */
  orderReconciliation?: OrderReconciliationReport | null;
  /**
   * The grid strategy's own order reconciliation last run — a separate job
   * from `orderReconciliation` above, not a duplicate of it. Reported
   * separately rather than merged into one "last reconciliation" field: the
   * two strategies run independent jobs, and collapsing them would either
   * lose which strategy a report belongs to or silently hide one that never
   * fired behind the other's more recent run.
   *
   * A different, narrower shape than `OrderReconciliationReport` — this run
   * carries no `ordersUpdated`, since the grid strategy's job releases a
   * stale `workingOrderId` but does not correct historic `Order` rows the way
   * the ladder's `reconcileOrderHistory` does.
   */
  gridOrderReconciliation?: GridOrderReconciliationReport | null;
}

/**
 * The grid strategy's order-only reconciliation result. See
 * `Status.gridOrderReconciliation`.
 */
export interface GridOrderReconciliationReport {
  ranAt: string;
  symbols: string[];
  brokerReachable: boolean;
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

/**
 * Id prefixes mirroring the backend's own strategy id convention
 * (`DIP_LADDER_ID_PREFIX`/`GRID_ID_PREFIX`) — every instance is `${prefix}${symbol}`,
 * one per traded symbol.
 */
const DIP_LADDER_ID_PREFIX = 'dip-ladder:';
const GRID_ID_PREFIX = 'grid:';

/**
 * Whether any registered dip-ladder instance is currently enabled.
 *
 * Drives which strategy's execution-tab panels the dashboard shows —
 * `page.tsx` hides ladder-specific UI (the rung ladder, its own lots table)
 * when the ladder is not the strategy in use, and the mirror image for grid.
 * Enabled state, not merely "registered", because both strategies are always
 * registered (`strategies.module.ts`) even when only one actually trades.
 */
export function isDipLadderEnabled(strategies: StrategySummary[]): boolean {
  return strategies.some((s) => s.id.startsWith(DIP_LADDER_ID_PREFIX) && s.enabled);
}

/** The grid counterpart to `isDipLadderEnabled`. */
export function isGridEnabled(strategies: StrategySummary[]): boolean {
  return strategies.some((s) => s.id.startsWith(GRID_ID_PREFIX) && s.enabled);
}

/**
 * True when a `ParameterSet` belongs to a grid instance, `false` for a
 * ladder one — the discriminant `parameters/page.tsx` uses to choose between
 * `ParameterEditor` and `GridParameterEditor`, since the two config shapes
 * are otherwise structurally indistinguishable (both are plain numeric-field
 * records).
 */
export function isGridParameterSet(set: ParameterSet): boolean {
  return set.strategyId.startsWith(GRID_ID_PREFIX);
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

/**
 * The grid strategy's editable parameters (`GET /parameters` for a `grid:`
 * id) — deliberately smaller than `LadderParameters`: no spacing mode, no
 * ATR, no take-profit/exit-mode duality. `symbol` and `entryBuffer` are
 * excluded from editing, mirroring the ladder's own exclusion of
 * `symbol`/`symbolCapital`, so they are absent here too.
 */
export interface GridParameters {
  /** Fixed-dollar distance between dip-buy levels, and a lot's sell target above its own fill. */
  gap: number;
  /** Whole-share quantity for every order — entries and exits alike. */
  quantity: number;
  /** How many stepped dip-buy levels to maintain below the lowest held lot. */
  maxBuyLevels: number;
  /** Cap on concurrent resting sells; the oldest/lowest-priced lots (FIFO) get them. */
  maxSellOrders: number;
}

export interface ParameterSet {
  strategyId: string;
  /** The symbol this strategy trades — joins to `riskLimits[symbol]`. */
  symbol: string | null;
  /** Ladder-shaped for a `dip-ladder:` id, grid-shaped for a `grid:` id. */
  parameters: LadderParameters | GridParameters;
}

export interface ParameterChange {
  id: string;
  changeId: string;
  strategyId: string;
  /**
   * A plain string rather than `keyof LadderParameters` — this table is
   * shared by every strategy's editor (`ParameterChange.parameter` on the
   * backend is the same widening, for the same reason: a grid edit's field
   * names, e.g. `gap`, are not ladder parameter names).
   */
  parameter: string;
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
  gridLots: boolean;
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
  /** The grid strategy's own lots (`GET /grid/lots`) — see `Lot` vs. `GridLot`. */
  gridLots: GridLot[];
  /** Set only when **every** read failed — a total backend outage. */
  error: string | null;
  /** Per-endpoint failure flags; absent on loaders that fetch as one unit. */
  unavailable?: Unavailable;
}

/**
 * One edit to the risk layer's per-symbol capital ceiling
 * (`RiskConfig.perSymbolLimits`, `capital-cap.ts`).
 *
 * A different fact from `ParameterChange` above — that audits edits to one
 * ladder's `DipLadderConfig`; this audits edits to the risk-layer ceiling
 * shared across every strategy trading `symbol`.
 */
export interface RiskLimitChange {
  id: string;
  symbol: string;
  oldValue: number | null;
  newValue: number;
  timestamp: string;
  reason: string | null;
}

/**
 * What the Parameters tab renders. `lots`/`gridLots` are only for each
 * editor's held-lot count — see `heldLotCountFor`.
 */
export interface ParametersData {
  parameters: ParameterSet[];
  parameterChanges: ParameterChange[];
  /** Current per-symbol risk limits, keyed by symbol. Absent key = unconstrained. */
  riskLimits: Record<string, number>;
  riskLimitChanges: RiskLimitChange[];
  lots: Lot[];
  /** The grid strategy's own lots — see `heldLotCountFor`. */
  gridLots: GridLot[];
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
async function get<T>(baseUrl: string, path: string, timeoutMs?: number): Promise<T> {
  // A controller rather than `AbortSignal.timeout`, so the timer is cleared the
  // moment the daemon answers instead of outliving every fast request.
  const controller = timeoutMs === undefined ? null : new AbortController();
  const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;

  try {
    response = await fetch(`${baseUrl}${path}`, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      ...(controller === null ? {} : { signal: controller.signal }),
    });
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }

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
export async function loadOrderDiagnosis(account: string): Promise<OrderDiagnosis> {
  return get<OrderDiagnosis>(await baseUrlFor(account), '/orders/diagnosis');
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
export type PostResult<T> = { ok: boolean; status: number; data: T | null; error: unknown };

export async function post<T>(
  account: string,
  path: string,
  body: unknown,
): Promise<PostResult<T>> {
  // Resolved inside the helper's try: an account no reachable daemon claims is
  // a refused action with a reason, never a request sent somewhere else.
  return postTo<T>(() => baseUrlFor(account), path, body);
}

/**
 * A POST to the primary backend — for the one action that belongs to no
 * account yet: creating one.
 */
export async function postToPrimary<T>(path: string, body: unknown): Promise<PostResult<T>> {
  return postTo<T>(async () => defaultApiUrl(), path, body);
}

async function postTo<T>(
  resolveBaseUrl: () => Promise<string>,
  path: string,
  body: unknown,
): Promise<PostResult<T>> {
  try {
    const baseUrl = await resolveBaseUrl();
    const response = await fetch(`${baseUrl}${path}`, {
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
export async function loadStatus(account: string): Promise<StatusData> {
  try {
    return { status: await get<Status>(await baseUrlFor(account), '/status'), error: null };
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
export async function loadExecution(account: string): Promise<ExecutionData> {
  // Resolved once, up front, so every panel on the page reads the *same*
  // daemon. Resolving per read could, in principle, split one render across
  // two processes if the account list changed mid-load.
  const base = baseUrlFor(account);
  const read = async <T>(path: string): Promise<T> => get<T>(await base, path);

  const [status, lots, rungs, positions, orders, fills, riskEvents, strategies, gridLots] =
    await Promise.allSettled([
      read<Status>('/status'),
      read<Lot[]>('/lots'),
      read<Rung[]>('/rungs'),
      read<Position[]>('/positions'),
      read<Order[]>('/orders'),
      read<Fill[]>('/fills'),
      read<RiskEvent[]>('/risk-events'),
      read<StrategySummary[]>('/strategies'),
      read<GridLot[]>('/grid/lots'),
    ]);

  const settled = [status, lots, rungs, positions, orders, fills, riskEvents, strategies, gridLots];
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
    gridLots: valueOr(gridLots, []),
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
      gridLots: gridLots.status === 'rejected',
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
 * Every registered strategy's parameters and their audit trail, for the
 * Parameters tab.
 *
 * `/lots` and `/grid/lots` are fetched only to count each strategy's own held
 * lots for its editor's warning — the count is part of how the "future
 * rungs/levels only" rule is communicated, so it has to describe the
 * strategy actually being edited rather than always the ladder's count (see
 * `heldLotCountFor`).
 */
export async function loadParameters(account: string): Promise<ParametersData> {
  const empty: ParametersData = {
    parameters: [],
    parameterChanges: [],
    riskLimits: {},
    riskLimitChanges: [],
    lots: [],
    gridLots: [],
    error: null,
  };

  try {
    const base = await baseUrlFor(account);
    const [parameters, parameterChanges, riskLimits, riskLimitChanges, lots, gridLots] =
      await Promise.all([
        get<ParameterSet[]>(base, '/parameters'),
        get<ParameterChange[]>(base, '/parameters/changes'),
        get<Record<string, number>>(base, '/risk-limits'),
        get<RiskLimitChange[]>(base, '/risk-limits/changes'),
        get<Lot[]>(base, '/lots'),
        get<GridLot[]>(base, '/grid/lots'),
      ]);

    return {
      parameters,
      parameterChanges,
      riskLimits,
      riskLimitChanges,
      lots,
      gridLots,
      error: null,
    };
  } catch (error) {
    return { ...empty, error: failure(error) };
  }
}

/**
 * Held-lot count for one strategy's parameter editor warning.
 *
 * The ladder's own held lots for a `dip-ladder:` id, the grid strategy's for
 * a `grid:` id — never one strategy's count on the other's editor, which
 * would tell an operator editing the grid's `gap` how many *ladder* lots are
 * unaffected, a fact with nothing to do with the edit they are making.
 */
export function heldLotCountFor(strategyId: string, lots: LotLike[], gridLots: LotLike[]): number {
  const source = strategyId.startsWith(GRID_ID_PREFIX) ? gridLots : lots;
  return source.filter((lot) => lot.status === 'HELD').length;
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
export function blendedAverageCost(lots: LotLike[]): number | null {
  const held = lots.filter((lot) => lot.status === 'HELD');
  const quantity = held.reduce((sum, lot) => sum + lot.quantity, 0);

  if (quantity === 0) {
    return null;
  }

  return round(held.reduce((sum, lot) => sum + lot.fillPrice * lot.quantity, 0) / quantity);
}

/** Distance from a mark price up to a lot's own target, as a fraction. */
export function distanceToTarget(lot: LotLike, mark: number | null): number | null {
  if (mark === null || mark <= 0) {
    return null;
  }

  return (lot.exitTarget - mark) / mark;
}

/** Realized P&L across completed lot cycles. */
export function totalRealized(lots: LotLike[]): number {
  return round(lots.reduce((sum, lot) => sum + (lot.realized ?? 0), 0));
}

export function totalHeldQuantity(lots: LotLike[]): number {
  return lots.filter((lot) => lot.status === 'HELD').reduce((sum, lot) => sum + lot.quantity, 0);
}

export function totalDeployedCost(lots: LotLike[]): number {
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
    const listing = await get<{ runs: BacktestRun[]; count: number }>(
      await anyBaseUrl(),
      '/backtest',
    );

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
      await anyBaseUrl(),
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

/**
 * The cookie recording the last account viewed. Read only by the `/` redirect;
 * nothing that acts on an account consults it (see `AccountContext`).
 */
export const LAST_ACCOUNT_COOKIE = 'lastAccount';

/**
 * Where `/` lands: the preferred account (the last one visited) when a daemon
 * still answers for it, otherwise the first account that answers. `null` when
 * none does.
 *
 * Only ever chooses among reachable, unambiguous accounts — landing an operator
 * on a page whose every control would fail is worse than the "nothing is
 * reachable" page.
 */
export function pickDefaultAccount(
  entries: AccountEntry[],
  preferred: string | null | undefined,
): string | null {
  const usable = entries.filter((entry) => entry.account !== null && entry.error === null);

  return (
    usable.find((entry) => entry.account!.alias === preferred)?.account!.alias ??
    usable[0]?.account!.alias ??
    null
  );
}

/**
 * The account a dashboard path belongs to, and the rest of the path within it:
 * `/accounts/nuuixl118/parameters` → `{ account: 'nuuixl118', rest: '/parameters' }`.
 * `null` for a page that belongs to no account (`/backtest`).
 */
export function accountFromPath(pathname: string): { account: string; rest: string } | null {
  const match = /^\/accounts\/([^/]+)(\/.*)?$/.exec(pathname);

  // `/accounts/new` is the create-account page, not an account; the backend
  // reserves the alias so the two can never collide.
  if (!match || match[1] === 'new') {
    return null;
  }

  return { account: decodeURIComponent(match[1]), rest: match[2] ?? '' };
}

/** The path of `rest` within `account` — the inverse of `accountFromPath`. */
export function accountPath(account: string, rest = ''): string {
  return `/accounts/${encodeURIComponent(account)}${rest}`;
}
