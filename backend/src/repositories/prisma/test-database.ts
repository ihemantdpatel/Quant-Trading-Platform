/**
 * Test-database access for the Prisma suites.
 *
 * ## Why these tests skip rather than fail without MySQL
 *
 * Story 0 established that the whole stack builds and tests green with **zero
 * external dependencies**, and that property is what makes the mock-data-first
 * sequencing work (`stories.md:8`). Requiring a live MySQL for `npm test` would
 * retire it at Story 8. So the Prisma suites run when `DATABASE_URL` is set and
 * skip when it is not.
 *
 * ## Why skipping is dangerous, and what stops it being silent
 *
 * A suite that skips looks exactly like a suite that passes. If CI ever lost
 * its MySQL service the Prisma implementations would go untested while the
 * build stayed green — reporting a confidence nobody earned, which is the
 * failure mode `CLAUDE.md` names about tests that cannot fail.
 *
 * `REQUIRE_DATABASE_TESTS=1` is the guard. CI sets it, and
 * `database-required.spec.ts` fails outright when it is set without a reachable
 * database. Locally neither is set and the suites skip quietly.
 */

import { PrismaClient } from '@prisma/client';

export const DATABASE_URL = process.env.DATABASE_URL;

/** True when a database is configured and the Prisma suites should run. */
export const hasDatabase = Boolean(DATABASE_URL);

/** True when the environment insists a database must be present (CI). */
export const databaseRequired = process.env.REQUIRE_DATABASE_TESTS === '1';

/**
 * `describe` when a database is configured, `describe.skip` otherwise.
 *
 * Jest evaluates `describe` bodies at collection time, before any hook runs, so
 * the decision has to be made synchronously here rather than in `beforeAll`.
 */
export const describeWithDatabase = hasDatabase ? describe : describe.skip;

let client: PrismaClient | null = null;

/**
 * The shared client for a test file.
 *
 * One client per worker rather than one per test: `PrismaClient` opens a
 * connection pool, and Jest runs suites in parallel workers that would
 * otherwise multiply into more connections than MySQL's default `max_connections`
 * allows — which surfaces as flaky "too many connections" failures rather than
 * as a clear error.
 */
export function testClient(): PrismaClient {
  if (client === null) {
    if (!hasDatabase) {
      // `describe.skip` still *evaluates* its body — Jest only skips the tests
      // inside it — so a skipped suite reaches this call. Constructing a client
      // with no URL throws at collection time and fails the file outright,
      // which would defeat the point of skipping. A lazy proxy defers the error
      // to an actual query, which a skipped test never makes.
      return lazyUnconfiguredClient();
    }

    client = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  }

  return client;
}

/**
 * Stands in for a client when no database is configured.
 *
 * Every property access returns a thrower rather than throwing on access, so
 * the object can be held by a skipped suite's closure without exploding.
 */
function lazyUnconfiguredClient(): PrismaClient {
  const fail = (): never => {
    throw new Error('No DATABASE_URL configured — this suite should have been skipped');
  };

  return new Proxy(
    {},
    {
      get: () => new Proxy(fail, { get: () => fail, apply: fail }),
    },
  ) as unknown as PrismaClient;
}

export async function disconnectTestClient(): Promise<void> {
  // Null when the suite was skipped and no real client was ever built.
  if (client !== null) {
    await client.$disconnect();
    client = null;
  }
}

/**
 * Empties every table the repository suites touch.
 *
 * `ParameterChange` is deleted with the triggers temporarily suppressed —
 * see `truncateParameterChanges`. Foreign keys mean order matters: children
 * before parents, or the delete is rejected.
 */
export async function resetDatabase(prisma: PrismaClient = testClient()): Promise<void> {
  await prisma.fill.deleteMany();
  await prisma.order.deleteMany();
  await prisma.orderIntent.deleteMany();
  await prisma.lot.deleteMany();
  await prisma.rung.deleteMany();
  await prisma.riskEvent.deleteMany();
  await prisma.backtestResult.deleteMany();
  await prisma.backtestRun.deleteMany();
  await prisma.strategyStateSnapshot.deleteMany();
  await prisma.strategyInstance.deleteMany();
  await prisma.bar.deleteMany();
  await prisma.instrument.deleteMany();
  await prisma.position.deleteMany();
  await truncateParameterChanges(prisma);
}

/**
 * Empties `ParameterChange`, which DELETE triggers otherwise forbid.
 *
 * `TRUNCATE` is used precisely **because it does not fire row triggers** — it
 * is a DDL operation, not a DML one. That is the property this needs: tests
 * must start from an empty table, while the append-only guarantee stays intact
 * for every ordinary DELETE the application could issue. A test that had to
 * drop the triggers to clean up would be testing a schema no deployment runs.
 */
export async function truncateParameterChanges(prisma: PrismaClient = testClient()): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE `ParameterChange`');
}
