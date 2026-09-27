# Decision: accounts as the top-level owner, one daemon per account

**Date:** 2026-09-23 · **Status:** accepted

## Context

The platform assumed a single IB account everywhere — no account in the schema, code, or UI — and the
IB socket even merged positions and balances across every account the login could see. We trade
`nuuixl118` today and may trade a second account, concurrently, and need a dashboard switcher to view
one account at a time.

## Decisions

| #             | Decision                                                                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime       | Accounts trade **concurrently and independently**. The switcher changes only what is _viewed_.                                                                                                                     |
| Process model | **One backend daemon per account**, all sharing one MySQL. Engine internals stay singletons.                                                                                                                       |
| Identity      | Keyed by an **alias** (`nuuixl118`) in `accounts.config.ts`; the IB id (`DU…`) lives only in each daemon's gitignored `.env` (`IB_ACCOUNT_ID`) and is pinned to the alias in the `Account` table on first IB boot. |
| Connectivity  | One broker connection per daemon; every IB read filtered to the account, every order sent with it; a login that does not manage the account fails the connect.                                                     |
| Scope         | Shared: `Instrument`, `Bar`, `BacktestRun`, `BacktestResult`. Per account: everything else. Existing rows backfilled to `nuuixl118`.                                                                               |
| Registry      | `accounts.config.ts` (reviewed source) holds label, permitted modes, equity, currency, symbol capital, loss threshold.                                                                                             |
| Safety scope  | Mode, kill switch, halts, startup assertions per account; the dashboard adds a **kill-all** that only engages.                                                                                                     |
| IDs           | Composite primary keys with `accountId`; new `clientOrderId`s are `co-<alias>-N`, legacy `co-N` kept.                                                                                                              |
| UI            | `/accounts/[accountId]/…`; `ACCOUNT_BACKENDS` lists daemon URLs; each daemon self-reports via `GET /account`.                                                                                                      |

## Why a daemon per account rather than per-account services in one process

Every safety-relevant service is a singleton with in-memory state (halts, kill switch, working-order
map, fill queues, reconnect policy). Making each per-account would rewrite most of the engine and put
account isolation in the hands of every future change. Separate processes make it structural: a crash,
a stuck timer, or a halt in one account cannot reach another.

**Costs accepted:** one more container per account; the UI resolves an account to a URL by asking each
daemon; two daemons on the _same_ IB login each pace their own historical requests, so IB's per-login
limits are shared without either queue knowing — prefer a login per daemon.

## Why the alias, not the IB id, in git

The id is sensitive and belongs to the deployment. Note that the real `nuuixl118` id already appears in
this repository's history (pre-accounts comments); this decision stops new occurrences, it does not
rewrite history.

## Cutover

Stop the daemon → `prisma migrate deploy` (`20260923000000_account`) → set `IB_ACCOUNT_ID` in `.env`
→ start. The migration backfills via `ADD COLUMN … DEFAULT 'nuuixl118'` (DDL, so the append-only
triggers are never suspended) and then drops the default. Resting orders keep their `co-N` ids and are
adopted as before. Verified against a copy of the live database: all 33 lots, 267 orders, 97 fills,
1,539 snapshots, and the 6 parameter changes carry `nuuixl118`, lots unchanged byte-for-byte, triggers
intact, no schema drift.

## Amendment (2026-09-24): accounts created from the dashboard

**Status:** accepted. Accounts can now be created at `/accounts/new`, and every account still trades in
its own process, in parallel.

| #             | Decision                                                                                                                                                                                                                                                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process model | Unchanged — one daemon per account. The backend container now runs a **supervisor** (`src/supervisor/`) that starts the configured account's daemon plus one `main.js` child per dashboard-created account, and restarts any that exit with backoff (1s → 5 min cap). It holds no trading state and has no path to a broker. |
| Registry      | Two sources. `accounts.config.ts` still defines `nuuixl118`. New accounts live in `AccountDefinition`, with creation audited in the append-only `AccountDefinitionChange` (triggers, like `ParameterChange`). A code alias cannot be recreated in the table, and `ACCOUNT_DEFINITION` cannot redefine one.                   |
| Hand-off      | The supervisor passes each child its definition as `ACCOUNT_DEFINITION` JSON, so capital figures still resolve synchronously at import time — no DB read before config validation.                                                                                                                                           |
| Connectivity  | Every account shares the container's `IB_HOST`/`IB_PORT` login. Client ids are allocated 11, 13, 15… (the `+1` execution connection needs the gap); ports 3101, 3102…, reached by the UI over the compose network via `API_URL`'s host.                                                                                      |
| Modes         | The form offers `PAPER` or `LIVE`, stored as the account's only allowed mode. `LIVE` records permission only: the startup assertions still refuse it until Story 15, so the daemon refuses to boot and is retried slowly.                                                                                                    |
| Scope         | Create-only. No edit or retire yet; the audit log's `action` column is where they would go. Needs `DATABASE_URL` — `POST /accounts` answers 503 without it rather than record an account no supervisor would start.                                                                                                          |

**Why not the alternatives.** Docker-socket access to create a container per account is effectively
root on the host. A single multi-account process is the rewrite this record already rejected. A UI
that only generated a config diff would not create an account.

**Costs accepted.** Capital figures for new accounts are no longer a reviewed diff — the audit log is
the trail instead. All accounts share one IB login, so they share its pacing limits (see above).
Kill-switch state is not persisted, so a new account starts trading once it reconciles, like every
other account after a restart.

## Revisit when

- A second account is added by hand rather than from the dashboard: add its entry to
  `accounts.config.ts`, a `backend-<alias>` compose service (template in `docker-compose.yml`, client
  id under 11), and its URL to `ACCOUNT_BACKENDS`.
- Accounts need editing or retiring: add actions to `AccountDefinitionChange`, and decide how a retired
  account's resting orders and held lots are handled before its daemon is stopped.
- Story 15 (`LIVE`): a live account gets its own entry with `allowedModes: [LIVE]`; its capital figures
  must be backtest-derived, like every other `LIVE` prerequisite.
