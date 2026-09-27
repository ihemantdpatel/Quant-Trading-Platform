# Decision — Per-symbol capital allocation (TQQQ)

**Status:** Set for `PAPER` (Story 13). Equity now converted at a live rate (Story 15, 2026-09-26).
Allocation still to be revisited with backtest evidence before `LIVE`.
**Date:** 2026-08-10
**Closes:** `PRD.md:503` — per-symbol capital allocation
**Decided by:** Operator, directly. **Not backtest-derived** — see "What informed this" below.

## The value

| Field                       | Value                                            |
| --------------------------- | ------------------------------------------------ |
| `symbolCapital.TQQQ`        | **USD 40,000**                                   |
| `equity`                    | **CAD 242,800**, converted to USD at a live rate |
| `equityCurrency`            | **CAD** — the account base currency              |
| `currency`                  | **USD** — the currency every cap and limit is in |

> **Amended 2026-09-26 (Story 15): the hand conversion is replaced by a live `USD.CAD` rate.**
> Equity is now stated in the account's real base currency and converted per evaluation at the
> IDEALPRO **ask** polled from IB every 60s (`risk/fx-rate.ts`, `market-data/fx/fx-rate-poller.ts`).
> A rate older than 180s, or none at all, **blocks new entries** — it never falls back to a cached
> rate. Exits are unaffected. `GET /status` reports it under `fx`.
>
> 242,800 CAD is the 2026-08-14 reading (248,973.68) less the same ~2.5% buffer, and equals the old
> 175,000 USD at that day's 1.3874 — so the cap is unchanged at that rate and now tracks the market.
> The buffer now absorbs **balance** drift only; the balance is still a static reading, which is
> the one staleness source left. The allocation itself (40,000) is **not** changed by this and is
> still not backtest-derived.
>
> **Direction, corrected.** Earlier text here and in Story 15 said a CAD _rally_ loosens the cap.
> It is the reverse: a stronger CAD raises the real USD equity (a static figure then under-states it
> and the cap is merely tight); a **weaker** CAD lowers it, and a static figure then over-states it —
> the loose direction. The "Revisit when" bullet below always had this right.

> **Corrected 2026-08-14.** The original figures were **USD 50,000 / USD 175,000**, and the equity
> was wrong in a way that cancelled itself: account `nuuixl118` reports `NetLiquidation` in **CAD**
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

`backend/src/config/capital.config.ts` — the single source (since accounts arrived, the values live in the `nuuixl118` entry of `accounts.config.ts` and `capital.config.ts` selects the active account's entry, renaming these `ACCOUNT_*`), read by `capital.module.ts` (which
publishes it to the risk layer) and `strategies.module.ts` (which sizes rungs from it).

Both read the _same_ constant. In `SHADOW` the ladder continues to use `SHADOW_NOMINAL_CAPITAL`
(a display scale that submits nothing) and `capital.module.ts` continues to report `null`, so the
startup assertion still correctly refuses a `PAPER` boot if this file is reverted.

## Revisit when

- ~~**Before `LIVE`, mandatorily** — the hand-converted equity figure must be replaced by live FX
  conversion.~~ **Done 2026-09-26** — see the amendment above.
- ~~**If `USD.CAD` moves more than ~2.5% from 1.3874**~~ — no longer applies; the rate is live.
- Before `LIVE` (Story 15) — mandatory, with backtest evidence.
- If the paper account balance moves materially from 248,973.68 CAD, since the cap derives from it.
  Re-read it with `reqAccountSummary` rather than assuming; it was found to be ~74,000 off once
  already. Update the **CAD** figure; the rate no longer needs re-reading by hand.
- If `sizePerRung`, `escalationFactor`, or `maxConcurrentRungs` change — all three move peak
  deployment, and the 125% figure above stops holding.
