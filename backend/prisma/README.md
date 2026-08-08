# Prisma / MySQL (Story 8)

Durable storage behind the Story 6 repository interfaces. `schema.prisma` is the
model; `src/repositories/prisma/` implements the same interfaces the in-memory
repositories do, and both run the **same** contract suite
(`src/repositories/repository-contract.suite.ts`).

## The switch

`DATABASE_URL` decides which repositories the engine binds — set means Prisma,
unset means in-memory. There is no separate flag that could disagree with it.
`GET /status` reports `storage: DURABLE | IN_MEMORY`, so the question "will my
ladder state survive a restart?" is answerable at runtime.

Leaving the in-memory path working is deliberate: Story 0 established that the
stack builds and tests green with zero external dependencies, and every
mock-data story still relies on it.

## Everyday commands

```bash
docker compose up -d mysql          # start the database
npm run prisma:migrate              # apply committed migrations
npm run prisma:seed                 # instrument vocabulary only
npm run prisma:studio               # browse the data

npm test                            # ~930 tests, no database needed
npm run test:db                     # the Prisma suites (needs DATABASE_URL)
```

Ladder state is **not** seeded. Lots are positions, and a fabricated lot would
present to Story 9's reconciliation as a real discrepancy. Produce state the way
the engine does:

```bash
curl -X POST localhost:3000/engine/replay \
  -H 'Content-Type: application/json' -d '{"fixture":"chop-range"}'
```

## Apple Silicon: run Prisma's CLI in a container

**On darwin-arm64, Prisma 6.19's engines fail against MySQL 8 with a misleading
error:**

```
Error querying the database: Unknown authentication plugin `sha256_password'.
```

It is not an authentication problem. The same DSN works from `mysql(1)`, from
the backend container, and from CI; every account is configured normally. It is
the macOS ARM engine binary, and it affects both the schema engine (migrations)
and the query engine (tests) — so `npm run test:db` cannot run natively on an
Apple Silicon host.

Do not "fix" this by weakening the server's authentication policy. That trades a
real security property for a host-only toolchain bug, in the wrong layer.

Run the CLI and the database tests through Linux instead:

```bash
# from the repo root
docker run --rm --network host -v "$PWD":/repo -w /repo/backend \
  -e DATABASE_URL="mysql://ib:ib_password@127.0.0.1:3306/ib" \
  node:22-slim sh -c "apt-get update -qq && apt-get install -y -qq openssl && \
    ./node_modules/.bin/prisma migrate deploy"
```

Swap the final command for `npx jest --config jest.database.config.ts` to run the
database suites. `docker compose up` is unaffected — the backend image is Linux.

## Generating a migration

`prisma migrate dev` needs the schema engine, so on Apple Silicon generate the
SQL in a container and commit it:

```bash
docker run --rm -v "$PWD":/app -w /app node:22-slim sh -c \
  "apt-get update -qq && apt-get install -y -qq openssl && \
   ./node_modules/.bin/prisma migrate diff \
     --from-schema-datasource ./prisma/schema.prisma \
     --to-schema-datamodel ./prisma/schema.prisma --script" \
  > prisma/migrations/<timestamp>_<name>/migration.sql
```

## Two schema decisions worth knowing

**`ParameterChange` is append-only in the database, not just in the interface.**
`BEFORE UPDATE` and `BEFORE DELETE` triggers raise SQLSTATE 45000. An audit trail
that a client can rewrite is not one, and the repository interface omitting
`update` is a convention rather than an enforcement. Consequences:

- `PrismaParameterChangeRepository.clear()` is a documented no-op. `engine.reset()`
  never calls it — the audit trail deliberately survives a reset.
- Tests empty the table with `TRUNCATE`, which is DDL and does not fire row
  triggers, so the constraint stays intact in the schema under test.
- Creating the triggers needs `log_bin_trust_function_creators=1` (compose sets
  it as a server flag; CI sets it with `SET GLOBAL`). Without it, MySQL rejects
  trigger creation by a non-SUPER user with error 1419.

**`Fill.clientOrderId` is indexed but is not a foreign key.** A fill is evidence
that something traded, and it must be recordable when the matching `Order` row is
missing — precisely the crash window Story 9 recovers from (`PRD.md:334`). An FK
would reject the record reconciliation needs to detect the discrepancy.

## What Story 8 does not do

Rows are written; **nothing reads them back on boot**. `GET /lots` serves live
strategy state, so after a restart MySQL holds the ladder and the API reports an
empty one. Rehydrating state into a running strategy is Story 9's startup
sequence (`stories.md:531`), which must reconcile against the broker before any
strategy resumes.

That boundary is pinned by a test — "leaves state in the database that a restart
does NOT yet reload" in `engine-persistence.integration.spec.ts`. When Story 9
lands, that assertion fails and should be replaced with its inverse.
