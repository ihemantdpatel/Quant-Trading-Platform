# Decision — `LIVE` cutover: flag, reduced size, and step-up

**Status:** Mechanism built (Story 15, 2026-09-26). **`LIVE` enabled 2026-09-27** by operator
decision, ahead of two gates — see "Enablement decision" below.
**Gates still open:** the `PAPER` soak sign-off (`docs/soak-log.md`) and backtest-backed capital
figures (`capital-allocation.md`, `daily-loss-threshold.md`).

## What is in place

| Setting (`backend/src/config/live.config.ts`) | Value         | Meaning                                                           |
| --------------------------------------------- | ------------- | ----------------------------------------------------------------- |
| `LIVE_TRADING_ENABLED`                        | **`true`**    | Permits `LIVE`; each account's `allowedModes` decides who uses it |
| `LIVE_SIZE_STAGE`                             | **`REDUCED`** | The first live period trades at reduced size                      |
| `LIVE_REDUCED_SIZE_MULTIPLIER`                | **0.25**      | 25% of each BUY's nominal quantity, floored                       |
| `LIVE_STEP_UP_RECORD`                         | **`null`**    | Required, non-empty, before `FULL` will boot                      |

Also in place, from the same story: equity is converted at a live `USD.CAD` rate, and a stale or
missing rate blocks new entries — see the 2026-09-26 amendment in `capital-allocation.md`.

## Account identity (added 2026-09-27)

Three checks, each able to refuse on its own:

- **The account must permit the mode.** `allowedModes` in `accounts.config.ts`; the paper account
  lists only `PAPER`, so a live boot needs a separate registry entry.
- **The id's kind must match the mode.** `config.schema.ts` refuses a `U…` `IB_ACCOUNT_ID` under
  `PAPER` and a `D…` one under `LIVE` (`broker/ib/account-identity.ts`). Without this, a live id
  under `PAPER` would have skipped reduced sizing and traded real money at full size.
- **The login must manage the id.** Checked by the socket on every connect (`checkManagedAccount`);
  every order is sent to that account and every read filtered to it.

## How reduced size works

- **Applied in the risk layer** (`risk/live-sizing.ts`, called from `RiskManagerService.decide`),
  not in a strategy. The ladder's `fixedQuantity` and the grid's own sizing both bypass
  `symbolCapital`, so shrinking the allocation alone would not have shrunk a single order. One
  control in the chokepoint binds every strategy the same way.
- **BUYs only.** An exit sells what actually filled, which is already the reduced quantity.
- **Floored**, never rounded: 50 → 12. A BUY that floors to zero is rejected
  (`LIVE_SIZE_REDUCTION`), not submitted as nothing.
- **Before the capital caps**, so the caps measure what would actually be submitted. When a cap
  then cuts further, the decision is reported under the cap's reason.
- **`LIVE` only.** `PAPER` keeps full size — the paper account exists to observe real mechanics.
  `GET /status` reports `liveSizing` in every mode so the setting is visible before it applies.

## How the step-up works

Stepping up is **a source change and nothing else**: set `LIVE_SIZE_STAGE = FULL` and
`LIVE_STEP_UP_RECORD` to a pointer into this document. `liveSizeMultiplier()` throws on `FULL`
without a record, so the boot fails. Nothing in `live.config.ts` reads a clock or schedules
anything, and `live.config.spec.ts` asserts that (a fake clock a year ahead still yields 0.25, and
the source is scanned for `Date`/timers). A date-driven step-up would make the largest sizing change
in the system with nobody looking at the two weeks meant to justify it.

## Cutover checklist (in order)

1. [ ] `PAPER` soak signed off in `docs/soak-log.md`, with at least one complete cycle
2. [ ] Capital allocation and loss threshold confirmed or replaced **with backtest evidence** of the
       strategy actually enabled — which is now the **grid**, not the dip ladder
3. [ ] Fixed-dollar geometry, gap re-basing, and Tier 2 lot rebuild revisited (see `CLAUDE.md`)
4. [ ] `IB_PORT` re-confirmed (4001 live), `IB_ACCOUNT_ID` set to the live account (`U…`), and
       `EXECUTION_MODE=LIVE` set deliberately. `GET /status` → `broker.account` must show that id
5. [ ] `LIVE_TRADING_ENABLED = true` — the last change, in its own reviewed commit
6. [ ] Kill switch verified on the live account
7. [ ] Two weeks at 25%, monitored daily, recorded below
8. [ ] Step-up decision recorded below, then `LIVE_SIZE_STAGE = FULL`

## Enablement decision (2026-09-27)

The operator enabled `LIVE` before the cutover checklist was complete. Recorded here so the
deviation is visible rather than inferred.

**Skipped or deferred:**

- **Paper soak sign-off (item 1)** — skipped. The soak log has no recorded sessions. The paper
  account keeps trading alongside live, so paper evidence continues to accumulate.
- **Backtest-backed capital figures (item 2)** — replaced by operator-chosen figures sized to
  affordable loss. The backtester runs only the dip ladder; the enabled strategy is the grid.
- **Ladder geometry and gap re-basing (item 3)** — deferred: the dip ladder is disabled. Re-enabling
  it for `LIVE` requires this review first.
- **Tier 2 lot rebuild (item 3)** — no action: it is gated to `PAPER`, so a `LIVE` lot-sum mismatch
  halts the symbol for manual resolution.

**What bounds the downside instead:** BUYs at 25% of nominal (`LIVE_SIZE_STAGE = REDUCED`), the
60% global cap (120,000 USD), the per-symbol limit, the 2,500 USD daily loss breaker, and the kill
switch. None of these ever sells.

**The live account** (`accounts.config.ts`, alias `live`): equity 200,000 USD, TQQQ 40,000, daily
loss threshold 2,500, `allowedModes: [LIVE]`. The paper account stays `PAPER`-only and keeps its
lots. Each runs as its own daemon — `backend` (paper, Gateway on 4002) and `backend-live` (live,
TWS on 7496, set by `LIVE_IB_PORT`) — sharing only MySQL. The account id is in `.env` as `LIVE_IB_ACCOUNT_ID`.

**Still required before the first live order:** TWS logged in with the live username, API socket
port 7496 enabled and not read-only, alongside the paper IB Gateway on 4002; kill switch verified on the live daemon (item 6);
then two weeks at 25%, logged below (item 7).

## Reduced-size log

_(none — `LIVE` not yet entered)_

## Step-up decision

_(pending)_
