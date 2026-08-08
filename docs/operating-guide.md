# Trading Platform — Operator's Guide

This guide is written for someone who has **not** worked on this code and may not be a programmer.
It explains what the system is, what every word on the screen means, how to start and stop it, and
what to do when something looks wrong.

> **Just want to get it running?** See the [README](../README.md) — it has the install steps and a
> five-minute quick start. This guide is the deeper reference for operating it day to day.

You do not need to understand the code to operate this system. You do need to understand the
vocabulary, because the words are precise and two that sound similar often mean very different
things.

> ### The single most important fact
>
> This system is currently in **SHADOW** mode. It watches the market, decides what it _would_ buy
> and sell, and writes those decisions down. **It does not send any order to any broker. No real
> money moves.** This is deliberate and is enforced in several independent places in the code.
>
> Nothing in this guide will change that. Turning real trading on is a separate, deliberate project
> step ("Story 13") that has not happened yet and is blocked by safety checks that refuse to start
> the system without values a human must decide first.

---

## If you only remember three things

1. **Nothing here trades real money.** The system is in SHADOW mode — it writes down decisions and
   sends nothing to any broker.
2. **When in doubt, hit the kill switch, then stop the system.** Both are instant, reversible, and
   neither one sells anything.
3. **"Halt" never means "sold."** A halt stops future activity and leaves everything you hold
   exactly as it is.

### Where to go next

- Confused by a word on screen → [§2 The dictionary](#2-the-dictionary)
- Something is red or you're worried → [§8 When something looks wrong](#8-when-something-looks-wrong)
- Running the daily trial-week check → [§7 The daily routine](#7-the-daily-routine)
- Want to know what it's actually trading → [§3 The strategy in plain English](#3-the-strategy-in-plain-english)

---

## Table of contents

1. [What this system does](#1-what-this-system-does)
2. [The dictionary](#2-the-dictionary) — read this before anything else
3. [The strategy in plain English](#3-the-strategy-in-plain-english)
4. [Starting and stopping](#4-starting-and-stopping)
5. [Reading the dashboard](#5-reading-the-dashboard)
6. [The controls, and when to use them](#6-the-controls-and-when-to-use-them)
7. [The daily routine](#7-the-daily-routine)
8. [When something looks wrong](#8-when-something-looks-wrong)
9. [Safety guarantees you can rely on](#9-safety-guarantees-you-can-rely-on)
10. [Things you must never do](#10-things-you-must-never-do)
11. [Where to get help](#11-where-to-get-help)

---

## 1. What this system does

This is a personal, self-hosted trading platform that connects to **Interactive Brokers** (a stock
broker). It runs entirely on one computer. There is no cloud service, no website other than the one
on your own machine, and no one else can see or touch it.

It has three moving parts:

| Part              | What it is                                                                                               | Where you see it                 |
| ----------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **The backend**   | The "brain". Watches prices, decides what to trade, enforces all safety rules. Has no screen of its own. | `http://localhost:3000`          |
| **The dashboard** | The web page you actually look at and click. Shows what the brain is doing.                              | `http://localhost:3001`          |
| **The database**  | The notebook. Remembers positions and decisions so a restart doesn't lose them.                          | Not directly — via the dashboard |

They are started together with one command. See [Starting and stopping](#4-starting-and-stopping).

**The flow of a decision**, top to bottom. Every decision travels this path, in this order, always:

```
   Market prices arrive
            ↓
   The strategy decides "I would like to buy 10 shares at $50"   ← called an INTENT
            ↓
   The risk manager checks it against every safety rule          ← can approve, shrink, or refuse
            ↓
   The broker would receive the order                            ← BLOCKED in SHADOW mode. Nothing is sent.
```

The important structural fact: **the strategy cannot reach the broker directly.** It is not merely
discouraged — it is impossible in the code. Everything must pass the risk manager. This is why the
risk manager is called "the only path to a broker" in the technical docs.

---

## 2. The dictionary

Read this section before you read the dashboard. Terms are grouped by topic and ordered so each one
only uses words already defined above it.

### 2.1 Core trading vocabulary

| Term                   | Plain meaning                                                                                                                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Broker**             | The company that actually holds the money and executes trades. Here: Interactive Brokers ("IB").                                                                                                                           |
| **IB Gateway**         | A small program from Interactive Brokers that must be running and logged in for our system to talk to IB. If it is closed or logged out, we get no prices.                                                                 |
| **Symbol**             | The ticker code for something tradeable, e.g. `TQQQ`.                                                                                                                                                                      |
| **Position**           | How many shares you currently own of a symbol. "Flat" means you own none.                                                                                                                                                  |
| **Order**              | A formal instruction sent to the broker: "buy 10 shares at $50".                                                                                                                                                           |
| **Fill**               | Confirmation that an order actually happened. An order can be placed and never fill.                                                                                                                                       |
| **Partial fill**       | You asked for 10 shares and got 6. The rest may fill later or not at all.                                                                                                                                                  |
| **Limit price**        | The worst price you will accept. A buy limit of $50 will never pay $51.                                                                                                                                                    |
| **Commission**         | The broker's fee per trade.                                                                                                                                                                                                |
| **P&L**                | Profit and Loss — how much money you have made or lost.                                                                                                                                                                    |
| **Realized P&L**       | Profit you have actually locked in by selling. Real, banked money.                                                                                                                                                         |
| **Unrealized P&L**     | Profit that exists only on paper because you still hold the position. It can vanish.                                                                                                                                       |
| **Mark price**         | The most recent price used to value what you hold right now.                                                                                                                                                               |
| **ETF**                | A fund that trades like a single stock.                                                                                                                                                                                    |
| **3x / leveraged ETF** | An ETF built to move **three times** as much as the thing it tracks. If the index falls 2%, this falls about 6%. These move violently. `TQQQ` is one. This matters — it is why the safety rules in this system are strict. |

### 2.2 Words this system uses in a special way

These are the ones that cause misunderstandings. Read them carefully.

| Term               | What it means **here**                                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Intent**         | A decision the strategy made — "I would like to buy". It is **not** an order and **not** a trade. In SHADOW mode, intents are all that ever happen. Think of it as a written recommendation. |
| **Execution mode** | Which of three behaviours the system is in: SHADOW, PAPER, or LIVE. See below.                                                                                                               |
| **SHADOW**         | **Current mode.** Decisions are recorded; nothing is sent to the broker. No money moves.                                                                                                     |
| **PAPER**          | Orders go to IB's practice account using fake money. Realistic, but not real. **Not enabled yet.**                                                                                           |
| **LIVE**           | Real orders, real money. **Not enabled yet.**                                                                                                                                                |
| **Halt**           | Trading has been stopped. Crucially, a halt **never sells anything**. It stops future activity and leaves what you hold exactly as it is.                                                    |
| **Entry halt**     | A halt that stops **buying** but still allows **selling** (so profits can still be taken).                                                                                                   |
| **Symbol halt**    | A stricter halt on one symbol that stops **both** buying and selling. Used when the system is not certain what it owns.                                                                      |
| **Kill switch**    | A big manual "stop" you control. Blocks all new order submission immediately. Does not sell.                                                                                                 |
| **Reconciliation** | The startup check where the system compares its own records against what the broker says you actually own. See §2.4 — this is the most important safety concept here.                        |
| **Storage**        | Whether the system is writing to the database (`DURABLE`, survives restarts) or just memory (`IN_MEMORY`, everything lost when it stops).                                                    |
| **Strategy**       | A set of trading rules. Only one is active: the "dip ladder".                                                                                                                                |
| **Backtest**       | Replaying past market data to see how the strategy _would_ have performed. Never touches a broker.                                                                                           |
| **Fixture**        | A small, fixed, pre-recorded set of fake price data used for testing. Deterministic — always produces the same result.                                                                       |
| **Soak**           | A trial run: leaving the system running in SHADOW for a full week to prove it behaves correctly before anything real is considered.                                                          |
| **Anomaly**        | Something the daily report flagged as unexpected. Not automatically a disaster, but every one must be explained.                                                                             |

### 2.3 Dip-ladder vocabulary

These describe the actual trading strategy. §3 explains how they fit together.

| Term                 | Plain meaning                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Ladder**           | The overall plan: a series of buy prices stacked below the current price, like rungs going down.                                                 |
| **Rung**             | One price level on that ladder — a single planned buy at a specific price.                                                                       |
| **Anchor**           | The reference price the whole ladder is measured down from. Recalculated each day.                                                               |
| **Spacing**          | How far apart the rungs are. Currently 5%.                                                                                                       |
| **Lot**              | One specific purchase, tracked individually. If you buy at three different rungs you hold three lots, each remembering its own purchase price.   |
| **Exit target**      | The price at which a specific lot will be sold for profit. Currently its own purchase price **+5%**.                                             |
| **Frozen target**    | Once a lot is bought, its exit target **never changes**, even if you edit settings afterwards. Protects live positions from configuration edits. |
| **Re-arm**           | After a rung's lot is sold at a profit, that rung returns to its original price and can buy again. This repeats.                                 |
| **Cycle**            | One complete buy-then-sell-at-profit round trip on a rung.                                                                                       |
| **Hard floor**       | A depth limit — currently **25%** below the first purchase. Below it, the system **stops buying more**. It does **not** sell.                    |
| **Firing window**    | The only time of day new buys are allowed: **09:45–16:00 ET**. The first 15 minutes of the day are skipped deliberately, as the open is erratic. |
| **Concurrent rungs** | How many lots may be held at once. Capped at **5**.                                                                                              |

### 2.4 Reconciliation — the concept worth understanding properly

When the system starts, two sources disagree about reality more often than you would think:

- **The database** says: "we hold 3 lots — 10 shares at \$50, 10 at \$47.50, 10 at \$45."
- **The broker** says: "you own 30 shares."

The system can only check one thing across that boundary: **the total**. The broker knows _how many
shares exist_; only our database knows _which lots they are_ and what each one cost.

So the rule is simply:

- **Totals match** (30 = 30) → resume normally with the full lot detail.
- **Totals disagree** in any way → **halt that symbol**. Buy nothing, sell nothing, touch nothing.

There is deliberately **no "close enough"** and no automatic repair. If the database said 30 and the
broker said 25, any attempt to fix it automatically would be a guess about which lot is wrong — and
guessing wrong means selling the wrong lot at the wrong price on an investment that moves 3x. So it
stops and asks a human. **Your positions are safe during a halt.** They are held, never sold.

> **Expected in SHADOW:** because SHADOW never actually buys anything, the database records lots the
> broker has never heard of. So restarting while the ladder holds lots **will** halt on this check.
> This is the system working correctly, not a bug.

### 2.5 Status words you'll see

| Word           | Where       | Meaning                                                                          |
| -------------- | ----------- | -------------------------------------------------------------------------------- |
| `CONNECTED`    | Broker      | Talking to IB normally.                                                          |
| `CONNECTING`   | Broker      | Trying to establish a connection.                                                |
| `DISCONNECTED` | Broker      | Not connected. Will retry automatically.                                         |
| `FAILED`       | Broker      | Gave up retrying. New buys halted; positions untouched. Needs a human.           |
| `HELD`         | Lot         | Bought and still owned.                                                          |
| `CLOSED`       | Lot         | Sold. Its realized profit is final.                                              |
| `PENDING`      | Rung        | Waiting for the price to fall to it.                                             |
| `RE_ARMED`     | Rung        | Sold at a profit and ready to buy again.                                         |
| `ARMED`        | Kill switch | **Normal.** Not blocking anything. (Confusingly, "armed" here means _inactive_.) |
| `ENGAGED`      | Kill switch | Actively blocking all new submission.                                            |
| `DURABLE`      | Storage     | Writing to the database. Survives restart.                                       |
| `IN_MEMORY`    | Storage     | Not saving. Everything lost on restart.                                          |

---

## 3. The strategy in plain English

Only one strategy is active: the **dip ladder**. Three others exist in the code but are switched off
and do nothing.

The idea is to buy progressively as a price falls, and sell each purchase individually once it has
recovered 5%.

**How a day works:**

1. **Set the anchor.** At the open, the system picks a reference price — the higher of yesterday's
   close and today's open, when holding nothing.
2. **Place the ladder.** Rungs are planned at 5% intervals _below_ the anchor.
3. **Wait for the window.** No buying before 09:45 ET.
4. **Buy on the way down.** Each time the price reaches a rung, that rung buys one lot. Each lot
   records its own purchase price.
5. **Sell each lot on its own merit.** Each lot sells when _its own_ price rises 5% — never the
   average of all of them.
6. **Re-arm and repeat.** A rung that sold at a profit goes back to its original price and can buy
   again. Choppy, sideways markets can cycle a rung many times.
7. **Stop adding at the floor.** 25% below the first purchase, buying stops. Selling still works.

**Two rules that are absolute:**

- **Lots only ever sell at a profit.** There is no stop-loss and no loss-taking exit at any level.
  If it goes down, the system stops buying and waits. It does not sell into the fall.
- **Every lot exits at its own price + 5%.** The blended average you see on screen is for display
  only and never drives a sale.

**Current settings** (`sizePerRung` etc. are the names you'll see in the parameter editor):

| Setting              | Value       | Meaning                                                           |
| -------------------- | ----------- | ----------------------------------------------------------------- |
| `spacingPercent`     | 5%          | Gap between rungs                                                 |
| `takeProfitPercent`  | 5%          | Profit target per lot                                             |
| `sizePerRung`        | 25%         | Share of this symbol's capital per rung                           |
| `maxConcurrentRungs` | 5           | Most lots held at once                                            |
| `hardFloorPercent`   | 25%         | Depth at which buying stops                                       |
| `escalationFactor`   | 1           | 1 = every rung the same size                                      |
| `exitMode`           | `PER_LOT`   | Each lot sells on its own price                                   |
| `symbolCapital`      | **not set** | Deliberately blank — a human must decide this before real trading |

That last blank is intentional and load-bearing. The system **refuses to start** in PAPER or LIVE
while it is unset, so nobody can accidentally trade with an unconsidered position size.

---

## 4. Starting and stopping

### What you need first

- **Docker Desktop** installed and running (the whale icon in your menu bar).
- **IB Gateway** running and logged in — only if you want real market prices. Without it the system
  runs happily on test data.

### Start everything

Open Terminal, go to the folder you downloaded the project into, then:

```bash
docker compose up
```

Leave that window open — closing it stops the system. Wait for the log to settle, then open:

**http://localhost:3001**

### Stop everything

Press `Ctrl-C` in that Terminal window. Or from another window, in the same folder:

```bash
docker compose down
```

Stopping is always safe. Nothing is sold, and with `DURABLE` storage nothing is forgotten.

### Check it's alive

```bash
curl localhost:3000/health
```

### What each piece is

| Service      | Port | Purpose                                                                                                 |
| ------------ | ---- | ------------------------------------------------------------------------------------------------------- |
| `ui`         | 3001 | The dashboard you look at                                                                               |
| `backend`    | 3000 | The brain                                                                                               |
| `mysql`      | 3306 | The database                                                                                            |
| `ib-gateway` | —    | Optional. Only starts with `--profile ib-gateway`; normally you run IB Gateway as a desktop app instead |

### Settings

**You do not need a settings file to run on test data.** `docker compose up` supplies a safe value
for everything on its own. A file called `.env` is only needed to connect to real Interactive
Brokers data — copy `.env.example` to `.env` and edit it. See the README's "Connecting to
Interactive Brokers" section.

The settings worth recognising:

- `EXECUTION_MODE` — **`SHADOW` is the line that keeps this system from trading.** Do not change it.
- `DATABASE_URL` — present means the database is in use (`DURABLE`). Absent means memory only.
- `IB_HOST` — present means connect to real IB. **Absent means run on test data**, which is the
  default and the safe starting point.
- `IB_PORT` — **4002 = practice account, 4001 = real account.** It is set to 4002 on purpose.

---

## 5. Reading the dashboard

Open **http://localhost:3001**. It refreshes itself. Top to bottom, in the order it is laid out —
and that order is deliberate: the most urgent things are highest.

### Alerts (red/amber bars at the very top)

Only appear when something needs attention. If you see none, there is nothing wrong. Each bar shows
a code and an explanation. See [§8](#8-when-something-looks-wrong).

### Kill switch

Always visible, even if everything else fails to load.

- **ARMED** (green) — normal, not blocking.
- **ENGAGED** (red) — actively blocking all new submission.

### Status bar

| Field                | How to read it                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Broker**           | Green = connected. Red = not. Shows which broker and its state.                                                                                              |
| **Open positions**   | What you hold. "flat" = nothing.                                                                                                                             |
| **Deployed at cost** | Total spent on lots currently held.                                                                                                                          |
| **Realized P&L**     | Profit actually banked from closed lots. Green = up.                                                                                                         |
| **Account equity**   | Shows **"not set"** — deliberately. The figure it would be measured against is the unset Story 13 value. A blank is honest; an invented number would not be. |

### Mode / Engine controls / Strategies

Current execution mode (expect `SHADOW`), replay controls for test data, and the list of strategies.
Expect only `dip-ladder` enabled; grid, wheel, and leaps are intentionally off.

### Ladder view and lot table

- **Ladder view** — the rungs, their prices, and which are waiting, held, or re-armed.
- **Lot table** — every purchase individually: what it cost, its frozen exit target, and its
  profit/loss. Each row is one lot with its own target. This is the strategy made visible.

### Parameter editor

Lets you change strategy settings while running. See the warning in [§6](#6-the-controls-and-when-to-use-them).

### Activity log

The running history: orders, fills, and every risk decision. In SHADOW, an entry here is a _record
of a decision_, not evidence that anything was sent.

---

## 6. The controls, and when to use them

### Kill switch — your emergency stop

**Use it whenever you are unsure.** It is safe, instant, and reversible.

- **What it does:** blocks all new order submission immediately.
- **What it does NOT do:** it does not sell anything and does not close positions.
- **To use:** optionally type a reason, click **Engage kill switch**.
- **To undo:** click **Release**.

There is no penalty for engaging it unnecessarily. In SHADOW it is belt-and-braces, since nothing is
being submitted anyway.

### Mode switch — do not touch

Leave on `SHADOW`. Attempts to select PAPER or LIVE will be **refused by the backend**, which lists
the specific missing safety values. That refusal is the system working. Do not attempt to work
around it.

### Parameter editor — careful, but safer than it looks

Changes apply to **future** rungs only. **A lot you already hold keeps the exit target it was bought
with, permanently.** This is structural, not a setting: it exists so an edit can never move a live
position into or out of a sale.

Every change is recorded permanently with the old value, the new value, the time, and the state at
that moment. That record cannot be edited or deleted by anyone.

Still: these values decide how much gets bought and when. Change them only with a specific reason.

### Releasing a symbol halt — only after investigating

A halted symbol stays halted until a human releases it. Only do this once you understand **why** it
halted and have confirmed the underlying disagreement is resolved. Releasing a halt without
resolving the cause reintroduces exactly the risk the halt existed to prevent.

### Engine reset — test data only

Clears engine state. It deliberately does **not** clear the parameter audit trail, and does **not**
release symbol halts.

---

## 7. The daily routine

While the system is in its SHADOW trial week, do this at or after **16:00 ET** each trading day.

**1. Pull the day's report:**

```bash
curl "localhost:3000/reports/daily?date=$(date +%F)" | jq
```

**2. Check the fields, in this order of importance:**

| Field                      | What you want             | If not                                                                                  |
| -------------------------- | ------------------------- | --------------------------------------------------------------------------------------- |
| `intents.submitted`        | **0** — always, in SHADOW | **Stop immediately.** Anything else means the core guarantee has been broken. Escalate. |
| `clean`                    | `true`                    | Read `anomalies`; log every one                                                         |
| `storage`                  | `DURABLE`                 | The day's record may be incomplete                                                      |
| `rungVerification.skipped` | `false`                   | A skip is **not** a pass — that day cannot count                                        |
| `reconciliation.clean`     | `true`                    | Expected `false` in SHADOW if the ladder holds lots — see §2.4                          |

**3. Record the day in `docs/soak-log.md`** — including clean days. A clean day is evidence and
belongs in the record.

**4. Log every anomaly**, even ones that turn out to be harmless. An anomaly with no recorded cause
counts as unexplained, and **one unexplained anomaly restarts the entire week**, not just that day.

The anomaly codes and their severity are listed in `docs/soak-log.md`, which is the authoritative
record for this process.

---

## 8. When something looks wrong

**The universal first answer: engage the kill switch.** It is free, instant, reversible, and never
sells anything. Then work out what happened.

| What you see             | What it means                                                               | What to do                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `BACKEND_UNREACHABLE`    | The dashboard can't reach the brain. The brain may still be running fine.   | Check the Terminal window is still open. Panels below may be stale — don't trust them.                          |
| `BROKER_DISCONNECTED`    | Lost the connection to IB.                                                  | Check IB Gateway is open **and logged in**. It retries automatically. Positions are untouched.                  |
| `ENTRY_HALT`             | Buying stopped; selling still allowed.                                      | Read the reason on the banner. Positions are held, not sold.                                                    |
| Symbol halt              | That symbol trades in **neither** direction. Usually reconciliation (§2.4). | Investigate before releasing. **Expected in SHADOW after restarting with held lots.**                           |
| Broker state `FAILED`    | Retries exhausted.                                                          | Needs a human. New buys halted; nothing sold.                                                                   |
| `dataStale: true`        | Still connected but prices stopped arriving.                                | Treat seriously — everything _looks_ fine while decisions run on old prices. New buys are halted automatically. |
| Storage says `IN_MEMORY` | Nothing is being saved.                                                     | Stop and get help before running a session you need a record of.                                                |
| `SUBMISSION_IN_SHADOW`   | An intent was recorded as submitted while in SHADOW.                        | **Most serious thing here.** Engage kill switch, stop the system, escalate.                                     |

**A connected-but-silent feed is more dangerous than a disconnection.** A disconnection is obvious;
a stale feed looks completely healthy while decisions are made on outdated prices. That is why it
has its own alert.

---

## 9. Safety guarantees you can rely on

These are enforced in code and covered by automated tests, not merely intended:

1. **In SHADOW, nothing reaches a broker.** Multiple independent checks.
2. **A technical fault never becomes a sale.** Disconnections, timeouts, exhausted retries — all
   halt new buying and leave positions alone. **No code path can automatically sell your positions.**
3. **Lots only ever sell in profit.** No stop-loss exists anywhere.
4. **A held lot's exit target is frozen at purchase.** Later edits cannot move it.
5. **Uncertainty causes a stop, not a guess.** When records and broker disagree, it halts rather
   than repairing.
6. **The parameter audit trail cannot be altered or deleted** — enforced by the database itself.
7. **The dashboard stays up when the broker goes down.** Deliberate: an outage is exactly when you
   need to see the screen.
8. **Every safety check reports a specific reason** — never a bare failure.

---

## 10. Things you must never do

1. **Never change `EXECUTION_MODE` from `SHADOW`.** This is the line preventing real trading.
2. **Never change `IB_PORT` to 4001.** That points at the real-money account. 4002 is the practice one.
3. **Never set `READ_ONLY_API=no`.** It is a second lock beneath the first.
4. **Never work around a refused mode switch.** The refusal names missing safety values a human must set.
5. **Never release a symbol halt you don't understand.** The halt is protecting you from a real disagreement.
6. **Never fill in `symbolCapital` to "make an error go away."** It is blank because a human must
   decide it deliberately.
7. **Never delete the database volume** unless you intend to lose all position history.
8. **Never run two copies at once against the same IB client id** — IB drops both connections.

If something suggests doing any of these, stop and ask.

---

## 11. Where to get help

**In an emergency, in order:** engage the kill switch → `docker compose down` → ask for help.
Stopping the system is always safe. Nothing is sold when it stops.

Useful commands:

```bash
curl localhost:3000/health                       # is it alive?
curl localhost:3000/status | jq                  # full state: mode, broker, halts, storage
curl localhost:3000/lots | jq                    # what is held
curl "localhost:3000/reports/daily?date=$(date +%F)" | jq   # today's report
docker compose logs backend --tail 100           # recent backend log
```

(`jq` just formats the output; drop `| jq` if it isn't installed.)

Documents in this repository, and who they're for:

| File                      | Audience          | Contents                                      |
| ------------------------- | ----------------- | --------------------------------------------- |
| `README.md`               | Everyone          | Installing and starting it for the first time |
| `docs/operating-guide.md` | **You**           | This guide                                    |
| `docs/soak-log.md`        | Operator          | The daily trial-week procedure and record     |
| `.env.example`            | Operator/engineer | Every setting, with explanation               |
| `docs/PRD.md`             | Engineer          | The full specification                        |
| `CLAUDE.md`               | Engineer          | Architecture and invariants                   |
| `docs/stories.md`         | Engineer          | The build plan                                |

### The read-only endpoints

All are safe to call — they only read.

`GET /health` `/status` `/intents` `/orders` `/fills` `/lots` `/rungs` `/positions` `/risk-events`
`/strategies` `/halts` `/reports/daily` `/parameters` `/parameters/changes` `/backtest`

### The endpoints that change something

Prefer the dashboard buttons over these.

`POST /kill-switch` · `/engine/replay` · `/engine/reset` · `/strategies/:id/enable|disable` ·
`/mode` · `/parameters/:strategyId` · `/halts/:symbol/release` · `/backtest`

---

**Current status:** SHADOW mode, no real orders. The trial week ("soak") has not yet started —
`docs/soak-log.md` records it once it does. Real trading remains gated behind that week completing
and behind safety values nobody has set yet.
