/**
 * The Prisma repositories, run against the **same** contract suite as the
 * in-memory ones (`stories.md:508`).
 *
 * That shared suite is the substance of this file: if MySQL orders lots
 * differently, loses a cent to Decimal conversion, or lets a caller mutate
 * stored state, an assertion written for the in-memory implementation fails
 * here. Below it sit the assertions that only mean something against a real
 * database — the append-only triggers, the composite index, durability across
 * a client restart.
 *
 * Skips without `DATABASE_URL`; see `test-database.ts` for why, and for the
 * guard that stops the skip being silent in CI.
 */

import { PrismaClient } from '@prisma/client';
import { LotStatus } from '../../strategies/dip-ladder/lot';
import { RungStatus } from '../../strategies/dip-ladder/rung';
import {
  lotFixture,
  parameterChangeFixture,
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
  rungFixture,
} from '../repository-contract.suite';
import {
  PrismaBacktestRepository,
  PrismaBarRepository,
  PrismaFillRepository,
  PrismaLotRepository,
  PrismaOrderIntentRepository,
  PrismaOrderRepository,
  PrismaParameterChangeRepository,
  PrismaRiskEventRepository,
  PrismaRungRepository,
  PrismaStrategyStateSnapshotRepository,
} from './prisma.repositories';
import { PrismaService } from './prisma.service';
import {
  describeWithDatabase,
  disconnectTestClient,
  resetDatabase,
  testClient,
  truncateParameterChanges,
} from './test-database';

/**
 * The repositories take a `PrismaService`; the tests hold a plain
 * `PrismaClient`. The service adds only Nest lifecycle hooks over the client,
 * so this cast exercises the production class without booting a module.
 */
function asService(client: PrismaClient): PrismaService {
  return client as PrismaService;
}

describeWithDatabase('Prisma repositories', () => {
  const prisma = testClient();

  afterAll(async () => {
    await disconnectTestClient();
  });

  runBarRepositoryContract(async () => {
    await resetDatabase(prisma);
    return new PrismaBarRepository(asService(prisma));
  });

  runLotRepositoryContract(async () => {
    await resetDatabase(prisma);
    return new PrismaLotRepository(asService(prisma));
  });

  runRungRepositoryContract(async () => {
    await resetDatabase(prisma);
    return new PrismaRungRepository(asService(prisma));
  });

  runOrderIntentRepositoryContract(async () => {
    await resetDatabase(prisma);
    return new PrismaOrderIntentRepository(asService(prisma));
  });

  runOrderRepositoryContract(async () => {
    await resetDatabase(prisma);
    return new PrismaOrderRepository(asService(prisma));
  });

  runFillRepositoryContract(async () => {
    await resetDatabase(prisma);
    return new PrismaFillRepository(asService(prisma));
  });

  runRiskEventRepositoryContract(async () => {
    await resetDatabase(prisma);
    return new PrismaRiskEventRepository(asService(prisma));
  });

  runParameterChangeRepositoryContract(
    async () => {
      await resetDatabase(prisma);
      return new PrismaParameterChangeRepository(asService(prisma));
    },
    // `clear` is a documented no-op here: the append-only trigger rejects
    // DELETE, and the audit trail deliberately survives `POST /engine/reset`.
    { supportsClear: false },
  );

  runStrategyStateSnapshotRepositoryContract(async () => {
    await resetDatabase(prisma);
    return new PrismaStrategyStateSnapshotRepository(asService(prisma));
  });

  runBacktestRepositoryContract(async () => {
    await resetDatabase(prisma);
    return new PrismaBacktestRepository(asService(prisma));
  });
});

describeWithDatabase('ParameterChange is append-only at the database level', () => {
  const prisma = testClient();
  const repo = new PrismaParameterChangeRepository(asService(prisma));

  beforeEach(async () => {
    await truncateParameterChanges(prisma);
  });

  afterAll(async () => {
    await disconnectTestClient();
  });

  it('rejects an UPDATE, so the audit trail cannot be rewritten', async () => {
    // `stories.md:494` asks for this as a *database* property. The interface
    // omitting `update` is a convention; a trigger is an enforcement, and it
    // holds against any client, not just this class.
    await repo.append(parameterChangeFixture('a'));

    await expect(
      prisma.$executeRawUnsafe("UPDATE `ParameterChange` SET `newValue` = '0.99' WHERE `id` = 'a'"),
    ).rejects.toThrow(/append-only/);

    expect((await repo.findAll())[0].newValue).toBe(0.07);
  });

  it('rejects a DELETE, so a row cannot be removed and re-inserted', async () => {
    // Blocking only UPDATE would leave delete-then-reinsert as a rewrite path.
    await repo.append(parameterChangeFixture('a'));

    await expect(
      prisma.$executeRawUnsafe("DELETE FROM `ParameterChange` WHERE `id` = 'a'"),
    ).rejects.toThrow(/append-only/);

    expect(await repo.findAll()).toHaveLength(1);
  });

  it('still accepts INSERT — the log appends, it just never rewrites', async () => {
    // Guards against a trigger so broad it makes the table read-only, which
    // would pass both tests above while breaking the feature.
    await repo.append(parameterChangeFixture('a'));
    await repo.append(parameterChangeFixture('b'));

    expect(await repo.findAll()).toHaveLength(2);
  });
});

describeWithDatabase('durability across a client restart', () => {
  const prisma = testClient();

  afterAll(async () => {
    await disconnectTestClient();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it('reloads lots, rung arming, and cycle counts through a fresh client', async () => {
    // The heart of Story 8: state written by one process is read back by
    // another. A fresh `PrismaClient` is the closest in-process analogue of the
    // restart in the exit criterion — nothing can be served from an object the
    // first client still holds.
    const lots = new PrismaLotRepository(asService(prisma));
    const rungs = new PrismaRungRepository(asService(prisma));

    await lots.saveAll(
      [
        lotFixture({ id: 'held-low', rungPrice: 90.25, fillPrice: 90.25, exitTarget: 94.76 }),
        lotFixture({
          id: 'closed-high',
          rungPrice: 95,
          openedAt: '2025-01-02T09:45:00.000-05:00',
          status: LotStatus.CLOSED,
          closedAt: '2025-01-02T13:00:00.000-05:00',
          exitPrice: 99.75,
        }),
      ],
      'TQQQ',
    );
    await rungs.saveAll(
      [
        // A re-armed rung with cycles behind it — the state that must survive,
        // because a restart that lost it would forget the level entirely.
        rungFixture(95, { status: RungStatus.RE_ARMED, completedCycles: 2, lastExitAt: 'x' }),
        rungFixture(90.25, { status: RungStatus.HELD, lotId: 'held-low' }),
      ],
      'TQQQ',
    );

    const reconnected = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });

    try {
      const reloadedLots = await new PrismaLotRepository(asService(reconnected)).findBySymbol(
        'TQQQ',
      );
      const reloadedRungs = await new PrismaRungRepository(asService(reconnected)).findBySymbol(
        'TQQQ',
      );

      // FIFO order preserved: the older closed lot first.
      expect(reloadedLots.map((l) => l.id)).toEqual(['closed-high', 'held-low']);
      expect(reloadedLots[1].exitTarget).toBe(94.76);

      const reArmed = reloadedRungs.find((r) => r.price === 95);
      expect(reArmed?.status).toBe(RungStatus.RE_ARMED);
      expect(reArmed?.completedCycles).toBe(2);

      const held = reloadedRungs.find((r) => r.price === 90.25);
      expect(held?.lotId).toBe('held-low');
    } finally {
      await reconnected.$disconnect();
    }
  });

  it('keeps a held lot’s frozen exit target exact across the round trip', async () => {
    // A held lot's target is frozen at the parameters in force when it filled
    // (`PRD.md:386`). Storage that rounded it would move a live position into
    // or out of an exit condition — the precise thing the frozen-target rule
    // exists to prevent.
    const lots = new PrismaLotRepository(asService(prisma));

    await lots.save(lotFixture({ id: 'x', fillPrice: 76.41, exitTarget: 80.23 }), 'TQQQ');

    const [reloaded] = await lots.findBySymbol('TQQQ');
    expect(reloaded.fillPrice).toBe(76.41);
    expect(reloaded.exitTarget).toBe(80.23);
  });
});

describeWithDatabase('Bar composite index', () => {
  const prisma = testClient();

  afterAll(async () => {
    await disconnectTestClient();
  });

  it('is used for symbol + barSize + timestamp range queries', async () => {
    // `stories.md:513`. Story 10 serves all history from this table and calls
    // IB only to fill gaps, so a range scan falling back to a full table scan
    // would degrade every backfill — silently, and only once the table is big.
    await resetDatabase(prisma);

    const instrument = await prisma.instrument.create({
      data: { symbol: 'TQQQ', secType: 'STK', currency: 'USD', exchange: 'SMART', multiplier: 1 },
    });

    await prisma.bar.createMany({
      data: Array.from({ length: 50 }, (_, i) => ({
        instrumentId: instrument.id,
        symbol: 'TQQQ',
        barSize: '5min',
        timestamp: `2025-01-02T${String(9 + Math.floor(i / 12)).padStart(2, '0')}:${String(
          (i % 12) * 5,
        ).padStart(2, '0')}:00.000-05:00`,
        open: 95,
        high: 96,
        low: 94,
        close: 95.5,
        volume: BigInt(1000),
      })),
    });

    const plan = await prisma.$queryRawUnsafe<{ key: string | null }[]>(
      'EXPLAIN SELECT * FROM `Bar` WHERE `symbol` = ? AND `barSize` = ? ' +
        'AND `timestamp` BETWEEN ? AND ?',
      'TQQQ',
      '5min',
      '2025-01-02T09:00:00.000-05:00',
      '2025-01-02T11:00:00.000-05:00',
    );

    // MySQL may pick either the unique constraint or the explicit index — both
    // lead on (symbol, barSize, timestamp), so both satisfy the requirement.
    // What matters is that *some* index is chosen rather than a full scan.
    expect(plan[0].key).not.toBeNull();
  });
});
