# PAPER Soak Log — Story 14

The running record of the soak week: what ran, what the daily report said, and every anomaly with
its resolution.

> **This log was written for a `SHADOW` soak (Story 12) and has been revised for `PAPER`.** SHADOW is
> retired — see `backend/src/config/execution-mode.ts`. The change is not cosmetic: **orders are now
> genuinely submitted to the IB paper account and rest there between sessions**, so two of the
> original daily checks meant the _opposite_ of what they mean now. They are called out inline.

**Exit criterion (`PRD.md:468`, adapted):** the system runs a **full trading week** generating
correct intents with **zero reconciliation errors**. **Any week containing an unexplained anomaly
restarts the clock** — not the day, the week. An anomaly that is explained and fixed within the week
does not restart it, provided the fix carries a regression test and the remaining days run clean.

`EXECUTION_MODE` stays `PAPER` throughout, against IB port **4002**. `LIVE` is Story 15 and remains
blocked. Confirm the port before starting: this is the setting that separates simulated from real.

---

## Preconditions

Confirm before starting the clock. A week that turns out to have run misconfigured does not count.

- [ ] `GET /status` reports `mode: PAPER`
- [ ] `IB_PORT` is **4002** — the practice account, not 4001
- [ ] The account the Gateway is logged into is the **paper** account (`DU…`), not a live one
- [ ] `GET /status` reports `storage: DURABLE` — an in-memory run loses the evidence the reports
      are built from, and a restart would silently truncate a session
- [ ] `GET /status` reports `broker.name` as the IB adapter, not the mock
- [ ] `GET /status` shows `halts.symbols` empty and `reconciliation.clean: true`
- [ ] IB Gateway logged in, with the market data subscription the live account carries
- [ ] Backfill has run: daily history to inception, 5-minute to IB's cap

## Daily procedure

Run at or after 16:00 ET each trading day.

1. **Pull the report.**

   ```bash
   curl "localhost:3000/reports/daily?date=$(date +%F)" | jq
   ```

2. **Check `clean`.** `true` means no anomaly was detected. Record the session below either way —
   a clean day is evidence and belongs in the record.

3. **Read `anomalies` if not clean.** Each carries a `code` and a `detail` naming the numbers that
   produced it. Every one gets an entry in the anomaly table, including ones that turn out benign.

4. **Spot-check the rung arithmetic.** `rungVerification` shows the anchor, the spacing distance,
   and the recomputed rung prices. The report derives these from the session's persisted anchor
   scalars, independently of the ladder's own rung list — so agreement means two paths through the
   same rules reached the same prices. Confirm by hand that the anchor matches
   `max(previous session close, today's open)` when flat, or the lowest held lot's rung price when
   holding.

5. **Check `intents.submitted` against what the ladder did.** ⚠️ **This check has inverted.** Under
   `SHADOW` it had to be **0** every day and any other value stopped the soak. In `PAPER` submission
   is the expected behaviour: on a day the ladder fired, a non-zero count is correct, and a **zero**
   count means orders are not reaching IB and needs investigating.

6. **Note `rungVerification.skipped`.** A skip is _not_ a pass — it means the day's check could not
   run. A skipped day cannot count toward a clean week.

7. **Reconcile the resting orders.** `GET /orders` against IB's own order window in TWS. Any order
   the ladder placed should be visible at IB at the same price, and IB should hold nothing at a rung
   the ladder does not show as `WORKING`. This is the check that only exists now that orders live
   outside the process.

8. **Note anything still resting at the close.** DAY orders expire at the close and the rung is
   released on the next reconciliation. An order still showing as `WORKING` the following morning
   with nothing at IB is worth a line in the anomaly table.

## Restart verification

**At least one deliberate mid-session restart per week** (`stories.md:700`), to exercise
reconciliation against a live broker position rather than a test fixture.

1. Note `GET /lots`, `GET /rungs`, and `GET /orders` before the restart.
2. Restart the backend mid-session.
3. Confirm `GET /status` → `reconciliation.clean: true` and `halts.symbols: []`.
4. Confirm lots and rungs match step 1 exactly — same lot ids, fill prices, targets, and rung
   arming.
5. **Confirm no order was duplicated.** Every `WORKING` rung should map to exactly one order at IB,
   at the same price it had before the restart. Two orders at one rung price is a serious finding —
   it is the specific failure open-order reconciliation exists to prevent.
6. **Confirm nothing was cancelled by the restart.** Orders resting before it should still be there.
7. Record the restart in the sessions table.

A halt here is a **finding, not a failure of the exercise** — reconciliation refusing to resume on
a mismatch is the system working. What matters is whether the mismatch itself is explained.

> ⚠️ **This expectation has inverted.** Under `SHADOW` a restart with a held ladder was **expected**
> to halt on the lot-sum assertion, because the ladder recorded intents that were never submitted and
> the database legitimately diverged from the broker's empty position. You were told to record it and
> move on.
>
> **In `PAPER` every lot follows a real fill, so the database and the broker should now agree.** A
> lot-sum halt is a **genuine anomaly** and must be investigated and explained like any other. Do not
> carry the old expectation forward — it would mask exactly the failure the restart exercise is for.

---

## Sessions

One row per trading day. `Report clean` is the `clean` field from `GET /reports/daily`.

| Date            | Intents | Submitted | Cycles closed | Realized | Rung check | Reconciliation | Report clean | Notes |
| --------------- | ------- | --------- | ------------- | -------- | ---------- | -------------- | ------------ | ----- |
| _(not started)_ |         |           |               |          |            |                |              |       |

**Week status:** not started. Clock starts on the first full trading day meeting the preconditions.

---

## Anomalies

Every anomaly, including ones resolved as benign. An anomaly with no root cause recorded is by
definition unexplained, and an unexplained anomaly restarts the week.

| #                 | Date | Code | What was observed | Root cause | Resolution | Regression test | Week restarted |
| ----------------- | ---- | ---- | ----------------- | ---------- | ---------- | --------------- | -------------- |
| _(none recorded)_ |      |      |                   |            |            |                 |                |

### Anomaly codes the report raises

| Code                           | Meaning                                                                       | Severity                                                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `RETIRED_MODE`                 | The session was recorded in `SHADOW`, which is retired and refused at startup | For a **historic** date, expected — it predates the retirement. For **today**, the mode config is wrong: **stop the soak** |
| `RUNG_PRICE_MISMATCH`          | An entry intent fired at a price the recomputed ladder does not explain       | **Stop and investigate.** State and rules have diverged                                                                    |
| `LOT_CLOSED_AT_LOSS`           | A lot closed below its fill price                                             | **Stop and investigate.** No code path may book a loss                                                                     |
| `RECONCILIATION_MISMATCH`      | The last reconciliation did not reconcile cleanly                             | ⚠️ **No longer expected.** Was routine in `SHADOW`; in `PAPER` it is a real finding                                        |
| `ACTIVE_SYMBOL_HALT`           | A symbol is halted and not trading                                            | Investigate the halt's own reason                                                                                          |
| `INTENT_OUTSIDE_FIRING_WINDOW` | An **entry** intent was stamped outside 09:45–16:00 ET                        | Investigate; the firing window is a hard rule. Exits are excluded — a lot may take profit at any point in the session      |
| `RUNG_VERIFICATION_SKIPPED`    | The day's rung check could not run                                            | The day does not count toward a clean week                                                                                 |

`SUBMISSION_IN_SHADOW` is **gone**, replaced by `RETIRED_MODE`. It asserted that nothing was ever
submitted, which is no longer a property this system has.

---

## Exit sign-off

Complete only when a full trading week has run with zero unexplained anomalies.

- [ ] Five consecutive trading sessions recorded above
- [ ] Every session's report `clean: true`, or every anomaly explained with a root cause
- [ ] Zero `RETIRED_MODE` anomalies on any current-dated session
- [ ] Zero unexplained reconciliation errors — **including lot-sum halts, which are no longer
      expected in `PAPER`**
- [ ] At least one mid-session restart performed and its reconciliation verified
- [ ] **No duplicated order at any rung across a restart**
- [ ] No session left with `rungVerification.skipped: true`
- [ ] Every fix made during the week carries a regression test

**Signed off:** _(pending)_ — Story 15 (`LIVE` enablement) is gated on this week, and additionally on
revisiting the capital figures in `docs/decisions/` with backtest evidence.
