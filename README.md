# Trading Platform

A personal, self-hosted trading system for **Interactive Brokers**. It watches prices, decides what
it would buy and sell using a "dip ladder" strategy, and shows you everything on a dashboard in your
browser. Everything runs on your own computer.

> ### Read this first
>
> This system ships in **SHADOW** mode. It watches the market, decides what it _would_ buy and sell,
> and writes those decisions down. **It does not send any order to any broker. No real money moves.**
>
> This is enforced in several independent places in the code, not by a setting you could forget. The
> strategy it runs buys **3x leveraged ETFs**, which move violently — turning real trading on is a
> separate, deliberate step that is blocked by safety checks refusing to start without values a human
> must decide first.

Nothing in this README can place a trade or spend money. You can run the whole thing without an
Interactive Brokers account.

---

## Contents

- [What you need](#what-you-need)
- [Quick start](#quick-start)
- [Make it do something](#make-it-do-something)
- [Stopping it](#stopping-it)
- [What you're looking at](#what-youre-looking-at)
- [Connecting to Interactive Brokers](#connecting-to-interactive-brokers-optional)
- [Configuration](#configuration)
- [For developers](#for-developers)
- [Documentation](#documentation)

---

## What you need

**Just Docker Desktop.** Nothing else.

- **macOS / Windows:** [Download Docker Desktop](https://www.docker.com/products/docker-desktop/),
  install it, and open it. Wait for the whale icon in your menu bar to stop animating.
- **Linux:** Install Docker Engine and the Compose plugin from your package manager.

You do **not** need an Interactive Brokers account, a database, or any programming tools. Those are
either included or optional.

---

## Quick start

**1. Download the project.** If you have `git`:

```bash
git clone https://github.com/ihemantdpatel/rungs.git
cd rungs
```

No `git`? Use the "Download ZIP" button on the project page, unzip it, and open a Terminal in the
unzipped folder.

**2. Start everything:**

```bash
docker compose up
```

**Leave this window open** — closing it stops the system. The first run downloads a few things and
takes several minutes; later runs take seconds. Wait until the scrolling text settles down.

**3. Open the dashboard:** **[http://localhost:3001](http://localhost:3001)**

That's it. **You do not need to create a settings file.** The system starts on built-in test data
with no Interactive Brokers connection and no account of any kind.

> **Don't copy `.env.example` to `.env` yet.** That file is set up for connecting to a real IB
> Gateway, and copying it will make the system try — and fail — to reach a broker that isn't there.
> Only do it when you actually want live data, and see
> [Connecting to Interactive Brokers](#connecting-to-interactive-brokers-optional) for how.

**4. Check these four things before trusting anything on screen:**

| Look at            | You want to see | If it's different                                                               |
| ------------------ | --------------- | ------------------------------------------------------------------------------- |
| **Execution mode** | `SHADOW`        | Stop and ask for help — this should never differ                                |
| **Kill switch**    | `ARMED` (green) | `ENGAGED` just means paused; safe either way                                    |
| **Broker**         | Green text      | Red means no live prices — expected without IB                                  |
| **Alerts (top)**   | Nothing there   | See the [operating guide](docs/operating-guide.md#8-when-something-looks-wrong) |

Confusingly, kill switch **ARMED means inactive** — it is not blocking anything. That's the normal
resting state.

<!-- TODO: add a screenshot of the dashboard here once captured from a running instance. -->

---

## Make it do something

A freshly started dashboard is empty, because no prices have arrived yet. To watch the strategy work,
replay a set of pre-recorded test prices through it.

Open a **second** Terminal window (leave the first one running) and paste:

```bash
curl -X POST localhost:3000/engine/replay \
  -H 'Content-Type: application/json' \
  -d '{"fixture":"chop-range"}'
```

Now refresh the dashboard. You should see rungs, lots, and activity appear.

`chop-range` is the best one to start with — prices bounce up and down, so the ladder buys and sells
repeatedly. Other test sets you can swap into that command:

| Fixture            | What it shows                                  |
| ------------------ | ---------------------------------------------- |
| `chop-range`       | Rungs firing and re-arming repeatedly          |
| `steady-decline`   | The ladder extending downward to its floor     |
| `gap-down-open`    | A sharp drop at the market open                |
| `gap-down-recover` | A drop followed by a recovery                  |
| `session-edges`    | Behavior at the start and end of a trading day |

These are fixed, pre-recorded prices — the same fixture always produces exactly the same result.

---

## Stopping it

Press `Ctrl-C` in the Terminal window running the system. Or, from another window in the same folder:

```bash
docker compose down
```

**Stopping is always safe.** Nothing is sold and nothing is forgotten.

---

## What you're looking at

Three pieces start together:

| Part              | What it is                                                               | Where            |
| ----------------- | ------------------------------------------------------------------------ | ---------------- |
| **The dashboard** | The web page you look at and click                                       | `localhost:3001` |
| **The backend**   | The "brain" — watches prices, decides trades, enforces every safety rule | `localhost:3000` |
| **The database**  | The notebook — remembers positions so a restart doesn't lose them        | Internal         |

Every decision travels this path, in this order, always:

```
   Market prices arrive
            ↓
   The strategy decides "I would like to buy 10 shares at $50"   ← called an INTENT
            ↓
   The risk manager checks it against every safety rule          ← can approve, shrink, or refuse
            ↓
   The broker would receive the order                            ← BLOCKED in SHADOW. Nothing is sent.
```

The strategy **cannot** reach the broker directly. It isn't merely discouraged — it's impossible in
the code. Everything must pass the risk manager.

**The dashboard uses precise vocabulary, and some words don't mean what they usually do** ("halt"
never means "sold"; "armed" means inactive). The
[operating guide](docs/operating-guide.md) has a full dictionary, a walkthrough of every panel, and
what to do when something looks wrong. **Read it before acting on anything you see.**

---

## Connecting to Interactive Brokers (optional)

**Not required.** Everything above works without it. Do this only when you want the system to watch
real market prices.

Even connected, **SHADOW mode still submits nothing** — the connection is read-only in practice.

**1.** Install and log into **IB Gateway** (or TWS) as a desktop app.

**2.** Create your settings file:

```bash
cp .env.example .env
```

**3.** Open `.env` and set `IB_HOST`:

```
IB_HOST=host.docker.internal
```

**4.** Check `IB_PORT`. **`4002` is the practice account and `4001` is the real-money account.** It
ships as `4002` deliberately. Leave it.

**5.** Restart: `docker compose down`, then `docker compose up`.

A Gateway that's running but **not logged in** is the awkward case — it accepts the connection and
then goes silent. Expect a `connect failed` message, then a `BROKER_UNAVAILABLE` halt. The dashboard
stays up throughout, which is deliberate: an outage is exactly when you need to see the screen.

---

## Configuration

You only need this section if you created a `.env` file. Each of these works by **presence** — what
matters is whether it's set at all.

| Setting          | Unset (default)                     | Set                                             |
| ---------------- | ----------------------------------- | ----------------------------------------------- |
| `EXECUTION_MODE` | `SHADOW` — records, submits nothing | `PAPER`/`LIVE` are **blocked** by safety checks |
| `IB_HOST`        | Built-in test data, no broker       | Connects to IB Gateway                          |
| `DATABASE_URL`   | Memory only, lost on restart        | Saves to the database, survives restarts        |
| `IB_PORT`        | `4002` — practice account           | `4001` is the **real-money** account            |
| `API_URL`        | `http://localhost:3000`             | Where the dashboard finds the backend           |

`docker compose up` sets sensible values for all of these on its own. `.env.example` documents every
setting in full.

---

## For developers

The stack is a **NestJS** backend daemon, a **Next.js** dashboard, and **MySQL** via Prisma.

```bash
npm ci                      # at the repo root first — the shared ESLint config lives here

cd backend
npm ci
npm test                    # 1283 tests, no database required
npm run lint
npm run start:dev           # run the daemon directly, without Docker

cd ../ui
npm ci
npm test                    # 82 dashboard component tests
npm run dev
```

Running the backend outside Docker needs **Node 22**. It boots with zero external dependencies when
`DATABASE_URL` and `IB_HOST` are both unset — in-memory storage and a mock broker.

**One trap worth knowing:** the backend reads `.env` from the directory you run it from, which is
`backend/` — not the repo root where `.env.example` lives. Copying `.env.example` to the root has no
effect on a direct `npm start`. Either export the variables in your shell or put a `.env` inside
`backend/`. It boots on defaults either way, which is easy to mistake for it having worked.

`docs/PRD.md` and `docs/stories.md` are cited by line number throughout the code comments (as
`PRD.md:343`); those citations still resolve, since the files moved without their contents changing.

---

## Documentation

| Document                                       | What it covers                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **[Operating guide](docs/operating-guide.md)** | **Start here after installing.** Dictionary, dashboard walkthrough, troubleshooting, safety rules |
| [Soak log](docs/soak-log.md)                   | The daily trial-week procedure and its record                                                     |
| [`.env.example`](.env.example)                 | Every setting, explained                                                                          |
| [PRD](docs/PRD.md)                             | The full specification                                                                            |
| [CLAUDE.md](CLAUDE.md)                         | Architecture and the invariants that constrain the code                                           |
| [Stories](docs/stories.md)                     | The build plan                                                                                    |

---

**Current status:** SHADOW mode, no real orders. Real trading is gated behind a full trial week and
behind capital limits nobody has set yet.
