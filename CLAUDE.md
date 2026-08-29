# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Follow the practices in "Working style" at the end of this file.

## Current State

Stories 0–13 of `docs/stories.md` are built. The engine runs end to end: fixtures or live IB bars
feed the dip-ladder strategy, the risk manager, and a broker adapter, the resulting state is served
over HTTP, and the dashboard renders it in a browser.

**`SHADOW` is retired and `PAPER` is the default.** This is the largest change since Story 12, and
it is not a loosening of a safety default — it is a consequence of Story 13's other change. Entries
now **rest at the broker as limit orders**, so a lot exists only once a fill arrives. A mode that
submits nothing would record intents forever and never open a lot, reporting a position history the
system could never actually produce. `assertStartupSafe` therefore **refuses** `SHADOW` at boot
rather than exempting it; the enum member survives only so historic `ParameterChange` and
`RiskEvent` rows still parse. See `config/execution-mode.ts`.

**Real orders now reach a paper account.** `PAPER` submits to IB. `LIVE` remains gated on Story 15.

Story 8 added MySQL/Prisma behind the existing repository interfaces. Story 9 closed the loop:
state is now **restored on boot, but only after it reconciles against the broker** — see
"Persistence and recovery" below. Story 10 added the real IB adapter, the pacing-aware historical
cache, and a live bar feed — see "The IB adapter" below. Story 11 added the backtester. Story 12
added the soak instrumentation — see "The daily soak report" below. Story 13 set the two capital
decisions, retired `SHADOW`, and moved entries onto resting limit orders — see "Resting limit
orders" and "The capital decisions" below.

**The soak's premise changed with the mode.** The Story 12 `SHADOW` week is superseded: what runs
now is a `PAPER` soak against live IB, where `intents.submitted` is *expected* to be non-zero and
reconciliation is expected to be **clean** rather than legitimately halted. `docs/soak-log.md` holds
the revised procedure and sign-off. Story 14 is that soak; Story 15 (`LIVE`) is gated on it.

`docs/stories.md` is the plan of record; read the relevant story before starting work on it.

## Commands

All backend commands run from `backend/`.

| Command | Purpose |
|---|---|
| `npm test` | Full suite (1568 tests), no database required |
| `npm run test:cov` | Suite + coverage thresholds — what CI gates on |
| `npm run test:db` | The Prisma suites; needs `DATABASE_URL` |
| `npm run test:watch` | Watch mode |
| `npm run prisma:migrate` | Apply committed migrations |
| `npm run prisma:seed` | Instrument vocabulary only — never ladder state |
| `npm run lint` | ESLint, `--max-warnings 0` |
| `npm run build` | `nest build` |
| `npm start` / `npm run start:dev` | Run the daemon (watch mode with `:dev`) |
| `npm run replay -- --fixture chop-range` | Stream a fixture's bars to stdout |
| `npm run recover:lots -- --symbol TQQQ` | Operator repair for a position stranded by a dropped fill |
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

**Containers:** `docker compose up` starts `mysql` (published on host 3307 — 3306 is usually a
locally installed MySQL, and the clash is silent; `MYSQL_HOST_PORT` overrides, and containers still
talk to `mysql:3306`), `backend` (3000), and `ui` (3001). The
backend waits for MySQL to be healthy and applies migrations from its entrypoint before Nest boots.

IB Gateway can come from either place, and **the container is opt-in**:

- **Host app** (the default, and the simpler one — the login already works):
  `IB_HOST=host.docker.internal`, port 4001 live / 4002 paper. `extra_hosts` maps
  `host.docker.internal` so this resolves on Linux too.
- **Container**: `IB_HOST=ib-gateway docker compose --profile ib-gateway up`, with `TWS_USERID` /
  `TWS_PASSWORD` in `.env` (gitignored).

There is deliberately **no `depends_on`** for IB: it may be on the host, in the optional container,
or absent, and compose cannot express "wait only if that profile is active". The adapter's reconnect
handles a Gateway that is not ready — which is the right mechanism anyway, since a Gateway can also
go away after startup. A Gateway that starts *after* the daemon is picked up by the slow retry poll
rather than needing a restart; see "`FAILED` is not terminal" under the IB adapter.

**A Gateway that is running but not logged in is the awkward case**, not a Gateway that is down: it
accepts the socket and never handshakes. Expect `connect failed … within 15000ms`, then
`IB did not respond within 10000ms`, then a `BROKER_UNAVAILABLE` halt — the API stays up throughout.
That halt is a *reconciliation* halt and stays until released by hand, even once the connection
recovers: the broker being reachable again is not evidence that positions reconcile.

**CI** (`.github/workflows/ci.yml`): lint → test with coverage → build, for backend and UI separately.
Coverage thresholds are enforced by Jest exiting non-zero, which fails the job.

## Architecture

A local, personal quantitative trading platform on the Interactive Brokers API. `docs/PRD.md` is the
specification and `docs/project-scope.md` the original design note; `docs/stories.md` sequences the
work.

**In-code citations like `PRD.md:343` refer to `docs/PRD.md`.** The files moved into `docs/` when the
README was rewritten for outside readers; their contents were not edited, so every line number in
those ~395 comments still resolves.

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
                                                         ↓
                                          limit order rests at IB
                                                         ↓
                            fill (minutes/hours later, or never) ──┐
                                                                   ↓
                              EngineService.routeFill → openLotFromFill → Lot
```

`EngineService` (`src/engine/engine.service.ts`) owns this path. Story 10 added the live source
(`LiveFeedService` → `processBar`, the same unit `replayFixture` calls per bar).

**Story 13 added the return leg, and it is the part that changes how you reason about the code.**
Under the original rule a bar produced an intent and the lot appeared on the same bar, so the
downward path was the whole story. With resting orders the ladder's entry decision and its position
are separated by an unbounded delay: `evaluateBar` places an order, and the lot is created only when
IB reports a fill — possibly on a much later bar, possibly never. Two consequences worth holding on
to:

- **A fill arrives with no listener unless something long-lived is subscribed.** `submitOrder`'s own
  subscription is torn down in its `finally`, which sufficed only while orders filled inside the
  submit call. `EngineService`'s constructor subscribes `onFill`/`onOrderStatus` **once for the life
  of the process** for exactly this reason.
- **The fixture suites no longer cover the live entry rule end to end.** They run
  `OrderPlacement.IMMEDIATE`, which is still the default in `DEFAULT_DIP_LADDER_CONFIG`; the live
  engine selects `RESTING` in `strategies.module.ts`. So the fixtures remain evidence about the
  ladder's *arithmetic* — anchors, spacing, exits — but the resting path is covered separately by
  `resting-orders.spec.ts` and the reconciliation suites. Do not read a green fixture run as
  evidence about resting-order behavior.

### Module layout (`backend/src/`)

| Directory | Contains |
|---|---|
| `domain/` | `Contract` — instrument vocabulary shared by every layer |
| `strategies/` | `Strategy` interface, coordinator, contract test suite, dip ladder, three scaffolds |
| `risk/` | The chokepoint: capital caps, loss breaker, kill switch, live guard, startup assertions |
| `reconciliation/` | Lot-sum assertion, per-symbol halt registry, the reconciliation service, the post-close order job |
| `broker/` | `BrokerAdapter` interface, `MockBrokerAdapter`, and `ib/` — the `IbSocket` port, its Stoqey implementation, pacing queue, reconnect policy |
| `engine/` | `EngineService` — wires replay → coordinator → risk → broker; `StartupSequence` |
| `api/` | HTTP controllers, incl. the parameter editor enforcing frozen targets |
| `repositories/` | Repository interfaces, the shared contract suite, and two implementations — in-memory and Prisma — bound by `repositories.module.ts` |
| `market-data/` | Bar/Tick types, seeded generator, committed fixtures, replay service, `history/` (cache + backfill + synthetic 3x), `live/` (bar feed + staleness watchdog) |
| `config/`, `health/`, `sentiment/`, `cli/` | Env config, health endpoint, null sentiment provider, replay + `recover-lots` CLIs |

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
60% cap. `canSubmit()` gates submission.

**With `SHADOW` retired, `canSubmit()` is true in the default mode.** It used to be false by
definition, and a good deal of prose leaned on that. The chokepoint is unchanged — every intent
still passes `evaluate()` — but "the risk manager approved it" now means an order actually goes to
IB, so the caps and the loss breaker are load-bearing rather than advisory.

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

- Each lot exits at **its own** fill price plus the configured take-profit, never the blended
  average. Blended cost is display-only. The *amount* is geometry-dependent — see "Fixed-dollar
  geometry" below; the per-lot derivation is the invariant, not the 5%.
- **Lots only ever exit in profit.** No stop-loss, no loss-booking exit, at any level.
- A rung re-arms at its **original** price and may fire again; re-armed empty rungs don't count
  against the 5-concurrent limit.
- The hard floor at −25% stops adding but **never sells**.
- Firing is 09:45–16:00 ET only; the anchor is still computed from the 09:30 open.
- The bootstrap anchor is `max(previousClose, open)` **except on a gap down past
  `gapRebasePercent`**, where it re-bases onto the open. Off by default (`null`), opted into at 1% in
  `strategies.module.ts` — see "Gap re-basing" below.
- The firing window governs **entries only**. A lot at its frozen take-profit target may exit at any
  point in the regular session, including the 09:30–09:45 opening auction — `onBar` runs `selectExit`
  before the window is consulted. Counting exits as window violations produced false anomalies; see
  the daily report section.

### Fixed-dollar geometry — what the live engine actually trades

**The live ladder is not the 5% ladder the fixtures describe.** `strategies.module.ts` selects
`SpacingMode.FIXED_DOLLAR` with `spacingDollars: 1`, `takeProfitDollars: 1`, and
`fixedQuantity: 50` — targeting **USD 50 per completed cycle** at any price level, since
`spacingDollars × fixedQuantity` is price-independent where a percentage is not (1% of $72 and 1% of
$100 are different amounts of money).

| Field | Default (fixtures) | Live engine |
|---|---|---|
| `spacingMode` | `PERCENTAGE`, 5% | `FIXED_DOLLAR`, $1 |
| take-profit | `takeProfitPercent` 5% | `takeProfitDollars` $1 |
| quantity | `floor(symbolCapital × sizePerRung / price)` | `fixedQuantity` 50 |

All three are **opt-in**, for the same reason `orderPlacement` is: the committed fixtures' expected
intents were computed under the percentage rule, and changing a default would silently invalidate
them. `takeProfitDollars` and `fixedQuantity` are `null` by default and *supersede* their percentage
counterparts when set.

- **`takeProfitDollars` is set equal to `spacingDollars` deliberately**, so a lot's target lands
  exactly on the rung above it and a rung freed by an exit is the level the next entry re-arms at.
- **`fixedQuantity` bypasses `symbolCapital` entirely** — sizing no longer consults the allocation.
  It does *not* bypass the risk layer: every intent still crosses `RiskManagerService`, so a fixed
  quantity is a request, not a guarantee. A full 5-rung ladder deploys ~$17,250 against the 40,000
  allocation.
- **The hard floor stops binding.** Five $1 rungs span $5 while a 25% floor sits ~$18 below a $72
  anchor, so the ladder exhausts `maxConcurrentRungs` long before the floor is consulted. The rung
  count is the binding constraint now, not the floor. `live-geometry.spec.ts` pins this.

**The backtest evidence argues against this geometry, and it was overridden deliberately.** Over the
committed drawdown scenarios, $1 rungs fill the whole ladder within $5 of price and leave nothing to
cycle: the 2020 crash-and-recovery scenario completes 4 cycles for **+$1,477** under 5% spacing and
**zero** under this one, sitting fully extended 94.9% of the time against 73.2%. The ladder earns by
cycling upper rungs while lower ones hold, and one that is always fully extended has nothing to
cycle. Accepted for a **paper** account, where the purpose is observing live mechanics rather than
return. `fixed-dollar-comparison.spec.ts` regenerates the comparison. **Story 15 must revisit this
alongside the capital figures before `LIVE`.**

**One known reporting gap follows from it.** The daily report's rung recomputation seeds
`knownRungs` only from lots held entering the session plus levels its own walk derives — so a rung
established in an earlier session, re-armed and still empty at the open, is invisible to it and the
engine's legitimate re-arm is reported as `RUNG_VERIFICATION_UNEXPLAINED`. The gap predates this
geometry; $1 spacing merely makes the ladder revisit levels often enough to reach it. The seeding is
deliberate — the service refuses to read the ladder's own rung ledger back, because that readback is
the comparison it exists to avoid — so closing it means finding a rung source that is not the
ladder's own ledger. **Relevant to the soak: this anomaly is expected and does not by itself
invalidate a week**, unlike every other anomaly code.

### Gap re-basing — why a stale anchor stops the live ladder

`max(previousClose, open)` implements "wait rather than chase" (`PRD.md:67`): on a gap down the
previous close wins, so the first rung sits a spacing unit below a level price has already left.
Under `IMMEDIATE` that only delays an entry. **Under `RESTING` it prevents one entirely** — the rung
is above the market, `isRestable` refuses to place a marketable BUY limit there, and the ladder
places *nothing* for as long as the gap holds.

The fixed-dollar geometry turned that from tolerable into acute. A $1 rung is ~1.4% at a $72 price,
while an ordinary 2% TQQQ gap is ~$1.44 — wider than a rung — so the whole ladder can sit stranded
above the market on exactly the down days it exists to work.

`gapRebasePercent` re-bases the bootstrap anchor onto the session open past a threshold, putting
rungs where the market can reach them.

- **It changes where levels sit, not how they are ordered.** Entries remain resting limit orders
  below the market; nothing here emits a market order. That matters because a lot has **no stop-loss
  underneath it** — a market order into a gapped-open 3x ETF book is a fill price the ladder must
  then hold until it reaches take-profit, however long that takes.
- **Bootstrap only.** Progression takes precedence whenever anything is held, so a ladder holding
  through a gap keeps extending below its own exposure rather than re-basing above it.
- **One-directional.** A gap *up* already re-bases through the max rule; the threshold applies only
  to gaps down, where the max rule is what strands the anchor.
- **Default `null`, opted in at 1%** in `strategies.module.ts`, for the same reason as
  `orderPlacement` and `fixedQuantity`: `scenarios.spec.ts` pins the `gap-down-open` fixture's first
  rung at 95.00 under the plain max rule, and a default would silently invalidate it. 1% sits just
  above the $1 spacing so the rule fires when a gap has consumed roughly a rung's worth of distance.
- **Not runtime-editable**, alongside `orderPlacement`: editing it while orders rest at levels the
  old rule chose would desynchronize the working orders from the rule that placed them.
- **The daily report must be passed the config.** `reconcileRungs` recomputes anchors via
  `resolveAnchor`, so omitting it would anchor every gap-down session on the previous close while the
  engine used the open — a full session of false `RUNG_VERIFICATION_UNEXPLAINED`. This stays a
  recomputation, not a readback: the config supplies the rule, exactly as spacing already does.
- Operator-chosen, not backtest-derived. **Story 15 must revisit it with the capital figures and the
  fixed-dollar geometry before `LIVE`.**

### Resting limit orders (Stories 13 and 14a)

**Story 13 rested entries; Story 14a rested exits.** For a while only half the path was converted,
and the asymmetry was the defect: `isRestingEntry` returned false for any SELL, so an exit was
submitted with no working-order registration and no persistent fill routing, and `applyExit` closed
the lot and re-armed its rung when the *intent* was created. A rejected or expired sell therefore
left the ladder believing it was flat at a level it still held — free to buy there again against
exposure it had never released — and booked the close at the assumed target rather than a real fill
price. Both sides now rest; `isRestingOrder` is the general test and `isRestingEntry` the narrower
one kept for rung bookkeeping, which is meaningful only for entries.

**`OrderPlacement` selects when an order is created, and it changes what a rung means.**

| Mode | Order created | Where it lives |
|---|---|---|
| `IMMEDIATE` | Only once a bar **closes** at or below the rung (`PRD.md:92`) | `DEFAULT_DIP_LADDER_CONFIG` — every committed fixture |
| `RESTING` | Placed **at** the rung in advance; the exchange fills it on the way through | `strategies.module.ts` — the live engine |

The reason for the change: a dip that wicks through a rung intra-bar and recovers before the close
fired *nothing* under `IMMEDIATE`. The ladder bought the close, not the dip — which is the opposite
of what a predetermined-level ladder is for.

**The default stays `IMMEDIATE` deliberately.** The committed fixtures' expected intents were
computed under that rule, and changing the default would silently invalidate them. `RESTING` is
selected in exactly one place.

**`RungStatus.WORKING` is the state that makes this possible.** Before it, "empty" and "fireable"
were the same question and `lotId === null` answered both. A rung with an order resting at it holds
no lot but **must not fire again** — otherwise every bar stacks another order at the same price.

- `isFireable()` excludes `WORKING` as well as `HELD`. This is the whole guard.
- `WORKING` is distinct from `PENDING`, and the difference only shows up on restart: a `WORKING`
  rung has an order at IB that reconciliation must find, a `PENDING` one does not.
- `committedRungCount()` counts held lots **plus** working rungs against `maxConcurrentRungs`. A
  resting order is exposure already committed; counting only filled lots would let a sixth order be
  placed and breach the limit the instant it filled, with no point at which the limit could
  intervene. Over-counting costs a declined rung; under-counting costs real exposure past the
  ceiling.
- Rung selection differs by mode: `RESTING` uses `highestFireableRung`, which **ignores where price
  is**. Requiring the bar to have reached the level would forfeit the intra-bar fill the resting
  order exists to capture, and would strand a released rung whenever price sits above it.

**Ordering rules that are easy to get wrong, and were:**

- **The rung is marked `WORKING` *before* `submit()`, not after.** A marketable limit can fill
  *during* the submit call. Marking afterwards lets the fill land first, find no rung, and then be
  overwritten by a `WORKING` mark for an order that already completed. Rejection and submission
  failure both undo the mark, so a rung is never blocked for an order that does not exist.
- **A partial fill cancels its remainder and opens a lot for what filled.** A resting order that
  fills 40 of 100 and then sits is a position the ladder is carrying without having decided to.
  Cancelling makes the rung's exposure final and knowable; the lot's target follows from the real
  fill price for the real quantity. A smaller position than intended is the safe direction. A failed
  cancel is a technical fault → halt new entries, positions untouched.
- **`workingOrders` is in-memory and is not the source of truth.** `Rung.workingOrderId` is the
  durable record, and the map is rebuilt by `adoptWorkingOrders` during reconciliation — a fill
  carries only broker vocabulary and nothing identifying which rung placed it, so the map is where
  `rungPrice` is kept between placement and fill.

**On the exit side the same rules hold, keyed to the lot rather than the rung:**

- **`Lot.workingOrderId` is the durable record**, the counterpart to `Rung.workingOrderId`.
  `selectExit` and `selectRestingExits` both skip a lot that has one — without it every bar stacks
  another sell against shares one order already covers, which is the bug `RungStatus.WORKING`
  prevents on the entry side.
- **A sell is placed as soon as the lot opens**, not when price approaches the target. `exitTarget`
  is frozen above `fillPrice` at open, so the limit is non-marketable on arrival by construction —
  this is why `isRestableExit` (the mirror of `isRestable`) always passes in normal operation. It
  earns its place on the one case where the premise fails: a lot reconstructed by `recover:lots`
  whose target is already below the market, where the right action is to place nothing rather than
  dump shares into a marketable sell.
- **Waiting for price to approach the target was considered and rejected.** The arming decision could
  only be made from bar closes, so a rally crossing the arm distance *and* the target inside one bar
  would arrive with no order resting — the intra-bar miss the whole change exists to remove.
- **A partial sell splits the lot** rather than shrinking it: the filled portion closes at the real
  fill price, the remainder stays `HELD` with the **same `fillPrice`, `exitTarget`, and `openedAt`**
  and a fresh id. Shrinking would change a lot's composition after open (`PRD.md:386`) and there is
  nowhere to record profit already taken — `realizedPnl` multiplies by a lot's whole quantity. The
  split keeps `sold + remainder == original`, so the lot-sum assertion is unaffected. The rung
  deliberately does **not** re-arm while the remainder is held.
- **The duplicate guard must not consult `Lot.workingOrderId`.** `selectRestingExits` already filters
  on it, so a duplicate sell can only arise when that field is *wrong* — state restored from a write
  that predates the mark, an adopted order, a fill router that has not run. A guard re-reading it
  agrees with it and lets the duplicate through, which is what it did. `restingSellIdFor` asks the
  broker and matches on **price and quantity**. That is coarser than the entry guard's price match,
  so a legitimate second exit at a shared target can be declined and retried next bar — deliberate,
  because a declined exit is recoverable and a position sold twice is not.
- **A bar that submits must persist before returning.** `Lot.workingOrderId` and `Rung.workingOrderId`
  are written by the submit path and by nothing else on that bar. Without the write, a crash between
  placement and the next fill left the database holding a lot with no working order while a live sell
  rested at IB — the entry-side crash window Story 13 closed, reopened on the exit side.
- **`selectRestingExits` returns every unprotected lot, not one per bar.** `selectExit`'s one-per-bar
  limit exists because each intent becomes an order immediately; here the orders enforce decisions
  the ladder already made, and a session opening with four held lots needs four sells resting.

**Restart safety is the reason `getOpenOrders()` exists on `BrokerAdapter`.** An order placed before
a restart is still live at IB afterwards, and nothing in the database can confirm that — only the
broker knows. Reconciliation resolves the two directions of divergence:

- **`WORKING` rung, no order at IB** — a DAY order expired overnight, or was cancelled in TWS.
  Released to fireable, or the level is blocked forever and the ladder silently stops laddering.
- **Order at IB, no `WORKING` rung** — the crash window: the order reached IB but the process died
  before persisting. Adopted, or the next bar places a **second** order at the same price and both
  fill.

**Orders are never cancelled by reconciliation.** An order the engine cannot explain is reported,
not destroyed — cancelling one an operator placed by hand would be the system overruling a human
decision it does not understand. And `getOpenOrders()` throwing is **not** `[]`: "cannot ask" leaves
the ledger exactly as persisted, because collapsing it to "nothing resting" would release every
`WORKING` rung and duplicate live orders.

**The one exception is an unambiguous duplicate**, via `POST /orders/resolve-duplicates` — never on
the reconciliation path, and never automatically. The rule above turns on *inexplicability*, which
is precisely what a duplicate is not: when two orders share a symbol, side, and price and exactly
one is tied to a rung or lot through `workingOrderId`, the ladder is demonstrably depending on that
one and the others are surplus exposure at a level already covered. Two orders at one rung both
fill. The rule is preserved everywhere it still applies — only *untracked* extras are cancelled, the
ladder's own claim always survives, a group with zero or several tracked orders is reported rather
than guessed at, and a partially filled order is excluded from grouping entirely so a fill can never
be stranded mid-flight. See "Checking, placing, and de-duplicating orders" below.

### Orders the engine could not learn the fate of

**A terminal status is attributed through an in-memory map, and that is the whole problem.**
`onOrderStatus` resolves IB's numeric order id through a map populated by `submit`. An order placed
*before* a restart and then cancelled — in TWS, or by IB expiring it at the close — produces a status
this process cannot attribute, so it is dropped. Three separate gaps follow from that one fact, and
each has its own repair:

**1. The `Order` row goes stale.** Open-order reconciliation releases the rung correctly, but nothing
moves the row off `SUBMITTED`: the ladder recovers while `GET /orders` keeps showing a live order
that exists nowhere. `getCompletedOrders()` — the complement to `getOpenOrders()` — supplies the
terminal outcome the engine never saw, and `reconcileOrderHistory` writes it.

- **Reporting only, and deliberately outside `clean`.** A stale record is not a divergence in
  position or exposure. Folding it into `clean` would report a halt-worthy condition for something
  that costs nothing and is now fixed. `getOpenOrders()` stays the sole authority on which levels are
  free, because a level is free when nothing is working at it — true whether or not the history query
  succeeds.
- **Only non-terminal rows are touched, and no row is ever created.** A row already `FILLED` /
  `CANCELLED` / `REJECTED` is left alone (the engine saw that outcome live, which is the more direct
  evidence), and an order with no row is skipped rather than manufactured — reconciling records the
  engine owns, never inventing ones for orders placed by hand in TWS.
- `CompletedOrder.status` is narrowed to the terminal set rather than reusing `OrderStatus`, so no
  caller can write `SUBMITTED` from a source that cannot produce it. `reason` is `null` when IB gave
  none, rather than a manufactured "cancelled by user".

**2. A fill that arrived while the daemon was down was dropped.** Such an order is no longer *open*,
so `adoptWorkingOrders` cannot see it in `getOpenOrders()`; the fill then lands on IB's execution
replay, finds nothing in `workingOrders`, and `routeFill` discards it. The shares exist and no lot is
ever opened — the next reconciliation compares zero lots against a real position and halts the
symbol. `recoverWorkingOrder` closes this from durable records: `Order` carries the strategy, symbol,
and quantity, and `Rung.workingOrderId` ties it to the level that placed it. The rung supplies
`rungPrice`, since that is the side that owns the fact. Deliberately narrow — BUY entries with a
`WORKING` rung only; inventing a rung for anything else would attach a lot to a level the ladder
never chose.

**3. A position already stranded cannot be repaired by the engine at all.** IB replays only the
*current day's* executions, so once that window passes the true fill prices are gone from the wire.
`npm run recover:lots` is the operator tool for that case, and it is a **script rather than a
reconciliation path** on purpose: reconciliation has no repair path because scaling lots or
synthesizing one for a difference are guesses at composition, and making that guess automatic would
put it on the startup path where nobody reads it.

- Each recovered lot takes **its own order's limit price** as its fill price. A buy limit fills at or
  below its limit, so every target errs *high* — held marginally longer, never sold below a true
  take-profit. The broker's blended `averageCost` is used as a **check**, not a source: it would give
  every lot an identical target and collapse the per-lot exits the ladder exists to produce.
- It **refuses** rather than guesses: a symbol not halted (or halted for another reason), a symbol
  with any lot already recorded, or quantities that do not sum *exactly* to the broker position.
- Reports by default; writes only with `--apply`.

### Reconciliation on demand and after the close

Boot is no longer the only time reconciliation runs, because the repairs above are needed during a
session and after one.

**`POST /reconcile` runs the full sequence on demand** (the dashboard's Reconcile button). An
operator who cancels an order in TWS previously had no way to clear the resulting `WORKING` rung
short of restarting the daemon. Two things to know before pressing it: it re-runs the lot-sum
assertion and **can halt symbols**, and it restores lots and rungs from the database over whatever is
in memory. The live path persists per bar so the two are normally identical — but a symbol whose
persistence is suppressed by an existing halt is exactly where they are not, which is the case an
operator is most likely reaching for this control to fix. It deliberately does *not* connect the
broker or re-initialize strategies: those are boot concerns, and re-initializing would discard the
live ladder rather than reconcile it. No route here can cancel an order or trade a position, which is
what makes exposing it to a button acceptable.

**`PostCloseReconcileService` runs the order half unattended, 15 minutes after the 16:00 ET close.**
DAY orders expire at the close, and without this the next session opens carrying yesterday's expired
orders as permanently blocked levels. It is started from `EngineModule` **alongside the live feed and
gated on the same condition** — so it runs only when IB is bound. Under the mock broker there is no
session and no resting order outliving one, and a nightly job would reconcile a ledger nothing had
changed.

- **It reconciles orders only, never positions** — `reconcileOrders`, not `reconcileAll`. A halt
  raised while nobody is watching is the failure mode a scheduled job must not have: a broker briefly
  unreachable at 16:10 would otherwise leave every symbol halted until someone noticed the next
  morning. The order half degrades to "changed nothing" instead. For the same reason it does not
  restore state from the database — live state is at least as current, and this job answers a
  question about orders, not composition.
- **`OrderReconciliationReport` is deliberately not a `ReconciliationReport`.** That type carries
  `clean` and `haltedSymbols`, which are verdicts about *positions*; reporting `clean: true` from a
  run that never checked them would claim a check that did not happen. `brokerReachable` distinguishes
  "nothing was resting" from "could not ask".
- **A one-shot timer that re-arms, not a 24-hour interval.** A fixed interval drifts across DST and
  anchors to process start, so a daemon restarted at 11:00 would reconcile at 11:00 forever.
- **The delay is not zero** because IB does not mark DAY orders expired at exactly 16:00:00. Asking
  too early returns them still open, and the job reports a clean run over precisely the orders it
  exists to clean up.
- **Market holidays are not skipped**, deliberately: there is no holiday calendar in this codebase,
  and a run on a closed day asks two harmless read-only questions. Inventing a calendar to avoid a
  no-op would be a source of wrong answers rather than a saving.
- Errors are caught, never rethrown — an unhandled rejection in a timer callback would turn a failed
  read into an outage. A halted symbol is still included: releasing a rung whose order expired changes
  nothing about the halt, and leaving its ledger stale would hand the operator a second, unrelated
  discrepancy to resolve.

### Checking, placing, and de-duplicating orders

Three operator controls sit beside Reconcile on the dashboard, backed by
`OrderDiagnosisService` and `DuplicateOrderService`. They exist because the ladder and the broker can
disagree in ways nothing on the bar path repairs, and because **asking reconciliation what is wrong
changes the answer** — `reconcileAll` releases rungs, adopts orphans, restores state from the
database, and can halt a symbol. An operator deciding whether to intervene needs to see the
divergence before anything acts on it.

**`GET /orders/diagnosis` is read-only and writes nothing.** It joins `getOpenOrders()` against live
ladder state and classifies into four findings, each with a different repair:

| Finding | Meaning | Repaired by |
|---|---|---|
| `MATCHED` | a rung or lot whose `workingOrderId` is present at the broker | nothing — the healthy case |
| `UNBACKED` | the ladder holds a `workingOrderId` the broker does not list | `POST /reconcile` |
| `ORPHAN` | an order at the broker no rung or lot claims | reported only, never cancelled |
| `DUPLICATE` | two or more unfilled orders at one symbol, side, and price | `POST /orders/resolve-duplicates`, when unambiguous |

A halted symbol is **skipped**, not diagnosed: a halt leaves live strategy state empty by design, so
every one of its orders would read as an orphan and every rung as missing — findings that describe
the halt rather than the orders.

**`POST /orders/place-missing` is the only route that creates an order outside a bar**, and the two
things a bar supplies are replaced rather than skipped:

- **The decision** is replaced by a diagnosis, re-run *inside* the call so a stale preview cannot
  place an order the ladder no longer wants. Candidates come from a specific claim the ladder makes
  and the broker contradicts — a HELD lot with no resting sell, or a fireable rung with no resting
  buy. **Never from an empty book**: a ladder resting nothing is not evidence of a fault, since a
  flat ladder with no fireable rung correctly rests nothing, and placing there would open a position
  the ladder never decided to open.
- **The price** is replaced by `lastBarClose`. Without it `isRestable`/`isRestableExit` cannot be
  evaluated, so a null close refuses *everything* — an order that cannot be proven non-marketable is
  not placed. A marketable order into a 3x ETF book is a fill price the ladder must then hold with no
  stop underneath it.

It **bypasses nothing**: every candidate crosses `RiskManagerService.evaluate()` exactly as a
bar-generated intent does (via `evaluateBatch`, so several are measured against one running capital
total), the entry halt still blocks BUYs while exits stay permitted, and the submit path persists
`Lot.workingOrderId` / `Rung.workingOrderId` before returning — the same crash window `processBar`
closes after its own submissions. A `WORKING` rung whose order is gone is deliberately **not** a
placement candidate: releasing it is reconciliation's job, and re-placing at a level still marked
`WORKING` would race that release.

**`POST /orders/resolve-duplicates` is the only route that destroys an order** — see the exception
noted under "Orders are never cancelled by reconciliation" above for why that is allowed here and
nowhere else.

**On the dashboard, both acting buttons stay disabled until a check has run.** That is the
interaction design rather than a convenience: placing against an unexamined book is how duplicates
are created, and cancelling without having seen which order the ladder depends on is how a working
order is destroyed. Acting also clears the findings, so a second action needs a fresh check —
acting twice on one diagnosis is itself a way to place a duplicate.

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
- **Only trading stops — the dashboard keeps showing the position.** Because a halt restores nothing
  into strategy state, `GET /lots` and `GET /rungs` served an *empty ladder* for a halted symbol:
  they read live state, and live state is empty by design. That blanked the panels an operator opens
  to compare the database against the broker, during the one event that requires exactly that
  comparison. Both endpoints now fall back to the persisted rows for a halted symbol, flagged
  `unverified: true`. This is read-only and reaches no strategy — nothing is written back into the
  coordinator, so `processBar` still returns before `dispatchBar`. The persisted rows **replace** a
  halted symbol's live rows rather than adding to them: a halt raised mid-session leaves the ladder
  populated in memory, and appending would render every lot twice. `fireable` is forced false on an
  unverified rung — a halted symbol has nothing armed, whatever the stored status says.
- Halts clear only via `POST /halts/:symbol/release`. `POST /engine/reset` deliberately does not.
- An unreachable broker is `null`, not `[]` — "unknown" must halt where "flat" may reconcile.

**`StrategyStateSnapshot` carries the anchor, and only the anchor.** Lots and rungs are restored from
their own tables (authoritative on composition); the snapshot supplies `sessionOpen`,
`previousSessionClose`, `firstEntryPrice`, `lotSequence`, `sessionDate`, `runningClose`, which live
nowhere else. One authority per fact — do not restore lots from the snapshot's copy. Snapshots are
append-per-save so a crash mid-write leaves the previous good one readable, and a `version` the
running code does not recognize is **rejected**, never coerced.

**The expected outcome of a restart has inverted.** Under `SHADOW` the database legitimately diverged
from the broker — the ladder recorded intents that were never submitted — so a restart with a held
ladder was *expected* to halt on the lot-sum assertion. In `PAPER` every lot is the consequence of a
real fill, so the two should now **agree**, and a lot-sum halt is a genuine finding to investigate
rather than a documented quirk to record and move past.

Open orders are reconciled **after** the lot-sum assertion passes, not instead of it: the assertion
is about shares that exist, open-order reconciliation about orders that might yet create some.
Order-history reconciliation runs after every symbol and cannot affect any of it — rung release is
decided by `getOpenOrders` alone. Boot is not the only trigger any more: see "Reconciliation on
demand and after the close" for `POST /reconcile` and the post-close job.

On Apple Silicon, Prisma's engines fail against MySQL with a misleading `sha256_password` error;
run the CLI and `test:db` through a Linux container. `backend/prisma/README.md` has the commands.

### The IB adapter (Story 10)

`IB_HOST` is the **only** switch. Set → `IBBrokerAdapter` and the live bar feed; unset → the mock
broker and fixture replay. Same convention as `DATABASE_URL`, for the same reason: one variable
cannot contradict itself. `GET /status` reports which broker is live. `EXECUTION_MODE` governs
submission independently — but note that **with `SHADOW` retired there is no longer a mode that
binds IB and submits nothing.** Binding IB in `PAPER` means orders reach the paper account.

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
- **`FAILED` is not terminal — a slow poll keeps trying.** It used to be: exhaustion stopped the
  liveness probe, no further disconnect event could fire, and *nothing in the process ever attempted
  another connection*. A Gateway that came back a minute later was never noticed, so the only
  recovery from any exhausted reconnect was restarting the daemon — including for IB Gateway's own
  daily restart, which routinely outlasts the ~3.5 minutes six exponential attempts cover.
  `failedRetryMs` (5 min, unbounded) now takes over from the bounded budget. The two are deliberately
  different mechanisms: the fast budget rides out a blip without disturbing a live session, the slow
  poll notices — eventually — that a long outage ended. **Entries stay halted throughout**; the poll
  restores only the *ability to notice*, never the decision to trade.
- **A failed *initial* connect is retried the same way, and reports `FAILED`.** Previously it set
  `DISCONNECTED` and rethrew: `StartupSequence` caught it and booted anyway (right — the dashboard
  must come up so an operator can see why nothing is trading), but nothing then re-attempted the
  connection. No disconnect event can fire for a socket that never opened, and the liveness probe
  only runs once connected, so a Gateway merely slow to start left the daemon permanently
  disconnected with every symbol halted. `FAILED` rather than `DISCONNECTED` because a *requested*
  `disconnect()` also reports `DISCONNECTED`, and the two must be distinguishable now that one is
  retried and the other must not be. `reconnectAttempts` stays 0, so "never got a connection" is
  still legible next to "exhausted a budget".
- **`connect()` and `disconnect()` both stop the poll.** An explicit connect supersedes it (a timer
  firing mid-connect would open a second socket against the same Gateway); a requested disconnect is
  deliberate, and reviving it behind the caller's back would be the adapter overruling an operator.
- **Stale data is its own fail-safe trigger.** A connected socket that stopped delivering is more
  dangerous than a dropped one — nothing looks wrong while the ladder evaluates against a stale
  price. `LiveFeedService` watches it and halts *new entries only*.
- **A bar subscription does not survive the socket it was made on.** IB Gateway logs itself out
  daily, and the reconnect policy restores the *socket* while the subscription made against the old
  one is silently gone. Without re-subscribing, the first logout ends the feed for the life of the
  process: connected broker, no bars, indefinitely. `LiveFeedService` re-subscribes on every
  `CONNECTED`, guarded so a reconnect that succeeds on attempt 2 does not subscribe twice. The
  watchdog would catch the silence, but a halt clearable only by restarting the daemon each morning
  is not a working feed. Recovery from `FAILED` travels this same channel, which is what stops a
  revived socket coming back with no subscription on it — connected broker, no bars, indefinitely.
- **Market-data errors are reported, not just logged.** IB rejects an unentitled or malformed data
  request on the subscription's error channel and then delivers nothing — the socket stays connected
  and every other `/status` field reads healthy, so the failure that matters most (no bars) was
  visible only as one `warn` line in the container log. Surfaced as `broker.dataErrors`, keyed by
  symbol so a repeating rejection cannot grow unboundedly, and cleared when a bar proves recovery.
  **Reporting only — it deliberately does not halt**, because IB uses the same channel for benign
  notices and a halt that fires on those trains an operator to clear halts without reading them. The
  staleness watchdog remains the thing that acts.

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

**`getHistoricalDataUpdates` is backfill-then-stream, not a live feed**, and `LiveBarGate` is the
rule that separates the two. On subscribe IB replays a window of historical bars and only then emits
live ones — and it re-emits the in-progress bar repeatedly as it forms. Treating every emission as a
new closed bar **walked a live ladder down five rungs in sixteen seconds against stale prices**,
which in `PAPER` went straight at the submission path.

- IB gives no marker between the last historical bar and the first live one, so a **quiet period** is
  the only available signal: historical bars arrive back-to-back, while the smallest live cadence is
  5 minutes. `BACKFILL_SETTLE_MS` is 3s, far above the burst gap and far below the cadence.
- Erring long is the safe direction — one skipped early bar against replaying a whole historical
  window into a ladder that can submit orders.
- Suppressed emissions still **advance the watermark**, and the comparison is `<=`, which is what
  drops the repeated in-progress bar.
- The gate is per subscription, which is what makes re-subscribing after a reconnect safe: the fresh
  backfill is absorbed rather than forwarded.
- It lives outside the socket for the same reason `ib-wire.ts` does — the Gateway-dependent file is
  excluded from coverage, and the rule protecting the ladder must not be.

The pure wire conversions live in `ib-wire.ts`, separate from the socket, so they stay under the
coverage threshold while the Gateway-dependent plumbing is excluded from it. That is where a
mis-encoded payload or misread timestamp would come from; it is covered at 100%.

### Halts, and how each one clears

There are **two** halts with different scopes and different exits, and the distinction between them
is covered under "Why this is not the engine's `entryHalt`" in `symbol-halt.service.ts`. What this
section adds is the part that was missing: **how each one ends**.

The governing rule is that no fault may latch with no way out. Every halt here refuses to liquidate —
that part is unchanged and must stay that way — but a halt only a process restart can clear is not an
operator control, and restarting a trading daemon to clear a flag is a far blunter instrument than
the flag itself.

| Halt | Scope | Exits allowed? | Clears by |
|---|---|---|---|
| `entryHalt` (`EngineService`) | whole engine | **yes** | operator, or self on resumed data |
| `SymbolHaltService` | one symbol | no | operator only |

**`EntryHaltCode` decides which technical halts can self-clear**, and it exists precisely so that
decision is structural rather than textual. The halt previously carried only English prose in
`reason`; matching on a substring to decide whether to resume trading would be one reworded log line
away from resuming against a dead broker.

- **`STALE_DATA` clears itself when a bar arrives.** A bar is direct positive evidence that the fault
  condition — no bars — has ended. `processBar` calls `clearStaleHalt()` *before* snapshotting the
  outcome, so the bar that proves recovery may itself trade; deferring to the next bar would discard
  a live evaluation for no added safety.
- **`BROKER_CONNECTION` and `ORDER_FAULT` never self-clear.** Bars and orders travel different paths,
  so a bar is no evidence about the broker — a feed can recover while submission stays broken. And a
  failed submission is disproved by nothing except trying again, which is an operator's decision.

Without the auto-clear, a feed that went quiet and then simply resumed — a data-farm blip, a pacing
throttle, no socket drop anywhere — left entries halted for the life of the process: bars flowed, the
ladder evaluated, and **every BUY was silently dropped** until someone restarted the daemon.

**`LiveFeedService` re-arms its detector on the same evidence.** `staleHaltRaised` is sticky so one
fault does not flood the alert list, but it used to reset only in `resubscribe()` — i.e. only on a
connection change. A recovery without a socket event left the detector permanently spent and the
*next* silence went unreported. It now unlatches when a bar arrives, set before processing rather
than after: it describes the arrival, not the outcome, and a bar that throws in `processBar` still
proves data is flowing.

**Reconciliation halts stay operator-only, deliberately.** "The numbers disagree" is never
self-resolving, and the existing refusal to guess at lot composition is what makes that right. Clear
them with `POST /halts/:symbol/release` after resolving the account by hand.

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

### The capital decisions (Story 13) — now set

The two `PRD.md:500` open items are decided. They live in **`src/config/capital.config.ts`**, a
reviewed source file rather than environment variables, on purpose: which instrument this system
trades and how much it may deploy belong in a diff someone read, not a deployment variable changeable
without review. The reasoning is recorded in `docs/decisions/`, which Story 13 requires.

| Value | Setting |
|---|---|
| `PAPER_SYMBOL_CAPITAL.TQQQ` | USD 40,000 — *expected deployment, not a ceiling* |
| `PAPER_ACCOUNT_EQUITY` | USD 175,000 — hand-converted from CAD |
| `PAPER_DAILY_LOSS_THRESHOLD` | USD 5,000 |
| `PAPER_DAILY_LOSS_BASIS` | `REALIZED_AND_UNREALIZED` |

**These were operator-chosen, not backtest-derived.** Story 13 specifies they should be informed by
Story 11 backtests; they were not. Both decision documents record that deviation. They are sized to
be *safe* — a full 5-rung ladder deploys 125% of allocation, so 50,000 peak against a 105,000 global
cap — not optimal. **Story 15 must revisit them with backtest evidence before `LIVE`.**

`shadowNotional()` is gone, replaced by `ladderCapital()`, which reads the real allocation for every
mode and returns `null` for an unconfigured symbol — so a missing allocation sizes rungs to zero
shares *and* trips the startup assertion, rather than silently borrowing another symbol's figure.

**The guard has not become decoration.** `capital.config.spec.ts` asserts that removing either value
still refuses a `PAPER` boot, so reverting the file fails startup exactly as before.

**The account is denominated in CAD and TQQQ trades in USD**, and the risk layer converts nothing.
`globalCapitalCap` compares a sum of position notionals against equity *directly*, so a USD notional
measured against a CAD figure permitted roughly `USDCAD` — about 1.39× — more exposure than intended.
Two errors partly cancelled (a stale-low equity tightened the cap while the missing conversion
loosened it), which is why it went unnoticed; relying on that cancellation is not a control.

- **`assertSingleCurrency` refuses rather than converts.** Converting needs a live FX rate, which is
  market data with its own staleness — and a stale rate mis-sizes every order silently, which is
  worse than not booting. Mixing currencies is a configuration error and is reported as one.
- The resolution taken is to express every figure in USD and convert the balance **once, by hand**.
  This makes the arithmetic sound but leaves `PAPER_ACCOUNT_EQUITY` carrying *two* sources of
  staleness — the balance and the rate. The ~2.5% buffer below the converted figure absorbs ordinary
  daily rate movement, **not a trend**.
- **The real fix is still open** and mandatory before `LIVE`: a live `USD.CAD` rate from IB treated
  as market data with a staleness watchdog, where an unavailable rate blocks new entries. Until then,
  re-read the balance **and** the rate together — converting one without the other reintroduces the
  original mismatch.

`INSTRUMENT_CURRENCY_SOURCE` publishes the traded currency the same way `SYMBOL_CAPITAL_SOURCE`
publishes allocation: through `CapitalModule`, so the risk layer never imports a strategy to learn
what it trades.

**A failed startup assertion now exits cleanly** (`main.ts`) with a single legible message instead of
an unhandled rejection — the raw stack buried the one line an operator needs, and compose reprinted
it every few seconds on restart. The refusal itself is unchanged; only the reporting is.

### The daily soak report (Story 12, revised for PAPER)

`DailyReportService` builds a per-session summary for the soak, served from
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

**The anchor is recomputed at every intent, not once per session.** This is the largest correction to
the report, and it removed a class of false anomaly. The anchor is a function of what is held *at
that moment*, and the ladder re-evaluates it every bar — so a session opening flat and filling four
rungs uses four different anchors, each progressing off the lot the previous entry created. A single
session-wide anchor agrees with the engine only when the held set never changes, and reports every
entry after the first as a false mismatch when it does. Consequences worth knowing before editing:

- Opens and closes are merged into **one chronologically ordered event stream**. Two separate cursors
  cannot express this: a lot opening at 10:00 and closing at 10:30 would have its close applied while
  the walk was still before its open, leaving it held for the rest of the session and reporting every
  re-entry at that level as unexplained.
- **Closes sort before opens at equal timestamps**, matching `onBar` — exits are applied first so a
  bar's entry sees the rung its exit just freed. An open applies at `<` its timestamp, since an entry
  cannot anchor off the position it is itself creating.
- **A rung outlives the lot that occupied it.** A re-armed rung fires again at its original price, and
  under `RESTING` placement `highestFireableRung` picks such a level regardless of where the bar
  closed. Modelling only "one spacing unit below the current anchor" explains the ladder's *first*
  entry at each level and none of the repeats — which is most of a cycling session. `knownRungs`
  tracks levels the walk has derived; it is never read back from the ladder's own rung list, because
  that readback is the comparison this service exists to avoid.
- The report considers **every lot touching the session**, not just those held at its end — a lot
  opened and exited mid-session still determined where rungs sat while it was held.

**`outsideFiringWindow` counts entries only.** The window constrains firing, not exiting, so a lot
reaching its frozen take-profit target during the 09:30–09:45 opening auction exits then,
deliberately. Counting exits made every session with an early take-profit raise a false
`INTENT_OUTSIDE_FIRING_WINDOW` — and during a soak that is worse than silence, since the week
restarts on any unexplained anomaly.

**`SUBMISSION_IN_SHADOW` is replaced by `RETIRED_MODE`.** A report claiming `SHADOW` now describes a
session this build could not have run — either a historic session predating the retirement, or mode
plumbing that is wrong in a way an operator must see rather than have silently normalized.

**`RECONCILIATION_MISMATCH` is no longer expected.** Under `SHADOW` it was a documented consequence
of a database that legitimately diverged from an empty broker position. In `PAPER` every lot follows
a real fill, so a mismatch is a genuine finding.

Note that `EngineService.persistLadderState` runs once per **replay**, not per session, so a
replayed multi-day fixture leaves only one snapshot. The live feed persists as bars arrive, so each
live session gets its own. This is why `reports.integration.spec.ts` verifies rungs against the
fixture's final session and asserts a skip for an earlier one.

The live per-bar write goes through `BarConsumer.persistState` (optional on the port, so a consumer
without persistence is unaffected). Two ordering rules there are deliberate: it runs **after** the
bar-processing catch, so a bar that threw *after* opening a lot still has that lot written rather
than left disagreeing with a position the broker already holds; and it has **its own catch**, so a
failed write is not reported as a failed bar and does not stall the queue behind it. The engine keeps
running on in-memory state, and reconciliation catches a persistent divergence on the next restart.

### HTTP API

Read: `GET /health` `/status` `/intents` `/orders` `/fills` `/lots` `/rungs` `/positions`
`/risk-events` `/strategies` `/halts` `/reports/daily` `/orders/diagnosis`

`GET /status` gains `broker.pacing`, `broker.dataStale`, `broker.lastBarAt`, and `broker.dataErrors`
when IB is bound. Pacing is reported because breaching IB's limits produces no error of its own — a
filling queue is the only early warning there is. `dataErrors` reports *why* the feed is silent next
to the fact that it is.

`GET /status` also carries `orderReconciliation`: the post-close job's last run, or `null` until it
has fired. An operator must be able to tell "scheduled but not yet due" from "ran and found nothing",
which absence alone cannot express.

`GET /lots` and `GET /rungs` carry `unverified`, true when the row was read from the database
because its symbol is halted rather than from live strategy state — see "Reconciliation" above. The
dashboard labels those panels so a last-recorded position is never mistaken for a confirmed one.

`GET /positions` answers **503** when the broker cannot be asked, rather than `[]`. Unknown and flat
must never look alike; `[]` would report a flat account during an outage. It also guards on
`isConnected()` before calling IB — an unauthenticated Gateway accepts the socket and then never
replies, so without the guard every dashboard poll paid a 10s timeout.

`GET /rungs` gains `workingOrderId`, so the dashboard can join a working rung to its row in
`GET /orders`. Its `fireable` field is derived as `lotId === null && !workingOrderId`, mirroring
`selectFireableRung` — deriving it from `status !== HELD` alone would report a `WORKING` rung as
fireable and tell an operator the ladder is armed at a level where an order is already committed.

Read: `GET /parameters` `/parameters/changes` `/parameters/:strategyId`

Control: `POST /engine/replay` `{fixture}` · `/engine/reset` · `/engine/clear-halt` · `/reconcile` ·
`/broker/reconnect` · `/kill-switch` `{engaged, reason}` · `/strategies/:id/enable|disable` ·
`/mode` `{mode}` · `/parameters/:strategyId` `{parameters, reason}` · `/halts/:symbol/release` ·
`/orders/place-missing` · `/orders/resolve-duplicates`

`POST /reconcile` takes no body and runs the **full** startup reconciliation — it can halt symbols
and it restores persisted state over live memory. See "Reconciliation on demand and after the close"
before wiring anything else to it.

`POST /engine/clear-halt` clears the engine's **technical** entry halt — the counterpart to
`/halts/:symbol/release`, which clears a *reconciliation* halt. `EngineService.clearHalt()` existed
from Story 6 and was reachable from **no route at all**, so a stale feed, an exhausted reconnect, or
a failed submission latched entries off until someone killed the process; `POST /engine/reset` was
the only alternative and it discards ladder state. It is narrower than it looks: it clears one
boolean gating new BUY intents, and 404s when nothing is halted, since reporting success for a halt
that never existed is the one answer worse than an error. Clearing a halt whose cause is still
present simply means the next fault re-raises it — the detectors all still run. There is no path from
here to a trade: clearing permits the *strategy* to decide again, and every intent it produces still
crosses the risk chokepoint, the caps, the loss breaker, and the kill switch unchanged.

`POST /broker/reconnect` forces an immediate connection attempt. The adapter already retries a
`FAILED` connection on its own slow poll, so this is not the only way back — but the poll is
deliberately slow, and an operator who has just restarted IB Gateway should not have to wait it out.
**It deliberately does not run reconciliation.** A recovered socket proves the broker is reachable;
it proves nothing about whether positions still agree with the database, and that question has its
own route whose answer can halt symbols. Chaining them would hide a halt-raising operation behind a
button labelled "reconnect". Nothing here submits, cancels, or liquidates.

```bash
curl -X POST localhost:3000/engine/replay -H 'Content-Type: application/json' \
  -d '{"fixture":"chop-range"}'
curl localhost:3000/lots
```

## Testing

1568 backend tests across 77 suites, plus database tests (`npm run test:db`, needs MySQL) and 119 UI
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
- **`FillMode.MARKET_AWARE` is what makes a resting order testable**, and the assembled app selects
  it (`engine.module.ts`). The `IMMEDIATE` default fills every order on submission at its limit
  price whatever the market is doing — tolerable for an entry, which rests below the market, and
  wrong for an exit, which rests above it: every lot opened and closed on the same bar. Market-aware
  fills are driven per bar by `EngineService.advanceSimulatedMarket`, and a fill carries **the
  timestamp of the bar that filled it**, not of the order that placed it. Stamping the order's own
  time backdated a lot's open and close to submission, which the daily report — walking a session's
  lots in timestamp order — reported as `RUNG_PRICE_MISMATCH`. The default stays `IMMEDIATE` so
  existing suites keep the rule their expectations were computed under.
- Integration tests drive the assembled app over Supertest. **The app now boots in `PAPER` against
  the mock broker**, so replay exercises the real submission path rather than stopping short of it —
  the separate `EngineService`-in-`PAPER` construction that used to be the only way to reach
  submission is no longer the only route. Mode safety is asserted the other way round now: `POST
  /mode` must *refuse* `SHADOW`.
- **Resting-order behavior is not covered by the fixtures.** They run `IMMEDIATE`; see
  `resting-orders.spec.ts` (entries), `resting-exits.spec.ts` (exits), and the reconciliation suites
  for the `RESTING` path.
- Prefer adding a case to an existing scenario suite over a new bespoke harness.

**Do not write a test that can never fail.** `architecture.spec.ts` tests its own detector for this
reason; a safety check that cannot fail reports confidence it has not earned.

## Working Constraints

- Testing and containerization are in scope, not follow-ups. Coverage must include order payload
  generation, broker-disconnect handling, and state recovery after restart.
- Everything runs locally in containers — no cloud deployment target.
- **A technical fault must never become a realized loss.** On a disconnect or exhausted retries: halt
  new entries, raise an alert, and leave existing positions alone. No code path may auto-liquidate.
- **No fault may latch with no way out.** The rule above says what a fault must not do; this one says
  what it must not become. Every halt needs an exit an operator can reach without restarting the
  process, and every terminal connection state needs something still trying. Both were violated until
  recently — `FAILED` stopped its own detector, and `clearHalt()` was wired to no route — and the
  symptom was a daemon that had to be restarted to recover from faults it had handled correctly.
  Recovering the *ability to act* is not the same as deciding to act: a reconnect never clears a
  halt, and only `STALE_DATA` clears on evidence rather than on an operator's say-so.
- **This code places real orders through a broker, and there is no longer a mode that does not.**
  `SHADOW` was the standing safety net for Stories 0–12 and is retired; the default is `PAPER`, which
  submits to a paper account, and entries **rest at the broker unattended, across restarts**. Confirm
  before any change that could affect order submission. The remaining guards are the startup
  assertions, the risk caps, the loss breaker, the kill switch, and reconciliation — not the mode.
- `LIVE` is still gated on Story 15, and the capital figures must be revisited with backtest evidence
  before it.

## Working style

### Approach

- Before implementing a change, restate the requirement, identify any ambiguous decisions, and
  recommend sensible defaults before writing code.
- Inspect existing patterns before introducing new abstractions, dependencies, or architectural
  changes. Match the repository's conventions first.
- Prefer the smallest change that solves the problem. Avoid unrelated refactoring.
- Explain the implementation plan briefly before making significant code changes.
- When debugging, identify and verify the root cause before proposing a fix.
- Consider failure paths (failed requests, empty data, invalid input, unexpected states) before
  considering a task complete.
- Before finishing, review the implementation against the original request and identify anything
  incomplete or any assumptions that were made.

### Development guidelines

These are guiding principles, not rigid rules. When trade-offs exist, explain them briefly and choose
the approach that best fits the existing architecture.

Prefer solutions that:

- Preserve existing architecture and coding conventions.
- Keep changes localized and easy to review.
- Minimize coupling between components and modules.
- Localize loading and error handling where appropriate.
- Preserve clear ownership of state and data.
- Optimize for correctness, readability, and maintainability before optimization.

### Communication

- When multiple reasonable approaches exist, recommend one and explain the trade-offs.
- State assumptions explicitly instead of silently choosing one interpretation.
- Keep explanations concise and focused on engineering decisions.

### Next.js conventions

Defaults for this repo, not hard rules — deviate when a requirement or existing pattern doesn't fit,
and say why.

- **Server vs. Client Components.** Default to Server Components. Add `'use client'` only where
  `useState`/`useEffect`/event handlers/browser APIs are needed, and prefer isolating just the
  interactive piece over converting the whole component.
- **Server Action vs. Route Handler.** Default to a Server Action for mutations from this app's own
  UI. Use a Route Handler (`route.ts`) only for endpoints called from outside the app (webhooks,
  third-party clients).
- **Data fetching location.** Fetch in Server Components or Server Actions, not `useEffect` — a
  Client Component should receive data as props or from a Server Action's return value, except for
  genuinely client-only cases (polling, client-only state).
- **Colocation.** Route-specific components/actions/types live next to the route (`app/characters/`)
  until reused by more than one route, or unless the repo's existing structure already centralizes
  that kind of code.
- **Loading/error boundaries.** Add `loading.tsx`/`error.tsx` per segment where a slow or failing
  fetch would otherwise block or crash something that doesn't need to be — skip where the boilerplate
  outweighs the benefit.
- **Dynamic segment naming.** Match existing bracket conventions (`[id]` vs `[slug]`) where a sibling
  route sets one; if none exists, pick the clearest name and note you're setting precedent.

### Code comments

Comment **why**, not **what**.

Use comments to explain:

- Non-obvious design decisions.
- Edge-case handling.
- Framework or API behavior that isn't immediately apparent.
- Important trade-offs.

Avoid comments that simply restate what the code already expresses.
