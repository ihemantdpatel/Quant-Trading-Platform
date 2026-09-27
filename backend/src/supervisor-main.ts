/**
 * The backend container's entrypoint: runs the supervisor, which runs one
 * trading daemon (`main.js`) per account. See `supervisor/supervisor.ts`.
 *
 * `npm start` / `start:dev` still run `main.ts` directly — one daemon, the
 * configured account — which is what local development and every test use.
 */

import { fork } from 'child_process';
import { join } from 'path';
import { createInterface } from 'readline';
import { Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { readAccountDefinitions } from './repositories/prisma/prisma-account-definition.repository';
import { ChildHandle, ChildSpec, Supervisor } from './supervisor/supervisor';

/* istanbul ignore file -- process and database I/O around the tested Supervisor */

const DAEMON_ENTRY = join(__dirname, 'main.js');

function spawnDaemon(spec: ChildSpec): ChildHandle {
  const child = fork(DAEMON_ENTRY, [], {
    env: spec.env as NodeJS.ProcessEnv,
    stdio: spec.prefixOutput ? ['ignore', 'pipe', 'pipe', 'ipc'] : 'inherit',
  });

  if (spec.prefixOutput) {
    // Every daemon logs through Nest in the same format; without the alias an
    // interleaved container log could not say which account a line is about.
    for (const [stream, sink] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ] as const) {
      if (stream !== null) {
        createInterface({ input: stream }).on('line', (line) =>
          sink.write(`[${spec.name}] ${line}\n`),
        );
      }
    }
  }

  return {
    onExit: (listener) => child.on('exit', listener),
    kill: (signal) => {
      child.kill(signal);
    },
  };
}

async function main(): Promise<void> {
  const logger = new Logger('Supervisor');
  const prisma = process.env.DATABASE_URL ? new PrismaClient() : null;

  const supervisor = new Supervisor({
    env: process.env,
    spawn: spawnDaemon,
    loadDefinitions: prisma === null ? null : () => readAccountDefinitions(prisma),
    logger: {
      log: (message) => logger.log(message),
      warn: (message) => logger.warn(message),
      error: (message) => logger.error(message),
    },
  });

  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.log(`${signal} received — stopping every account daemon`);

    void supervisor
      .stop()
      .then(() => prisma?.$disconnect())
      .finally(() => process.exit(0));
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await supervisor.start();
}

void main().catch((error: unknown) => {
  Logger.error(error instanceof Error ? error.message : String(error), undefined, 'Supervisor');
  process.exit(1);
});
