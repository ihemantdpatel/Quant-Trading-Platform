# Trading Platform — Operator's Guide

This guide is written for someone who has **not** worked on this code and may not be a programmer.
It explains what the system is, what every word on the screen means, how to start and stop it, and
what to do when something looks wrong.

> **Just want to get it running?** See the [README](../README.md) — it has the install steps and a
> five-minute quick start. This guide is the deeper reference for operating it day to day.

You do not need to understand the code to operate this system. You do need to understand the
vocabulary, because the words are precise and two that sound similar often mean very different
things.

> ### The single most important fact — THIS HAS CHANGED
>
> This system is now in **PAPER** mode, and it **does send orders to Interactive Brokers.** They go
> to a _paper_ account — IB's simulated-money account — so **no real money moves.** But orders are
> genuinely transmitted, they sit at the broker waiting to be filled, and they stay there when you
> shut the system down.
>
> **The old "SHADOW" mode, which sent nothing at all, has been removed.** If you have operated this
> system before, the safety net you were relying on is gone. The system will now refuse to start if
> you set `EXECUTION_MODE=SHADOW`.
>
> What still protects you: the account is a paper account, real-money `LIVE` mode remains blocked,
> and there are caps, a loss breaker, a kill switch, and a reconciliation check on every restart.
> What no longer protects you: the mode itself.

---

## If you only remember three things

1. **No real money — but real orders.** The system trades a _paper_ (simulated-money) account at IB.
   Orders really are sent and really do rest at the broker; the money is not real.
2. **When in doubt, hit the kill switch, then stop the system.** Both are instant, reversible, and
   neither one sells anything. But see §4: **stopping the system does not cancel orders already
   resting at the broker.**
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
   The broker receives the order                                 ← REALLY SENT (paper account)
            ↓
   The order RESTS at IB, waiting for the price to reach $50     ← may wait minutes, hours, or never
            ↓
   IB reports a FILL                                             ← only now do you own anything
```

**The last two steps are new and they change how you read the dashboard.** The system no longer buys
the moment it decides to. It places an order at a price and waits for the market to come to it. So
"the system decided to buy" and "the system owns shares" are now separated by an unpredictable gap —
possibly the whole day, possibly forever if the price never gets there.

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

| Term               | What it means **here**                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Intent**         | A decision the strategy made — "I would like to buy". It is **not** an order and **not** a trade. It is the record of the decision; an order is what gets sent because of it.              |
| **Execution mode** | Which behaviour the system is in: PAPER or LIVE. (SHADOW was a third; it has been removed.) See below.                                                                                     |
| **PAPER**          | **Current mode.** Orders go to IB's practice account using fake money. Realistic, but not real money.                                                                                      |
| **SHADOW**         | **Removed.** Formerly: decisions recorded, nothing sent. The system now **refuses to start** if set to SHADOW. You may still see the word on old records and in historic daily reports.    |
| **LIVE**           | Real orders, real money. **Not enabled.** Still blocked.                                                                                                                                   |
| **Resting order**  | An order sitting at the broker, waiting for the price to reach it. It is live exposure: it can fill at any moment without the system deciding anything further. **It survives a restart.** |
| **Working**        | The dashboard's word for a rung that has a resting order at it. The level is committed but you do not own shares there **yet**.                                                            |
| **Halt**           | Trading has been stopped. Crucially, a halt **never sells anything**. It stops future activity and leaves what you hold exactly as it is.                                                  |
| **Entry halt**     | A halt that stops **buying** but still allows **selling** (so profits can still be taken).                                                                                                 |
| **Symbol halt**    | A stricter halt on one symbol that stops **both** buying and selling. Used when the system is not certain what it owns.                                                                    |
| **Kill switch**    | A big manual "stop" you control. Blocks all new order submission immediately. Does not sell.                                                                                               |
| **Reconciliation** | The startup check where the system compares its own records against what the broker says you actually own. See §2.4 — this is the most important safety concept here.                      |
| **Storage**        | Whether the system is writing to the database (`DURABLE`, survives restarts) or just memory (`IN_MEMORY`, everything lost when it stops).                                                  |
| **Strategy**       | A set of trading rules. Only one is active: the "dip ladder".                                                                                                                              |
| **Backtest**       | Replaying past market data to see how the strategy _would_ have performed. Never touches a broker.                                                                                         |
| **Fixture**        | A small, fixed, pre-recorded set of fake price data used for testing. Deterministic — always produces the same result.                                                                     |
| **Soak**           | A trial run: leaving the system running for a full trading week to prove it behaves correctly before anything real is considered. Now run in PAPER, against the practice account.          |
| **Anomaly**        | Something the daily report flagged as unexpected. Not automatically a disaster, but every one must be explained.                                                                           |

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

> **This expectation has flipped.** Under the old SHADOW mode nothing was ever really bought, so the
> database recorded lots the broker had never heard of and restarting with held lots **always**
> halted here — routine, and something you were told to expect and move past.
>
> **In PAPER, every lot comes from a real fill, so the two should now agree.** A halt on this check is
> a genuine finding. Do not wave it through. Investigate it before releasing.

**Restarting also checks orders left resting at the broker**, which is a second thing that can now
diverge. The system asks IB which orders are still working and compares that against its own record:

- **Its record says an order is resting, IB says it is not** — the order expired at the close or was
  cancelled by hand in TWS. The system frees that rung so it can be used again.
- **IB has an order the system does not know about** — the order reached IB just as the system
  crashed. It adopts it, so it knows the level is taken. Without this it would place a _second_ order
  at the same price and both would fill.

**It never cancels an order it cannot explain** — it reports it. An order you placed yourself by hand
is not something the system will quietly delete. And if IB cannot be reached at all, it changes
nothing and leaves its records as they are, because "I could not ask" is not the same as "there is
nothing there".

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
| `mysql`      | 3307 | The database (3307 on the host to avoid a local MySQL on 3306; `MYSQL_HOST_PORT` overrides)             |
| `ib-gateway` | —    | Optional. Only starts with `--profile ib-gateway`; normally you run IB Gateway as a desktop app instead |

### Settings

**You do not need a settings file to run on test data.** `docker compose up` supplies a safe value
for everything on its own. A file called `.env` is only needed to connect to real Interactive
Brokers data — copy `.env.example` to `.env` and edit it. See the README's "Connecting to
Interactive Brokers" section.

The settings worth recognising:

- `EXECUTION_MODE` — `PAPER` is the current and only working value. `LIVE` means real money and is
  blocked by safety checks. `SHADOW` is removed and the system will refuse to start. **Do not
  change this setting.**
- `IB_PORT` — **4002 = practice account, 4001 = real account.** It is set to 4002 on purpose. Now
  that orders are genuinely sent, **this is the setting that decides whether money is real.** Treat
  it with more care than any other line in the file.
- `DATABASE_URL` — present means the database is in use (`DURABLE`). Absent means memory only.
- `IB_HOST` — present means connect to real IB. **Absent means run on test data**, which is the
  default and the safe starting point.

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

| Field                | How to read it                                                                                                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Broker**           | Green = connected. Red = not. Shows which broker and its state.                                                                                                                                      |
| **Open positions**   | What you hold. "flat" = nothing.                                                                                                                                                                     |
| **Deployed at cost** | Total spent on lots currently held.                                                                                                                                                                  |
| **Realized P&L**     | Profit actually banked from closed lots. Green = up.                                                                                                                                                 |
| **Account equity**   | Still displays **"not set"** on the dashboard. The figure _is_ now set in the code (USD 175,000, see §9), but this panel has not been updated to read it. Cosmetic — the cap is enforced regardless. |

### Mode / Engine controls / Strategies

Current execution mode (expect `PAPER`), replay controls for test data, and the list of strategies.
Expect only `dip-ladder` enabled; grid, wheel, and leaps are intentionally off.

### Reconcile button (top right, in the header)

**New.** Re-checks the system's records against the broker, on demand. It sits in the header rather
than with the engine controls because those are hidden whenever a real broker is connected — and this
button is least useful against test data and most useful against a live Gateway.

It asks you to confirm first, and that step is not ceremony. See
[§6](#reconcile-when-the-dashboard-and-tws-disagree) before pressing it.

Under the button, when the scheduled evening job has run, you'll see when it last ran and what it
found. "Not yet run" means scheduled but not yet due — not "ran and found nothing".

### Pending orders

**New, and the first panel to read.** It lists orders resting at the broker _right now_ — what is
live, as opposed to what happened earlier. Each row shows the side, the shares still outstanding, the
price it is waiting at, and **Working** or **Partial**.

This is deliberately separate from the activity log below it. The log is capped and scrolls, so a
resting order placed early in a busy day would scroll out of sight — and that is precisely the order
you most need to see. This panel is not capped, because the ladder itself limits it to at most five.

An empty list means nothing is waiting at the broker. It does **not** mean nothing is held — held
shares appear in the lot table.

### Ladder view and lot table

- **Ladder view** — the rungs, their prices, and which are waiting, working, held, or re-armed.
  **"Working" (amber) is the new one and the one to understand**: an order is resting at that price
  and may fill at any moment. It is not "held" — you own nothing there yet — but it is not idle
  either, because capital is already committed to it. The header counts working rungs separately.
- **Lot table** — every purchase individually: what it cost, its frozen exit target, and its
  profit/loss. Each row is one lot with its own target. This is the strategy made visible.

### Parameter editor

Lets you change strategy settings while running. See the warning in [§6](#6-the-controls-and-when-to-use-them).

### Activity log

The running history: orders, fills, and every risk decision. **These entries are now evidence that
something really was sent** to the paper account — which was not true under the old SHADOW mode,
where they were only records of decisions. For what is live right now rather than what already
happened, read the Pending orders panel above.

---

## 6. The controls, and when to use them

### Kill switch — your emergency stop

**Use it whenever you are unsure.** It is safe, instant, and reversible.

- **What it does:** blocks all new order submission immediately.
- **What it does NOT do:** it does not sell anything and does not close positions.
- **What it also does NOT do — important now:** it does **not** cancel orders already resting at the
  broker. Those stay at IB and can still fill. The kill switch stops _new_ orders being placed.
- **To use:** optionally type a reason, click **Engage kill switch**.
- **To undo:** click **Release**.

There is no penalty for engaging it unnecessarily.

> **If you need to stop a resting order from filling, the kill switch is not enough** — and neither
> is stopping the system, which also leaves them at IB. Cancel the order in IB's own software (TWS
> or the Gateway's order window). This is deliberate: the system will not cancel orders it cannot
> explain, and that restraint cuts both ways.

### Mode switch — do not touch

Leave on `PAPER`. Selecting `LIVE` will be **refused by the backend**, which lists the specific
safety values it is missing. Selecting `SHADOW` will also be refused — that mode has been removed.
Those refusals are the system working. Do not attempt to work around them.

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

### Reconcile — when the dashboard and TWS disagree

**Press this when a rung shows "Working" but no such order exists in TWS.** That happens when you
cancel an order by hand, or when an order that was placed before the last restart went away without
this system being able to attribute the news to a rung. The level stays blocked until reconciliation
clears it, and before this button existed the only fix was restarting the daemon mid-session.

It also corrects order rows that still read as live when the broker says they are finished — so
the activity log stops showing an order that no longer exists anywhere.

**Two things to know before pressing it:**

1. **It can halt a symbol.** It re-runs the full check, including the position comparison. If your
   recorded lots genuinely disagree with the broker's position, that symbol stops trading. That is
   the correct outcome — but it is not a silent one, so do not press this expecting a harmless
   refresh.
2. **It reloads lots and rungs from the database over what is in memory.** Normally identical. The
   exception is a symbol that is already halted, where saving is deliberately suppressed.

It cannot place an order, cancel one, or sell anything. There is no path from this button to a trade.

### The evening reconciliation — automatic, nothing to do

**Fifteen minutes after the 16:00 ET close, the system reconciles orders by itself.** Day orders
expire at the close, and without this the next morning would open with those expired orders still
recorded as blocked levels.

This runs only when the system is connected to IB. On built-in test data there is nothing for it to
check, so you will not see it there.

It checks **orders only, never positions** — deliberately. A position check can halt a symbol, and a
halt raised at 16:15 with nobody watching would leave you with a dead ladder discovered the next
morning. If the broker happens to be unreachable, this job changes nothing and tries again tomorrow.

You'll see its result under the Reconcile button. There is nothing to do unless it reports a problem.

### Engine reset — test data only

Clears engine state. It deliberately does **not** clear the parameter audit trail, and does **not**
release symbol halts.

---

## 7. The daily routine

While the system is in its PAPER trial week, do this at or after **16:00 ET** each trading day.

**1. Pull the day's report:**

```bash
curl "localhost:3000/reports/daily?date=$(date +%F)" | jq
```

**2. Check the fields, in this order of importance:**

| Field                      | What you want                 | If not                                                                              |
| -------------------------- | ----------------------------- | ----------------------------------------------------------------------------------- |
| `clean`                    | `true`                        | Read `anomalies`; log every one                                                     |
| `reconciliation.clean`     | `true`                        | **Now a real finding.** This used to be expected-false; in PAPER it should be true. |
| `intents.submitted`        | **non-zero on an active day** | Zero on a day the ladder fired means orders are not reaching IB — investigate.      |
| `storage`                  | `DURABLE`                     | The day's record may be incomplete                                                  |
| `rungVerification.skipped` | `false`                       | A skip is **not** a pass — that day cannot count                                    |

> **`intents.submitted` has reversed meaning.** Under SHADOW it had to be **0** every single day, and
> anything else was the worst thing the report could say. In PAPER, submission is the expected
> behaviour and a _zero_ on a day the ladder fired is the thing worth investigating.

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

| What you see                                                      | What it means                                                                                          | What to do                                                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `BACKEND_UNREACHABLE`                                             | The dashboard can't reach the brain. The brain may still be running fine.                              | Check the Terminal window is still open. Panels below may be stale — don't trust them.                                 |
| `BROKER_DISCONNECTED`                                             | Lost the connection to IB.                                                                             | Check IB Gateway is open **and logged in**. It retries automatically. Positions are untouched.                         |
| `ENTRY_HALT`                                                      | Buying stopped; selling still allowed.                                                                 | Read the reason on the banner. Positions are held, not sold.                                                           |
| Symbol halt                                                       | That symbol trades in **neither** direction. Usually reconciliation (§2.4).                            | Investigate before releasing. **No longer routine** — in PAPER this should not normally happen.                        |
| Broker state `FAILED`                                             | Retries exhausted.                                                                                     | Needs a human. New buys halted; nothing sold.                                                                          |
| `dataStale: true`                                                 | Still connected but prices stopped arriving.                                                           | Treat seriously — everything _looks_ fine while decisions run on old prices. New buys are halted automatically.        |
| `broker.dataErrors` set                                           | IB rejected the price subscription — often a missing market-data entitlement.                          | This is usually _why_ `dataStale` is true. Check the subscription on your IB account.                                  |
| Storage says `IN_MEMORY`                                          | Nothing is being saved.                                                                                | Stop and get help before running a session you need a record of.                                                       |
| `RETIRED_MODE`                                                    | A report says the session ran in SHADOW, which no longer exists.                                       | If the report is for an **old** date, it is history and fine. For **today**, the mode config is wrong — escalate.      |
| `RESTING_ORDER_REJECTED`                                          | IB refused an order the ladder placed at a rung.                                                       | Read the reason. The rung is freed automatically; nothing is held that shouldn't be.                                   |
| Rung shows **Working**, TWS shows no such order                   | The system did not learn the order went away — usually cancelled by hand, or expired before a restart. | Press **Reconcile** ([§6](#reconcile-when-the-dashboard-and-tws-disagree)). The evening job also fixes this by itself. |
| Symbol halted, and it holds shares the system has **no lots for** | An order filled while the daemon was down and the fill was missed.                                     | See [Recovering a stranded position](#recovering-a-stranded-position) below. Do not release the halt first.            |

**A connected-but-silent feed is more dangerous than a disconnection.** A disconnection is obvious;
a stale feed looks completely healthy while decisions are made on outdated prices. That is why it
has its own alert.

### Recovering a stranded position

**The situation:** a symbol is halted, the broker shows real shares, and the system has no lots
recorded for them. This happens when a buy order filled at IB while the daemon was down. The engine
now recovers such fills by itself when it can — but IB only replays the **current day's** executions,
so once that window passes the fill prices are gone from the wire and it cannot.

There is a script for exactly this case. It reconstructs the lots from the orders the system did
record, using each order's own limit price as its fill price — which errs slightly **high**, meaning
those lots are held marginally longer and can never be sold below a true take-profit.

```bash
# Report only — writes nothing:
npm run recover:lots -- --symbol TQQQ --broker-quantity 400 --average-cost 61.20

# Write the lots, once the report looks right:
npm run recover:lots -- --symbol TQQQ --broker-quantity 400 --average-cost 61.20 --apply
```

Read the report before adding `--apply`. The script **refuses** rather than guesses if the symbol is
not halted for this reason, if any lot is already recorded, or if the reconstructed shares do not sum
**exactly** to the broker's position — a leftover means shares nobody can account for, and then the
answer is genuinely unknown and needs a human.

Release the halt only after the recovered lots and the broker's position agree.

---

## 9. Safety guarantees you can rely on

These are enforced in code and covered by automated tests, not merely intended:

1. **No real money is at risk.** Orders go to IB's _paper_ account, and `LIVE` is blocked by startup
   checks that refuse to run without values a human has deliberately set.
   _(This replaces the old guarantee "in SHADOW, nothing reaches a broker" — orders **do** now reach
   a broker. The protection is the paper account and the `LIVE` block, not the mode.)_
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
9. **A restart cannot duplicate an order.** Orders resting at IB are checked against the system's own
   records on every startup, so it cannot place a second order at a level that already has one.
10. **The system never cancels an order it cannot explain.** An order you placed by hand is reported,
    not deleted.

---

## 10. Things you must never do

1. **Never change `IB_PORT` to 4001.** That points at the real-money account; 4002 is the practice
   one. **This is now the single most dangerous line in the settings** — orders are really sent, so
   this setting alone decides whether the money is real.
2. **Never change `EXECUTION_MODE` from `PAPER`.** `LIVE` means real money.
3. **Never set `READ_ONLY_API=no`.** It is a second lock beneath the first.
4. **Never work around a refused mode switch.** The refusal names missing safety values a human must set.
5. **Never release a symbol halt you don't understand.** The halt is protecting you from a real disagreement.
6. **Never edit the capital figures to "make an error go away."** They are deliberate decisions
   recorded in `docs/decisions/`; changing one changes how much real exposure the ladder takes.
7. **Never assume stopping the system cancels its orders.** Orders resting at IB survive shutdown.
   Cancel them in TWS if you truly need them gone.
8. **Never delete the database volume** unless you intend to lose all position history.
9. **Never run two copies at once against the same IB client id** — IB drops both connections.

If something suggests doing any of these, stop and ask.

---

## 11. Where to get help

**In an emergency, in order:** engage the kill switch → `docker compose down` → ask for help.
Stopping the system is always safe. Nothing is sold when it stops.

**One caveat now:** stopping the system does not cancel orders already resting at IB. They stay and
can still fill. If that matters for the emergency you are in, cancel them in TWS as well.

Useful commands:

```bash
curl localhost:3000/health                       # is it alive?
curl localhost:3000/status | jq                  # full state: mode, broker, halts, storage
curl localhost:3000/lots | jq                    # what is held
curl localhost:3000/orders | jq                  # orders sent, incl. what is resting at IB
curl localhost:3000/rungs | jq                   # ladder levels; "WORKING" = order resting there
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

`POST /kill-switch` · `/engine/replay` · `/engine/reset` · `/reconcile` ·
`/strategies/:id/enable|disable` · `/mode` · `/parameters/:strategyId` · `/halts/:symbol/release` ·
`/backtest`

`POST /reconcile` is what the Reconcile button calls. It reads from the broker and corrects records —
it never places, cancels, or sells anything — but it **can halt a symbol**. See
[§6](#reconcile-when-the-dashboard-and-tws-disagree).

---

**Current status:** PAPER mode against IB's practice account. Orders **are** sent and rest at the
broker; the money is simulated. The trial week ("soak") has not yet started — `docs/soak-log.md`
records it once it does. Real-money trading (`LIVE`) remains gated behind that week completing and
behind a review of the capital figures in `docs/decisions/`.
