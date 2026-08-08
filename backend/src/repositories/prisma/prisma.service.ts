/**
 * The Prisma connection, owned as a Nest lifecycle-managed singleton.
 *
 * One client for the whole process: `PrismaClient` holds a connection pool, and
 * constructing one per repository would multiply the pool by seven for no gain.
 *
 * **Connects eagerly at module init rather than lazily on first query.** A bad
 * `DATABASE_URL` should fail startup, in the same breath as the Story 5 config
 * assertions, rather than surfacing mid-replay as a failed write after the
 * engine has already reported itself healthy on `GET /health` — at which point
 * an intent has been generated and its persistence-before-submission guarantee
 * (`PRD.md:366`) has already been quietly broken.
 */

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('connected to MySQL — repositories are durable');
  }

  /**
   * Closes the pool on shutdown so a restart does not leave connections held
   * server-side until they time out. Story 8's exit criterion restarts the
   * backend deliberately, so this path runs in the scenario it is written for.
   */
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
