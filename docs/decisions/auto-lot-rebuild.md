# Decision — Automatic recovery of a `LOT_SUM_MISMATCH`

**Status:** Set for `PAPER`. Gated off entirely in `LIVE` — revisit before Story 15.
**Date:** 2026-09-01
**Closes:** the operational cost of `reconciliation.service.ts`'s only-response-is-halt rule —
`stories.md:558`, `PRD.md:321`/`347` — without weakening the rule itself.
**Decided by:** Operator, directly, in response to wanting more of the paper soak's trading days to
run unattended rather than stall on a halt only a human can clear.

## The value

| Field                                   | Value                                                                                        |
| --------------------------------------- | -------------------------------------------------------------------------------------------- |
| Applies in                              | **`PAPER` only** — `ReconciliationService` checks `ExecutionMode` before attempting anything |
| Applies to                              | `LOT_SUM_MISMATCH` only — never `BROKER_UNAVAILABLE` or `STATE_VERSION_MISMATCH`             |
| Tier 1 (exact reconstruction)           | **Enabled**                                                                                  |
| Tier 2 (synthetic lot at average cost)  | **Enabled**                                                                                  |
| Write-off (broker reports fewer shares) | **Enabled**                                                                                  |

All three tiers of `LotRebuildService` are live. This was a deliberate choice over Tier-1-only —
see "Why Tier 2 is included" below.

## What this does not change

`reconciliation.service.ts`'s header is still accurate: reconciliation **never liquidates and never
guesses at composition to make a halt go away by force.** Every path `LotRebuildService` can take
either:

- reconstructs lots **exactly** from this ladder's own `Order` records, where the reconstruction's
  quantity sums to precisely the broker's number and its weighted fill price is not below the
  broker's reported average cost (Tier 1); or
- synthesizes **one** lot at the broker's own blended average cost, when Tier 1 cannot explain the
  gap exactly (Tier 2) — the broker told us what it paid on average; the ladder just failed to
  attribute it to a lot; or
- closes excess DB-only exposure at each lot's **own** `fillPrice`, never a market price, so realized
  P&L from a write-off is always exactly zero (the broker-lower direction).

None of these invents a quantity or a price the broker did not already report. `assertLotSum` still
runs after every attempt, and if the result still does not reconcile exactly, the symbol still halts
— there is no partial application and no second guess. The refusal-to-guess rule is unchanged; what
changed is that some of what used to require a human phrasing "yes, trust the broker's number" is now
phrased as code that reaches the same conclusion the same way an operator running `recover-lots
--apply` would.

## Why this is safe enough for `PAPER` specifically

**The failure mode of a wrong auto-rebuild is bounded, and it is the same failure mode
`recover-lots` already accepts for the manual path:**

- Every recovered lot's `fillPrice` is a **limit price a real order carried**, or the broker's own
  average cost — a buy limit fills at or below its limit, so a Tier 1 target errs _high_ (held
  marginally longer, never sold below a true take-profit).
- The worst outcome of a _wrong_ Tier 2 synthesis is a **collapsed exit target** — every share in the
  gap shares one blended target instead of its own per-lot one. That is a real cost (the per-lot exit
  discipline this ladder is built around is lost for those shares) but not a _runaway_ one: the lot
  still only ever exits in profit, still has no leverage on top of what the broker already reports,
  and still cannot exceed the broker's own quantity.
- A write-off can only ever reduce recorded exposure to match a broker that reports **less** than the
  DB does — it can never manufacture a position, and `realizedPnl` from it is definitionally zero.

**None of this holds for `LIVE`.** A wrong Tier 2 synthesis on real capital is a real mispriced exit
on real money, not a paper one — this is exactly the kind of tradeoff `capital-allocation.md` and
`daily-loss-threshold.md` both flag as "acceptable for PAPER, not yet decided for LIVE." Gating on
`ExecutionMode.PAPER` is structural, mirroring how those two documents' figures are themselves
`PAPER`-only pending Story 15, not a preference expressed only in this file's prose.

## Why Tier 2 is included, not deferred

The alternative considered was Tier 1 only: auto-resolve an exact reconstruction, still halt
(manually) whenever the gap cannot be explained from this ladder's own order history. That was
rejected because **the case Tier 2 exists for is exactly the case that most needs to not halt**: an
order placed, filled, and never durably tied to a rung — a gap in _our own_ records, not in the
broker's. The broker's blended average cost is a real, reported fact about what happened; refusing to
use it when our own bookkeeping is what's missing trades a known, bounded cost (one collapsed exit
target) for an unbounded one (the symbol sits halted, deploying no capital, until someone manually
runs `recover-lots` — which would reach for the _same_ average-cost figure anyway).

## What this does for the "reduce operator toil" goal

Two mismatch directions previously **always** required `POST /halts/:symbol/release` after a human
looked at the account by hand:

- broker reports more shares than the ladder's lots explain (`UNTRACKED_AT_BROKER`,
  `QUANTITY_MISMATCH` with the broker higher);
- broker reports fewer (`MISSING_AT_BROKER`, `QUANTITY_MISMATCH` with the broker lower).

Both now resolve automatically in `PAPER`, in the ordinary case, at reconciliation time — startup,
`POST /reconcile`, or a `BROKER_UNAVAILABLE` auto-release re-check. The symbol still halts, exactly as
before, whenever the automatic attempt itself does not produce an exact match — `LotRebuildService`
refuses rather than partially applies, and `reconcileSymbol` treats a refusal identically to how it
treated every mismatch before this feature existed.

## Revisit when

- **Before `LIVE` (Story 15) — mandatory.** Decide separately, with real-money stakes in view,
  whether Tier 2's collapsed-target tradeoff is still acceptable, whether it should require an
  explicit operator confirmation even in `PAPER`-adjacent `LIVE` testing, and whether a size cap on
  automatic Tier 2 applications is warranted in addition to the frequency cap below.
- **A per-symbol, per-session frequency cap is now implemented**
  (`ReconciliationService.rebuildsAppliedBySymbol`), after the `PAPER` soak _did_ show a need for
  it: a fill-routing race
  (`EngineService.routeFill`/`routeExitFill`, fixed 2026-09-03) let a resting sell's fill land on the
  broker in more than one execution report while this process still attributed both to the same
  in-memory working order, closing the wrong lot and leaving real, already-sold shares recorded as
  still `HELD`. The next reconciliation read that as `LOT_SUM_MISMATCH` and Tier 2 synthesized a lot
  to explain it — masking an upstream bug as "reconciliation resolved it," exactly the risk this
  section anticipated. Worse, the synthetic lot's blended exit target authorized what was, against the
  real underlying lot's actual fill price, a loss-making sale — the "still only ever exits in profit"
  safety property above assumed Tier 2's gap was genuinely untracked shares, not shares already
  belonging to a higher-cost real lot. A second `LOT_SUM_MISMATCH` for the same symbol within one
  process's lifetime is now refused and halts instead of rebuilding again — see
  `attemptRebuild` in `reconciliation.service.ts`.
- **If the paper soak shows Tier 2 firing often.** A rebuild that fires routinely is evidence of a
  _live_ bug upstream (a fill silently not persisted, a crash window not otherwise closed) masking
  itself as "reconciliation resolved it," rather than the rare edge case this was designed for. Check
  `RebuildAction.ADD_TIER2_SYNTHETIC` frequency in `ReconciliationReport` before `LIVE`.
- **If a second symbol is added.** `ReconciliationService` currently reads one shared
  `DIP_LADDER_CONFIG` for `takeProfitPercent`/`takeProfitDollars`, matching `DailyReportService`'s
  existing single-instance assumption. A second ladder with its own config needs this threaded
  per-symbol, not read from one shared token.
