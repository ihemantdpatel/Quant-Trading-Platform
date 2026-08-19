# Stories — Modular Multi-Strategy Quantitative Trading Platform

Vertical slices derived from `PRD.md`. Each story crosses every layer it touches and ends in
something observable — a passing scenario suite, an HTTP response, a browser view, a soak result.

> ## Where this stands
>
> **Stories 0–13 are built. Story 14 (the `PAPER` soak) is next and has not started.**
>
> Two things diverged from this plan and are marked inline rather than edited away, so the reasoning
> stays auditable:
>
> - **Story 12's `SHADOW` soak was superseded before its week ran.** Its instrumentation shipped and
>   now serves Story 14. The mode it tested no longer exists.
> - **Story 13 grew well beyond its scope.** It retired `SHADOW`, moved entries onto resting limit
>   orders, and added open-order reconciliation — none of which were planned here. Its
>   "What changed from the plan" subsection is the record.
>
> **Two debts block Story 15 (`LIVE`)**: the capital figures have no backtest behind them, and
> account equity is a hand-converted FX snapshot. Both are listed in Story 15's scope.
>
> Earlier stories still describe `SHADOW` as current. That is deliberate — they are the record of
> what was built at the time, and Story 13 is where the change is documented.

## Principles

1. **Mock-data-first.** The system is built and made deployable against mock data with zero external
   dependencies. Real MySQL, then real IB Gateway, swap in behind interfaces that already exist.
   **Stories 0–7 require no MySQL, no IB Gateway, no credentials, no market data subscription.**
2. **Vertical, not horizontal.** No story is "build the schema" or "build the interfaces." Every
   story's exit criterion is runnable.
3. **Strategies never touch I/O.** They receive an immutable context and return `OrderIntent[]`
   (`PRD.md` §2). The contract suite enforces this.
4. **The risk manager is the only path to the broker** (`PRD.md` §3). No story may introduce a
   strategy→broker code path.
5. ~~**`SHADOW` is the default mode** until Story 13. Nothing is submitted anywhere before then.~~
   **Superseded at Story 13.** `SHADOW` held through Stories 0–12 and did its job. Story 13 retired
   it: resting limit orders make a lot the consequence of a **broker fill**, so a mode that submits
   nothing would record intents forever and never open a lot — a different and misleading behaviour
   rather than a quieter one. `PAPER` is the default from Story 13 on, and `SHADOW` is **refused at
   startup**. See Story 13's "What changed from the plan".

## Deliberate departures from `PRD.md`

| Departure | Rationale |
|---|---|
| Dashboard at Story 7, not Phase 3 (`PRD.md:477`) | Seeing the ladder cycle in a browser on replayed mock data is the cheapest way to validate the engine before real dependencies exist |
| Backtester at Story 11, after the IB adapter (PRD Phase 2) | So it validates against real cached TQQQ history, including the 2022 ~80% drawdown named at `PRD.md:470` |
| MySQL before IB | Reconciliation (`PRD.md` §5) is the riskiest code; build it against a real store + mock broker so only one new failure source at a time |
| Compose grows incrementally | Story 0 is backend + UI only; MySQL joins at Story 8, IB Gateway at Story 10 |

## Decisions recorded (not in `PRD.md`)

- **Coverage thresholds:** 80% lines/branches global, **95% on `src/strategies/**` and
  `src/risk/**`**. Those are pure functions with no I/O — 95% is cheap there and that is where a bug
  costs real money. Enforced in CI from Story 0.
- **The two `PRD.md:500` open items stay open until Story 13.** Story 5 builds the assertion that
  refuses `PAPER`/`LIVE` without them; Story 13 sets the values, once a backtest exists to inform them.
  **Done at Story 13 — but the values were operator-chosen, not backtest-derived.** That deviation is
  recorded in `docs/decisions/` and must be closed before Story 15.
- **Order placement is `RESTING`, not bar-close, in the live engine** (Story 13). The `IMMEDIATE`
  bar-close rule (`PRD.md:92`) remains the config default so the committed fixtures keep testing the
  rule their expected intents were computed under. A dip that wicks through a rung intra-bar and
  recovers fired nothing under the original rule — the ladder bought the close, not the dip.
- **Account currency must match instrument currency, or boot is refused.** Found at Story 13: the
  paper account reports `NetLiquidation` in CAD while TQQQ trades in USD, and the global cap compares
  notional against equity directly. Refusal rather than FX conversion — a stale rate mis-sizes every
  order silently, which is worse than not booting.
- **PAPER→LIVE gate is cycle-based, not calendar-based.** At least one complete lot cycle
  (fire → target → exit → re-arm → fire) on paper before LIVE.
- **LIVE opens at 25% of nominal** for two weeks, then steps up.

## Story map

| # | Story | Deployable result | Depends on |
|---|---|---|---|
| 0 | Infra & test env | `docker compose up` → health 200, UI page, CI green | — |
| 1 | Mock data fixtures | Deterministic TQQQ bar series, replayable via CLI | 0 |
| 2 | Strategy interface + contract tests + scaffolds | Contract suite green; coordinator registers 4 strategies | 0 |
| 3 | Dip ladder core | Replay fixtures → intents at hand-calculated rung prices | 1, 2 |
| 4 | Per-lot FIFO exits + re-arming | Chop suite: fire → target → exit → re-arm → fire | 3 |
| 5 | Risk manager + 4 safety controls | Intents rejected/resized; kill switch; mode guard | 4 |
| 6 | Engine HTTP API + `MockBrokerAdapter` | `GET /intents`, `/lots`, `/rungs` over replayed data | 5 |
| 7 | Dashboard | Ladder, per-lot table, kill switch, mode switch in browser | 6 |
| 8 | Prisma/MySQL swap | Compose gains MySQL; state survives restart | 6 |
| 9 | Reconciliation & recovery | Lot-sum assertion; injected mismatch halts symbol | 8 |
| 10 | IB adapter + pacing cache | Compose gains IB Gateway; live bars in `SHADOW` | 9 |
| 11 | Backtester | 2022 drawdown examined explicitly | 10 |
| 12 | ~~SHADOW soak~~ **superseded** | Instrumentation built and kept; the week itself never ran — the mode was retired first | 10 |
| 13 | PAPER enablement + resting orders | Capital + loss threshold set; `SHADOW` retired; entries rest at IB | 11 |
| 14 | PAPER soak + fix loop | ≥1 complete lot cycle; kill switch verified live | 13 |
| 15 | LIVE enablement | Explicit flag; 25% nominal for two weeks | 14 |
| 16 | Phase 4 handoff | Grid / Wheel / LEAPs on the proven engine | 15 |

---

## Story 0 — Infrastructure & test environment

**Goal:** A two-service containerized skeleton that starts, responds, and runs a green CI pipeline
with coverage thresholds already enforced.

**Depends on:** —
**PRD refs:** §10 (`PRD.md:449`), §9 (`PRD.md:418`), §12 (`PRD.md:488`)

**In scope**
- `git init`; repo layout `backend/` (NestJS) + `ui/` (Next.js App Router + Tailwind)
- NestJS scaffold with `GET /health` returning `{ status: 'ok', mode: 'SHADOW' }`
- Next.js scaffold rendering a static placeholder page
- `docker-compose.yml` with exactly two services: `backend`, `ui`
- Jest + Supertest configured in `backend/`; coverage thresholds wired: 80% global, 95% for
  `src/strategies/**` and `src/risk/**` (directories exist as empty stubs so the threshold is real
  from day one)
- ESLint + Prettier, shared config
- GitHub Actions: lint → test → build, thresholds enforced, fails the job on breach
- `.env.example` + config module; `EXECUTION_MODE` defaults to `SHADOW`

**Out of scope**
- MySQL service → Story 8
- IB Gateway service → Story 10
- Prisma → Story 8
- Any trading logic → Story 2+

**Files**
- `backend/src/main.ts`, `backend/src/app.module.ts` — Nest bootstrap
- `backend/src/health/health.controller.ts` — health endpoint
- `backend/src/config/config.module.ts` — typed env config, `EXECUTION_MODE` enum
- `backend/jest.config.ts` — coverage thresholds
- `ui/app/page.tsx`, `ui/app/layout.tsx` — placeholder
- `docker-compose.yml`, `backend/Dockerfile`, `ui/Dockerfile`
- `.github/workflows/ci.yml`
- `.env.example`, `.eslintrc.cjs`, `.prettierrc`

**Tests**
- integration (Supertest): `GET /health` → 200, body `{ status: 'ok', mode: 'SHADOW' }`
- unit: config module rejects an invalid `EXECUTION_MODE` value at startup
- unit: config module defaults `EXECUTION_MODE` to `SHADOW` when unset

**Exit criterion:** `docker compose up` → `curl localhost:3000/health` returns 200 and the UI renders
at `localhost:3001`; `npm test` passes; CI is green on a pushed branch and demonstrably red when a
coverage threshold is dropped below the limit.

---

## Story 1 — Deterministic mock market data

**Goal:** A seeded, reproducible TQQQ bar generator plus hand-authored fixture scenarios that every
later strategy test replays against.

**Depends on:** Story 0
**PRD refs:** §1 (`PRD.md:61`), §4 (`PRD.md:296`), §9 (`PRD.md:422`)

**In scope**
- `Bar` and `Tick` domain types (symbol, barSize, timestamp in ET, OHLCV)
- Seeded pseudo-random generator — same seed always yields the same series
- Both bar sizes: 5-minute and daily
- Hand-authored fixture scenarios, committed as data, each with a documented expected outcome:
  - `gap-down-open` — market gaps down 4% at 09:30 (anchor must re-base to the gapped open)
  - `gap-down-recover` — gaps down then recovers (anchor takes the higher of prev close / open, so
    no stale anchor stranded below market)
  - `steady-decline` — sustained fall past the 25% hard floor
  - `chop-range` — the oscillating range that motivates per-lot exits (`PRD.md:127`); must produce
    repeated rung cycles
  - `session-edges` — bars at 09:30, 09:44, 09:45, 15:59, 16:00, plus pre/post-market bars
- CLI: `npm run replay -- --fixture chop-range` prints the bar stream
- Fixtures are pure data with no strategy knowledge

**Out of scope**
- Real historical data → Story 10
- Fill modeling / slippage → Story 11
- Synthetic 3x QQQ series → Story 10

**Files**
- `backend/src/market-data/types.ts` — `Bar`, `Tick`, `BarSize`
- `backend/src/market-data/mock/generator.ts` — seeded generator
- `backend/src/market-data/mock/fixtures/*.json` — the five scenarios
- `backend/src/market-data/mock/replay.service.ts` — streams a fixture as bars
- `backend/src/cli/replay.ts` — CLI entry

**Tests**
- unit: same seed → byte-identical series; different seed → different series
- unit: generated 5-min bars fall only on 5-minute boundaries in ET, DST transitions included
- unit: each fixture loads and satisfies its documented invariant (e.g. `chop-range` crosses its
  band at least 3 times; `steady-decline` closes >25% below its first bar)
- integration: replay service emits bars in strict timestamp order with no gaps or duplicates

**Exit criterion:** `npm run replay -- --fixture chop-range` streams a deterministic series; re-running
produces identical output; all five fixtures load and pass their invariant tests.

---

## Story 2 — Strategy interface, contract tests, scaffolded strategies

**Goal:** The plugin architecture exists and is enforced: four strategies register with the
coordinator, all pass a shared contract suite, three are inert.

**Depends on:** Story 0
**PRD refs:** §2 (`PRD.md:203`), §9 contract tests (`PRD.md:441`), §1 sentiment (`PRD.md:199`)

**In scope**
- `Strategy` interface exactly as `PRD.md:210`: `initialize`, `onTick`, `onBar`, `evaluate`, `terminate`
- `StrategyContext` (immutable), `StrategyState` (fully serializable — the durable recovery unit),
  `OrderIntent`
- **`Contract` models options from day one**: symbol, secType, strike, expiry, right, multiplier
  (`PRD.md:226`). Retrofitting options later is a rewrite.
- Multi-strategy coordinator: registers strategies, dispatches lifecycle hooks, honors enable/disable
- Shared contract test suite every plugin must pass, asserting:
  - hooks return the declared types
  - **no I/O** — strategies get no broker, no repository, no clock; injecting a context whose forbidden
    members throw proves nothing calls them
  - `StrategyState` survives a `JSON.parse(JSON.stringify(state))` round trip unchanged
  - `terminate` is idempotent
- `GridStrategy`, `WheelStrategy`, `LeapsStrategy` — interface implementations, registered, **disabled
  in config**, no live wiring
- `SentimentProvider` interface with a null implementation (`PRD.md:199`)

**Out of scope**
- Any dip-ladder logic → Story 3
- Real behavior in the three scaffolds → Story 16
- Order submission of any kind → Story 5/6

**Files**
- `backend/src/strategies/strategy.interface.ts`
- `backend/src/strategies/types.ts` — `StrategyContext`, `StrategyState`, `OrderIntent`, `Contract`
- `backend/src/strategies/coordinator.service.ts`
- `backend/src/strategies/contract-test-suite.ts` — exported, reused by every plugin's spec
- `backend/src/strategies/{grid,wheel,leaps}/*.strategy.ts` — scaffolds
- `backend/src/sentiment/sentiment.provider.ts`, `null-sentiment.provider.ts`

**Tests**
- contract: all three scaffolds pass the shared suite
- unit: coordinator registers 4 strategies; disabled ones receive no hook calls
- unit: coordinator runs multiple strategies concurrently across different symbols without state bleed
- unit: `Contract` round-trips an option (strike/expiry/right/multiplier) and an equity
- unit: strategy calling a forbidden context member throws — proving the no-I/O rule is enforced, not
  merely documented
- unit: null sentiment provider returns neutral and never vetoes

**Exit criterion:** contract suite green for all registered strategies; coordinator test shows 4
registered, 3 disabled and receiving zero hook invocations.

---

## Story 3 — Dip ladder core: anchor, rungs, firing, invalidation

**Goal:** The ladder computes correct rung prices and fires correct entry intents when mock fixtures
are replayed through it.

**Depends on:** Stories 1, 2
**PRD refs:** §1 entry rules (`PRD.md:61`), sizing (`PRD.md:107`), invalidation (`PRD.md:161`),
§9 unit tests (`PRD.md:422`)

**In scope**
- **Bootstrap anchor** (no position): `max(previous session close, today's open)`, recomputed each
  session; first rung one spacing unit below
- **Ladder progression** (position held): anchor = price of the **lowest currently-held lot**; next
  rung one spacing unit below. Chains off live exposure, not a fixed grid.
- **Spacing**, both implemented from day one: fixed percentage (default 5%) and ATR multiple
  (default 1× ATR-14 on daily bars). Percentage is the default; switching is config, not a rewrite.
- **Firing on 5-minute bar close**: fires when close ≤ rung price and that rung holds no lot. A rung
  missed by an intra-bar spike-and-recover is accepted.
- **Session window**: fires only 09:45–16:00 ET. Anchor still computed from the 09:30 open — the
  exclusion applies to firing, not anchoring. Pre/post-market excluded entirely.
- **Flat sizing**: each rung 25% of symbol capital; escalation exists as a config parameter,
  **defaulted off** (`PRD.md:107`)
- **Invalidation**: max 5 concurrent rungs held; hard floor 25% below first entry stops adding but
  **never sells**; no stop-loss at any level
- Emits `OrderIntent[]` only — no submission

**Out of scope**
- Exits, lots, re-arming → Story 4
- Risk approval → Story 5
- Persistence → Story 8

**Files**
- `backend/src/strategies/dip-ladder/dip-ladder.strategy.ts`
- `backend/src/strategies/dip-ladder/anchor.ts` — bootstrap + progression
- `backend/src/strategies/dip-ladder/spacing.ts` — percentage + ATR-14
- `backend/src/strategies/dip-ladder/session-window.ts` — ET boundaries, DST-aware
- `backend/src/strategies/dip-ladder/invalidation.ts` — rung count, hard floor
- `backend/src/strategies/dip-ladder/config.ts` — typed params with defaults

**Tests**
- unit: rung price calculation, percentage spacing
- unit: rung price calculation, ATR-14 spacing (incl. insufficient-history fallback)
- unit: bootstrap anchor = max(prev close, open) — normal case
- unit: bootstrap anchor, **gap-down** — anchor re-bases to gapped open; first rung a further 5% below
- unit: bootstrap anchor, **gap-down-then-recover** — no stale anchor stranded below market
- unit: lowest-held-lot anchor progression
- unit: session window — no fire at 09:44, fires at 09:45, no fire at 16:00, none pre/post-market
- unit: concurrent-rung limit stops firing at 5
- unit: hard floor at −25% stops adding and emits **no** sell intent
- unit: flat sizing — every rung 25% of symbol capital; escalation off by default
- scenario: `steady-decline` fixture → ladder fully extends then stops at the floor, still holding
- contract: dip ladder passes the Story 2 shared suite

**Exit criterion:** replaying each fixture produces intents at prices matching hand-calculated rung
values in the fixture's documented expectation; no intent is ever generated outside 09:45–16:00 ET.

---

## Story 4 — Per-lot FIFO exits and rung re-arming

**Goal:** Lots exit independently at their own targets, rungs re-arm and fire again — the chop cycle
that motivates this design works end to end.

**Depends on:** Story 3
**PRD refs:** §1 exit rules (`PRD.md:127`), §9 ladder cycling (`PRD.md:432`), §6 `Lot` (`PRD.md:360`)

**In scope**
- `Lot` as a first-class domain entity: rung reference, fill price, quantity, open timestamp, exit
  target, status `HELD`/`CLOSED`
- **Per-lot take-profit**: each lot exits when **that lot** is up its own target (default +5%)
  measured from **its own fill price**, never from the blended average
- **FIFO disposal**: when a rung's target is hit, the oldest lot at that rung (by open timestamp) is
  sold
- **Lots only ever exit in profit.** No per-lot stop, no loss-booking exit. A lot below target
  continues to be held.
- **Rung re-arming**: on exit, the rung is re-armed **at its original price** and may fire again. A
  rung may not fire while it already holds a lot.
- Re-armed empty rungs **do not** count against the 5-concurrent limit
- Blended average cost computed for **display only** — never an input to an exit decision
- Average-cost exit available as a config option, **not default**

**Out of scope**
- Persistence of lots → Story 8
- Reconciliation against IB net position → Story 9

**Files**
- `backend/src/strategies/dip-ladder/lot.ts` — `Lot` entity, FIFO queue
- `backend/src/strategies/dip-ladder/rung.ts` — rung state, re-arming
- `backend/src/strategies/dip-ladder/exits.ts` — per-lot target evaluation
- `backend/src/strategies/dip-ladder/average-cost.ts` — display-only blend + optional exit mode

**Tests**
- unit: per-lot target computed from that lot's own fill price, not the blend
- unit: FIFO disposal ordering when one rung holds multiple lots across cycles
- unit: rung re-arms at its **original** price after a lot exits, not at the exit price
- unit: a rung holding a lot cannot fire again
- unit: re-armed empty rungs excluded from the concurrent-rung limit
- unit: a lot below target is never sold — no stop path exists
- unit: blended average is display-only; changing it cannot trigger an exit
- **scenario (chop suite, the headline test):** `chop-range` fixture → rung fires → hits target →
  exits → re-arms → fires again, repeatedly. Asserts realized P&L per completed cycle **and that
  lower lots are untouched throughout**.
- scenario: upper rungs cycle while a lower lot holds through the entire drawdown
- unit: `selling to lower the average` is not implemented — no code path books a loss to adjust basis

**Exit criterion:** the chop scenario suite is green, showing ≥3 complete cycles on one rung with
correct realized P&L, while a lower lot remains held and untouched across all of them.

---

## Story 5 — Risk manager chokepoint and the four safety controls

**Goal:** Every intent passes through the risk manager; there is no code path from a strategy to
order submission that bypasses it.

**Depends on:** Story 4
**PRD refs:** §3 (`PRD.md:235`), execution modes (`PRD.md:266`), §9 integration (`PRD.md:434`)

**In scope**
- `RiskManager.evaluate(intent) → Approved | Resized | Rejected`, with a reason on every outcome
- **Global capital cap: total deployed capital across all strategies ≤ 60% of account equity**
  (`PRD.md:243`) — the control a per-symbol limit cannot provide
- Per-symbol and per-strategy allocation limits
- **Daily loss circuit breaker** — halts all strategies on breach; threshold **configurable and
  deliberately unset**; halts new submission, **does not liquidate**
- **Kill switch** — single point halting all new order submission, effective within one evaluation cycle
- **Live-account guard** — refuses `LIVE` absent an explicit config flag, asserted at startup
- **Startup assertion refusing `PAPER`/`LIVE`** while per-symbol capital or the daily loss threshold
  is unset (`PRD.md:505`) — no silent default
- Execution modes `SHADOW` (default) / `PAPER` / `LIVE`; in `SHADOW`, intents are logged with full
  order payloads and nothing is submitted
  — *`SHADOW` was retired at Story 13 and is now refused by this same assertion; `PAPER` is the
  default. The assertion and the guard are unchanged.*
- `RiskEvent` emitted for **every** rejection, resize, halt, and kill-switch activation

**Out of scope**
- Setting the capital and loss-threshold **values** → Story 13
- `RiskEvent` durable storage → Story 8

**Files**
- `backend/src/risk/risk-manager.service.ts`
- `backend/src/risk/capital-cap.ts` — global 60% + per-symbol/per-strategy
- `backend/src/risk/loss-breaker.ts`
- `backend/src/risk/kill-switch.service.ts`
- `backend/src/risk/live-account-guard.ts`
- `backend/src/risk/startup-assertions.ts`
- `backend/src/risk/risk-event.ts`

**Tests**
- unit: capital cap arithmetic — approve under 60%, resize at the boundary, reject over
- unit: five rungs on one symbol approved; the same five across eight symbols rejected by the global
  cap (the broad-selloff case at `PRD.md:243`)
- unit: per-symbol and per-strategy limits reject independently of the global cap
- unit: daily loss breaker halts on breach and emits a `RiskEvent`
- unit: breaker halts **new submission only** — no liquidation intent is ever produced
- unit: kill switch halts submission within one evaluation cycle
- unit: live-account guard rejects startup when the explicit flag is absent
- unit: startup assertion refuses `PAPER` while per-symbol capital is unset
- unit: startup assertion refuses `PAPER` while the daily loss threshold is unset
- unit: `SHADOW` logs the full order payload and submits nothing
- integration: **no strategy can reach a broker except through the risk manager** — asserted by
  architecture test over module imports, not just by convention
- unit: every rejection/resize/halt produces exactly one `RiskEvent` with a reason

**Exit criterion:** an architecture test proves no strategy module imports a broker module; all four
safety controls have a passing test; the app refuses to boot in `PAPER` with unset parameters.

---

## Story 6 — Engine HTTP API and `MockBrokerAdapter`

**Goal:** The engine runs as a service over replayed mock data and exposes its state over HTTP.

**Depends on:** Story 5
**PRD refs:** §4 (`PRD.md:276`), §7 monitoring (`PRD.md:373`)

**In scope**
- `BrokerAdapter` interface (`PRD.md:278`)
- **`MockBrokerAdapter`** — deterministic test double: accepts orders, produces configurable fills,
  reports positions, can simulate disconnects and rejections. A real artifact, not scaffolding.
- Engine service wiring: replay fixture → coordinator → dip ladder → risk manager → mock broker
- Read endpoints: `GET /intents`, `GET /lots`, `GET /rungs`, `GET /positions`, `GET /risk-events`,
  `GET /status` (mode, connection health, active halts)
- Control endpoints: `POST /kill-switch`, `POST /strategies/:id/enable|disable`, `POST /mode`
- In-memory repositories behind repository interfaces — the same interfaces Prisma implements at
  Story 8

**Out of scope**
- `IBBrokerAdapter` → Story 10
- `SimulatedBrokerAdapter` / fill modeling → Story 11
- Durable storage → Story 8
- UI → Story 7

**Files**
- `backend/src/broker/broker-adapter.interface.ts`
- `backend/src/broker/mock/mock-broker.adapter.ts`
- `backend/src/engine/engine.service.ts`
- `backend/src/api/*.controller.ts`
- `backend/src/repositories/*.interface.ts` + `in-memory/*.repository.ts`

**Tests**
- integration (Supertest): full flow — replay `chop-range` → `GET /lots` shows held lots with correct
  fill prices, targets, and ages
- integration: `GET /rungs` distinguishes held / re-armed / pending with prices
- integration: `POST /kill-switch` → subsequent bars produce zero submissions
- integration: `POST /mode` cannot reach `PAPER` while startup parameters are unset
- integration: **order payload generated field-by-field** matches the expected broker order structure
  (`PRD.md:435`)
- integration: mock broker simulated disconnect mid-order → new entries halt, alert surfaces on
  `GET /status`, **existing positions are not liquidated** (`PRD.md:316`)
- integration: reconnect with exponential backoff resumes normal operation

**Exit criterion:** `docker compose up` → replay a fixture → `GET /lots` and `GET /rungs` return the
ladder state matching the Story 4 chop scenario; kill switch verified over HTTP.

---

## Story 7 — Dashboard

**Goal:** The full control center in a browser, driven by the Story 6 API on mock data.

**Depends on:** Story 6
**PRD refs:** §7 (`PRD.md:373`), parameter edit semantics (`PRD.md:386`)

**In scope**
- **Monitoring:** account equity, open positions, ladder rung state (held / re-armed / pending with
  prices), **per-lot table — fill price, quantity, age, individual target, distance to target**,
  blended average cost **labelled "reference only"**, realized P&L per completed lot cycle, order and
  fill log, live P&L, connection health, active alerts
- **Control:** global kill switch **always visible**, per-strategy enable/disable, execution mode
  switch, live parameter editing
- **Parameter edit semantics — applies to future rungs only** (`PRD.md:386`):
  - each held lot's exit target is **frozen** at the parameters in force when that lot filled
  - new values affect only rungs not currently holding a lot, including re-armed rungs, which pick up
    current parameters on their next fire
  - full recompute is **not permitted** — a single edit must never move a live position into or out
    of an exit condition
- Every parameter change persisted with timestamp, old value, new value, and strategy state at the time
- Mode switch to `PAPER`/`LIVE` blocked in the UI with the reason shown when assertions fail

**Out of scope**
- No MSW / mock API layer — the UI is built against the real running backend
- Backtest result views → Story 11

**Files**
- `ui/app/page.tsx` — dashboard shell
- `ui/app/components/{LadderView,LotTable,KillSwitch,ModeSwitch,ParameterEditor,AlertBanner}.tsx`
- `ui/app/lib/api.ts` — typed client for the Story 6 endpoints
- `backend/src/api/parameters.controller.ts` — edit endpoint enforcing frozen-target semantics
- `backend/src/strategies/dip-ladder/parameter-change.ts` — append-only change record

**Tests**
- unit (backend): a parameter edit **does not** alter the exit target of any currently-held lot
- unit (backend): a re-armed rung picks up **current** parameters on its next fire
- unit (backend): full recompute is rejected — no endpoint can retarget a filled rung
- unit (backend): every parameter change is recorded append-only with old value, new value, timestamp
- component: per-lot table renders fill price, age, own target, and distance to target
- component: blended average is rendered with its "reference only" label
- component: kill switch is present on every dashboard route
- e2e: kill switch clicked in browser → backend halts submission
- e2e: mode switch to `PAPER` with unset parameters shows the blocking reason

**Exit criterion:** in a browser against replayed mock data, the ladder cycles visibly (fire → target
→ exit → re-arm), the per-lot table shows independent targets, and the kill switch demonstrably halts
the engine.

---

## Story 8 — Prisma / MySQL swap

**Goal:** Replace in-memory repositories with durable MySQL storage; state survives a restart.

**Depends on:** Story 6
**PRD refs:** §6 (`PRD.md:354`)

**In scope**
- MySQL 8.0 added to `docker-compose.yml`
- Prisma schema for: `Instrument`, `Bar` (composite index on symbol + barSize + timestamp),
  `OrderIntent`, `Order`, `Fill`, `Position`, `Lot`, `Rung`, `StrategyInstance`,
  `StrategyStateSnapshot`, `RiskEvent`, `ParameterChange`, `BacktestRun`, `BacktestResult`
- Prisma implementations of the Story 6 repository interfaces — **no call-site changes**
- `Lot` durable: rung ref, fill price, quantity, open timestamp, exit target, status; FIFO ordered by
  open timestamp
- `Rung` records level price and whether it currently holds a lot, so **re-arming survives restart**
- **`OrderIntent` persists before submission** (`PRD.md:366`) — this is what makes the crash window
  recoverable
- `RiskEvent` rows for every rejection/halt/kill-switch
- `ParameterChange` append-only, never in-place update
- `StrategyStateSnapshot` versioned so a schema change does not orphan live state
- Migrations + seed script

**Out of scope**
- Reconciliation logic → Story 9
- Real bar ingestion → Story 10

**Files**
- `backend/prisma/schema.prisma`, `backend/prisma/migrations/*`
- `backend/src/repositories/prisma/*.repository.ts`
- `docker-compose.yml` — MySQL service, healthcheck, volume

**Tests**
- integration: every repository interface has a Prisma implementation passing the **same** test suite
  as the in-memory one
- integration: `OrderIntent` row exists **before** any submission attempt
- integration: restart mid-ladder → lots, rungs (incl. re-armed flags), and anchor reload identically
- integration: `Bar` composite index used for symbol+barSize+timestamp range queries
- integration: `ParameterChange` is append-only — an update attempt fails
- integration: a versioned `StrategyStateSnapshot` from an older version loads or is explicitly rejected
- unit: FIFO ordering preserved across a persistence round trip

**Exit criterion:** `docker compose up` with MySQL → run the chop fixture → kill the backend
mid-scenario → restart → ladder state (lots, rung arming, anchor) is byte-identical to pre-restart.

---

## Story 9 — Startup reconciliation and crash recovery

**Goal:** IB is truth for positions; the DB is truth for lot composition; any mismatch halts the
symbol rather than guessing.

**Depends on:** Story 8
**PRD refs:** §5 (`PRD.md:321`), lot reconciliation (`PRD.md:334`), §9 integration (`PRD.md:434`)

**In scope**
- Startup sequence **before any strategy resumes** (`PRD.md:323`):
  1. query broker for actual positions and open orders
  2. load persisted strategy state from MySQL
  3. reconcile — **broker authoritative on positions/orders; DB authoritative on strategy intent**
     (which rungs hold lots, lot composition, anchor)
  4. on discrepancy: log, alert, **refuse to trade that symbol** until resolved
- **The lot-sum assertion** (`PRD.md:343`): sum of held lot quantities **must equal** broker net
  position. Match → lot structure trusted, ladder resumes. Mismatch → symbol halted for manual
  resolution. **The system must never guess at lot composition** — guessing wrong means selling the
  wrong lot at the wrong target.
- Crash-window recovery: crash between order submission and fill persistence, with lots partially
  written
- Reconciliation status surfaced on `GET /status` and the dashboard

**Out of scope**
- Real IB connection → Story 10 (this story reconciles against `MockBrokerAdapter`)

**Files**
- `backend/src/reconciliation/reconciliation.service.ts`
- `backend/src/reconciliation/lot-sum-assertion.ts`
- `backend/src/reconciliation/symbol-halt.service.ts`
- `backend/src/engine/startup.sequence.ts`

**Tests**
- integration: clean restart with a held ladder → lot sum matches net position → ladder resumes with
  exact lot structure
- integration: **injected quantity mismatch** → symbol halted, alert raised, **no trading on that
  symbol**, other symbols unaffected (`PRD.md:349`)
- integration: crash between submission and fill persistence, lots partially written → recovery
  reaches a consistent state or halts explicitly, never silently diverges
- integration: broker reports a position the DB has no lots for → halt
- integration: DB has lots the broker reports no position for → halt
- integration: reconciliation runs **before** any strategy hook fires — asserted by call ordering
- unit: a held ladder of 3 lots and a single block of the same share count are indistinguishable to
  the broker, so the DB alone determines composition

**Exit criterion:** killing the backend mid-session with an open position and restarting restores
exact ladder state; an artificially injected mismatch halts the symbol and is visible on the dashboard.

---

## Story 10 — IB broker adapter with pacing-aware historical cache

**Goal:** Real IB Gateway connection in `SHADOW` mode, with historical data served from cache and IB
called only to fill gaps.

**Depends on:** Story 9
**PRD refs:** §4 (`PRD.md:276`), pacing (`PRD.md:287`), history depth (`PRD.md:297`), §10 (`PRD.md:449`)

**In scope**
- `IBBrokerAdapter` — local socket to IB Gateway/TWS; market data streaming, historical bars, order
  lifecycle tracking
- IB Gateway (IBC-based auto-login) added to `docker-compose.yml`, headless
- **Pacing as a correctness requirement** (`PRD.md:289`): ~60 requests / 10 minutes, no identical
  request within 15 seconds, small-bar-size restrictions. Exceeding them does not error cleanly — IB
  silently throttles or drops the connection.
- **All historical bars cached in MySQL and served from there. IB is called only to fill gaps,
  through a rate-limited request queue.**
- History depth: daily to inception (**TQQQ from Feb 2010**); QQQ daily to 1999 with 3x daily returns
  synthesized and **clearly labelled synthetic** (they exclude expense ratio and financing costs that
  make real leveraged ETFs decay faster); 5-minute to IB's ~6-month cap
- One-time paced backfill at setup; incremental gap-filling thereafter
- **Failure handling — fail safe** (`PRD.md:311`): bounded reconnect with exponential backoff; on
  exhausted retries / stale data beyond threshold / unexpected rejection → halt new entries, raise
  alert, surface on dashboard; **existing positions are never auto-liquidated on a technical fault**
- **IB Gateway periodic forced re-authentication handled as a routine event**, not an exception

**Out of scope**
- Any submission — mode stays `SHADOW` (`PAPER` is Story 13)

**Files**
- `backend/src/broker/ib/ib-broker.adapter.ts`
- `backend/src/broker/ib/pacing-queue.ts` — rate limiter
- `backend/src/broker/ib/reconnect.ts` — backoff + forced re-auth handling
- `backend/src/market-data/history/backfill.service.ts`
- `backend/src/market-data/history/cache.service.ts` — cache-first, gap-fill
- `backend/src/market-data/history/synthetic-3x.ts` — labelled synthetic QQQ→TQQQ series
- `docker-compose.yml` — IB Gateway service

**Tests**
- integration (mocked socket): pacing queue never exceeds 60 requests / 10 min under burst load
- integration: identical request inside 15 seconds is suppressed or delayed, never sent
- unit: cache-first — a fully-cached range issues **zero** IB requests
- unit: partial cache issues requests for gaps only
- integration: forced re-authentication mid-session → reconnect succeeds, streaming resumes
- integration: socket drop → exponential backoff → reconnect
- integration: retries exhausted → new entries halted, alert raised, **positions untouched**
- integration: stale data beyond threshold → same fail-safe path
- unit: synthetic 3x series is flagged `synthetic: true` and cannot be silently mixed with real bars
- integration: full backfill (daily to inception + 5-min to cap) completes without tripping pacing

**Exit criterion:** `docker compose up` brings all four services healthy; the backend connects to IB
Gateway; backfill populates daily history to inception and 5-min to IB's cap without tripping pacing;
`SHADOW` mode streams live bars and generates intents.

---

## Story 11 — Backtester

**Goal:** Validate the ladder rules against real TQQQ history through the same strategy and risk code.

**Depends on:** Story 10
**PRD refs:** §8 (`PRD.md:400`), Phase 2 exit criterion (`PRD.md:470`)

**In scope**
- **`SimulatedBrokerAdapter` behind the same `BrokerAdapter` interface, running identical strategy and
  risk-manager code** — an implementation, not a parallel engine
- Staged per `PRD.md:405`:
  1. **Replay harness** — stream cached bars through the real strategy + risk layer, emit the intents
     that would have been generated
  2. **Fill modeling** — commission, slippage, limit-fill assumptions
  3. **Statistics** — total/annualized return, max drawdown, win rate, average holding period, rung
     distribution, time-in-position
  4. **Parameter sweeps** — grid over spacing, rung count, exit target
- `BacktestRun` / `BacktestResult` persisted so results are comparable across parameter sets
- Backtest views on the dashboard
- **The 2022 drawdown examined explicitly**, as its own reported scenario — not averaged into a
  summary statistic

**Out of scope**
- Changing strategy defaults based on results — that is a decision for Story 13

**Files**
- `backend/src/broker/simulated/simulated-broker.adapter.ts`
- `backend/src/backtest/{replay-harness,fill-model,statistics,parameter-sweep}.ts`
- `backend/src/backtest/backtest.service.ts`
- `ui/app/backtest/page.tsx`

**Tests**
- integration: the same strategy code runs unmodified against simulated and mock brokers, producing
  identical intents for identical bars — proving the strategy cannot tell which broker exists
- unit: fill model applies commission and slippage; limit fills only when price trades through
- unit: each statistic computed correctly against a hand-worked fixture
- integration: parameter sweep produces one persisted `BacktestRun` per combination
- **scenario: 2022 (TQQQ ~−80%)** — reported as its own result showing max drawdown, ladder extension,
  time at the hard floor, and whether lots ever reached their targets
- scenario: 2020 (~−70%) drawdown
- scenario: rules evaluated on synthetic 3x QQQ across 2000 and 2008, output labelled synthetic
- integration: 5-minute validation over the available ~6-month window

**Exit criterion:** backtests run over TQQQ daily history 2010–present and 5-min over the ~6-month
window; the 2022 scenario is reported explicitly and reviewed before proceeding.

---

## Story 12 — SHADOW soak — **SUPERSEDED**

> **Status: the instrumentation shipped and is still in use; the soak week itself never ran.**
>
> `DailyReportService`, the anomaly codes, and `docs/soak-log.md` were all built and are now the
> backbone of the **Story 14 `PAPER` soak** instead. What was abandoned is the *`SHADOW` week* — the
> mode was retired at Story 13 before the week was completed, so there is no state in which this
> story's exit criterion can now be met as written.
>
> **Why it could not simply be finished first.** The exit criterion is "correct intents with zero
> reconciliation errors", but in `SHADOW` the database legitimately diverges from the broker — the
> ladder records intents that were never submitted, so a restart with a held ladder *always* halted on
> the lot-sum assertion. The soak was therefore proving reconciliation against a divergence that only
> existed because of the mode. The `PAPER` soak tests the real thing.
>
> **Read this story for the report's design rationale**, which still holds. Read Story 14 for the
> procedure that is actually run.

**Goal:** ~~Prove the engine generates correct intents against live market data for a full week with
zero reconciliation errors.~~ Superseded by Story 14.

**Depends on:** Story 10
**PRD refs:** Phase 1 exit criterion (`PRD.md:468`), §12 (`PRD.md:486`)

**In scope**
- Run `SHADOW` continuously for one full trading week against live IB data
- Daily verification: intents match hand-calculated rung prices for that session
- Monitor reconciliation on every restart
- Structured logging + a daily summary report
- Log and triage every anomaly; fix and redeploy within the soak

**Out of scope**
- Any order submission

**Files**
- `backend/src/observability/daily-report.service.ts`
- `docs/soak-log.md` — running record of anomalies and resolutions

**Tests**
- operational: each session's intents reconciled by hand against expected rung prices
- operational: at least one deliberate mid-session restart per week, verifying reconciliation
- integration: daily report content asserted against a fixture session

**Exit criterion (`PRD.md:468`):** ~~shadow mode runs a **full week** generating correct intents with
**zero reconciliation errors**. Any week containing an unexplained anomaly restarts the clock.~~

**Not met, and now unmeetable — carried to Story 14.** The "full week, zero unexplained anomalies,
one anomaly restarts the clock" rule survives intact; only the mode it runs in changed.

**What was built here and is still live:**

- `DailyReportService` and `GET /reports/daily?date=` — reads *persisted evidence* rather than
  counting as bars arrive, because the soak includes deliberate mid-session restarts and an in-memory
  counter would under-report exactly the sessions under scrutiny.
- The rung check as an **independent recomputation**, not a readback of the ladder's own rung list —
  which would be a test that cannot fail.
- **A skip is not a pass** (`RUNG_VERIFICATION_SKIPPED`): "could not check" must never read as
  "checked and fine".
- `docs/soak-log.md`, since revised for `PAPER`.

**Changed at Story 13**, once the report had to describe a mode that submits:

- `SUBMISSION_IN_SHADOW` → `RETIRED_MODE`. The old code asserted nothing was ever submitted, which is
  no longer a property this system has.
- `outsideFiringWindow` counts **entries only** — the window governs firing, not exiting, so a lot
  taking profit in the opening auction was raising a false anomaly against a rule the engine was
  honouring.
- The anchor is recomputed **per intent**, not once per session, since it depends on what is held at
  that moment. A single session-wide anchor reported every entry after the first as a false mismatch.

---

## Story 13 — PAPER enablement — **BUILT, wider than planned**

**Goal:** Close the two open PRD items and submit the first real order to the IB paper account.

**Depends on:** ~~Stories 11, 12~~ Story 11. **Story 12's soak week was not completed** — see that
story and "What changed from the plan" below.
**PRD refs:** Open Items (`PRD.md:500`), §3 breaker tension (`PRD.md:252`)

**In scope**
- **Set per-symbol capital allocation.** Informed by Story 11 backtests. Recall the allocation figure
  represents *expected* deployment, not maximum — five flat rungs at 25% each = 125% of nominal.
- **Set the daily loss threshold.** Resolve the tension recorded at `PRD.md:252`: a dip-buying ladder
  is expected to sit in unrealized loss **by design**, so a tight unrealized threshold trips during
  normal operation, while realized-only would never trip on the scenario that actually matters.
  Decide and **record the reasoning** — on TQQQ with no stop-loss this is the system's only automated
  drawdown response.
- Verify the startup assertion now passes and `PAPER` becomes reachable
- Confirm the paper account inherits market data subscriptions from the funded live account
  (`PRD.md:460`)
- Switch mode to `PAPER`; first order round-trips submission → fill → persistence

**Added during the story** — each forced by something found while making `PAPER` real:
- **Retire `SHADOW`** and make `PAPER` the default; refuse `SHADOW` at startup
- **Resting limit orders** (`OrderPlacement.RESTING`), `RungStatus.WORKING`, and the fill router
- **Open-order reconciliation** — `BrokerAdapter.getOpenOrders()`, so a restart cannot duplicate an
  order resting at IB
- **`assertSingleCurrency`** — the CAD account vs. USD instrument mismatch
- **`LiveBarGate`** — separating IB's historical backfill from live bars
- **Live-feed re-subscription** after IB Gateway's daily logout
- **Market-data error reporting** on `GET /status` (`broker.dataErrors`)
- **Per-bar state persistence** on the live path (`BarConsumer.persistState`)

**Added after the first resting orders went unattended** — every one of these follows from a single
fact found in practice: a terminal order status can only be attributed to a rung by the process that
placed the order, so anything that happened across a restart was invisible to the engine.
- **`BrokerAdapter.getCompletedOrders()`** and order-history reconciliation — an `Order` row stayed
  `SUBMITTED` forever after an order was cancelled in TWS, so `GET /orders` showed a live order that
  existed nowhere. Reporting only; it never releases a rung.
- **`POST /reconcile` and the dashboard's Reconcile button** — reconciliation ran only at boot, so
  the only way to clear a `WORKING` rung whose order was gone was to restart the daemon mid-session.
- **`PostCloseReconcileService`** — DAY orders expire at the close, and the next session otherwise
  opened carrying them as permanently blocked levels. Orders only, never positions: a halt raised at
  16:15 unattended is the failure mode a scheduled job must not have.
- **`EngineService.recoverWorkingOrder`** — a fill arriving while the daemon was down had no
  in-memory working-order record and was dropped entirely, leaving shares at the broker with no lot
  and a symbol halted on the next boot.
- **`npm run recover:lots`** — the operator repair for a position *already* stranded that way. A
  script rather than a reconciliation path, because reconciliation must have no repair path.

**Out of scope**
- `LIVE` → Story 15

**Files**
- `backend/src/config/capital.config.ts` — the now-set values
- `docs/decisions/daily-loss-threshold.md` — the decision and its reasoning
- `docs/decisions/capital-allocation.md`
- `backend/src/broker/ib/live-bar-gate.ts`
- `backend/src/engine/resting-orders.spec.ts`
- `backend/prisma/migrations/20260814000000_rung_working_order/`
- `backend/src/reconciliation/post-close-reconcile.service.ts`
- `backend/src/cli/recover-lots.ts`
- `ui/app/components/ReconcileButton.tsx`

**Tests**
- integration: startup assertion passes with values set, still fails when either is removed
- integration: first paper order — submission → fill → persistence, all rows written correctly
- integration: order payload asserted field-by-field against IB's expected structure on the real socket
- integration: daily loss breaker fires against a **simulated losing session** at the chosen threshold
- integration: breaker halts submission without liquidating

**Exit criterion:** `PAPER` mode active; a real paper order round-trips to a persisted fill; both open
items closed with written reasoning.

**Status:** the code is built and the suite is green (1383 tests / 71 suites). **The operational half
is not signed off** — the first real paper order round-tripping against live IB is Story 14's opening
act, and the two figures still need backtest evidence before Story 15.

### What changed from the plan

**1. `SHADOW` was retired rather than left as a safer option.** Not planned here. Resting orders make
a lot the consequence of a broker fill, and `SHADOW` submits nothing — so a shadow ladder would record
intents forever and never open a lot. That is not a quieter version of live behaviour but a different
and misleading one, and a mode reporting something the system would never do is worse than no mode.
It is **refused at boot**, not silently redirected to `PAPER`: quietly upgrading a mode that submits
nothing into one that submits real orders is exactly the implicit escalation the startup assertions
exist to prevent. The enum member survives so historic `ParameterChange` and `RiskEvent` rows parse.

**2. Entries now rest at the broker.** The bar-close rule (`PRD.md:92`) only creates an order once a
bar has *closed* at or below a rung, so a dip that touches the level intra-bar and recovers fires
nothing — the ladder buys the close, not the dip. Since the levels are chosen in advance, waiting for
confirmation only forfeits fills. This is the change that pulled in `WORKING`, the persistent fill
router, and open-order reconciliation: orders now outlive the process that placed them.

**3. The capital figures were operator-chosen, not backtest-derived.** This story specifies "informed
by Story 11 backtests"; no backtest was run. They were derived from the account balance and the cap
arithmetic. **They are defensible as *safe* — a full ladder fits the global cap with headroom — but
are not claimed to be optimal**, nor validated against the 2022 ~80% drawdown at `PRD.md:470`.
Recorded in both decision documents rather than left implicit. **Story 15 must close this.**

**4. A currency error was found and only partly fixed.** The paper account reports `NetLiquidation`
in **CAD**; TQQQ trades in **USD**; the risk layer converts nothing. A USD notional was being capped
against a CAD figure, permitting ~1.39× more exposure than intended — masked because a stale-low
equity figure tightened the cap while the missing conversion loosened it. Two errors partly
cancelling is not a control. Resolved by expressing every figure in USD and converting the balance
**once, by hand**, which makes the arithmetic sound but leaves `PAPER_ACCOUNT_EQUITY` carrying FX
staleness on top of balance staleness. **Live FX conversion remains open and is mandatory before
`LIVE`.**

**5. A live-data hazard surfaced that no fixture could have caught.** IB's
`getHistoricalDataUpdates` is backfill-then-stream and re-emits the in-progress bar as it forms.
Treating every emission as a closed bar **walked a live ladder down five rungs in sixteen seconds
against stale prices** — which, in `PAPER`, went straight at the submission path. `LiveBarGate` is
the fix. Related: a bar subscription does not survive the socket it was made on, so IB Gateway's
daily logout silently ended the feed for the life of the process until re-subscription was added.

---

## Story 14 — PAPER soak and fix loop

**Goal:** Run on paper until the full lifecycle — including exits and re-arming — has demonstrably
executed against a real broker.

**Depends on:** Story 13
**PRD refs:** §12 (`PRD.md:486`), rollout decisions above

> **This story now absorbs Story 12's soak week**, which was superseded before it ran. The daily
> report, the anomaly codes, and `docs/soak-log.md` all carry over — as does the rule that **one
> unexplained anomaly restarts the clock**. What changed is the mode they run in, and two daily
> checks that now mean the **opposite** of what they meant under `SHADOW`:
>
> | Check | Under `SHADOW` | Under `PAPER` |
> |---|---|---|
> | `intents.submitted` | Had to be **0** every day; anything else stopped the soak | Expected **non-zero**; a zero on a day the ladder fired needs investigating |
> | Lot-sum halt on restart | **Routine** — the DB legitimately diverged from an empty broker position | **A genuine finding.** Every lot now follows a real fill, so the two should agree |

**In scope**
- Continuous `PAPER` operation, minimum four weeks
- **Gate: at least one complete lot cycle** — fire → target → exit → re-arm → fire — executed against
  the real paper broker. A ladder that has only fired and held has never exercised the exit, re-arm,
  or FIFO code paths; that is half the system.
- **First order round-trip** — submission → resting at IB → fill → persistence. Carried from Story
  13, whose code is built but whose operational half is unverified.
- Kill switch verified **under live conditions**, not just in tests
- Every reconciliation halt investigated to root cause
- Iterate: gather feedback → fix bugs → redeploy → continue. Fixes carry regression tests.
- Compare live paper behavior against Story 11 backtest expectations; investigate divergence
- **Resting-order verification, new at Story 13** — orders now outlive the process, so:
  - `GET /orders` reconciled against IB's own order window
  - **no duplicated order at any rung across a restart** — the specific failure open-order
    reconciliation exists to prevent
  - a rung released after its DAY order expires overnight, and re-placed the next session
  - a partial fill: remainder cancelled, lot opened for the shares that actually filled
- **Verify the `RESTING` rule earns its change** — that intra-bar dips are captured which the
  bar-close rule would have missed. This is the observable justification for the departure from
  `PRD.md:92`, and it has only been reasoned about, never measured.

**Out of scope**
- Parameter tuning beyond correcting outright defects — strategy changes need their own decision

**Files**
- `docs/soak-log.md` — revised for `PAPER`; the running record
- `docs/paper-soak-log.md` — cycle records, anomalies, fixes, regression test refs

**Tests**
- operational: ≥1 complete lot cycle recorded with realized P&L matching hand calculation
- operational: kill switch activated live, halting submission within one evaluation cycle
- operational: at least one mid-session restart with successful reconciliation **and no duplicated
  resting order**
- regression: every bug found produces a failing test first, then the fix

**Exit criterion:** four weeks minimum **and** ≥1 complete lot cycle executed, **and** zero unexplained
reconciliation halts, **and** kill switch verified live, **and** no duplicated order across any
restart.

---

## Story 15 — LIVE enablement at reduced size

**Goal:** First real capital, deliberately undersized.

**Depends on:** Story 14
**PRD refs:** §3 live guard (`PRD.md:259`), §1 risk acknowledgement (`PRD.md:35`)

> **Two debts from Story 13 are mandatory blockers here.** Both are acceptable on paper, where a
> loose cap costs a simulated loss, and neither is acceptable where it costs real money.
>
> 1. **The capital figures have no backtest behind them.** `PAPER_SYMBOL_CAPITAL.TQQQ` (40,000) and
>    `dailyLossThreshold` (5,000) were operator-chosen from cap arithmetic, not derived from Story 11
>    backtests as Story 13 specified. They are safe but unvalidated — in particular, never tested
>    against the 2022 ~80% drawdown named at `PRD.md:470`.
> 2. **Account equity is a hand-converted FX snapshot.** `PAPER_ACCOUNT_EQUITY` (175,000 USD) was
>    converted by hand from 248,973.68 CAD at USD.CAD 1.3874 on 2026-08-14. It carries **two** kinds
>    of staleness — the balance and the rate — and a sustained CAD rally silently loosens the cap. The
>    ~2.5% buffer covers ordinary daily movement, not a trend.
>
> See `docs/decisions/capital-allocation.md` and `docs/decisions/daily-loss-threshold.md`.

**In scope**
- **Close the Story 13 debts above, before any live order:**
  - Run the backtester over cached TQQQ history including 2022; either confirm both figures or
    replace them, updating both decision documents with the evidence
  - Replace the hand-converted equity with a **live `USD.CAD` rate from IB** (`IDEALPRO`), treated as
    market data with its own staleness watchdog, where an unavailable or stale rate **blocks new
    entries** rather than falling back to a cached value of unknown age
- Explicit live flag set; startup assertion verified to reject its absence
- **First two weeks at 25% of nominal per-symbol allocation**, then step up. Going from paper to full
  nominal means the first real drawdown is also the first real position — on a 3x leveraged ETF,
  averaged down, with no stop-loss.
- Reduced-size period monitored daily; kill switch verified on the live account
- Step-up to full nominal is an explicit, recorded decision, not automatic
- Re-read `PRD.md` §1 before any parameter change (`PRD.md:18`)
- **Re-confirm `IB_PORT`.** With `SHADOW` gone, this setting is the last thing separating simulated
  from real money, and Story 15 is where it deliberately changes.

**Out of scope**
- New strategies → Story 16

**Files**
- `backend/src/config/live.config.ts` — flag + size multiplier with the step-up schedule
- `backend/src/config/capital.config.ts` — the revisited, backtest-backed figures
- `docs/decisions/live-cutover.md`

**Tests**
- integration: live-account guard rejects startup when the flag is absent (`PRD.md:493`)
- integration: size multiplier applied — orders at 25% of nominal during the reduced period
- integration: step-up requires an explicit config change; it cannot happen on a timer alone
- integration: a stale or unavailable FX rate blocks new entries and never falls back to a cached rate
- operational: kill switch verified on the live account

**Exit criterion:** live trading active at 25% nominal, guard verified, kill switch verified live,
**both Story 13 debts closed with written evidence**, and the step-up decision recorded after two
clean weeks.

---

## Story 16 — Phase 4 handoff: Grid, Wheel, LEAPs

**Goal:** Build out the three scaffolded strategies against the now-proven engine.

**Depends on:** Story 15
**PRD refs:** §11 Phase 4 (`PRD.md:480`), §2 scaffolds (`PRD.md:229`)

**In scope**
- **Options data pipeline — the bulk of this phase**: chains, greeks, assignment detection, expiry rolls
- `GridStrategy` — bracket limit orders at configured price increments
- `WheelStrategy` — cash-secured puts transitioning to covered calls on assignment
- `LeapsStrategy` — timed or threshold-based multi-month positioning
- Each passes the Story 2 contract suite before any live wiring
- Each goes through the same **`PAPER` → `LIVE`** progression as the dip ladder. **`SHADOW` is no
  longer available as the first rung of that ladder** (retired at Story 13), so a new strategy's
  first exposure to a broker is a paper account rather than a mode that submits nothing. Its
  substitute is the pre-broker evidence the dip ladder also had: the contract suite, fixture replay,
  and a Story 11 backtest — all of which run with no broker at all. A strategy reaching `PAPER`
  **disabled** and being enabled deliberately is the equivalent gate.
- Sentiment provider revisited **only if a paid feed is acquired**; when it lands it is a **veto
  filter, not an entry trigger** (`PRD.md:196`)

**Out of scope**
- Anything that modifies the dip ladder — it is in production

**Files**
- `backend/src/strategies/{grid,wheel,leaps}/` — real implementations
- `backend/src/market-data/options/` — chains, greeks, assignment, rolls

**Tests**
- contract: all three pass the shared suite with real behavior
- unit: option assignment transitions (Wheel: put assigned → covered call)
- unit: expiry roll logic
- unit: grid level math
- integration: global 60% capital cap holds with four strategies running concurrently — the
  correlation-goes-to-1 case at `PRD.md:243`
- integration: options `Contract` round-trips through persistence and order payload generation

**Exit criterion:** each strategy independently completes `PAPER` → `LIVE` with the same gates the
dip ladder passed — contract suite, backtest, paper soak with ≥1 complete cycle, then reduced-size
live.

---

## Traceability

Every `PRD.md` section maps to at least one story:

| PRD section | Stories |
|---|---|
| §1 Dip-buying ladder | 3, 4 |
| §2 Strategy interface | 2 |
| §3 Risk manager | 5 |
| §4 Broker boundary | 6, 10 |
| §5 State & recovery | 9 |
| §6 Persistence | 8 |
| §7 Dashboard | 7 |
| §8 Backtesting | 11 |
| §9 Testing | every story (per-story test lists) |
| §10 Containerization | 0, 8, 10 |
| §11 Roadmap | ~~12~~, 13, 14, 15, 16 — Story 12 superseded by 14 |
| §12 Verification | 0, 5, 9, 10, ~~12~~ → 14, 13, 15 |
| Open Items | 5 (assertion), 13 (values set, **not backtest-validated**), 15 (must revisit) |
