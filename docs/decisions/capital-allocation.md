# Decision — Per-symbol capital allocation (TQQQ)

**Status:** Set for `PAPER` (Story 13). Revisit before `LIVE` (Story 15).
**Date:** 2026-08-10
**Closes:** `PRD.md:503` — per-symbol capital allocation
**Decided by:** Operator, directly. **Not backtest-derived** — see "What informed this" below.

## The value

| Field                       | Value                                     |
| --------------------------- | ----------------------------------------- |
| `PAPER_SYMBOL_CAPITAL.TQQQ` | **USD 40,000**                            |
| `PAPER_ACCOUNT_EQUITY`      | **USD 175,000** (hand-converted from CAD) |
| `PAPER_ACCOUNT_CURRENCY`    | **USD** — _not_ the account base currency |

> **Corrected 2026-08-14.** The original figures were **USD 50,000 / USD 175,000**, and the equity
> was wrong in a way that cancelled itself: account `DU7022583` reports `NetLiquidation` in **CAD**
> at **248,973.68**, so a USD position notional was being capped against a CAD number. See below.

## The currency error, and how it is handled

The account's base currency is CAD; TQQQ trades in USD. The global cap compares a sum of position
notionals against `accountEquity` **directly**, with no conversion anywhere in the risk layer. So a
USD notional was measured against a CAD figure, permitting roughly `USDCAD` — about **1.39×** — more
exposure than intended, on top of a denominator that was itself ~74,000 too low.

The two errors partly offset, which is why this went unnoticed: the stale-low equity tightened the
cap while the missing conversion loosened it. Relying on that cancellation is not a control.

**Resolution taken: express every capital figure in USD and convert the balance once, by hand.**

```
248,973.68 CAD ÷ 1.3874 (USD.CAD, IDEALPRO, 2026-08-14) ≈ 179,455 USD
                                          rounded down →  175,000 USD
```

`assertSingleCurrency` (`risk.config.ts`) now passes because both sides genuinely say USD, and the
cap arithmetic is sound. This was chosen over the alternatives — refusing to boot until FX conversion
exists, or funding the account in USD — to keep the engine running today.

**What this costs, stated plainly.** `PAPER_ACCOUNT_EQUITY` is now a hand-converted snapshot carrying
_two_ sources of staleness rather than one: the account balance, and the exchange rate. A sustained
CAD rally shrinks real USD equity while the constant stays put, which loosens the cap silently —
exactly the failure mode this document exists to prevent, only slower. The ~2.5% buffer below absorbs
ordinary daily rate movement, not a trend.

**The real fix remains open:** a live `USD.CAD` rate from IB (`IDEALPRO`), treated as market data
with its own staleness watchdog, where an unavailable or stale rate blocks new entries rather than
falling back to a cached value of unknown age. Until then, re-read the balance **and** the rate
together whenever revisiting — converting one without the other reintroduces the original mismatch.

## Reasoning

The allocation is _expected deployment_, not a ceiling (`stories.md:Story 13`). The ladder's defaults
are `sizePerRung: 0.25`, `escalationFactor: 1` (flat), `maxConcurrentRungs: 5`, so a fully-extended
ladder deploys **125% of the allocation**:

```
5 rungs × 25% × 40,000 = 50,000 peak deployment
```

The binding constraint is the global cap at `GLOBAL_CAPITAL_CAP_FRACTION = 0.6`:

```
0.6 × 175,000 = 105,000 global cap
50,000 peak   <  105,000            ✅ full ladder fits with ~52% headroom
```

`PAPER_ACCOUNT_EQUITY` is set to **175,000 against a converted ~179,455** — deliberately below it, so
both balance drift and adverse FX movement have room before the cap becomes too loose.

The theoretical maximum that still fits is `105,000 / 1.25 = 84,000`. **40,000 was chosen far below
that ceiling deliberately**, for two reasons — and was _not_ restored to the original 50,000, because
the equity denominator now carries FX staleness the original did not:

1. **The cap must not be the thing that stops a rung.** If the allocation is sized so a full ladder
   only just fits, the fifth rung — the deepest one, fired in the worst drawdown — is the one the
   risk manager resizes or rejects. That is precisely the rung the strategy exists to take. Headroom
   means the ladder is limited by its own rules, not by a collision with the cap.
2. **Nothing has been validated at size yet.** This is the first configuration that can submit an
   order anywhere. See the caveat below.

## What informed this — and what did not

**Story 13 specifies these figures should be "informed by Story 11 backtests." They were not.** No
backtest was run to produce this number; it was derived from the account balance and the cap
arithmetic above. This is a deviation from the story, recorded here rather than left implicit.

The consequence: this figure is defensible as _safe_ — it fits the cap with headroom and cannot
overdeploy — but it is **not** claimed to be optimal, or validated against the 2022 ~80% drawdown
named at `PRD.md:470`. Before `LIVE` (Story 15), run the backtester over cached TQQQ history and
either confirm this figure or replace it, updating this document with the evidence.

## Where it lives

`backend/src/config/capital.config.ts` — the single source, read by `capital.module.ts` (which
publishes it to the risk layer) and `strategies.module.ts` (which sizes rungs from it).

Both read the _same_ constant. In `SHADOW` the ladder continues to use `SHADOW_NOMINAL_CAPITAL`
(a display scale that submits nothing) and `capital.module.ts` continues to report `null`, so the
startup assertion still correctly refuses a `PAPER` boot if this file is reverted.

## Revisit when

- **Before `LIVE`, mandatorily** — the hand-converted equity figure must be replaced by live FX
  conversion. A manually-converted constant is acceptable for `PAPER`, where the cost of a loose cap
  is a paper loss; it is not acceptable where the cost is real money.
- **If `USD.CAD` moves more than ~2.5% from 1.3874**, since that is the entire buffer. A stronger CAD
  raises real USD equity (harmless, cap merely tightens); a weaker CAD lowers it and loosens the cap.
- Before `LIVE` (Story 15) — mandatory, with backtest evidence.
- If the paper account balance moves materially from 248,973.68 CAD, since the cap derives from it.
  Re-read it with `reqAccountSummary` rather than assuming; it was found to be ~74,000 off once
  already. **Re-read the FX rate in the same sitting.**
- If `sizePerRung`, `escalationFactor`, or `maxConcurrentRungs` change — all three move peak
  deployment, and the 125% figure above stops holding.
