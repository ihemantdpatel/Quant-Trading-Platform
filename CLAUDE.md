# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Follow practices from @WORKING-NOTES.md

## Current State

Stories 0–12 of `stories.md` are built. The engine runs end to end on mock data: fixtures replay
through the dip-ladder strategy, the risk manager, and a mock broker, the resulting state is served
over HTTP, and the dashboard renders it in a browser. `EXECUTION_MODE` is `SHADOW` everywhere and
**nothing is submitted to any broker**.

Story 8 added MySQL/Prisma behind the existing repository interfaces. Story 9 closed the loop:
state is now **restored on boot, but only after it reconciles against the broker** — see
"Persistence and recovery" below. Story 10 added the real IB adapter, the pacing-aware historical
cache, and a live bar feed — see "The IB adapter" below. Story 11 added the backtester. Story 12
added the soak instrumentation — see "The daily soak report" below.

**Story 12's exit criterion is operational and not yet met.** The code it needs is built; what
remains is running `SHADOW` against live IB for a full trading week with zero unexplained
anomalies. `docs/soak-log.md` is the running record and holds the daily procedure and sign-off.
Story 13 (`PAPER`) is gated on that week completing.

`stories.md` is the plan of record; read the relevant story before starting work on it.

## Commands

All backend commands run from `backend/`.

| Command | Purpose |
|---|---|
| `npm test` | Full suite (1283 tests), no database required |
| `npm run test:cov` | Suite + coverage thresholds — what CI gates on |
| `npm run test:db` | The Prisma suites; needs `DATABASE_URL` |
| `npm run test:watch` | Watch mode |
| `npm run prisma:migrate` | Apply committed migrations |
| `npm run prisma:seed` | Instrument vocabulary only — never ladder state |
| `npm run lint` | ESLint, `--max-warnings 0` |
| `npm run build` | `nest build` |
| `npm start` / `npm run start:dev` | Run the daemon (watch mode with `:dev`) |
| `npm run replay -- --fixture chop-range` | Stream a fixture's bars to stdout |
| `npm run fixtures:build` | Regenerate fixture JSON from `definitions.ts` |

**Running a single test:**

```bash
npm test -- src/risk/capital-cap.spec.ts          # one file
npm test -- -t "kill switch halts submission"     # one test by name
```

Formatting is repo-wide from the root: `npm run format` / `npm run format:check`. The shared ESLint
config lives at the root, and its parser resolves from the root `node_modules` — so `npm ci` at the
root is required before either package can lint.

The UI has its own suite (`ui/`): `npm test` runs Jest + React Testing Library over the dashboard
components. `NEXT_PUBLIC_API_URL` points it at the backend (default `http://localhost:3000`).

**Containers:** `docker compose up` starts `mysql` (3306), `backend` (3000), and `ui` (3001). The
backend waits for MySQL to be healthy and applies migrations from its entrypoint before Nest boots.

IB Gateway can come from either place, and **the container is opt-in**:

- **Host app** (the default, and the simpler one — the login already works):
  `IB_HOST=host.docker.internal`, port 4001 live / 4002 paper. `extra_hosts` maps
  `host.docker.internal` so this resolves on Linux too.
- **Container**: `IB_HOST=ib-gateway docker compose --profile ib-gateway up`, with `TWS_USERID` /
  `TWS_PASSWORD` in `.env` (gitignored).

There is deliberately **no `depends_on`** for IB: it may be on the host, in the optional container,
or absent, and compose cannot express "wait only if that profile is active". The adapter's bounded
reconnect handles a Gateway that is not ready — which is the right mechanism anyway, since a Gateway
can also go away after startup.

**A Gateway that is running but not logged in is the awkward case**, not a Gateway that is down: it
accepts the socket and never handshakes. Expect `connect failed … within 15000ms`, then
`IB did not respond within 10000ms`, then a `BROKER_UNAVAILABLE` halt — the API stays up throughout.

**CI** (`.github/workflows/ci.yml`): lint → test with coverage → build, for backend and UI separately.
Coverage thresholds are enforced by Jest exiting non-zero, which fails the job.

## Architecture

A local, personal quantitative trading platform on the Interactive Brokers API. `PRD.md` is the
specification and `project-scope.md` the original design note; `stories.md` sequences the work.

**Stack as built:** NestJS backend daemon (`backend/`) · Next.js App Router + Tailwind dashboard
(`ui/`) · MySQL 8.0 + Prisma · Jest + Supertest · Jest + React Testing Library (`ui/`) ·
Docker Compose.

### The execution path

```
fixture bars ─┐
              ├→ CoordinatorService → strategies → OrderIntent[]
live IB bars ─┘                                          ↓
                                          RiskManagerService  ← the only path to a broker
                                                         ↓
                                                 BrokerAdapter
```

`EngineService` (`src/engine/engine.service.ts`) owns this path. Story 10 added the live source
(`LiveFeedService` → `processBar`, the same unit `replayFixture` calls per bar); **nothing else in
the chain changed**, which is why the fixture suites remain evidence about live behavior.

### Module layout (`backend/src/`)

| Directory | Contains |
|---|---|
| `domain/` | `Contract` — instrument vocabulary shared by every layer |
| `strategies/` | `Strategy` interface, coordinator, contract test suite, dip ladder, three scaffolds |
| `risk/` | The chokepoint: capital caps, loss breaker, kill switch, live guard, startup assertions |
| `reconciliation/` | Lot-sum assertion, per-symbol halt registry, the reconciliation service |
| `broker/` | `BrokerAdapter` interface, `MockBrokerAdapter`, and `ib/` — the `IbSocket` port, its Stoqey implementation, pacing queue, reconnect policy |
| `engine/` | `EngineService` — wires replay → coordinator → risk → broker; `StartupSequence` |
| `api/` | HTTP controllers, incl. the parameter editor enforcing frozen targets |
| `repositories/` | Repository interfaces, the shared contract suite, and two implementations — in-memory and Prisma — bound by `repositories.module.ts` |
| `market-data/` | Bar/Tick types, seeded generator, committed fixtures, replay service, `history/` (cache + backfill + synthetic 3x), `live/` (bar feed + staleness watchdog) |
| `config/`, `health/`, `sentiment/`, `cli/` | Env config, health endpoint, null sentiment provider, replay CLI |

### Four invariants that constrain how code is written

**1. Strategies perform no I/O.** They receive an immutable `StrategyContext` and return
`OrderIntent[]`. They get no broker, no repository, no clock. Enforced two ways, and both matter
because they catch different violations:

- `src/risk/architecture.spec.ts` scans imports — a strategy file referencing `src/broker/` fails.
- `src/strategies/contract-test-suite.ts` injects a context whose forbidden members (`broker`,
  `repository`, `clock`, `submit`, …) **throw on access**, catching a broker passed in at runtime
  that no import scan would see.

This is why `Contract` lives in `src/domain/` rather than `src/strategies/`: the broker needs it, and
importing it from the strategy layer would violate the first rule.

**2. The risk manager is the only path to the broker.** `RiskManagerService.evaluate()` returns
Approved / Resized / Rejected with a reason on every outcome, and emits a `RiskEvent` for every
non-approval. Use `evaluateBatch()` when several intents fire on one bar — it evaluates against a
running capital total, which is what stops five rungs across eight symbols slipping past the global
60% cap. `canSubmit()` gates submission and is false in `SHADOW` by definition.

**3. Strategies are plugins.** New strategies implement `Strategy` (`initialize`, `onTick`, `onBar`,
`evaluate`, `terminate`) and register with the coordinator — never as special cases inside the
coordinator or the broker. Every plugin must pass the shared contract suite:

```ts
runStrategyContractSuite({ name: 'MyStrategy', create: () => new MyStrategy() });
```

`GridStrategy`, `WheelStrategy`, and `LeapsStrategy` are registered, **disabled**, and inert until
Story 16. `DipLadderStrategy` is the only strategy with real behavior.

**4. `StrategyState` is the durable recovery unit.** It must stay JSON-serializable — the contract
suite asserts a round trip after bar processing, where a `Date` or `Map` would otherwise creep in.
Lots and rungs live in ladder state, and re-arming must survive a restart.

### Dip ladder specifics

The strategy is an adapter (`dip-ladder.strategy.ts`) over pure modules — `anchor.ts`, `spacing.ts`,
`session-window.ts`, `invalidation.ts`, `lot.ts`, `rung.ts`, `exits.ts`. **Put rule changes in the
pure modules, not the adapter.** `replay-ladder.ts` is a test harness, not the production engine.

Rules that are easy to break by accident:

- Each lot exits at **its own** fill price +5%, never the blended average. Blended cost is display-only.
- **Lots only ever exit in profit.** No stop-loss, no loss-booking exit, at any level.
- A rung re-arms at its **original** price and may fire again; re-armed empty rungs don't count
  against the 5-concurrent limit.
- The hard floor at −25% stops adding but **never sells**.
- Firing is 09:45–16:00 ET only; the anchor is still computed from the 09:30 open.

### Parameter edits apply to future rungs only

`POST /parameters/:strategyId` edits ladder parameters at runtime. **A held lot's exit target is
frozen at the parameters in force when it filled** (`PRD.md:386`) — a full recompute would let one
edit move a live position into or out of an exit condition.

This holds structurally rather than by a guard: `openLot` **stores** `exitTarget` on the lot, and
`evaluateBar` reads config **fresh each bar**. So `ParameterService` mutates the shared
`DipLadderConfig` **in place** — the same object instance the strategy holds, registered from
`EngineModule`. Rebuilding the strategy would discard its lots and rungs; recomputing targets is the
forbidden operation. **Do not "fix" the in-place mutation** — it is what makes the rule true.

The editable set excludes `symbolCapital` and `symbol`, and lot/rung fields are absent entirely, so
no request shape can retarget a filled rung. Every change is written append-only with old value, new
value, timestamp, and the strategy state at the time.

### Persistence and recovery

`DATABASE_URL` is the **only** switch. Set → the Prisma repositories; unset → the in-memory ones and
the Story 0 zero-dependency path. `GET /status` reports `storage: DURABLE | IN_MEMORY`. Both
implementations run the *same* suite (`src/repositories/repository-contract.suite.ts`), which is what
keeps them from drifting.

Three rules that are easy to break:

- **`ParameterChange` is append-only in the database**, via `BEFORE UPDATE`/`BEFORE DELETE` triggers,
  not just by an interface lacking `update`. So `PrismaParameterChangeRepository.clear()` is a
  documented no-op, and `engine.reset()` deliberately never clears the audit trail.
- **`Fill.clientOrderId` is indexed but not a foreign key.** A fill must be recordable when its order
  row is missing — that is the crash window reconciliation reasons about, and an FK would reject the
  evidence it needs.
- **Money is `DECIMAL(18,6)`**, converted to `number` only at the repository boundary
  (`prisma/decimal.ts`). Do not widen the domain types to `Decimal`; that would push persistence into
  the strategy layer, which may not import anything I/O-shaped.

### Reconciliation: the DB never restores without the broker's agreement

`StartupSequence` (`src/engine/startup.sequence.ts`) runs **before any bar reaches a strategy**:
connect broker → `initializeAll` (empty state, no hooks) → `reconcileAll` → open the gate.
`EngineModule.onModuleInit` calls it; nothing else should.

**The lot-sum assertion is the whole decision** (`PRD.md:343`). The broker is authoritative on *how
many shares exist*; the database is authoritative on *which lots they are*. The only fact checkable
across that boundary is the total, so: summed held-lot quantities == broker net position → resume
with the exact lot structure. Anything else → halt the symbol.

- **There is no tolerance band and no repair path.** Scaling lots, synthesizing one for the
  difference, or dropping the oldest are all guesses at composition, and guessing wrong means selling
  the wrong lot at the wrong target on a 3x ETF with no stop underneath.
- **A halted symbol is not evaluated at all** — `processBar` returns before `dispatchBar`. This is
  stricter than the engine's `entryHalt`, which still permits exits; here exits are the danger, since
  FIFO would pick from records that disagree with reality. Positions are held, never liquidated.
- A halt also **suppresses persistence for that symbol**, so the empty in-memory ladder cannot
  overwrite the stored lots an operator needs to resolve it.
- Halts clear only via `POST /halts/:symbol/release`. `POST /engine/reset` deliberately does not.
- An unreachable broker is `null`, not `[]` — "unknown" must halt where "flat" may reconcile.

**`StrategyStateSnapshot` carries the anchor, and only the anchor.** Lots and rungs are restored from
their own tables (authoritative on composition); the snapshot supplies `sessionOpen`,
`previousSessionClose`, `firstEntryPrice`, `lotSequence`, `sessionDate`, `runningClose`, which live
nowhere else. One authority per fact — do not restore lots from the snapshot's copy. Snapshots are
append-per-save so a crash mid-write leaves the previous good one readable, and a `version` the
running code does not recognize is **rejected**, never coerced.

In `SHADOW` the database legitimately diverges from the broker — the ladder records intents that were
never submitted — so a restart in SHADOW with a held ladder halts on the lot-sum assertion. That is
correct, not a bug.

On Apple Silicon, Prisma's engines fail against MySQL with a misleading `sha256_password` error;
run the CLI and `test:db` through a Linux container. `backend/prisma/README.md` has the commands.

### The IB adapter (Story 10)

`IB_HOST` is the **only** switch. Set → `IBBrokerAdapter` and the live bar feed; unset → the mock
broker and fixture replay. Same convention as `DATABASE_URL`, for the same reason: one variable
cannot contradict itself. `GET /status` reports which broker is live. **Selecting IB does not enable
submission** — `EXECUTION_MODE` governs that, and `SHADOW` submits nothing whichever broker is bound.

**`stoqey-ib-socket.ts` is the only file that imports `@stoqey/ib`.** Everything above it depends on
the `IbSocket` port, so IB's vocabulary stops there. That containment is what lets the whole Story 10
suite run offline against `FakeIbSocket` — socket drops, forced re-auth, and a feed that goes quiet
all happen on cue, and none of them is reproducible against a live Gateway.

- **Every historical request goes through `PacingQueue`.** ~60 req/10 min and no identical request
  within 15s are correctness requirements, not optimizations: breaching them yields no error, just
  silent throttling or a dropped connection (`PRD.md:289`). Requests **wait, never drop** — a
  discarded request would leave a gap indistinguishable from "the market was closed".
- **The pacing window resets on reconnect**, because IB counts per session.
- **Re-auth is routine, a socket drop is a fault.** IB reports both on the same error channel; only
  the code (1100/1101/1102) distinguishes them. Alerting on the daily logout would train an operator
  to ignore alerts.
- **Retries exhausted → `FAILED` → new entries halt, positions untouched.** There is no code path
  from a technical fault to a sell, and none may be added.
- **Stale data is its own fail-safe trigger.** A connected socket that stopped delivering is more
  dangerous than a dropped one — nothing looks wrong while the ladder evaluates against a stale
  price. `LiveFeedService` watches it and halts *new entries only*.

**The HTTP server must never wait on the broker.** `EngineModule.onModuleInit` runs *before*
`app.listen()`, so `startup.run()` is deliberately **not awaited** — the live feed starts from its
`.then()`. Awaiting it made the API's availability depend on IB being reachable, which is precisely
when an operator most needs the dashboard. This does not weaken Story 9: the guarantee is
`hasReconciled()`, which gates bar dispatch, not the ordering against `listen`.

**Every IB call needs a timeout, because an unauthenticated Gateway hangs rather than refusing.** It
accepts the TCP connection and then says nothing, so the Observables behind `getPositions` /
`getAccountSummary` never emit *and* never error. `firstValue` enforces a 10s bound. Without it the
hang landed inside `onModuleInit`, the process never bound its port, nothing held the event loop
open, and Node **exited 0** — a clean exit that compose restarts forever, with no stack trace to
explain it. `first-value.spec.ts` is the regression.

The pure wire conversions live in `ib-wire.ts`, separate from the socket, so they stay under the
coverage threshold while the Gateway-dependent plumbing is excluded from it. That is where a
mis-encoded payload or misread timestamp would come from; it is covered at 100%.

### Historical cache: IB is called only for gaps

All history is served from MySQL (`BarRepository`); IB fills gaps only. A **fully-cached range issues
zero IB requests**, and that count is asserted directly rather than inferred.

The hard part is that **an absent bar has two causes** — the market was closed, or we never fetched
it — and only the second is a gap. Treating every quiet stretch as a gap re-requests Christmas Day
forever; treating a real gap as a holiday leaves a permanent hole a backtest reads as a flat market.
The resolution is coverage-based: a range is cached when no interior span exceeds `maxGapMs`.

- `BarRepository.saveAll` **upserts** on `(symbol, barSize, timestamp)`. Gap-fill ranges overlap at
  their edges deliberately — a boundary bar is safer re-fetched than missed.
- **Backfill skips cached chunks; incremental fill must not.** Incremental's range starts at the
  newest cached bar by construction, so the resume check would skip it forever (`skipCached`).
- **Synthetic bars are excluded from reads unless explicitly requested.** Naive 3x compounding
  excludes the expense ratio and financing costs real leveraged ETFs pay, so it is optimistic in
  exactly the choppy regimes this strategy targets. `synthetic: true` plus the default exclusion mean
  silent mixing requires opting in twice. TQQQ pre-dates Feb 2010 only as synthesized QQQ.

### Two deliberately-unset values

`RiskConfig.dailyLossThreshold` and per-symbol capital allocation are `null` on purpose
(`PRD.md:500`). `src/risk/startup-assertions.ts` refuses to boot `PAPER`/`LIVE` while either is unset,
and `POST /mode` reuses that same assertion so the HTTP path cannot permit what boot would refuse.
**Story 13 sets these — do not set them earlier, and do not paper over them with a default.**

`SHADOW` uses a nominal display figure (`shadowNotional()` in `strategies.module.ts`) purely so
replayed intents have non-zero quantities. It returns `null` for any non-SHADOW mode, so it cannot
reach a mode that submits, and `SYMBOL_CAPITAL` still reports `null` so the assertion stays honest.
It is not the Story 13 decision.

### The daily soak report (Story 12)

`DailyReportService` builds a per-session summary for the `SHADOW` soak, served from
`GET /reports/daily?date=yyyy-MM-dd`. `docs/soak-log.md` holds the daily procedure, the anomaly
table, and the exit sign-off.

- **It reads persisted evidence rather than counting as bars arrive.** The soak includes deliberate
  mid-session restarts, and an in-memory counter would under-report exactly the sessions containing
  the event under scrutiny. The consequence is that a complete report needs `DATABASE_URL`; the
  report states its `storage` mode so a reader knows whether it is seeing a full day.
- **The rung check is a recomputation, not a readback.** Expected rung prices are derived from the
  session's persisted anchor scalars through the same pure modules the strategy uses
  (`resolveAnchor`, `nextRungPrice`) — *not* from the ladder's own rung list, which would be a test
  that cannot fail. Agreement means two independent paths reached the same prices.
- **The snapshot must be the reported session's, not the newest.** `findLatest` would anchor
  Tuesday's report on Friday's `sessionOpen` and report a full day of false mismatches.
- **A skip is not a pass.** A session with no snapshot raises `RUNG_VERIFICATION_SKIPPED` and does
  not count toward a clean week — "could not check" must never read as "checked and fine".
- **The service holds no broker.** It depends on `RECONCILIATION_READ_MODEL`, a one-method port,
  rather than `ReconciliationService`, which carries the adapter. That is what makes "no report can
  place an order" structural.
- In `SHADOW` a restart with a held ladder legitimately halts on the lot-sum assertion, so
  `RECONCILIATION_MISMATCH` is expected there and is **not** a soak anomaly — see the note in
  `docs/soak-log.md`.

Note that `EngineService.persistLadderState` runs once per **replay**, not per session, so a
replayed multi-day fixture leaves only one snapshot. The live feed persists as bars arrive, so each
live session gets its own. This is why `reports.integration.spec.ts` verifies rungs against the
fixture's final session and asserts a skip for an earlier one.

### HTTP API

Read: `GET /health` `/status` `/intents` `/orders` `/fills` `/lots` `/rungs` `/positions`
`/risk-events` `/strategies` `/halts` `/reports/daily`

`GET /status` gains `broker.pacing`, `broker.dataStale`, and `broker.lastBarAt` when IB is bound.
Pacing is reported because breaching IB's limits produces no error of its own — a filling queue is
the only early warning there is.

Read: `GET /parameters` `/parameters/changes` `/parameters/:strategyId`

Control: `POST /engine/replay` `{fixture}` · `/engine/reset` · `/kill-switch` `{engaged, reason}` ·
`/strategies/:id/enable|disable` · `/mode` `{mode}` · `/parameters/:strategyId` `{parameters, reason}` ·
`/halts/:symbol/release`

```bash
curl -X POST localhost:3000/engine/replay -H 'Content-Type: application/json' \
  -d '{"fixture":"chop-range"}'
curl localhost:3000/lots
```

## Testing

1283 backend tests across 68 suites, plus database tests (`npm run test:db`, needs MySQL) and 82 UI
component tests. Coverage thresholds are enforced in CI: **80% global, 95% on
`src/strategies/**` and `src/risk/**`** — those are pure functions where a bug costs real money.

The database suites **skip** without `DATABASE_URL` so `npm test` needs no external dependencies.
Because a skipped suite looks exactly like a passing one, CI sets `REQUIRE_DATABASE_TESTS=1` and
`database-required.spec.ts` fails the job if the database is missing or unreachable.

- Fixtures are committed data in `src/market-data/mock/fixtures/`: `chop-range` (rung cycling),
  `steady-decline` (ladder extension to the floor), `gap-down-open`, `gap-down-recover`,
  `session-edges`. They are strategy-agnostic and each carries machine-checked invariants.
- Replay is deterministic — the same fixture always produces identical intents. Tests depend on this.
- The mock broker is deterministic too (no clock, no randomness) and models partial fills,
  rejections, disconnects, and exponential-backoff reconnect.
- Integration tests drive the assembled app over Supertest. Because the app boots in `SHADOW`, the
  submission path is only reachable by constructing `EngineService` directly in `PAPER` — see
  `src/engine/engine.service.spec.ts`.
- Prefer adding a case to an existing scenario suite over a new bespoke harness.

**Do not write a test that can never fail.** `architecture.spec.ts` tests its own detector for this
reason; a safety check that cannot fail reports confidence it has not earned.

## Working Constraints

- Testing and containerization are in scope, not follow-ups. Coverage must include order payload
  generation, broker-disconnect handling, and state recovery after restart.
- Everything runs locally in containers — no cloud deployment target.
- **A technical fault must never become a realized loss.** On a disconnect or exhausted retries: halt
  new entries, raise an alert, and leave existing positions alone. No code path may auto-liquidate.
- This code places real orders through a broker. `SHADOW` is the default and stays so until Story 13.
  Confirm before any change that could affect live order submission.
