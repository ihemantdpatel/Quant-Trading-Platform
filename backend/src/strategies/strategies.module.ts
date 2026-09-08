/**
 * Wires the strategy layer.
 *
 * Registration itself happens in `EngineModule`, not here: the coordinator is
 * provided as an empty registry, and the engine populates it from config at
 * startup. That keeps this module free of any decision about *which* strategies
 * run, so enabling the Wheel at Story 16 is a config change rather than a
 * module change.
 *
 * The dip-ladder config is provided by token so Story 13 can supply the
 * now-set `symbolCapital` without touching a call site, and Story 7's
 * parameter editor has one place to write through.
 */

import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { AppConfigService } from '../config/app-config.service';
import { PAPER_SYMBOL_CAPITAL } from '../config/capital.config';
import { ExecutionMode } from '../config/execution-mode';
import { NullSentimentProvider } from '../sentiment/null-sentiment.provider';
import { CoordinatorService } from './coordinator.service';
import {
  buildDipLadderConfig,
  DipLadderConfig,
  OrderPlacement,
  SpacingMode,
} from './dip-ladder/config';

export const DIP_LADDER_CONFIG = Symbol('DIP_LADDER_CONFIG');
export const SENTIMENT_PROVIDER = Symbol('SENTIMENT_PROVIDER');

/**
 * The symbol the Phase 1 ladder trades (`PRD.md:61`). A named constant rather
 * than an env var: changing which instrument this system trades is a decision
 * that belongs in a reviewed diff, not in a deployment variable.
 */
export const DIP_LADDER_SYMBOL = 'TQQQ';

/**
 * The currency `DIP_LADDER_SYMBOL` trades in, matching `equityContract`'s
 * default.
 *
 * Named alongside the symbol because the two travel together: the risk layer
 * compares position notional against account equity, and that comparison is
 * only sound when it knows both currencies. TQQQ is a US-listed ETF, so USD —
 * which differs from the CAD paper account, and `assertSingleCurrency` is what
 * makes that difference loud instead of silently mis-scaling the cap.
 */
export const DIP_LADDER_CURRENCY = 'USD';

/**
 * The fixed-dollar ladder geometry — an operator decision, recorded here
 * rather than left to a deployment variable, for the same reason
 * `DIP_LADDER_SYMBOL` is a constant.
 *
 * The target is a **currency** figure per completed cycle rather than a
 * percentage return: `LADDER_SPACING_DOLLARS * LADDER_FIXED_QUANTITY` = 50 USD,
 * at any price level. Percentage spacing cannot express that, because 1% of $72
 * and 1% of $100 are different amounts of money.
 *
 * `takeProfitDollars` is set equal to the spacing deliberately: a lot's target
 * then lands exactly on the rung above it, so a rung freed by an exit is the
 * level the next entry re-arms at.
 *
 * **The backtest evidence against this geometry is on record and was
 * overridden.** Over the committed drawdown scenarios, $1 rungs fill the whole
 * ladder within $5 of price and leave nothing to cycle: the 2020 crash-and-
 * recovery scenario completes 4 cycles for +$1,477 under 5% spacing and **zero**
 * under this one, sitting fully extended 94.9% of the time against 73.2%. The
 * ladder earns by cycling upper rungs while lower ones hold, and a ladder that
 * is always fully extended has nothing to cycle. This is accepted deliberately
 * for a **paper** account, where the purpose is observing live mechanics rather
 * than return. Revisit before `LIVE` — Story 15 already requires the capital
 * figures be re-derived from backtest evidence, and this geometry belongs in
 * that review.
 */
export const LADDER_SPACING_DOLLARS = 1;

/** Whole shares per rung. See `LADDER_SPACING_DOLLARS` for the reasoning. */
export const LADDER_FIXED_QUANTITY = 50;

/**
 * The gap-down size past which the anchor re-bases onto the market — 1% of the
 * reference it is measured against (previous close while flat, the lowest held
 * lot while holding — see `resolveAnchor`).
 *
 * Without this the anchor stays at the previous close on a gap-down open, which
 * under RESTING placement means the first rung sits *above* the market;
 * `isRestable` then refuses to place it and the ladder trades nothing for as
 * long as the gap holds. That was tolerable at 5% spacing, where a rung was
 * ~$3.60 wide against a $72 price and most gaps landed inside one rung. It is
 * not tolerable at `LADDER_SPACING_DOLLARS` of $1: a routine 2% TQQQ gap is
 * ~$1.44 — more than a full rung — so the whole ladder is stranded above the
 * market on exactly the down days it exists to work.
 *
 * **The same threshold also governs a *held* ladder, not just a flat one.**
 * At the tighter `spacingDollars` an operator can dial in through the
 * parameter editor (see the `restore` note on `ParameterService`), a ladder
 * that grinds down gradually — several sessions of re-armed/pending rungs
 * accumulating above a market that has since moved on, never a single
 * gapped-down open — can strand the same way: the anchor's one computed next
 * level already exists in the ledger and sits above the market, and
 * `evaluateBar` deliberately refuses to invent a fresh one in its place
 * (chasing a single move). Past this threshold that is judged a genuine gap
 * rather than one print, and the anchor follows the market down instead.
 *
 * **1% is chosen to sit just above the spacing, not tuned.** A $1 rung is ~1.4%
 * at a $72 price, so the threshold fires roughly when a gap has consumed a
 * rung's worth of distance — the point at which the stale anchor actually costs
 * a placement rather than merely shifting one. Below it the max rule stands and
 * the ladder still waits rather than chasing.
 *
 * This changes *where the levels sit*, never how they are ordered: entries stay
 * resting limit orders below the market, and nothing here emits a market order.
 * Like the geometry above it, this is an operator decision to revisit with
 * backtest evidence before `LIVE`.
 */
export const LADDER_GAP_REBASE_PERCENT = 0.01;

/**
 * Rung spacing as a multiple of ATR-14 — an *available* alternative to the
 * flat `LADDER_SPACING_DOLLARS`, not the compiled default.
 *
 * `LADDER_SPACING_DOLLARS` of $1 is a *static* distance: the same on a quiet
 * day and a 5%-range day. The backtest note on that constant already records
 * the cost — the ladder fills all `maxConcurrentRungs` within $5 of price and
 * sits fully extended 94.9% of the time in the 2020 crash scenario, with
 * nothing left to cycle. ATR spacing (`spacing.ts`, implemented since Story 3
 * but never selected by default here) makes the distance track recent daily
 * true range instead: narrower on calm days, so more rungs are within reach
 * and more cycles complete; wider on volatile days, so the ladder does not
 * exhaust itself on the first real move — the same failure mode the
 * fixed-dollar note documents.
 *
 * **Not selected by default deliberately.** An earlier revision of this file
 * did select `SpacingMode.ATR` here, on the theory that the fixed-dollar
 * geometry's rigidity was the whole problem. It was reverted: the operator
 * had already expressed a concrete, tighter `FIXED_DOLLAR` geometry through
 * the runtime parameter editor (`spacingDollars`/`takeProfitDollars` → 0.5),
 * and defaulting `spacingMode` to `ATR` here silently made that tuning inert
 * — `spacingMode` itself was never part of the edit, so
 * `ParameterService.restore` had nothing to restore it from, and it fell
 * through to whatever this factory compiled to. `atrMultiple`/`atrPeriod`
 * stay populated below anyway, so switching `spacingMode` to `ATR` through
 * the dashboard — now durable across a restart — works immediately without a
 * second edit.
 *
 * **`atrMultiple` is chosen, not derived.** A multiple of 1 spaces each rung a
 * full day's average true range apart — close to how wide the ladder already
 * sits at the top of a normal-volatility day under the old $1 rule, but
 * shrinking automatically in quieter regimes rather than staying fixed. Like
 * `LADDER_SPACING_DOLLARS` before it, this is an operator choice sized to be
 * safe, not backtested — `fixed-dollar-comparison.spec.ts` compares
 * percentage vs. fixed-dollar spacing but not ATR, so there is no committed
 * evidence for this multiple yet. Revisit alongside the other geometry
 * decisions before `LIVE`.
 *
 * **`takeProfitDollars` stays fixed at `LADDER_SPACING_DOLLARS`, decoupled
 * from this.** The fixed-dollar note above explains why the two were set
 * equal — so a lot's target lands exactly on the rung above it. ATR distance
 * moves session to session while a lot's target is frozen at fill
 * (`PRD.md:386`), so exact alignment is no longer achievable by construction;
 * decoupling accepts a lot's exit occasionally landing short of or past the
 * rung above it, in exchange for entries that adapt to the market they are
 * actually being placed into.
 *
 * **Warm-up**: a symbol with fewer than `atrPeriod + 1` sessions of history —
 * every symbol immediately after this change ships, and any symbol for
 * `atrPeriod` sessions after a restart that lost `dailyBars` — has no ATR yet,
 * and `resolveSpacing` falls back to `spacingPercent` (5%, ~$3.60 on a $72
 * TQQQ) rather than to `LADDER_SPACING_DOLLARS`. That is wider than the old
 * $1 rule, not narrower — the ladder will look *less* active than before for
 * the first ~14 live sessions after this deploys, then tighten or widen with
 * realized volatility once it has history to draw on.
 */
export const LADDER_ATR_MULTIPLE = 1;

/** Lookback for the ATR calculation, in daily bars. See `LADDER_ATR_MULTIPLE`. */
export const LADDER_ATR_PERIOD = 14;

/**
 * The capital the ladder sizes rungs from.
 *
 * Reads the real Story 13 allocation for every mode. There is no longer a
 * per-mode branch: the SHADOW display notional it used to return existed only
 * so a mode that submitted nothing still produced non-zero quantities to look
 * at, and SHADOW is retired (`execution-mode.ts`).
 *
 * `null` for a symbol absent from `PAPER_SYMBOL_CAPITAL`, so a missing
 * allocation sizes every rung to zero shares (`ladder.ts:47`) **and** trips the
 * startup assertion, rather than silently borrowing another symbol's figure.
 */
export function ladderCapital(_mode: ExecutionMode, symbol: string): number | null {
  return PAPER_SYMBOL_CAPITAL[symbol] ?? null;
}

@Module({
  imports: [AppConfigModule],
  providers: [
    CoordinatorService,
    {
      provide: DIP_LADDER_CONFIG,
      useFactory: (appConfig: AppConfigService): DipLadderConfig =>
        buildDipLadderConfig(DIP_LADDER_SYMBOL, {
          symbolCapital: ladderCapital(appConfig.executionMode, DIP_LADDER_SYMBOL),
          // **The live engine rests its entries at the broker.**
          //
          // The bar-close rule only creates an order once a 5-minute bar has
          // *closed* at or below the rung, so a dip that touches the level
          // intra-bar and recovers fires nothing at all. A resting limit order
          // is filled by the exchange on the way through, which is what a
          // predetermined-level ladder is supposed to do.
          //
          // `DEFAULT_DIP_LADDER_CONFIG` stays `IMMEDIATE` so the committed
          // fixtures keep testing the rule their expected intents were computed
          // under; this is the one place the live behaviour is selected.
          orderPlacement: OrderPlacement.RESTING,
          // **Fixed-dollar geometry, targeting $50 per completed cycle.**
          //
          // Opt-in here rather than in `DEFAULT_DIP_LADDER_CONFIG` so every
          // committed fixture keeps testing the percentage rule its expected
          // intents were computed under — the same reason `orderPlacement`
          // is selected here and not defaulted.
          //
          // **`FIXED_DOLLAR` stays the compiled default, not `ATR`.** ATR
          // spacing (`LADDER_ATR_MULTIPLE`) is fully wired and available —
          // `spacingMode` is runtime-editable, and `ParameterService.restore`
          // now makes that edit durable across a restart — but it is not
          // selected *here* by default. The operator's own runtime tuning
          // (`spacingDollars`/`takeProfitDollars` → 0.5 via the parameter
          // editor) already expresses the intended geometry for `FIXED_DOLLAR`
          // mode; defaulting the compiled `spacingMode` to `ATR` made that
          // tuning inert without changing `spacingMode` itself, since nothing
          // had asked for `spacingMode` to change. `atrMultiple`/`atrPeriod`
          // stay populated below so switching `spacingMode` to `ATR` — via the
          // dashboard, durably — works immediately without a second edit.
          spacingMode: SpacingMode.FIXED_DOLLAR,
          spacingDollars: LADDER_SPACING_DOLLARS,
          atrMultiple: LADDER_ATR_MULTIPLE,
          atrPeriod: LADDER_ATR_PERIOD,
          takeProfitDollars: LADDER_SPACING_DOLLARS,
          fixedQuantity: LADDER_FIXED_QUANTITY,
          // **Re-base the anchor on a gap down.** Opt-in here rather than in
          // `DEFAULT_DIP_LADDER_CONFIG` for the same reason as everything
          // above: `scenarios.spec.ts` pins the gap-down fixture's first rung
          // at 95.00 under the plain max rule, and defaulting this on would
          // silently invalidate that expectation.
          gapRebasePercent: LADDER_GAP_REBASE_PERCENT,
        }),
      inject: [AppConfigService],
    },
    {
      // Null until a paid feed is acquired (`PRD.md:199`). Provided by token so
      // acquiring one is a binding change, not a call-site change.
      provide: SENTIMENT_PROVIDER,
      useClass: NullSentimentProvider,
    },
  ],
  exports: [CoordinatorService, DIP_LADDER_CONFIG, SENTIMENT_PROVIDER],
})
export class StrategiesModule {}
