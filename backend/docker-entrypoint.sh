#!/bin/sh
# Applies pending migrations, then starts the daemon.
#
# Migrations run here rather than in the application's bootstrap so the schema
# is settled before Nest wires a single provider — `PrismaService` connects
# eagerly at module init, and a mid-boot migration would race it.
#
# `migrate deploy` (not `migrate dev`): it only applies committed migrations and
# never generates, resets, or prompts. A container that could regenerate a
# migration against a live database is a container that could drop a table
# holding real lots.
set -e

if [ -n "$DATABASE_URL" ]; then
  echo "applying database migrations..."
  npx prisma migrate deploy
else
  # Story 0's zero-dependency path: without a DATABASE_URL the engine binds the
  # in-memory repositories and runs exactly as it did before Story 8.
  echo "no DATABASE_URL — running with in-memory repositories (state will not survive restart)"
fi

exec "$@"
