/**
 * The guard that stops the Prisma suites skipping silently.
 *
 * The Prisma specs skip without `DATABASE_URL`, which preserves the Story 0
 * property that `npm test` needs no external dependencies. But a skipped suite
 * is indistinguishable from a passing one in Jest's summary, so if CI ever lost
 * its MySQL service the durable-storage implementations would go completely
 * untested while the build stayed green.
 *
 * That is the failure `CLAUDE.md` warns about — a safety check reporting
 * confidence it has not earned. CI sets `REQUIRE_DATABASE_TESTS=1`, and this
 * file turns the absent database into a failure there while leaving a
 * developer's laptop alone.
 *
 * This spec deliberately has no `describeWithDatabase` wrapper: it must run in
 * exactly the case where every other Prisma suite does not.
 */

import { PrismaClient } from '@prisma/client';
import { databaseRequired, hasDatabase } from './test-database';

describe('database test guard', () => {
  it('has a DATABASE_URL when the environment requires one', () => {
    // Fails the CI job when the MySQL service is missing or misconfigured,
    // rather than letting seven repository suites quietly not run.
    if (databaseRequired) {
      expect(hasDatabase).toBe(true);
    } else {
      // Locally this is the documented, intended state.
      expect(databaseRequired).toBe(false);
    }
  });

  it('can actually reach the database when the environment requires one', async () => {
    // A set-but-wrong `DATABASE_URL` would satisfy the check above while every
    // suite still failed to connect. Proving a query round-trips is what makes
    // the guard mean "the tests really ran".
    // Skipped locally, and also when the URL is missing entirely — the first
    // test already reports that case, and constructing a client without a URL
    // would bury it under a Prisma validation stack trace.
    if (!databaseRequired || !hasDatabase) {
      return;
    }

    const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

    try {
      const rows = await prisma.$queryRawUnsafe<{ ok: number }[]>('SELECT 1 AS ok');
      expect(Number(rows[0].ok)).toBe(1);
    } finally {
      await prisma.$disconnect();
    }
  });
});
