import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  BROKER_ADAPTER,
  BrokerAdapter,
  Fill,
  OrderStatus,
} from '../broker/broker-adapter.interface';
import { AppConfigService } from '../config/app-config.service';
import { ExecutionMode } from '../config/execution-mode';
import { OptionRight, SecurityType } from '../domain/contract';
import { contractKey, OptionScan, validStandardOption } from '../domain/options';
import { committedCapital } from '../risk/committed-capital';
import { RiskManagerService } from '../risk/risk-manager.service';
import { RISK_CONFIG } from '../risk/risk.module';
import { RiskConfig } from '../risk/risk.config';
import { CoordinatorService } from '../strategies/coordinator.service';
import { OrderIntent } from '../strategies/types';
import { WheelConfig, wheelConfigSchema } from '../strategies/wheel/config';
import { WheelStrategy, wheelSessionOpen } from '../strategies/wheel/wheel.strategy';
import {
  FILL_REPOSITORY,
  FillRepository,
  ORDER_INTENT_REPOSITORY,
  OrderIntentRepository,
  ORDER_REPOSITORY,
  OrderRepository,
  STRATEGY_STATE_SNAPSHOT_REPOSITORY,
  StrategyStateSnapshotRepository,
} from '../repositories/repository.interfaces';
import { EngineService } from './engine.service';
import { StartupSequence } from './startup.sequence';

const JOURNAL_ID = 'wheel-runtime';
const contractSchema = z.object({
  symbol: z.string(),
  secType: z.nativeEnum(SecurityType),
  currency: z.string(),
  exchange: z.string(),
  multiplier: z.number(),
  strike: z.number(),
  right: z.nativeEnum(OptionRight),
  expiry: z.string(),
});
const journalSchema = z.object({
  config: wheelConfigSchema.nullable(),
  enabled: z.boolean(),
  halt: z.string().nullable(),
  shares: z.number().int().nonnegative(),
  stockCost: z.number().finite().nonnegative(),
  orders: z.array(
    z.object({
      id: z.string(),
      contract: contractSchema,
      quantity: z.number().int().positive(),
      status: z.string(),
      settled: z.boolean(),
    }),
  ),
  audit: z.array(z.object({ at: z.string(), action: z.string(), reason: z.string() })),
});
type Journal = z.infer<typeof journalSchema>;

/** Scheduled execution owns I/O; WheelStrategy receives only immutable evidence. */
@Injectable()
export class WheelService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WheelService.name);
  private readonly strategy = new WheelStrategy();
  private journal: Journal = {
    config: null,
    enabled: false,
    halt: null,
    shares: 0,
    stockCost: 0,
    orders: [],
    audit: [],
  };
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private readonly unsubscribe: () => void;

  constructor(
    @Inject(BROKER_ADAPTER) private readonly broker: BrokerAdapter,
    private readonly app: AppConfigService,
    private readonly risk: RiskManagerService,
    @Inject(RISK_CONFIG) private readonly riskConfig: RiskConfig,
    private readonly engine: EngineService,
    private readonly startup: StartupSequence,
    private readonly coordinator: CoordinatorService,
    @Inject(STRATEGY_STATE_SNAPSHOT_REPOSITORY)
    private readonly snapshots: StrategyStateSnapshotRepository,
    @Inject(ORDER_INTENT_REPOSITORY) private readonly intents: OrderIntentRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(FILL_REPOSITORY) private readonly fills: FillRepository,
  ) {
    this.unsubscribe = broker.onFill((fill) => {
      if (!fill.clientOrderId.startsWith(`wheel-${app.accountAlias}-`)) return;
      void this.serial(async () => this.recordFill(fill)).catch((error) =>
        this.logger.error(String(error)),
      );
    });
  }

  async onModuleInit(): Promise<void> {
    await this.serial(async () => undefined);
    this.timer = setInterval(() => {
      if (this.ticking || !this.journal.enabled || !this.startup.hasReconciled()) return;
      this.ticking = true;
      void this.run()
        .catch((error) => this.logger.warn(String(error)))
        .finally(() => {
          this.ticking = false;
        });
    }, 60000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe();
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      if (!this.loaded) {
        const saved = await this.snapshots.findLatest(JOURNAL_ID);
        if (saved) {
          if (saved.version !== 1) throw new Error('unsupported wheel journal version');
          this.journal = journalSchema.parse(saved.data);
        }
        this.loaded = true;
        if (this.journal.config) this.engine.setWheelRiskEnabled();
      }
      return action();
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async persist(): Promise<void> {
    await this.snapshots.save({
      strategyId: JOURNAL_ID,
      version: 1,
      symbols: this.journal.config ? [this.journal.config.symbol] : [],
      data: JSON.parse(JSON.stringify(this.journal)),
      capturedAt: new Date().toISOString(),
    });
  }

  private audit(action: string, reason: string): void {
    this.journal.audit.push({ at: new Date().toISOString(), action, reason });
  }

  status(): Promise<Journal> {
    return this.serial(async () => JSON.parse(JSON.stringify(this.journal)));
  }

  configure(input: unknown): Promise<Journal> {
    return this.serial(async () => {
      this.assertPaper();
      const config = wheelConfigSchema.parse(input);
      if (
        this.journal.enabled ||
        this.journal.shares > 0 ||
        this.journal.orders.some((o) => !o.settled)
      ) {
        throw new Error('disable and settle the current wheel cycle before changing configuration');
      }
      this.assertExclusive(config.symbol);
      this.journal.config = config;
      this.engine.setWheelRiskEnabled();
      this.audit('CONFIGURE', JSON.stringify(config));
      await this.persist();
      return JSON.parse(JSON.stringify(this.journal));
    });
  }

  setEnabled(enabled: boolean): Promise<Journal> {
    return this.serial(async () => {
      if (enabled) {
        this.assertPaper();
        this.assertConfigured();
      }
      this.journal.enabled = enabled;
      this.audit(
        enabled ? 'ENABLE' : 'DISABLE',
        'operator request; working orders are left at the broker',
      );
      await this.persist();
      return JSON.parse(JSON.stringify(this.journal));
    });
  }

  /** Explicit operator attribution of broker lifecycle events; never synthesizes assignments on a timer. */
  reconcile(reference: string): Promise<Journal> {
    return this.serial(async () =>
      this.engine.runAccountSubmission(async () => {
        this.assertPaper();
        const config = this.assertConfigured();
        if (reference.trim().length < 8)
          throw new Error('provide a broker activity reference and reason (at least 8 characters)');
        const positions = await this.broker.getPositions();
        const open = await (this.broker.getAccountOpenOrders?.() ?? this.broker.getOpenOrders());
        if (
          open.some((o) => o.symbol === config.symbol) ||
          positions.some(
            (p) => p.symbol === config.symbol && p.contract?.secType !== SecurityType.STOCK,
          )
        ) {
          throw new Error(
            'reconciliation requires no open QQQ/wheel-symbol orders or option positions; wait for execution replay if a fill is missing',
          );
        }
        const stock = positions.filter((p) => p.symbol === config.symbol);
        if (
          stock.length > 1 ||
          stock.some(
            (p) =>
              p.contract?.currency !== 'USD' ||
              p.quantity < 0 ||
              !Number.isInteger(p.quantity) ||
              !Number.isFinite(p.averageCost) ||
              p.averageCost < 0,
          )
        ) {
          throw new Error('ambiguous stock position');
        }
        const shares = stock[0]?.quantity ?? 0;
        const stockCost = stock[0]?.averageCost ?? 0;
        if (shares * stockCost > config.allocation)
          throw new Error('assigned stock exceeds wheel allocation');
        // All option legs are proven absent. No order is cancelled or shares sold by this action.
        this.journal.shares = shares;
        this.journal.stockCost = stockCost;
        for (const order of this.journal.orders) order.settled = true;
        this.journal.halt = null;
        this.audit('RECONCILE', `${reference}; broker shares=${shares}; basis=${stockCost}`);
        await this.persist();
        return JSON.parse(JSON.stringify(this.journal));
      }),
    );
  }

  clearHalt(reference: string): Promise<Journal> {
    return this.serial(async () => {
      this.assertPaper();
      if (reference.trim().length < 8) throw new Error('provide a reason for clearing the halt');
      await this.evidence();
      this.journal.halt = null;
      this.audit('CLEAR_HALT', reference);
      await this.persist();
      return JSON.parse(JSON.stringify(this.journal));
    });
  }

  preview(): Promise<{ intents: OrderIntent[]; scan: OptionScan }> {
    return this.serial(async () => {
      this.assertPaper();
      const config = this.assertConfigured();
      const scan = await this.broker.scanOptions!({
        symbol: config.symbol,
        right: this.journal.shares >= 100 ? 'C' : 'P',
        minDte: config.minDte,
        maxDte: config.maxDte,
        strikeLimit: this.journal.shares >= 100 ? this.journal.stockCost : undefined,
      });
      const evidence = await this.evidence();
      return { intents: this.decide(scan, evidence.cash), scan };
    });
  }

  run(): Promise<{ submitted: string | null; reason: string }> {
    return this.serial(async () => {
      if (!this.journal.enabled) return { submitted: null, reason: 'wheel disabled' };
      if (!wheelSessionOpen(new Date().toISOString()))
        return { submitted: null, reason: 'outside wheel trading session' };
      try {
        this.assertPaper();
        const config = this.assertConfigured();
        if (!this.startup.hasReconciled() || this.engine.isHalted())
          throw new Error('engine is halted or startup has not reconciled');
        if (this.journal.halt) throw new Error(this.journal.halt);
        // Slow chain reads happen outside the account submission lock.
        const scan = await this.broker.scanOptions!({
          symbol: config.symbol,
          right: this.journal.shares >= 100 ? 'C' : 'P',
          minDte: config.minDte,
          maxDte: config.maxDte,
          strikeLimit: this.journal.shares >= 100 ? this.journal.stockCost : undefined,
        });
        if (scan.quotes.length === 0)
          return {
            submitted: null,
            reason: 'no complete live option quotes; market closed or data unavailable',
          };
        return await this.engine.runAccountSubmission(async () => {
          const evidence = await this.evidence();
          if (this.engine.isHalted() || !this.risk.canSubmit())
            throw new Error('submission halted');
          const intent = this.decide(scan, evidence.cash)[0];
          if (!intent)
            return { submitted: null, reason: 'no eligible contract or cycle already open' };
          const decision = this.risk.evaluate(
            {
              strategyId: 'wheel',
              symbol: config.symbol,
              side: 'SELL',
              quantity: intent.quantity,
              limitPrice: intent.limitPrice,
              contract: intent.contract,
              exposureEffect: 'OPEN',
              coverage: {
                cash: Math.min(config.allocation, evidence.cash),
                shares: this.journal.shares,
              },
              capitalPerUnit: intent.contract.right === 'P' ? intent.contract.strike! * 100 : 0,
              timestamp: intent.timestamp,
              reason: intent.reason,
            },
            { deployed: committedCapital(evidence.positions, evidence.open), pnl: evidence.funds },
          );
          const id = `wheel-${this.app.accountAlias}-${randomUUID()}`;
          await this.intents.save({
            id,
            intent,
            decision,
            submitted: false,
            clientOrderId: id,
            createdAt: intent.timestamp,
          });
          if (decision.approvedQuantity < 1) return { submitted: null, reason: decision.detail };
          const quantity = decision.approvedQuantity;
          this.journal.orders.push({
            id,
            contract: intent.contract as Journal['orders'][number]['contract'],
            quantity,
            status: 'PREPARED',
            settled: false,
          });
          await this.persist();
          await this.orders.save({
            clientOrderId: id,
            brokerOrderId: null,
            symbol: config.symbol,
            side: 'SELL',
            quantity,
            limitPrice: intent.limitPrice,
            status: OrderStatus.SUBMITTED,
            rejectReason: null,
            strategyId: 'wheel',
            createdAt: intent.timestamp,
          });
          if (!this.risk.canSubmit() || this.engine.isHalted())
            throw new Error('halt changed before submit; reconcile prepared order');
          const ack = await this.broker.submit({
            clientOrderId: id,
            contract: intent.contract,
            side: 'SELL',
            quantity,
            orderType: 'LMT',
            limitPrice: intent.limitPrice,
            timeInForce: 'DAY',
            timestamp: intent.timestamp,
          });
          this.journal.orders[this.journal.orders.length - 1].status = ack.status;
          if (ack.status === OrderStatus.REJECTED)
            this.journal.orders[this.journal.orders.length - 1].settled = true;
          await this.orders.save({
            clientOrderId: id,
            brokerOrderId: ack.brokerOrderId,
            symbol: config.symbol,
            side: 'SELL',
            quantity,
            limitPrice: intent.limitPrice,
            status: ack.status,
            rejectReason: ack.rejectReason ?? null,
            strategyId: 'wheel',
            createdAt: intent.timestamp,
          });
          await this.intents.markSubmitted(id, id);
          this.audit('SUBMIT', `${id} ${contractKey(intent.contract)} x${quantity}`);
          await this.persist();
          return { submitted: id, reason: ack.rejectReason ?? ack.status };
        });
      } catch (error) {
        this.journal.halt = error instanceof Error ? error.message : String(error);
        await this.persist();
        throw error;
      }
    });
  }

  private decide(scan: OptionScan, cash: number): OrderIntent[] {
    const config = this.assertConfigured();
    const now = new Date().toISOString();
    return this.strategy.evaluate(
      {
        strategyId: 'wheel',
        symbols: [config.symbol],
        now,
        parameters: {},
        history: [],
        wheel: {
          config,
          quotes: scan.quotes,
          underlyingPrice: scan.underlyingPrice,
          ownedShares: this.journal.shares,
          stockCost: this.journal.stockCost,
          cashAvailable: Math.min(config.allocation, cash),
          hasExposure: this.journal.orders.some((o) => !o.settled),
        },
      },
      { strategyId: 'wheel', version: 1, symbols: [config.symbol], data: {} },
    );
  }

  private async evidence() {
    const config = this.assertConfigured();
    if (!this.broker.isConnected()) throw new Error('broker unavailable');
    const open = await (this.broker.getAccountOpenOrders?.() ?? this.broker.getOpenOrders());
    const positions = await this.broker.getPositions();
    const funds = await this.broker.getWheelFunds!();
    if (
      positions.some(
        (p) =>
          p.contract?.currency !== 'USD' ||
          !Number.isFinite(p.quantity) ||
          !Number.isFinite(p.averageCost) ||
          (p.contract?.secType === SecurityType.OPTION && !validStandardOption(p.contract)),
      )
    )
      throw new Error('unsupported position currency or invalid broker position');
    if (![funds.cashUsd, funds.realized, funds.unrealized].every(Number.isFinite))
      throw new Error('invalid cash/P&L');
    const expected = new Map<string, number>();
    const completed = await this.broker.getCompletedOrders();
    for (const order of this.journal.orders.filter((o) => !o.settled)) {
      const fills = await this.fills.findByClientOrderId(order.id);
      const filled = fills.reduce((sum, f) => sum + f.quantity, 0);
      if (filled > order.quantity) throw new Error('wheel overfill');
      if (filled > 0)
        expected.set(
          contractKey(order.contract),
          (expected.get(contractKey(order.contract)) ?? 0) - filled,
        );
      const working = open.find((o) => o.clientOrderId === order.id);
      const terminal = completed.find((o) => o.clientOrderId === order.id);
      if (working) {
        if (
          !working.contract ||
          contractKey(working.contract) !== contractKey(order.contract) ||
          working.side !== 'SELL' ||
          working.quantity !== order.quantity ||
          working.filledQuantity !== filled
        ) {
          throw new Error(
            'working wheel order differs from durable journal; wait for fills then reconcile',
          );
        }
      } else if (
        terminal &&
        (terminal.status === OrderStatus.CANCELLED || terminal.status === OrderStatus.REJECTED)
      ) {
        if (terminal.filledQuantity !== filled)
          throw new Error('terminal order executions are incomplete; wait for replay');
        order.status = terminal.status;
        if (filled === 0) order.settled = true;
        await this.orders.updateStatus(order.id, terminal.status, terminal.reason ?? undefined);
      } else if (
        filled !== order.quantity &&
        order.status !== OrderStatus.REJECTED &&
        order.status !== OrderStatus.CANCELLED
      ) {
        throw new Error(
          'prepared or missing wheel order has unknown outcome; reconcile before retrying',
        );
      }
    }
    const actual = new Map<string, number>();
    let shares = 0;
    for (const p of positions.filter((p) => p.symbol === config.symbol)) {
      if (!p.contract) throw new Error('broker position has no contract identity');
      if (p.contract.secType === SecurityType.STOCK) shares += p.quantity;
      else
        actual.set(
          contractKey(p.contract),
          (actual.get(contractKey(p.contract)) ?? 0) + p.quantity,
        );
    }
    if (
      shares !== this.journal.shares ||
      JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())
    ) {
      throw new Error(
        'wheel positions changed: verify expiration/assignment in broker activity, then reconcile',
      );
    }
    if (
      open.some(
        (o) =>
          o.symbol === config.symbol && !this.journal.orders.some((j) => j.id === o.clientOrderId),
      )
    ) {
      throw new Error('untracked order on wheel symbol');
    }
    const committed = committedCapital(positions, open);
    // Reserve all stock BUYs and puts, including GRID and manual broker orders.
    const stockCapital = positions
      .filter((p) => p.contract?.secType !== SecurityType.OPTION)
      .reduce((sum, p) => sum + Math.abs(p.quantity * p.averageCost), 0);
    const cash = Math.max(0, funds.cashUsd - Math.max(0, committed.total - stockCapital));
    await this.persist();
    return { positions, open, funds, cash };
  }

  private async recordFill(fill: Fill): Promise<void> {
    const order = this.journal.orders.find((o) => o.id === fill.clientOrderId);
    if (await this.fills.findByFillId(fill.fillId)) return;
    if (order?.settled) {
      order.settled = false;
      this.journal.halt = 'late execution after lifecycle confirmation; verify broker positions';
    }
    if (
      !order ||
      !Number.isInteger(fill.quantity) ||
      fill.quantity <= 0 ||
      !Number.isFinite(fill.price) ||
      fill.price <= 0 ||
      fill.side !== 'SELL' ||
      fill.symbol !== order.contract.symbol ||
      (fill.contract && contractKey(fill.contract) !== contractKey(order.contract))
    ) {
      this.journal.halt = 'unattributable wheel execution';
      await this.persist();
      return;
    }
    if (!(await this.fills.findByFillId(fill.fillId))) await this.fills.save(fill);
    const filled = (await this.fills.findByClientOrderId(order.id)).reduce(
      (sum, f) => sum + f.quantity,
      0,
    );
    order.status = filled >= order.quantity ? OrderStatus.FILLED : OrderStatus.PARTIALLY_FILLED;
    await this.orders.updateStatus(order.id, order.status as OrderStatus);
    await this.persist();
  }

  private assertConfigured(): WheelConfig {
    if (!this.journal.config) throw new Error('configure wheel first');
    this.assertExclusive(this.journal.config.symbol);
    return this.journal.config;
  }

  private assertExclusive(symbol: string): void {
    if (this.coordinator.snapshots().some((s) => s.id !== 'wheel' && s.symbols.includes(symbol))) {
      throw new Error(`${symbol} belongs to another strategy; wheel needs its own symbol`);
    }
  }

  private assertPaper(): void {
    if (
      this.app.executionMode !== ExecutionMode.PAPER ||
      !this.app.ibAccountId?.startsWith('DU') ||
      !this.app.hasDurableStorage ||
      !this.broker.scanOptions ||
      !this.broker.getWheelFunds ||
      this.riskConfig.accountCurrency !== 'USD'
    ) {
      throw new Error(
        'wheel requires PAPER, a DU paper account, durable storage, USD risk accounting and options-capable IB',
      );
    }
  }
}
