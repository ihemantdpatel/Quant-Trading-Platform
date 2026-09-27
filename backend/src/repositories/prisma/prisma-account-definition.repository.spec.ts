/**
 * The dashboard-created account registry against MySQL: the round trip the
 * supervisor depends on, the unique keys that decide a creation race, and the
 * append-only audit log. Skips without `DATABASE_URL`; see `test-database.ts`.
 */

import { PrismaClient } from '@prisma/client';
import { StoredAccountDefinition } from '../../config/account-definition';
import { ExecutionMode } from '../../config/execution-mode';
import { LossBasis } from '../../risk/risk.config';
import { AccountDefinitionConflictError } from '../repository.interfaces';
import {
  PrismaAccountDefinitionRepository,
  readAccountDefinitions,
} from './prisma-account-definition.repository';
import { PrismaService } from './prisma.service';
import {
  describeWithDatabase,
  disconnectTestClient,
  testClient,
  truncateAccountDefinitions,
} from './test-database';

function definition(overrides: Partial<StoredAccountDefinition> = {}): StoredAccountDefinition {
  return {
    alias: 'second',
    label: 'Second',
    mode: ExecutionMode.PAPER,
    currency: 'USD',
    equity: 100_000.25,
    symbolCapital: { TQQQ: 25_000 },
    dailyLossThreshold: 3_000,
    dailyLossBasis: LossBasis.REALIZED_AND_UNREALIZED,
    ibAccountId: 'DU7654321',
    ibClientId: 11,
    port: 3101,
    createdAt: '2026-09-24T10:00:00.000Z',
    ...overrides,
  };
}

describeWithDatabase('Prisma account definitions', () => {
  const prisma = testClient();
  const repo = new PrismaAccountDefinitionRepository(prisma as PrismaService);

  beforeEach(async () => {
    await truncateAccountDefinitions(prisma);
  });

  afterAll(async () => {
    await truncateAccountDefinitions(prisma);
    await disconnectTestClient();
  });

  it('round-trips a definition exactly as the supervisor will read it', async () => {
    await repo.create(definition(), 'soak');

    expect(await readAccountDefinitions(prisma as PrismaClient)).toEqual([definition()]);
    expect(await prisma.accountDefinitionChange.findMany()).toEqual([
      expect.objectContaining({ alias: 'second', action: 'CREATED', reason: 'soak' }),
    ]);
  });

  it.each([
    ['alias', { ibAccountId: 'DU1', ibClientId: 13, port: 3102 }],
    ['IB account id', { alias: 'third', ibClientId: 13, port: 3102 }],
    ['client id', { alias: 'third', ibAccountId: 'DU1', port: 3102 }],
    ['port', { alias: 'third', ibAccountId: 'DU1', ibClientId: 13 }],
  ])('refuses a second definition sharing its %s, writing no audit row', async (_, overrides) => {
    await repo.create(definition(), null);

    await expect(repo.create(definition(overrides), null)).rejects.toBeInstanceOf(
      AccountDefinitionConflictError,
    );
    expect(await prisma.accountDefinitionChange.count()).toBe(1);
  });

  it('keeps the audit log append-only', async () => {
    await repo.create(definition(), null);

    await expect(
      prisma.$executeRawUnsafe("UPDATE `AccountDefinitionChange` SET `reason` = 'x'"),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe('DELETE FROM `AccountDefinitionChange`')).rejects.toThrow(
      /append-only/,
    );
  });
});
