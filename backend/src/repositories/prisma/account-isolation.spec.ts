/**
 * Two accounts, one database, and neither can see the other.
 *
 * One daemon trades one account, and every daemon shares a MySQL. The only
 * thing standing between one account's lots and another account's lot-sum
 * assertion is the scope each Prisma repository is constructed with — so this
 * suite builds two of every per-account repository over the *same* client and
 * asserts, for each, that:
 *
 * - the same natural id can exist in both accounts without colliding (a lot id,
 *   a `clientOrderId`, a rung price are only unique *within* an account), and
 * - reads, `saveAll` replacement, and `clear` never cross the boundary — a
 *   reset in one account must not empty the other's ledger.
 *
 * Skips without `DATABASE_URL`; see `test-database.ts`.
 */

import { PrismaClient } from '@prisma/client';
import { DEFAULT_ACCOUNT_ALIAS } from '../../config/accounts.config';
import { AppConfigService } from '../../config/app-config.service';
import { StartupAssertionError } from '../../risk/startup-assertions';
import { AccountRegistrationService } from './account-registration.service';
import {
  fillFixture,
  gridLotFixture,
  intentRecordFixture,
  lotFixture,
  lotRebuildEventFixture,
  orderFixture,
  parameterChangeFixture,
  perSymbolLimitChangeFixture,
  riskEventFixture,
  rungFixture,
  snapshotFixture,
} from '../repository-contract.suite';
import {
  PrismaFillRepository,
  PrismaGridLotRepository,
  PrismaLotRebuildEventRepository,
  PrismaLotRepository,
  PrismaOrderIntentRepository,
  PrismaOrderRepository,
  PrismaParameterChangeRepository,
  PrismaPerSymbolLimitChangeRepository,
  PrismaRiskEventRepository,
  PrismaRungRepository,
  PrismaStrategyStateSnapshotRepository,
} from './prisma.repositories';
import { PrismaService } from './prisma.service';
import {
  describeWithDatabase,
  disconnectTestClient,
  resetDatabase,
  SECOND_TEST_ACCOUNT,
  testClient,
} from './test-database';

function asService(client: PrismaClient): PrismaService {
  return client as PrismaService;
}

const A = DEFAULT_ACCOUNT_ALIAS;
const B = SECOND_TEST_ACCOUNT;

describeWithDatabase('Prisma repositories are isolated by account', () => {
  const prisma = testClient();

  /** One repository per account over the same client. */
  function pair<T>(Repo: new (prisma: PrismaService, accountId: string) => T): [T, T] {
    return [new Repo(asService(prisma), A), new Repo(asService(prisma), B)];
  }

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await disconnectTestClient();
  });

  it('lots: the same id in two accounts, each seeing only its own, each clearing only its own', async () => {
    const [a, b] = pair(PrismaLotRepository);

    await a.save(lotFixture({ quantity: 10 }), 'TQQQ');
    await b.save(lotFixture({ quantity: 20 }), 'TQQQ');

    expect((await a.findHeld('TQQQ')).map((lot) => lot.quantity)).toEqual([10]);
    expect((await b.findHeld('TQQQ')).map((lot) => lot.quantity)).toEqual([20]);

    // `saveAll` replaces the symbol's set — within this account only.
    await a.saveAll([], 'TQQQ');
    expect(await a.findAll()).toHaveLength(0);
    expect(await b.findAll()).toHaveLength(1);

    await a.save(lotFixture(), 'TQQQ');
    await b.clear();
    expect(await a.findAll()).toHaveLength(1);
  });

  it('rungs: two ladders at the same price never overwrite each other', async () => {
    const [a, b] = pair(PrismaRungRepository);

    await a.saveAll([rungFixture(95, { completedCycles: 1 })], 'TQQQ');
    await b.saveAll([rungFixture(95, { completedCycles: 7 })], 'TQQQ');

    expect((await a.findBySymbol('TQQQ'))[0].completedCycles).toBe(1);
    expect((await b.findBySymbol('TQQQ'))[0].completedCycles).toBe(7);

    await a.saveAll([], 'TQQQ');
    expect(await b.findBySymbol('TQQQ')).toHaveLength(1);

    await b.clear();
    expect(await a.findAll()).toHaveLength(0);
    expect(await b.findAll()).toHaveLength(0);
  });

  it('grid lots', async () => {
    const [a, b] = pair(PrismaGridLotRepository);

    await a.save(gridLotFixture(), 'grid:TQQQ', 'TQQQ');
    await b.save(gridLotFixture({ quantity: 99 }), 'grid:TQQQ', 'TQQQ');

    expect((await a.findHeld('grid:TQQQ'))[0].quantity).toBe(50);

    await a.saveAll([], 'grid:TQQQ', 'TQQQ');
    expect(await b.findHeld('grid:TQQQ')).toHaveLength(1);

    await a.clear();
    expect(await b.findAll()).toHaveLength(1);
  });

  it('orders: one clientOrderId per account, updated and read without crossing over', async () => {
    const [a, b] = pair(PrismaOrderRepository);

    await a.save(orderFixture('co-1'));
    await b.save(orderFixture('co-1'));

    await a.updateStatus('co-1', 'REJECTED' as never, 'account A only');

    expect((await a.findByClientOrderId('co-1'))?.rejectReason).toBe('account A only');
    expect((await b.findByClientOrderId('co-1'))?.rejectReason).toBeNull();

    await a.clear();
    expect(await b.findAll()).toHaveLength(1);
  });

  it('fills: dedup by fillId is per account', async () => {
    const [a, b] = pair(PrismaFillRepository);

    await a.save(fillFixture('co-1', 'f1'));

    // `routeFill` dedupes on `findByFillId`. Account B must not see A's fill as
    // "already recorded", or B would drop a genuine fill of its own.
    expect(await b.findByFillId('f1')).toBeNull();
    expect(await b.findByClientOrderId('co-1')).toEqual([]);

    await b.save(fillFixture('co-1', 'f1'));
    await a.clear();
    expect(await b.findAll()).toHaveLength(1);
  });

  it('intents', async () => {
    const [a, b] = pair(PrismaOrderIntentRepository);

    await a.save(intentRecordFixture('i1'));
    await b.save(intentRecordFixture('i1'));
    await a.markSubmitted('i1', 'co-a');

    expect((await b.findAll())[0].submitted).toBe(false);
    expect(await a.findBySymbol('TQQQ')).toHaveLength(1);

    await b.clear();
    expect(await a.findAll()).toHaveLength(1);
  });

  it('risk and rebuild events', async () => {
    const [riskA, riskB] = pair(PrismaRiskEventRepository);
    const [rebuildA, rebuildB] = pair(PrismaLotRebuildEventRepository);

    await riskA.save(riskEventFixture('a'));
    await rebuildA.save(lotRebuildEventFixture('a'));

    expect(await riskB.findAll()).toEqual([]);
    expect(await rebuildB.findAll()).toEqual([]);
    expect(await rebuildB.findBySymbol('TQQQ')).toEqual([]);

    await riskB.clear();
    await rebuildB.clear();
    expect(await riskA.findAll()).toHaveLength(1);
    expect(await rebuildA.findAll()).toHaveLength(1);
  });

  it('parameter audit trails: the same change id in both, each reading its own', async () => {
    const [a, b] = pair(PrismaParameterChangeRepository);
    const [limitA, limitB] = pair(PrismaPerSymbolLimitChangeRepository);

    await a.append(parameterChangeFixture('p1', { newValue: 0.07 }));
    await b.append(parameterChangeFixture('p1', { newValue: 0.09 }));
    await limitA.append(perSymbolLimitChangeFixture('l1'));

    // `ParameterService.restore` replays this log at boot. Account B replaying
    // A's edits would silently retune B's ladder to A's parameters.
    expect((await a.findByStrategy('dip-ladder:TQQQ'))[0].newValue).toBe(0.07);
    expect((await b.findByStrategy('dip-ladder:TQQQ'))[0].newValue).toBe(0.09);
    expect(await limitB.findBySymbol('TQQQ')).toEqual([]);
  });

  it('snapshots: each account restores its own anchor', async () => {
    const [a, b] = pair(PrismaStrategyStateSnapshotRepository);

    await a.save(
      snapshotFixture('dip-ladder:TQQQ', { capturedAt: '2025-01-02T16:00:00.000-05:00' }),
    );
    await b.save(
      snapshotFixture('dip-ladder:TQQQ', { capturedAt: '2025-01-03T16:00:00.000-05:00' }),
    );

    expect((await a.findLatest('dip-ladder:TQQQ'))?.capturedAt).toBe(
      '2025-01-02T16:00:00.000-05:00',
    );
    expect(await b.findAll('dip-ladder:TQQQ')).toHaveLength(1);

    await a.clear();
    expect(await b.findLatest('dip-ladder:TQQQ')).not.toBeNull();
  });

  it('refuses a row for an account that was never registered', async () => {
    // The foreign key is the backstop behind `AccountRegistrationService`: a
    // repository scoped to an unknown account cannot write orphaned rows.
    const repo = new PrismaLotRepository(asService(prisma), 'never-registered');

    await expect(repo.save(lotFixture(), 'TQQQ')).rejects.toThrow();
  });
});

describeWithDatabase('AccountRegistrationService', () => {
  const prisma = testClient();
  const ALIAS = 'registration-test';

  function service(ibAccountId: string | undefined): AccountRegistrationService {
    return new AccountRegistrationService(
      asService(prisma),
      { ibAccountId } as AppConfigService,
      ALIAS,
    );
  }

  beforeEach(async () => {
    await prisma.account.deleteMany({ where: { id: ALIAS } });
  });

  afterAll(async () => {
    await prisma.account.deleteMany({ where: { id: ALIAS } });
    await disconnectTestClient();
  });

  it('pins nothing at boot, before IB has confirmed the account', async () => {
    await service('nuuixl118').onModuleInit();

    expect(await prisma.account.findUnique({ where: { id: ALIAS } })).toMatchObject({
      id: ALIAS,
      ibAccountId: null,
    });
  });

  it('pins the IB id once IB has confirmed it', async () => {
    await service('DU0000001').confirmBrokerAccount();

    expect(await prisma.account.findUnique({ where: { id: ALIAS } })).toMatchObject({
      id: ALIAS,
      ibAccountId: 'DU0000001',
    });
  });

  it('boots again with the same pairing', async () => {
    await service('DU0000001').confirmBrokerAccount();
    await expect(service('DU0000001').confirmBrokerAccount()).resolves.toBeUndefined();
  });

  it('refuses a later boot that pairs the alias with a different IB account', async () => {
    await service('DU0000001').confirmBrokerAccount();

    await expect(service('DU0000002').confirmBrokerAccount()).rejects.toBeInstanceOf(
      StartupAssertionError,
    );

    // And the pin is untouched by the refused attempt.
    expect((await prisma.account.findUnique({ where: { id: ALIAS } }))?.ibAccountId).toBe(
      'DU0000001',
    );
  });

  it('keeps the pin through a mock-broker boot with no id', async () => {
    await service('DU0000001').confirmBrokerAccount();
    await service(undefined).confirmBrokerAccount();

    expect((await prisma.account.findUnique({ where: { id: ALIAS } }))?.ibAccountId).toBe(
      'DU0000001',
    );
  });
});
