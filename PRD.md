# PRD: Modular Multi-Strategy Quantitative Trading Platform

## Context

`project-scope.md` describes a local, personal quantitative trading platform on the Interactive
Brokers API with four strategies, a NestJS backend, Next.js dashboard, MySQL persistence, and
mandatory testing plus containerization. The repository currently contains only that scope
document — no code exists.

This PRD converts that scope into a buildable specification. The central decision from the design
interview: **all four strategies are scaffolded as registered plugins in Phase 1, but only one —
a dip-buying ladder ("Simple Buy/Sell") on TQQQ — is built deep and run for real.** Grid, Wheel, and
LEAPs exist as interface implementations with contract tests and no live wiring until Phase 4.

**This is an aggressive configuration by choice.** A 3x leveraged ETF, averaged down without a
stop-loss, at rung spacing calibrated for an unleveraged index. The risks are documented in §1
rather than mitigated, because they were accepted deliberately during design. Read that section
before changing any parameter.

The engine is the product; the first strategy is how we prove the engine works. Every architectural
decision below is made to keep the strategy layer thin, testable, and incapable of bypassing risk
controls.

This system places real orders through a broker. Paper trading is the default and a deliberate,
explicit action is required to target a live account.

---

## 1. The Phase 1 Strategy: Dip-Buying Ladder

A rung-anchored accumulation ladder on **TQQQ**, evaluated on 5-minute bar closes during regular
trading hours (excluding the first 15 minutes), with **per-lot FIFO take-profit** — each rung's lot
exits independently when that lot is up its own target.

### Symbol: TQQQ — recorded risk acknowledgement

TQQQ is a **3x leveraged ETF**, chosen deliberately with 5% rung spacing retained. Two properties
make this materially more aggressive than the same ladder on an unleveraged index, and both are
accepted rather than mitigated:

**Amplified drawdown.** A 5% TQQQ move is a ~1.7% move in the underlying Nasdaq 100. But TQQQ's own
drawdowns are roughly 3x the index: QQQ fell ~35% peak-to-trough in 2022, TQQQ fell ~80%. A 5-rung
ladder at 5% spacing spans only ~20%, so on TQQQ the ladder reaches full extension during an
ordinary bad month, not a rare correction. **Expect the ladder fully deployed and past its floor
regularly.**

**Volatility decay.** TQQQ tracks 3x *daily* returns compounded, not 3x the index over time. In a
choppy sideways market QQQ can finish flat while TQQQ loses 15-20%. This partially undermines the
mean-reversion premise a dip-buying ladder rests on — there is no stable level for TQQQ to revert
to, and its price path is downward-biased in chop. Averaging down into a decaying instrument is the
central risk of this configuration.

**Consequences accepted:** rungs fire frequently; the hard floor is reached often; a sustained
downtrend produces a fully-extended position in an instrument that decays even if the index
recovers.

**Mitigation available but not default:** ATR-based spacing (already specified below) auto-widens
rungs for TQQQ's volatility. Switching the default from percent to ATR is a config change and is
the recommended first adjustment if rungs prove too tight in practice.

### Entry rules

**Bootstrap anchor (no position held).** Anchor = `max(previous session close, today's open)`,
recomputed each session. The first rung sits one spacing unit below that anchor.

This is what handles the opening-gap case: if the market gaps down 4% at the open, the anchor
re-bases to the gapped-down open, and the first rung sits a further 5% below *that* — the system
waits rather than treating the gap as "almost there."

Because the anchor takes the *higher* of previous close and open, a gap down that recovers does
not leave a stale anchor stranded below the market.

**Ladder progression (position held).** Anchor = price of the **lowest currently-held lot**. The
next rung sits one spacing unit below that. Rungs chain off live exposure, not off a fixed grid.

Anchoring on the lowest *held* lot rather than the most recent *fill* is what makes per-lot exits
coherent: when a lot takes profit and is no longer held, it stops influencing where new rungs go,
so the ladder always extends downward from real exposure.

**Rungs are price levels, not one-shot slots.** Each rung is a price at which at most one lot may be
held. When a rung's lot exits at its take-profit, that rung is **re-armed at its original price** and
may fire again. This is what allows the ladder to cycle repeatedly in a range — the primary
advantage of per-lot exits over a single average-cost exit, and especially relevant on TQQQ where
chop is frequent.

A rung may not fire while it already holds a lot.

**Spacing.** Configurable per strategy instance, expressed either as:
- Fixed percentage (default 5%) — intuitive, what you reason about initially
- ATR multiple (default 1× ATR-14 on daily bars) — volatility-normalized

Both are implemented from day one. Percentage is the default; ATR exists so that adapting spacing
to changing volatility is a config change, not a rewrite.

**Firing.** Evaluation happens on 5-minute bar close: if the bar's close is at or below the rung
price and that rung holds no lot, it fires. A rung can be missed if price spikes through and
recovers within a single bar — accepted, because the strategy buys weakness and being slightly late
is not costly.

**Session window.** Rungs may fire only during regular trading hours, **excluding the first 15
minutes** — no entry before 09:45 ET, none after 16:00 ET. The bootstrap anchor is still computed
from the 09:30 open; the exclusion applies to firing, not to anchoring. This avoids the opening
auction, where spreads are widest and TQQQ's leveraged rebalancing makes prints least reliable.
Pre- and post-market are excluded entirely.

### Position sizing

**Flat sizing across rungs — this is deliberate and should not be changed to escalating sizing
without an explicit decision.**

Each rung is 25% of the capital allocated to the symbol. Five concurrent rungs maximum, so a
fully-extended ladder is 125% of nominal symbol allocation — sized so that the allocation figure
represents the *expected* deployment, not the maximum.

**The per-symbol capital figure is not yet set.** Phase 1 runs in `SHADOW` mode where no capital is
deployed, so this is not blocking. A startup assertion must refuse to run in `PAPER` or `LIVE` mode
until a real value is configured — no silent default.

Retail DCA/grid bots almost universally escalate size on lower rungs (1×, 1.5×, 2.25×) because it
pulls average cost down faster and raises the win rate. It is also the exact mechanism that converts
a bad trade into an account-ending one: the largest position gets established at the point where
there is the most evidence the thesis is wrong. Flat sizing bounds the worst case to a knowable
number. Escalation is available as a config parameter, defaulted off.

### Exit rules

**Per-lot FIFO take-profit.** Each rung's lot exits independently when **that lot** is up its own
target (default **+5%**, matching rung spacing) measured from **its own fill price** — not from the
blended average. Lower lots keep running when higher lots exit.

Lots are tracked and disposed **FIFO**: when a rung's target is hit, the oldest lot at that rung is
the one sold. Each lot carries its own fill price, quantity, timestamp, and exit target, persisted
individually.

**Lots only ever exit in profit.** There is no per-lot stop and no loss-booking exit. A lot below its
target simply continues to be held.

This was chosen over average-cost exit and is the better fit for TQQQ: in a choppy range, upper
rungs cycle repeatedly — fire, take profit, re-arm, fire again — generating realized gains while
lower rungs continue holding through the drawdown. An average-cost exit would close everything at
once and forfeit that.

**Cost of this choice, accepted:** the position is no longer a single object with one cost basis. The
durable unit is now a *set of lots*, each with independent state. This is a materially more complex
state machine to reconcile against IB after a restart — IB reports a net position, not your lot
structure — so lot-level records in MySQL are the authoritative source for lot composition, and their
sum must reconcile to IB's net position. See §5.

**On "selling to bring the average down":** this was raised during design and is worth recording,
because the intuition is common and the mechanic doesn't work as expected. Selling a lot at a loss
*raises* the average cost of the shares that remain — buy at 100 and 90 (average 95), sell the
100-lot at 92, and the remaining 90-lot leaves you at 90. The average dropped only because the
expensive lot was disposed of at a realized loss, with less exposure remaining. The thing that
lowers the average while *keeping* exposure is buying lower, which the ladder already does. Per-lot
FIFO take-profit delivers the intended behaviour — realizing gains on individual trades at their own
prices rather than waiting for the blend — without booking losses to get there.

Average-cost exit remains available as a config option but is not the default.

### Invalidation

Three independent limits, all mandatory:

1. **Maximum 5 rungs held concurrently.** At 5% spacing, rung 5 sits roughly 18-20% below first
   entry. On an unleveraged index that is a genuine correction; **on TQQQ it is an ordinary bad
   month** — see the risk acknowledgement above. Re-armed rungs do not count against this limit
   unless they currently hold a lot.
2. **Hard floor at 25% below first entry.** Below this, the strategy stops adding entirely. It does
   **not** sell — liquidating the bottom of a dip-buying strategy is the worst of both worlds. Held
   lots continue to wait for their individual targets.
3. **Global capital cap (see §3).** Enforced outside the strategy.

There is no stop-loss, at either position or lot level. A stop on a dip-buying strategy is
self-contradictory: it buys weakness and would then sell more weakness. Downside is bounded by
concurrent rung count, flat sizing, and the hard floor — not by a stop.

**What this means concretely on TQQQ:** the worst case is 5 lots held through an 80%-style decline
with no stop, in an instrument whose decay means it may not recover even when the index does. That
is the accepted risk profile of this configuration. The daily loss circuit breaker (§3) is the only
control that acts on drawdown, and it halts *new* activity rather than liquidating.

### What was deliberately excluded

**News/sentiment signals.** Requested during design, deferred with agreement. The reasoning is
recorded here because it should be revisited rather than forgotten:

- Real-time news sentiment requires a licensed sub-minute feed. IB's own news (Dow Jones, Benzinga
  Pro) is a paid subscription over the same socket. Free alternatives (NewsAPI, Finnhub free tier,
  social scraping) are 15+ minutes delayed, rate-limited below usefulness, or contractually forbid
  automated trading use. A 15-minute-delayed sentiment score is not a signal.
- There is no proven open-source news-sentiment trading algorithm. There are well-known
  *components* — FinBERT for headline scoring, VADER as a lexicon baseline, gap-and-go and
  opening-range-breakout as documented price patterns. What does not exist publicly is a validated
  end-to-end profitable system. Published sentiment backtests mostly fail on transaction costs and
  look-ahead bias in news timestamps.
- **When it does land (Phase 2+), sentiment should be a veto filter, not an entry trigger** —
  suppressing a rung when a catastrophic headline is detected, never initiating a trade.

Phase 1 defines `SentimentProvider` as an interface with a null implementation so the wiring exists.

---

## 2. Strategy Interface

Per the scope's lifecycle hooks, with one binding constraint: **strategies perform no I/O.** They
receive an immutable context and return order intents. They never call the broker, never write to
the database, never read the clock directly.

```ts
interface Strategy {
  initialize(ctx: StrategyContext): Promise<StrategyState>;
  onTick(tick: Tick, state: StrategyState): OrderIntent[];
  onBar(bar: Bar, state: StrategyState): OrderIntent[];
  evaluate(ctx: StrategyContext, state: StrategyState): OrderIntent[];
  terminate(state: StrategyState): Promise<void>;
}
```

This is what makes the risk chokepoint enforceable and what makes the backtester cheap: the same
strategy code runs unmodified against live IB or a simulated broker, because it does not know which
one exists.

`StrategyState` must be fully serializable — it is the durable recovery unit.

**Instrument abstraction.** `Contract` must model options (strike, expiry, right, multiplier) from
day one even though Phase 1 trades only ETF shares. Retrofitting options into an equity-shaped
contract model is a rewrite; the Wheel and LEAPs both need it.

**Scaffolded strategies.** `GridStrategy`, `WheelStrategy`, `LeapsStrategy` implement the interface,
register with the coordinator, pass a shared contract test suite proving they honor the lifecycle,
and are disabled in config. No live wiring.

---

## 3. Risk Manager — Mandatory Chokepoint

**Strategies emit intents. Only the risk manager calls the broker.** There is no code path from a
strategy to order submission that bypasses it.

Responsibilities:

- **Approve / reject / resize** every intent before it becomes an order
- **Global capital cap: total deployed capital across all strategies never exceeds 60% of account
  equity.** This is the control that matters most and the one a per-symbol limit cannot provide.
  Five rungs on one symbol is fine; five rungs on eight symbols simultaneously is what actually
  happens in a broad selloff, because that is when everything dips together. Correlation goes to 1
  in a crisis and per-symbol limits give a false sense of bounded risk.
- **Per-symbol and per-strategy allocation limits**
- **Daily loss circuit breaker** — halts all strategies when realized + unrealized loss breaches a
  configured daily threshold. **Threshold not yet set** — deferred, and it needs a decision before
  `PAPER` mode. This is the only control in the system that responds to drawdown: the strategy has
  no stop-loss at position or lot level, and the hard floor only stops *adding*. On a 3x leveraged
  instrument that makes this breaker the sole automated response to a sustained decline. It halts new
  order submission; it does **not** liquidate. Note the tension to resolve when setting it: a
  dip-buying ladder is expected to sit in unrealized loss by design, so a tight threshold on
  unrealized P&L will trip during normal operation, while realized-only would never trip on the
  scenario that actually matters.
- **Kill switch** — single point that halts all new order submission
- **Live-account guard** — refuses to run against a live account absent an explicit config flag,
  asserted at startup

All four safety controls are Phase 1 requirements, not follow-ups.

### Execution modes

| Mode | Behavior |
|---|---|
| `SHADOW` | Strategies run, intents are logged with full order payloads, nothing is submitted. **Default.** |
| `PAPER` | Orders submitted to IB paper account |
| `LIVE` | Orders submitted to live account. Requires explicit flag + startup assertion. |

Shadow is the default operating mode for the first weeks.

---

## 4. Broker Boundary

`BrokerAdapter` interface with three implementations:

- `IBBrokerAdapter` — live socket to IB Gateway/TWS
- `MockBrokerAdapter` — deterministic test double for integration tests
- `SimulatedBrokerAdapter` — fill modeling for the backtester

Single execution path, swappable broker. This is what makes the backtester an implementation rather
than a parallel codebase.

### Market data and IB pacing

**IB's historical data pacing limits are a hard design constraint, not a performance concern.**
Roughly 60 requests per 10 minutes, plus restrictions on identical requests within 15 seconds and
on small bar sizes. Exceeding them does not produce a clean error — IB silently throttles or drops
the connection, a failure mode that reads as a bug in your own code for days.

Therefore: **all historical bars are cached in MySQL and served from there. IB is called only to
fill gaps, through a rate-limited request queue.** This is a correctness requirement.

**History depth.** "Maximum IB allows" resolves differently by bar size:
- **Daily bars:** back to instrument inception. **TQQQ launched February 2010**, so there is no
  2000 or 2008 history for it — the deepest drawdowns available are 2020 (~70%) and 2022 (~80%).
  Also ingest QQQ daily to inception (1999) so the *rules* can be evaluated across 2000 and 2008 on
  the unleveraged index, with 3x daily returns synthesized for approximate TQQQ behaviour. Synthetic
  series must be clearly labelled as such — they exclude the expense ratio and financing costs that
  make real leveraged ETFs decay faster than the naive 3x calculation.
- **5-minute bars:** approximately 6 months — IB's cap regardless of what is requested
- **Sub-minute:** a few weeks, not needed

Consequence for validation: the *rules* can be backtested on daily data across multiple major
drawdowns, but the actual 5-minute evaluation cadence can only be validated over the recent
~6-month window. One-time paced backfill at setup, incremental gap-filling thereafter.

### Failure handling — fail safe

- **Transient socket drops:** bounded reconnect with exponential backoff
- **Retries exhausted, stale data beyond threshold, or unexpected rejection:** halt all new entries,
  raise alert, surface on dashboard
- **Existing positions are never auto-liquidated on a technical fault.** A network blip must not
  become a realized loss.

---

## 5. State & Recovery — IB Is Truth

On startup, before any strategy resumes:

1. Query IB for actual positions and open orders
2. Load persisted strategy state from MySQL
3. Reconcile — IB is authoritative on positions and orders; the DB is authoritative on strategy
   intent (which rungs hold lots, lot composition, where the anchor is)
4. On discrepancy: log, alert, and refuse to trade that symbol until resolved

The DB can always be stale after a crash between order submission and fill persistence. That window
is exactly where a naive DB-is-truth system silently desynchronizes from reality.

### Lot reconciliation — the hard case

Per-lot FIFO exits make this materially harder than a single-position model. **IB reports a net
position and an average cost; it does not report your lot structure.** A held ladder of 3 lots and a
single block of the same share count are indistinguishable to IB.

Therefore:
- Lot records in MySQL are the **authoritative source for lot composition** (which rung, what fill
  price, what target)
- **The sum of held lot quantities must equal IB's reported net position.** This is the reconciliation
  assertion.
- If the sum matches, lot structure is trusted and the ladder resumes
- If the sum does not match, the symbol is halted for manual resolution — the system must never
  guess at lot composition, because guessing wrong means selling the wrong lot at the wrong target

Reconstructing ladder and lot state from IB net position plus persisted lot history — including the
mid-order-crash case and an injected quantity mismatch — is a required integration test.

---

## 6. Persistence (Prisma / MySQL 8.0)

Core models: `Instrument`, `Bar` (composite index on symbol + barSize + timestamp), `OrderIntent`,
`Order`, `Fill`, `Position`, `Lot`, `Rung`, `StrategyInstance`, `StrategyStateSnapshot`, `RiskEvent`,
`ParameterChange`, `BacktestRun`, `BacktestResult`.

Requirements:
- `Lot` is a first-class durable entity — rung reference, fill price, quantity, open timestamp, exit
  target, and status (`HELD` / `CLOSED`). FIFO disposal is ordered by open timestamp. This is the
  authoritative record of lot composition that IB cannot provide.
- `Rung` records the level price and whether it currently holds a lot, so re-arming after a per-lot
  exit is durable across restarts
- `OrderIntent` persists **before** submission — this is what makes the crash window recoverable
- Every risk rejection, halt, and kill-switch activation is an auditable `RiskEvent` row
- Parameter changes are append-only history, not in-place updates
- Strategy state snapshots are versioned so a schema change does not orphan live state

---

## 7. Dashboard (Next.js, App Router, Tailwind)

Full control center, per decision.

**Monitoring:** account equity, open positions, ladder rung state (held / re-armed / pending, with
prices), **per-lot table — fill price, quantity, age, individual target, and distance to it**,
blended average cost shown for reference only, realized P&L per completed lot cycle, order and fill
log, live P&L, connection health, active alerts.

**Control:** global kill switch (always visible), per-strategy enable/disable, execution mode
switch, live parameter editing.

### Parameter edit semantics — applies to future rungs only

**Each held lot's exit target is frozen at the parameters in force when that lot filled.** New values
affect only rungs not currently holding a lot — including re-armed rungs, which pick up current
parameters on their next fire.

This is the rule that keeps live parameter editing safe. Full recompute — recalculating levels and
targets for filled rungs — means a single edit can instantly move you into or out of an exit
condition on a live position. Not permitted.

Every parameter change is persisted with timestamp, old value, new value, and the strategy state at
the time of change.

---

## 8. Backtesting

Built as `SimulatedBrokerAdapter` behind the same `BrokerAdapter` interface, running identical
strategy and risk-manager code. Not a separate engine.

Staged:
1. **Replay harness** — stream cached bars through the real strategy + risk layer, emit the order
   intents that would have been generated. Reuses the mocked-broker test infrastructure the scope
   already requires.
2. **Fill modeling** — commission, slippage, limit-fill assumptions
3. **Statistics** — total/annualized return, max drawdown, win rate, average holding period, rung
   distribution, time-in-position
4. **Parameter sweeps** — grid over spacing, rung count, exit target

Backtest runs are persisted so results are comparable across parameter sets.

---

## 9. Testing

Per scope, mandatory rather than follow-up.

**Unit:** rung price calculation for both percentage and ATR spacing; bootstrap anchor including the
gap-down and gap-down-then-recover cases; lowest-held-lot anchor progression; per-lot target
computation from individual fill price; FIFO disposal ordering when a rung holds multiple lots
across cycles; rung re-arming after a lot exits; concurrent-rung limit excluding re-armed empty
rungs; session window boundaries (no fire before 09:45 or after 16:00 ET); invalidation limits;
capital cap arithmetic.

**Ladder cycling:** a dedicated scenario suite for the chop case that motivated per-lot exits — rung
fires, hits target, exits, re-arms, fires again — asserting realized P&L and that lower lots are
untouched throughout.

**Integration (mocked IB sockets + repositories):** full intent → risk → order → fill → persistence
flow; order payload generation asserted field-by-field against IB's expected structure; broker
disconnect mid-order; reconnect with backoff; startup reconciliation including DB/IB mismatch;
**lot-sum reconciliation against IB net position, including an injected quantity mismatch that must
halt the symbol**; recovery from a crash between submission and fill persistence with lots partially
written; kill switch halting in-flight evaluation; daily loss breaker firing; live-account guard
rejecting startup.

**Contract tests:** shared suite every strategy plugin must pass, including the three scaffolded ones.

Coverage must include order payload generation, broker-disconnect error handling, and state recovery
after restart, per scope §4.

---

## 10. Containerization

`docker-compose.yml` orchestrating MySQL 8.0, NestJS backend, Next.js UI, and headless IB Gateway
(IBC-based auto-login). Everything local; no cloud target.

IB Gateway's periodic forced re-authentication must be handled — it is a routine operational event,
not an exception, and the reconnect path must survive it.

---

## 11. Roadmap

**Phase 0 — Prerequisites.** Verify IB market data subscriptions on the funded live account.
Confirm paper account inherits them. Scaffold repo, Docker Compose, Prisma schema, CI.

**Phase 1 — Engine + Dip Ladder + Safety.** Strategy interface and contract tests; three scaffolded
strategies; dip ladder implemented fully; risk manager chokepoint with all four safety controls;
IB broker adapter with pacing-aware historical cache; reconciliation on startup; persistence.
Runs in `SHADOW` mode. **Exit criterion: shadow mode runs a full week generating correct intents
with zero reconciliation errors.**

**Phase 2 — Backtesting.** Simulated broker, replay harness, fill modeling, statistics, parameter
sweeps. Validate ladder rules on TQQQ daily history (2010-present, including the 2020 and 2022
drawdowns) and 5-minute history over the available ~6-month window; optionally on synthetic 3x QQQ
for 2000/2008. **Exit criterion: backtested rules produce results you're willing to trade on paper —
specifically including what the ladder does through 2022, where TQQQ fell ~80%. That scenario is the
one this configuration is most exposed to, and it must be examined explicitly rather than averaged
into a summary statistic.**

**Phase 3 — Dashboard.** Full control center. **Exit criterion: paper trading runs driven entirely
from the UI, kill switch verified under live conditions.**

**Phase 4 — Strategy Suite.** Grid, Wheel, LEAPs built out against the now-proven engine. Options
data pipeline (chains, greeks, assignment detection, expiry rolls) is the bulk of this phase.
Sentiment provider revisited here if a paid feed is acquired.

---

## 12. Verification

- `docker compose up` brings all four services healthy; backend connects to IB Gateway
- Unit + integration suites pass; coverage thresholds enforced in CI
- Backfill populates daily history to inception and 5-min to IB's cap without tripping pacing limits
- Shadow mode over a full session produces intents matching hand-calculated rung prices
- Kill switch halts submission within one evaluation cycle
- Live-account guard rejects startup when the flag is absent
- Kill the backend mid-session with an open position; on restart, reconciliation restores exact
  ladder state and detects an injected artificial mismatch
- Daily loss breaker fires against a simulated losing session

---

## Open Items

Both remaining items are non-blocking for Phase 1, which runs in `SHADOW` mode. **Both must be
resolved before `PAPER` mode.**

- **Capital allocation:** the per-symbol nominal figure is not set. Startup assertion must refuse
  `PAPER`/`LIVE` until configured.
- **Daily loss threshold:** not set. Given TQQQ with no stop-loss, this is the system's only
  automated drawdown response — see §3 for the realized-vs-unrealized tension that needs deciding.

### Resolved during design

- **Symbol:** TQQQ, 5% rungs retained deliberately, leverage and decay risks acknowledged in §1
- **Exit:** per-lot FIFO take-profit at +5% from each lot's own fill price
- **Sessions:** regular hours only, no firing before 09:45 ET
