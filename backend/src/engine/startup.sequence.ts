/**
 * The startup sequence — **reconciliation before any strategy resumes**
 * (`PRD.md:323`).
 *
 * The ordering is the safety property, not an implementation detail. Every step
 * has to complete before bars are allowed to reach a strategy:
 *
 * ```
 * connect broker → initialize strategies → reconcile → open the gate
 * ```
 *
 * `initializeAll` comes *before* reconciliation because reconciliation restores
 * into live strategy state, and there is no state to restore into until the
 * strategies exist. That is safe specifically because initialization creates an
 * **empty** ladder and fires no hooks — a strategy that traded during
 * `initialize` would break this, which is why the contract suite pins
 * `initialize` to returning state and nothing else.
 *
 * ## Why a gate rather than a convention
 *
 * "Call these in the right order" is a comment. `hasReconciled()` is a fact the
 * engine can check, and `engine.processBar` refuses to dispatch until it is
 * true. That turns a sequencing rule into something a test can assert by call
 * ordering (`stories.md:563`) and something a future caller cannot quietly get
 * wrong by wiring a bar source before startup finishes.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { BROKER_ADAPTER, BrokerAdapter } from '../broker/broker-adapter.interface';
import {
  ReconciliationReport,
  ReconciliationService,
} from '../reconciliation/reconciliation.service';
import { CoordinatorService } from '../strategies/coordinator.service';

export interface StartupResult {
  /** False when the broker could not be reached; strategies still initialize. */
  brokerConnected: boolean;
  reconciliation: ReconciliationReport;
}

@Injectable()
export class StartupSequence {
  private readonly logger = new Logger(StartupSequence.name);
  private reconciled = false;

  constructor(
    private readonly coordinator: CoordinatorService,
    private readonly reconciliation: ReconciliationService,
    @Inject(BROKER_ADAPTER) private readonly broker: BrokerAdapter,
  ) {}

  /**
   * Runs the sequence. Safe to call once per process boot.
   *
   * A broker that cannot connect does **not** abort startup: the process still
   * comes up, reconciliation halts every symbol because it cannot verify any
   * position, and the dashboard shows why. Exiting instead would take the
   * operator's only view of the problem down with it.
   */
  async run(now: string): Promise<StartupResult> {
    const brokerConnected = await this.connectBroker();

    // Creates empty state for each enabled strategy. No hook fires and no
    // intent can be produced here — reconciliation is what puts real lots in.
    await this.coordinator.initializeAll(now);

    const reconciliation = await this.reconciliation.reconcileAll(now);

    // The gate opens even when symbols halted. A halt is per-symbol and the
    // engine enforces it per-symbol; refusing to process bars at all would
    // stop the unaffected symbols too.
    this.reconciled = true;

    this.logger.log(
      `startup complete — broker ${brokerConnected ? 'connected' : 'UNAVAILABLE'}, ` +
        `reconciliation ${reconciliation.clean ? 'clean' : 'HALTED ' + reconciliation.haltedSymbols.join(', ')}`,
    );

    return { brokerConnected, reconciliation };
  }

  /**
   * True once the sequence has finished.
   *
   * The engine consults this before dispatching a bar, so a bar arriving during
   * startup is dropped rather than evaluated against unreconciled state.
   */
  hasReconciled(): boolean {
    return this.reconciled;
  }

  private async connectBroker(): Promise<boolean> {
    try {
      await this.broker.connect();
      return this.broker.isConnected();
    } catch (error) {
      this.logger.error(
        `broker connect failed at startup: ${
          error instanceof Error ? error.message : String(error)
        }. Every symbol will halt — positions cannot be verified.`,
      );
      return false;
    }
  }

  /** Test and replay support: reopens the gate for a fresh sequence. */
  reset(): void {
    this.reconciled = false;
  }
}
