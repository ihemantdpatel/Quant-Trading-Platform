/**
 * The engine's read and control API (`stories.md:387`).
 *
 * Read endpoints project state the engine already holds; they compute nothing
 * the engine does not, so the dashboard and a `curl` see exactly the same
 * numbers the strategy decided on.
 *
 * Control endpoints are deliberately few and deliberately explicit. Every one
 * of them is an operator action with a recorded reason — there is no endpoint
 * that liquidates, and no endpoint that can set a capital or loss-threshold
 * value (those are Story 13, and `POST /mode` refuses PAPER while they are
 * unset rather than inventing them).
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import { BROKER_ADAPTER, BrokerAdapter } from '../broker/broker-adapter.interface';
import { IBBrokerAdapter } from '../broker/ib/ib-broker.adapter';
import { AppConfigService } from '../config/app-config.service';
import { ExecutionMode } from '../config/execution-mode';
import { EngineService } from '../engine/engine.service';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { SymbolHaltService } from '../reconciliation/symbol-halt.service';
import { KillSwitchService } from '../risk/kill-switch.service';
import { RISK_CONFIG, SYMBOL_CAPITAL } from '../risk/risk.module';
import { RiskConfig } from '../risk/risk.config';
import { evaluateStartupAssertions, SymbolCapital } from '../risk/startup-assertions';
import { CoordinatorService } from '../strategies/coordinator.service';
import { RungStatus } from '../strategies/dip-ladder/rung';
import { LotStatus } from '../strategies/dip-ladder/lot';
import {
  FILL_REPOSITORY,
  FillRepository,
  ORDER_INTENT_REPOSITORY,
  ORDER_REPOSITORY,
  OrderIntentRepository,
  OrderRepository,
  RISK_EVENT_REPOSITORY,
  RiskEventRepository,
} from '../repositories/repository.interfaces';
import { STORAGE_MODE, StorageMode } from '../repositories/repositories.module';
import { isFixtureName } from '../market-data/mock/fixtures';

/** A lot as the dashboard renders it, including derived display fields. */
interface LotView {
  id: string;
  symbol: string;
  rungPrice: number;
  fillPrice: number;
  quantity: number;
  openedAt: string;
  exitTarget: number;
  status: LotStatus;
  closedAt: string | null;
  exitPrice: number | null;
  /** Realized P&L for a closed lot, null while held. */
  realized: number | null;
}

@Controller()
export class EngineController {
  constructor(
    private readonly engine: EngineService,
    private readonly coordinator: CoordinatorService,
    private readonly killSwitch: KillSwitchService,
    private readonly reconciliation: ReconciliationService,
    private readonly symbolHalts: SymbolHaltService,
    private readonly appConfig: AppConfigService,
    @Inject(BROKER_ADAPTER) private readonly broker: BrokerAdapter,
    @Inject(ORDER_INTENT_REPOSITORY) private readonly intents: OrderIntentRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(FILL_REPOSITORY) private readonly fills: FillRepository,
    @Inject(RISK_EVENT_REPOSITORY) private readonly riskEvents: RiskEventRepository,
    @Inject(STORAGE_MODE) private readonly storageMode: StorageMode,
    @Inject(RISK_CONFIG) private readonly riskConfig: RiskConfig,
    @Inject(SYMBOL_CAPITAL) private readonly symbolCapital: SymbolCapital,
  ) {}

  /**
   * Runs a fixture through the full engine path.
   *
   * Explicit rather than automatic on boot: nothing should happen in a system
   * whose default posture is "submit nothing" until an operator asks for it,
   * and an explicit trigger is re-runnable and testable.
   */
  @Post('engine/replay')
  @HttpCode(HttpStatus.OK)
  async replay(@Body() body: { fixture?: string }): Promise<unknown> {
    const fixture = body?.fixture;

    if (!fixture || !isFixtureName(fixture)) {
      throw new UnprocessableEntityException(
        `unknown fixture "${fixture ?? ''}" — see market-data/mock/fixtures`,
      );
    }

    return this.engine.replayFixture(fixture);
  }

  @Post('engine/reset')
  @HttpCode(HttpStatus.OK)
  async reset(): Promise<{ reset: true }> {
    await this.engine.reset();
    return { reset: true };
  }

  @Get('intents')
  async getIntents(): Promise<unknown[]> {
    return this.intents.findAll();
  }

  @Get('orders')
  async getOrders(): Promise<unknown[]> {
    return this.orders.findAll();
  }

  @Get('fills')
  async getFills(): Promise<unknown[]> {
    return this.fills.findAll();
  }

  /**
   * Lots with their **individual** targets — the per-lot view the whole design
   * exists to make possible. Blended average cost is deliberately *not* here;
   * it is display-only and belongs on a view that can label it "reference only"
   * (`PRD.md:386`).
   */
  @Get('lots')
  getLots(): LotView[] {
    return this.engine.ladderLots().map((lot) => ({
      id: lot.id,
      symbol: lot.id.split('-lot-')[0],
      rungPrice: lot.rungPrice,
      fillPrice: lot.fillPrice,
      quantity: lot.quantity,
      openedAt: lot.openedAt,
      exitTarget: lot.exitTarget,
      status: lot.status,
      closedAt: lot.closedAt,
      exitPrice: lot.exitPrice,
      realized:
        lot.status === LotStatus.CLOSED && lot.exitPrice !== null
          ? Math.round((lot.exitPrice - lot.fillPrice) * lot.quantity * 100) / 100
          : null,
    }));
  }

  /** Rungs distinguishing held / working / re-armed / pending with their prices. */
  @Get('rungs')
  getRungs(): unknown[] {
    return this.engine.ladderRungs().map((rung) => ({
      price: rung.price,
      status: rung.status,
      lotId: rung.lotId,
      // The handle for the order resting at this level. Exposed so the dashboard
      // can join a working rung to its row in `GET /orders` — without it the two
      // views show the same order twice with nothing tying them together.
      workingOrderId: rung.workingOrderId,
      completedCycles: rung.completedCycles,
      lastExitAt: rung.lastExitAt,
      held: rung.status === RungStatus.HELD,
      // Mirrors `selectFireableRung`: a rung with an order resting at the broker
      // holds no lot but must not fire again. Deriving this from `status !== HELD`
      // alone would report a WORKING rung as fireable and tell an operator the
      // ladder is armed at a level where an order is already committed.
      fireable: rung.lotId === null && !rung.workingOrderId,
    }));
  }

  @Get('positions')
  async getPositions(): Promise<unknown[]> {
    // Broker-reported: net quantity and average cost, nothing more. Lot
    // composition comes from `GET /lots` — the two are reconciled at Story 9.
    return this.broker.getPositions();
  }

  @Get('risk-events')
  async getRiskEvents(): Promise<unknown[]> {
    return this.riskEvents.findAll();
  }

  @Get('strategies')
  getStrategies(): unknown[] {
    return this.coordinator.snapshots().map((snapshot) => ({
      id: snapshot.id,
      enabled: snapshot.enabled,
      symbols: snapshot.symbols,
      initialized: snapshot.initialized,
    }));
  }

  /** Mode, connection health, and every active halt in one place. */
  @Get('status')
  getStatus(): unknown {
    const health = this.broker.connectionHealth();

    return {
      mode: this.appConfig.executionMode,
      // Whether this process is writing to MySQL or to memory (Story 8).
      // Reported rather than inferred from deployment config: "will my ladder
      // state survive a restart" is not a question an operator should have to
      // answer by reading a compose file.
      storage: this.storageMode,
      broker: {
        name: this.broker.name,
        connected: this.broker.isConnected(),
        state: health.state,
        reconnectAttempts: health.reconnectAttempts,
        lastError: health.lastError,
        // Story 10 additions, present only when trading through IB. Pacing is
        // surfaced because breaching IB's limits produces no error of its own —
        // a queue that is filling up is the only early warning there is, and it
        // is invisible unless reported. Staleness is surfaced because a
        // connected socket that stopped delivering bars looks healthy in every
        // other field here (`PRD.md:314`).
        ...(this.broker instanceof IBBrokerAdapter
          ? {
              pacing: this.broker.pacingStats(),
              dataStale: this.broker.isDataStale(),
              lastBarAt: this.broker.lastBarAt(),
              // Why the feed is silent, next to the fact that it is. IB rejects
              // an unentitled data request and then delivers nothing, which
              // leaves every other field here reading healthy — so without this
              // the cause was visible only in the container log.
              dataErrors: this.broker.dataErrorList(),
            }
          : {}),
      },
      halts: {
        killSwitch: this.killSwitch.snapshot(),
        dailyLossBreaker: { halted: false },
        entryHalt: {
          halted: this.engine.isHalted(),
          reason: this.engine.haltReason(),
        },
        // Per-symbol reconciliation halts (`stories.md:543`). Separate from
        // `entryHalt` because they mean something stricter: a symbol here
        // trades in neither direction until an operator resolves it.
        symbols: this.symbolHalts.active(),
      },
      // What the startup reconciliation concluded. Null before it has run —
      // which an operator should be able to see, rather than reading absence
      // as success.
      reconciliation: this.reconciliation.lastReconciliation(),
      // The post-close job's last run. Null until it has fired — an operator
      // must be able to tell "scheduled but not yet due" from "ran and found
      // nothing", which absence alone cannot express.
      orderReconciliation: this.reconciliation.lastOrderReconcile(),
      alerts: this.engine.activeAlerts(),
      strategies: this.coordinator.snapshots().map((s) => ({ id: s.id, enabled: s.enabled })),
    };
  }

  /**
   * Engages or releases the kill switch.
   *
   * Effective within one evaluation cycle, because the risk manager reads it at
   * the top of every `evaluate()` (`PRD.md:492`). There is no queue to drain.
   */
  @Post('kill-switch')
  @HttpCode(HttpStatus.OK)
  killSwitchControl(@Body() body: { engaged?: boolean; reason?: string }): unknown {
    const reason = body?.reason ?? 'operator action via API';
    const at = new Date().toISOString();

    if (body?.engaged === false) {
      this.killSwitch.release(reason, at);
    } else {
      this.killSwitch.engage(reason, at);
    }

    return this.killSwitch.snapshot();
  }

  /** Every active reconciliation halt, for the dashboard's alert surface. */
  /**
   * Re-runs the full startup reconciliation on demand.
   *
   * **Why this exists as a manual control.** `reconcileOpenOrders` is already
   * the designated repair for a rung whose order no longer exists at the
   * broker — a DAY order that expired, or one cancelled by hand in TWS. Until
   * now the only way to reach it was to restart the daemon, because
   * `StartupSequence` was its sole caller. An operator who cancels an order in
   * TWS and then watches the dashboard keep showing the rung as `WORKING` has
   * no way to correct it short of a restart, which is a poor answer during a
   * live session.
   *
   * **This is the full sequence, not just the open-order half**, and the
   * difference matters before pressing it. It re-runs the lot-sum assertion and
   * therefore **can halt symbols**, and it restores lots and rungs from the
   * database over whatever is in memory. At startup that restore writes into an
   * empty ladder; here it can overwrite live state with the last persisted
   * copy. Since the live path persists per bar (`BarConsumer.persistState`) the
   * two are normally identical, but a symbol whose persistence is suppressed by
   * an existing halt is exactly where they are not — which is the case an
   * operator is most likely to be reaching for this control to fix.
   *
   * It deliberately does **not** connect the broker or re-initialize
   * strategies: those are boot concerns, and re-initializing would discard the
   * live ladder rather than reconcile it. An unreachable broker still halts
   * every symbol here, exactly as it does at startup, because `null` positions
   * mean "unknown" and unknown may not resume.
   *
   * No order is ever cancelled and no position is ever traded by this route —
   * `reconcileAll` has no path to either, which is what makes exposing it to a
   * button acceptable.
   */
  @Post('reconcile')
  @HttpCode(HttpStatus.OK)
  async reconcile(): Promise<unknown> {
    return this.reconciliation.reconcileAll(new Date().toISOString());
  }

  @Get('halts')
  getHalts(): unknown {
    return {
      symbols: this.symbolHalts.active(),
      reconciliation: this.reconciliation.lastReconciliation(),
    };
  }

  /**
   * Releases a reconciliation halt after **manual** resolution.
   *
   * There is deliberately no endpoint that resolves a mismatch by trading: an
   * operator reconciles the account by hand, then tells the system it is safe.
   * The reverse — letting the system flatten a position to make its own records
   * agree — is the guess `PRD.md:347` forbids, and no route to it exists.
   */
  @Post('halts/:symbol/release')
  @HttpCode(HttpStatus.OK)
  releaseHalt(@Param('symbol') symbol: string): unknown {
    if (!this.symbolHalts.release(symbol, new Date().toISOString())) {
      throw new NotFoundException(`no active halt for "${symbol}"`);
    }

    return { symbol, halted: false };
  }

  @Post('strategies/:id/enable')
  @HttpCode(HttpStatus.OK)
  async enableStrategy(@Param('id') id: string): Promise<unknown> {
    const enabled = await this.coordinator.enable(id, new Date().toISOString());

    if (!enabled) {
      throw new NotFoundException(`unknown strategy "${id}"`);
    }

    return { id, enabled: true };
  }

  @Post('strategies/:id/disable')
  @HttpCode(HttpStatus.OK)
  disableStrategy(@Param('id') id: string): unknown {
    if (!this.coordinator.disable(id)) {
      throw new NotFoundException(`unknown strategy "${id}"`);
    }

    return { id, enabled: false };
  }

  /**
   * Requests a mode change.
   *
   * **Refuses `PAPER`/`LIVE` while the two open PRD items are unset**
   * (`PRD.md:500`), reusing the same assertion the startup path runs — one
   * definition, so the HTTP path cannot drift from the boot path and permit
   * what boot would refuse.
   *
   * Returns the blocking reasons rather than a bare 422, because Story 7 shows
   * them in the UI and an operator needs to know *which* value is missing.
   */
  @Post('mode')
  @HttpCode(HttpStatus.OK)
  setMode(@Body() body: { mode?: string }): unknown {
    const requested = body?.mode;

    if (!requested || !Object.values(ExecutionMode).includes(requested as ExecutionMode)) {
      throw new UnprocessableEntityException(
        `mode must be one of ${Object.values(ExecutionMode).join(', ')}`,
      );
    }

    const mode = requested as ExecutionMode;
    const assertions = evaluateStartupAssertions(mode, this.riskConfig, this.symbolCapital);

    if (!assertions.permitted) {
      throw new UnprocessableEntityException({
        message: `refusing to switch to ${mode}`,
        mode,
        permitted: false,
        failures: assertions.failures,
      });
    }

    // Reaching here means the assertions passed. Actually *applying* the mode
    // requires a restart with the new EXECUTION_MODE: the risk manager reads it
    // at construction, and mutating it live would leave in-flight decisions
    // straddling two modes. Story 13 makes this reachable.
    return {
      mode,
      permitted: true,
      applied: false,
      detail:
        `${mode} passes every startup assertion. Restart with EXECUTION_MODE=${mode} to apply — ` +
        'the mode is fixed at construction so no decision can straddle two modes.',
    };
  }
}
