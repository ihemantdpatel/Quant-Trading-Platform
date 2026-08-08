/**
 * Seed script — the instrument vocabulary, and nothing else.
 *
 * Deliberately minimal. It is tempting to seed a ladder of lots and rungs to
 * make the dashboard look alive, but lots are **positions**: a seeded lot is a
 * claim that shares were bought. Story 9 reconciles the sum of held lot
 * quantities against the broker's net position and halts the symbol on a
 * mismatch (`PRD.md:343`), so a fabricated lot would present as a real
 * discrepancy — indistinguishable from the corruption that check exists to
 * catch.
 *
 * Ladder state comes from replaying a fixture, which produces it the way the
 * engine actually would:
 *
 *   curl -X POST localhost:3000/engine/replay \
 *     -H 'Content-Type: application/json' -d '{"fixture":"chop-range"}'
 *
 * Run with: `npm run prisma:seed`
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // TQQQ is the only instrument Phase 1 trades (`PRD.md:61`).
  //
  // `findFirst` + `create` rather than `upsert`, because the identity of an
  // equity is a tuple whose option columns are all NULL — and a MySQL unique
  // index does not treat NULLs as equal, so that constraint cannot deduplicate
  // equities and Prisma will not accept nulls in a composite `where` at all.
  // The constraint still does its real job: distinguishing option contracts,
  // where strike/expiry/right are populated.
  const existing = await prisma.instrument.findFirst({
    where: { symbol: 'TQQQ', secType: 'STK', strike: null, expiry: null, right: null },
  });

  const tqqq =
    existing ??
    (await prisma.instrument.create({
      data: {
        symbol: 'TQQQ',
        secType: 'STK',
        exchange: 'SMART',
        currency: 'USD',
        multiplier: 1,
      },
    }));

  console.log(
    existing === null
      ? `seeded instrument ${tqqq.symbol} (id ${tqqq.id})`
      : `instrument ${tqqq.symbol} already present (id ${tqqq.id})`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
