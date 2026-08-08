/**
 * The in-memory repositories, run against the **shared** contract suite.
 *
 * The assertions live in `repository-contract.suite.ts` and the Prisma spec
 * runs the identical set (`stories.md:508`), so these two implementations
 * cannot drift apart silently. Behaviour unique to this implementation — the
 * `RiskEventSink` double-duty in particular — is asserted below the suite.
 */

import {
  runBacktestRepositoryContract,
  runBarRepositoryContract,
  runFillRepositoryContract,
  runLotRepositoryContract,
  runOrderIntentRepositoryContract,
  runOrderRepositoryContract,
  runParameterChangeRepositoryContract,
  runRiskEventRepositoryContract,
  runRungRepositoryContract,
  runStrategyStateSnapshotRepositoryContract,
  riskEventFixture,
} from '../repository-contract.suite';
import {
  InMemoryBacktestRepository,
  InMemoryBarRepository,
  InMemoryFillRepository,
  InMemoryLotRepository,
  InMemoryOrderIntentRepository,
  InMemoryOrderRepository,
  InMemoryParameterChangeRepository,
  InMemoryRiskEventRepository,
  InMemoryRungRepository,
  InMemoryStrategyStateSnapshotRepository,
} from './in-memory.repositories';

describe('in-memory repositories', () => {
  runBarRepositoryContract(() => new InMemoryBarRepository());
  runLotRepositoryContract(() => new InMemoryLotRepository());
  runRungRepositoryContract(() => new InMemoryRungRepository());
  runOrderIntentRepositoryContract(() => new InMemoryOrderIntentRepository());
  runOrderRepositoryContract(() => new InMemoryOrderRepository());
  runFillRepositoryContract(() => new InMemoryFillRepository());
  runRiskEventRepositoryContract(() => new InMemoryRiskEventRepository());
  runParameterChangeRepositoryContract(() => new InMemoryParameterChangeRepository());
  runStrategyStateSnapshotRepositoryContract(() => new InMemoryStrategyStateSnapshotRepository());
  runBacktestRepositoryContract(() => new InMemoryBacktestRepository());
});

describe('InMemoryRiskEventRepository (implementation-specific)', () => {
  it('doubles as a RiskEventSink so the chokepoint writes straight through', async () => {
    // One object is both the write path and the read path, so an event the
    // risk manager emitted is on `GET /risk-events` with no sync step. The
    // Prisma implementation deliberately does *not* do this: `emit` is
    // synchronous and a database write is not, so the engine forwards events
    // into it instead (`engine.module.ts:onModuleInit`).
    const repo = new InMemoryRiskEventRepository();

    repo.emit(riskEventFixture('via emit'));

    expect((await repo.findAll())[0].detail).toBe('via emit');
  });
});
