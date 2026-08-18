# Decision — Daily loss threshold and P&L basis

**Status:** Set for `PAPER` (Story 13). Revisit before `LIVE` (Story 15).
**Date:** 2026-08-10
**Closes:** `PRD.md:505` — daily loss threshold; resolves the tension at `PRD.md:252`
**Decided by:** Operator, directly.

## The value

| Field                | Value                         |
| -------------------- | ----------------------------- |
| `dailyLossThreshold` | **USD 5,000**                 |
| `dailyLossBasis`     | **`REALIZED_AND_UNREALIZED`** |

## Why this matters more than the other number

This is **the only automated drawdown response in the system.** The dip ladder has:

- no stop-loss, at any level;
- a hard floor at −25% that **stops adding but never sells**;
- an exit rule where lots only ever close _in profit_.

So every other control either prevents entry or does nothing during a decline. If TQQQ — a 3x
leveraged ETF — falls hard, the breaker is the only thing that reacts.

## Resolving the `PRD.md:252` tension

The PRD records the conflict without resolving it. Both bases are wrong in opposite directions:

**`REALIZED` only would never fire.** Lots close only in profit, so realized P&L on this strategy is
positive almost by construction. A realized-only breaker on a ladder holding six figures of
underwater TQQQ would report a _profitable_ day. It would be an automated response that never
responds — worse than none, because it looks like protection.

**A tight `REALIZED_AND_UNREALIZED` threshold fires constantly.** The strategy is _designed_ to sit
in unrealized loss: that is what buying a dip means. Every rung fires into a decline and is
underwater the moment it fills. A threshold set near normal ladder depth would halt during correct
operation, and an operator who sees the breaker trip on ordinary Tuesdays learns to ignore it.

**The resolution is the basis that can actually fire, with a threshold set beyond normal operation.**
`REALIZED_AND_UNREALIZED` at a level a routine ladder does not reach.

## Why 5,000

> **Recomputed 2026-08-14.** The figures below originally used the `50,000` allocation. That was
> corrected to `40,000` (see [capital-allocation.md](./capital-allocation.md)), so the ratios have
> moved. **The threshold itself was left at 5,000** — the reasoning below still holds at the new
> ratios, which sit further from normal ladder operation rather than closer to it.

Against the `40,000` TQQQ allocation (see [capital-allocation.md](./capital-allocation.md)):

```
5,000 / 40,000 = 12.5% of allocation
5,000 / 50,000 = 10% of peak deployment (full 5-rung ladder)
5,000 / 175,000 = 2.9% of account equity
```

A normally-extended ladder sits underwater by design, but the rungs are 5% apart and the hard floor
is −25% below first entry. A 10% loss on peak deployment is deeper than routine ladder drift and
shallower than the floor — so the breaker fires in a genuine rout, not on an ordinary dip the
strategy is built to absorb.

At 2.9% of equity it is also small enough that tripping it is survivable, which is the point: the
breaker exists to stop the day, not to cap the maximum possible loss.

## What the breaker does — and does not do

**Halts new submission. Does not liquidate.** No code path in this system may turn a technical fault
or a breached threshold into a realized loss (`CLAUDE.md`, Working Constraints). Positions are held.
The breaker stops the ladder from adding; the operator decides what happens next.

This is deliberate and must not be "improved" into an auto-flatten. On a 3x ETF with no stop
underneath, an automated liquidation at the bottom of a panic is the single most expensive thing this
system could do.

## Revisit when

- Before `LIVE` (Story 15) — mandatory. Story 14's paper soak should show whether 5,000 sits at the
  right distance from normal operation, or whether it trips on ordinary sessions.
- If the TQQQ allocation changes — the ~10%-of-peak-deployment relationship is what was reasoned
  about, not the absolute figure. (It has changed once already: 40,000 replaced 50,000 and this
  document was recomputed rather than the threshold moved.)
- If a second symbol is added. The threshold is **account-wide**, not per-symbol, so two ladders
  share one budget and the same number becomes proportionally tighter.
