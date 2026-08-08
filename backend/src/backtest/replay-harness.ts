/**
 * Replay harness — stage 1 of the backtester (`PRD.md:405`).
 *
 * Streams cached bars through **the real strategy and risk layer** and reports
 * what would have happened. The word "real" is the entire design constraint:
 * this file constructs `DipLadderStrategy`, `CoordinatorService`,
 * `RiskManagerService`, and `EngineService` — the same classes the daemon runs
 * — and drives them with `EngineService.processBar`, the same method the live
 * IB feed calls. There is no backtest-specific strategy and no backtest branch
 * inside the engine.
 *
 * ## Why it builds its own instances instead of reusing the daemon's
 *
 * Two reasons, and both are correctness rather than convenience:
 *
 * 1. **A backtest must not touch live state.** The running engine's
 *    repositories hold the ladder an operator is actually watching, and Story 9
 *    restores from them on boot. A backtest writing thousands of historical
 *    lots into those tables would corrupt the record reconciliation depends on.
 *    So the harness wires **fresh in-memory repositories** per run and discards
 *    them afterwards.
 * 2. **A backtest must not be able to submit.** Its broker is a
 *    `SimulatedBrokerAdapter` with no socket, constructed here and never bound
 *    to the `BROKER_ADAPTER` token, so there is no path from a backtest to IB
 *    even in principle.
 *
 * ## Why the harness runs in PAPER
 *
 * `RiskManagerService.canSubmit()` is false in `SHADOW` **by definition**, so a
 * backtest in SHADOW would generate intents, submit none, fill none, and exit
 * none — producing an empty ladder and statistics about nothing. The harness
 * therefore constructs its risk manager in `PAPER`, which is safe precisely
 * because the mode is a *constructor argument to a locally-built instance*
 * rather than a change to `EXECUTION_MODE`. The daemon's mode is untouched, and
 * `AppConfigService` is never consulted.
 *
 * This is also why the harness carries its own `symbolCapital` (see
 * `BacktestRequest.symbolCapital`) rather than reading the global config: the
 * real per-symbol allocation is deliberately unset until Story 13
 * (`PRD.md:503`), and these backtests are the evidence meant to inform it.
 * Reading a value the system refuses to have would invert that dependency;
 * writing one would pre-empt the decision.
 *
 * ## Bar ordering and the simulated market
 *
 * `setCurrentBar` is called before `processBar` so an order submitted on a bar
 * is priced against that bar's range, and so orders resting from earlier bars
 * are retried first. Bars are processed strictly sequentially — each decision
 * depends on the state the previous bar left, and racing them would make the
 * ladder nondeterministic.
 */

import { Logger } from '@nestjs/common';
import { SimulatedBrokerAdapter } from '../broker/simulated/simulated-broker.adapter';
import { ExecutionMode } from '../config/execution-mode';
import { Bar, BarSize } from '../market-data/types';
import { ReplayService } from '../market-data/mock/replay.service';
import {
  InMemoryFillRepository,
  InMemoryLotRepository,
  InMemoryOrderIntentRepository,
  InMemoryOrderRepository,
  InMemoryRiskEventRepository,
  InMemoryRungRepository,
} from '../repositories/in-memory/in-memory.repositories';
import { EngineService } from '../engine/engine.service';
import { KillSwitchService } from '../risk/kill-switch.service';
import { RiskManagerService } from '../risk/risk-manager.service';
import { buildRiskConfig } from '../risk/risk.config';
import { CoordinatorService } from '../strategies/coordinator.service';
import { buildDipLadderConfig, DipLadderConfig } from '../strategies/dip-ladder/config';
import { DipLadderStrategy } from '../strategies/dip-ladder/dip-ladder.strategy';
import { Lot } from '../strategies/dip-ladder/lot';
import { Rung } from '../strategies/dip-ladder/rung';
import { Fill } from '../broker/broker-adapter.interface';
import { DEFAULT_FILL_MODEL_CONFIG, FillModelConfig } from './fill-model';

/**
 * A backtest's inputs.
 *
 * Ladder parameters are `Partial` so a sweep varies one dimension at a time
 * while everything else stays at the shipped default — which is what makes a
 * sweep's results attributable to the parameter that changed.
 */
export interface BacktestRequest {
  symbol: string;
  barSize: BarSize;
  bars: Bar[];
  /**
   * Capital allocated to the symbol for **this run only**.
   *
   * Explicit per-run rather than read from `DipLadderConfig`, whose
   * `symbolCapital` is `null` until Story 13. A backtest needs a figure to size
   * rungs against; taking one from config would either read a null (sizing
   * every rung at zero shares, so the run proves nothing) or require setting
   * the value this story is expressly not allowed to set (`stories.md:651`).
   */
  symbolCapital: number;
  /** Starting account equity the global 60% cap is measured against. */
  accountEquity: number;
  ladder?: Partial<Omit<DipLadderConfig, 'symbol' | 'symbolCapital'>>;
  fillModel?: Partial<FillModelConfig>;
}

/** A completed lot cycle: bought, then sold at its own target. */
export interface ClosedTrade {
  lotId: string;
  rungPrice: number;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  entryAt: string;
  exitAt: string;
  /** Net of commission on both legs. */
  realizedPnl: number;
  commission: number;
  /** Milliseconds held — the raw input to average holding period. */
  holdingPeriodMs: number;
}

/**
 * A point on the equity curve, recorded once per bar.
 *
 * Carries `unrealized` separately from `realized` because the ladder's defining
 * characteristic is sitting in unrealized drawdown by design; a curve that
 * netted them would hide exactly the behaviour the 2022 scenario exists to
 * examine.
 */
export interface EquityPoint {
  timestamp: string;
  close: number;
  /** Cumulative realized P&L, commissions deducted. */
  realized: number;
  /** Mark-to-market on lots still held. */
  unrealized: number;
  /** `accountEquity + realized + unrealized` — what drawdown is measured on. */
  equity: number;
  /** Shares held at this bar. */
  positionQuantity: number;
  /** Held lots at this bar — drives time-in-position and rung distribution. */
  heldLots: number;
}

export interface BacktestRunResult {
  symbol: string;
  barSize: BarSize;
  rangeStart: string;
  rangeEnd: string;
  barsProcessed: number;
  /** True when any input bar was synthetic (`stories.md:619`). */
  synthetic: boolean;
  intentsGenerated: number;
  ordersSubmitted: number;
  fills: Fill[];
  closedTrades: ClosedTrade[];
  /** Lots still held when the run ended — an unclosed ladder is a real outcome. */
  openLots: Lot[];
  rungs: Rung[];
  equityCurve: EquityPoint[];
  commissionPaid: number;
  /** Data-quality signal — see `coverage` below. */
  coverage: BarCoverage;
}

/**
 * Bar coverage over the run's range.
 *
 * Reported alongside results because **a backtest over a range with a hole in
 * it reads that hole as a flat market**. A 2022 run that quietly skipped
 * October would understate the drawdown and report a max-drawdown figure that
 * looks better than reality — the single most dangerous way for this backtester
 * to be wrong. Surfacing the largest gap makes a suspiciously clean result
 * visible rather than plausible.
 */
export interface BarCoverage {
  barCount: number;
  /** The largest gap between consecutive bars, in milliseconds. */
  largestGapMs: number;
  /** ISO timestamp of the bar preceding the largest gap, or null. */
  largestGapAt: string | null;
}

const logger = new Logger('ReplayHarness');

/**
 * Runs one backtest.
 *
 * Everything it touches is constructed here and thrown away on return, so two
 * runs in a sweep cannot contaminate each other — a requirement for comparing
 * parameter sets, since a leaked lot would attribute one run's position to
 * another's parameters.
 */
export async function runBacktest(request: BacktestRequest): Promise<BacktestRunResult> {
  const bars = [...request.bars].sort((a, b) => compare(a.timestamp, b.timestamp));

  if (bars.length === 0) {
    throw new Error('backtest requires at least one bar');
  }

  const ladderConfig = buildDipLadderConfig(request.symbol, {
    ...request.ladder,
    symbolCapital: request.symbolCapital,
  });

  const broker = new SimulatedBrokerAdapter({
    equity: request.accountEquity,
    fillModel: { ...DEFAULT_FILL_MODEL_CONFIG, ...request.fillModel },
  });
  await broker.connect();

  const coordinator = new CoordinatorService();
  const ladder = new DipLadderStrategy(ladderConfig);
  coordinator.register({ strategy: ladder, enabled: true, symbols: [request.symbol] });

  const riskEvents = new InMemoryRiskEventRepository();

  // PAPER, not SHADOW — see the file header. A locally-constructed risk manager
  // in PAPER against a socket-less simulated broker; `EXECUTION_MODE` is never
  // read and never changed.
  const riskManager = new RiskManagerService(
    buildRiskConfig({
      accountEquity: request.accountEquity,
      perSymbolLimits: { [request.symbol]: request.symbolCapital },
    }),
    ExecutionMode.PAPER,
    new KillSwitchService(riskEvents),
    riskEvents,
  );

  const intents = new InMemoryOrderIntentRepository();
  const orders = new InMemoryOrderRepository();
  const fills = new InMemoryFillRepository();
  const lots = new InMemoryLotRepository();
  const rungs = new InMemoryRungRepository();

  const engine = new EngineService(
    // The harness drives bars itself, so the fixture replay service is never
    // used. Supplied because the constructor requires it; `replayFixture` is
    // never called on this instance.
    new ReplayService(),
    coordinator,
    riskManager,
    broker,
    intents,
    orders,
    fills,
    lots,
    rungs,
    ExecutionMode.PAPER,
  );

  await coordinator.initializeAll(bars[0].timestamp);

  const equityCurve: EquityPoint[] = [];
  let intentsGenerated = 0;
  let ordersSubmitted = 0;

  for (const bar of bars) {
    // Before `processBar`: an order submitted on this bar must be priced
    // against this bar's range, and orders resting from earlier bars fill the
    // moment the market reaches them rather than after the next decision.
    broker.setCurrentBar(bar);

    const outcome = await engine.processBar(bar);
    intentsGenerated += outcome.intentsGenerated;
    ordersSubmitted += outcome.submitted;

    equityCurve.push(equityPoint(bar, ladder, coordinator, broker, request.accountEquity));
  }

  const finalLots = ladderLots(coordinator, ladder.id);

  return {
    symbol: request.symbol,
    barSize: request.barSize,
    rangeStart: bars[0].timestamp,
    rangeEnd: bars[bars.length - 1].timestamp,
    barsProcessed: bars.length,
    synthetic: bars.some((bar) => bar.synthetic === true),
    intentsGenerated,
    ordersSubmitted,
    fills: broker.executedFills(),
    closedTrades: closedTradesFrom(finalLots, broker.executedFills()),
    openLots: finalLots.filter((lot) => lot.status === 'HELD'),
    rungs: ladderRungs(coordinator, ladder.id),
    equityCurve,
    commissionPaid: broker.commissionPaid(),
    coverage: barCoverage(bars),
  };
}

/**
 * Reconstructs completed cycles by pairing each closed lot with its fills.
 *
 * Derived from lot records rather than from the fill stream alone, because the
 * broker's fills carry no lot identity — three lots and one block of the same
 * share count are indistinguishable to a broker, which is the same asymmetry
 * Story 9's reconciliation exists for. The lot is the only record of which
 * shares belonged to which entry, and therefore the only basis for a per-cycle
 * realized P&L.
 */
export function closedTradesFrom(lots: Lot[], fills: Fill[]): ClosedTrade[] {
  const closed = lots.filter((lot) => lot.status === 'CLOSED' && lot.exitPrice !== null);

  // Commission is charged per fill, and a lot's cycle consumed two of them.
  // Averaging across all fills is exact when every fill is one lot's leg, which
  // holds here: the ladder sizes one order per rung fire and one per exit.
  const averageCommission =
    fills.length === 0 ? 0 : fills.reduce((sum, fill) => sum + fill.commission, 0) / fills.length;

  return closed.map((lot) => {
    const commission = roundToCents(averageCommission * 2);
    const gross = (lot.exitPrice! - lot.fillPrice) * lot.quantity;

    return {
      lotId: lot.id,
      rungPrice: lot.rungPrice,
      quantity: lot.quantity,
      entryPrice: lot.fillPrice,
      exitPrice: lot.exitPrice!,
      entryAt: lot.openedAt,
      exitAt: lot.closedAt ?? lot.openedAt,
      realizedPnl: roundToCents(gross - commission),
      commission,
      holdingPeriodMs: Math.max(
        0,
        Date.parse(lot.closedAt ?? lot.openedAt) - Date.parse(lot.openedAt),
      ),
    };
  });
}

function equityPoint(
  bar: Bar,
  ladder: DipLadderStrategy,
  coordinator: CoordinatorService,
  broker: SimulatedBrokerAdapter,
  startingEquity: number,
): EquityPoint {
  const lots = ladderLots(coordinator, ladder.id);
  const held = lots.filter((lot) => lot.status === 'HELD');

  const unrealized = held.reduce((sum, lot) => sum + (bar.close - lot.fillPrice) * lot.quantity, 0);
  // The simulator's realized cash is net of every purchase, so held inventory
  // reads as spent cash. Adding it back at cost leaves realized P&L on closed
  // cycles only, which is what the statistics expect.
  const heldAtCost = held.reduce((sum, lot) => sum + lot.fillPrice * lot.quantity, 0);
  const realized = broker.realizedCash() + heldAtCost;

  return {
    timestamp: bar.timestamp,
    close: bar.close,
    realized: roundToCents(realized),
    unrealized: roundToCents(unrealized),
    equity: roundToCents(startingEquity + realized + unrealized),
    positionQuantity: held.reduce((sum, lot) => sum + lot.quantity, 0),
    heldLots: held.length,
  };
}

function ladderLots(coordinator: CoordinatorService, strategyId: string): Lot[] {
  const state = coordinator.getState(strategyId);

  return state ? (DipLadderStrategy.lotsOf(state) ?? []) : [];
}

function ladderRungs(coordinator: CoordinatorService, strategyId: string): Rung[] {
  const state = coordinator.getState(strategyId);

  return state ? (DipLadderStrategy.rungsOf(state) ?? []) : [];
}

/** Largest interior gap, so a hole in the history is visible in the result. */
export function barCoverage(bars: Bar[]): BarCoverage {
  let largestGapMs = 0;
  let largestGapAt: string | null = null;

  for (let i = 1; i < bars.length; i += 1) {
    const gap = Date.parse(bars[i].timestamp) - Date.parse(bars[i - 1].timestamp);

    if (gap > largestGapMs) {
      largestGapMs = gap;
      largestGapAt = bars[i - 1].timestamp;
    }
  }

  return { barCount: bars.length, largestGapMs, largestGapAt };
}

function compare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

export { logger as replayHarnessLogger };
