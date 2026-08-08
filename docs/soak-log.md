# SHADOW Soak Log — Story 12

The running record of a `SHADOW` soak week: what ran, what the daily report said, and every
anomaly with its resolution.

**Exit criterion (`PRD.md:468`):** shadow mode runs a **full trading week** generating correct
intents with **zero reconciliation errors**. **Any week containing an unexplained anomaly restarts
the clock** — not the day, the week. An anomaly that is explained and fixed within the week does
not restart it, provided the fix carries a regression test and the remaining days run clean.

Nothing is submitted during this soak. `EXECUTION_MODE` stays `SHADOW` throughout; `PAPER` is
Story 13 and is blocked by a startup assertion until the two open `PRD.md:500` items are set.

---

## Preconditions

Confirm before starting the clock. A week that turns out to have run misconfigured does not count.

- [ ] `GET /status` reports `mode: SHADOW`
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

5. **Confirm `intents.submitted` is 0.** In `SHADOW` this must be zero every day. A non-zero value
   is the most serious thing the report can find and stops the soak immediately.

6. **Note `rungVerification.skipped`.** A skip is *not* a pass — it means the day's check could not
   run. A skipped day cannot count toward a clean week.

## Restart verification

**At least one deliberate mid-session restart per week** (`stories.md:700`), to exercise
reconciliation against a live broker position rather than a test fixture.

1. Note `GET /lots` and `GET /rungs` before the restart.
2. Restart the backend mid-session.
3. Confirm `GET /status` → `reconciliation.clean: true` and `halts.symbols: []`.
4. Confirm lots and rungs match step 1 exactly — same lot ids, fill prices, targets, and rung
   arming.
5. Record the restart in the sessions table.

A halt here is a **finding, not a failure of the exercise** — reconciliation refusing to resume on
a mismatch is the system working. What matters is whether the mismatch itself is explained.

> **In `SHADOW`, a restart with a held ladder is expected to halt on the lot-sum assertion.** The
> ladder records intents that were never submitted, so the database legitimately diverges from the
> broker's (empty) position. This is correct behaviour, documented in `CLAUDE.md`, and is **not** an
> anomaly for soak purposes. Record it as an expected halt. A restart while the ladder is flat
> should reconcile cleanly, and that is the case worth checking for a genuine regression.

---

## Sessions

One row per trading day. `Report clean` is the `clean` field from `GET /reports/daily`.

| Date | Intents | Submitted | Cycles closed | Realized | Rung check | Reconciliation | Report clean | Notes |
|---|---|---|---|---|---|---|---|---|
| _(not started)_ | | | | | | | | |

**Week status:** not started. Clock starts on the first full trading day meeting the preconditions.

---

## Anomalies

Every anomaly, including ones resolved as benign. An anomaly with no root cause recorded is by
definition unexplained, and an unexplained anomaly restarts the week.

| # | Date | Code | What was observed | Root cause | Resolution | Regression test | Week restarted |
|---|---|---|---|---|---|---|---|
| _(none recorded)_ | | | | | | | |

### Anomaly codes the report raises

| Code | Meaning | Severity |
|---|---|---|
| `SUBMISSION_IN_SHADOW` | An intent was recorded as submitted while in `SHADOW` | **Stop the soak.** The mode guarantee has been violated |
| `RUNG_PRICE_MISMATCH` | An entry intent fired at a price the recomputed ladder does not explain | **Stop and investigate.** State and rules have diverged |
| `LOT_CLOSED_AT_LOSS` | A lot closed below its fill price | **Stop and investigate.** No code path may book a loss |
| `RECONCILIATION_MISMATCH` | The last reconciliation did not reconcile cleanly | Investigate; expected in `SHADOW` with a held ladder — see above |
| `ACTIVE_SYMBOL_HALT` | A symbol is halted and not trading | Investigate the halt's own reason |
| `INTENT_OUTSIDE_FIRING_WINDOW` | An intent was stamped outside 09:45–16:00 ET | Investigate; the firing window is a hard rule |
| `RUNG_VERIFICATION_SKIPPED` | The day's rung check could not run | The day does not count toward a clean week |

---

## Exit sign-off

Complete only when a full trading week has run with zero unexplained anomalies.

- [ ] Five consecutive trading sessions recorded above
- [ ] Every session's report `clean: true`, or every anomaly explained with a root cause
- [ ] Zero `SUBMISSION_IN_SHADOW` on any day
- [ ] Zero unexplained reconciliation errors
- [ ] At least one mid-session restart performed and its reconciliation verified
- [ ] No session left with `rungVerification.skipped: true`
- [ ] Every fix made during the week carries a regression test

**Signed off:** _(pending)_ — Story 13 (`PAPER` enablement) is gated on this and on Story 11.
