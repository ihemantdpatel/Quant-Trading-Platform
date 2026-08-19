import { ExecutionMode } from './execution-mode';

/**
 * Exercises validation through the Nest module rather than calling the schema
 * directly — the guarantee that matters is that the *app refuses to boot*, not
 * merely that a pure function throws.
 *
 * Each case re-imports the module inside `jest.isolateModulesAsync`. Nest's
 * ConfigModule caches validated env on the module instance, so without a fresh
 * module registry the second boot would reuse the first one's resolved values
 * and read nothing from `process.env`.
 */
describe('AppConfigModule', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.EXECUTION_MODE;
    delete process.env.PORT;
    delete process.env.IB_HOST;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  async function bootConfigModule(): Promise<{
    executionMode: ExecutionMode;
    port: number;
    ibHost: string | undefined;
    usesIbBroker: boolean;
  }> {
    let result: {
      executionMode: ExecutionMode;
      port: number;
      ibHost: string | undefined;
      usesIbBroker: boolean;
    };

    await jest.isolateModulesAsync(async () => {
      const { Test } = await import('@nestjs/testing');
      const { AppConfigModule } = await import('./config.module');
      const { AppConfigService } = await import('./app-config.service');

      const moduleRef = await Test.createTestingModule({
        imports: [AppConfigModule],
      }).compile();

      const config = moduleRef.get(AppConfigService);
      result = {
        executionMode: config.executionMode,
        port: config.port,
        ibHost: config.ibHost,
        usesIbBroker: config.usesIbBroker,
      };
      await moduleRef.close();
    });

    return result!;
  }

  it('boots with EXECUTION_MODE defaulted to PAPER when unset', async () => {
    const config = await bootConfigModule();

    expect(config.executionMode).toBe(ExecutionMode.PAPER);
  });

  it('refuses to boot when EXECUTION_MODE is invalid', async () => {
    process.env.EXECUTION_MODE = 'YOLO';

    await expect(bootConfigModule()).rejects.toThrow(/Invalid environment configuration/);
  });

  it('exposes the configured mode', async () => {
    process.env.EXECUTION_MODE = ExecutionMode.PAPER;

    const config = await bootConfigModule();

    expect(config.executionMode).toBe(ExecutionMode.PAPER);
  });

  it('exposes a typed port', async () => {
    process.env.PORT = '4321';

    const config = await bootConfigModule();

    expect(config.port).toBe(4321);
  });

  describe('IB_HOST as the broker switch', () => {
    it('selects the mock broker when unset', async () => {
      const config = await bootConfigModule();

      expect(config.ibHost).toBeUndefined();
      expect(config.usesIbBroker).toBe(false);
    });

    it('boots and stays on the mock broker when IB_HOST is blank', async () => {
      // The `docker compose up` default path: compose passes `IB_HOST:
      // ${IB_HOST:-}`, so with no .env the variable arrives as ''. This once
      // failed validation outright, and then — once validation allowed it —
      // still bound the IB adapter with no host to reach. Both halves are
      // asserted here because they failed independently.
      process.env.IB_HOST = '';

      const config = await bootConfigModule();

      expect(config.ibHost).toBeUndefined();
      expect(config.usesIbBroker).toBe(false);
    });

    it('selects the IB broker when a host is configured', async () => {
      process.env.IB_HOST = 'host.docker.internal';

      const config = await bootConfigModule();

      expect(config.ibHost).toBe('host.docker.internal');
      expect(config.usesIbBroker).toBe(true);
    });
  });
});
