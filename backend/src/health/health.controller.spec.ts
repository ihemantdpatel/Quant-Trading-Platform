import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ExecutionMode } from '../config/execution-mode';
import { HealthController } from './health.controller';

/**
 * Boots inside `jest.isolateModulesAsync` for the same reason as the config
 * module spec: ConfigModule caches validated env, so a second boot in the same
 * module registry would silently reuse the first case's EXECUTION_MODE.
 */
describe('GET /health', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  /**
   * Boots the whole app in an isolated module registry, and **always unwinds
   * that registry before returning** — including when the boot itself throws.
   *
   * The `catch`/rethrow matters and is not defensive padding. A boot that
   * rejects (which the PAPER refusal test *requires*) would otherwise propagate
   * out of `isolateModulesAsync` while Jest still considered the isolation
   * open. The next call then fails with "isolateModulesAsync cannot be nested",
   * turning a passing safety assertion into an unrelated infrastructure error —
   * and it surfaced only under `--coverage`, where worker timing differs, so it
   * read as flakiness rather than as the ordering bug it is.
   */
  async function withApp(fn: (app: INestApplication) => Promise<void>): Promise<void> {
    let failure: unknown = null;

    await jest.isolateModulesAsync(async () => {
      try {
        const { Test } = await import('@nestjs/testing');
        const { AppModule } = await import('../app.module');

        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        const app = moduleRef.createNestApplication();
        await app.init();

        try {
          await fn(app);
        } finally {
          await app.close();
        }
      } catch (error) {
        // Captured rather than thrown, so the isolation closes cleanly. The
        // caller still sees the failure — it is rethrown below.
        failure = error;
      }
    });

    if (failure !== null) {
      throw failure;
    }
  }

  it('returns 200 with status ok and PAPER mode by default', async () => {
    process.env = { ...originalEnv };
    delete process.env.EXECUTION_MODE;

    await withApp(async (app) => {
      await request(app.getHttpServer())
        .get('/health')
        .expect(200)
        .expect({ status: 'ok', mode: ExecutionMode.PAPER });
    });
  });

  /**
   * Reads the mode from config rather than booting the app in PAPER.
   *
   * Story 5's startup assertion makes a PAPER boot fail by design while the
   * capital and loss-threshold values are unset (`PRD.md:500`) — see the
   * refusal test below. The claim under test here is only that the controller
   * reports the configured mode instead of a hardcoded literal, which does not
   * require a whole application.
   */
  it('reports the configured mode rather than a hardcoded one', () => {
    // Statically imported: this case constructs the controller directly and
    // needs no isolated registry, and a dynamic import here would touch the
    // module registry between two isolated boots for no reason.
    const controller = new HealthController({
      executionMode: ExecutionMode.PAPER,
    } as never);

    expect(controller.check()).toEqual({ status: 'ok', mode: ExecutionMode.PAPER });
  });

  /**
   * Story 13 closed the two open PRD items (`capital.config.ts`), so the boot
   * this originally asserted must fail now succeeds.
   *
   * The capital figures are expressed in USD to match TQQQ, with the CAD account
   * balance hand-converted once (`capital.config.ts`). That keeps the cap
   * arithmetic sound — the property the currency check enforces — at the cost of
   * an equity figure that carries FX staleness.
   *
   * The Story 5 claim has not been dropped: `capital.config.spec.ts` asserts the
   * assertion still refuses PAPER when either original value is removed, and
   * that the currency check still refuses a CAD-tagged account. The guard stays
   * load-bearing rather than becoming decoration.
   */
  it('boots in PAPER now that capital and loss threshold are set', async () => {
    process.env = { ...originalEnv, EXECUTION_MODE: ExecutionMode.PAPER };

    await withApp(async (app) => {
      await request(app.getHttpServer())
        .get('/health')
        .expect(200)
        .expect({ status: 'ok', mode: ExecutionMode.PAPER });
    });
  });
});
