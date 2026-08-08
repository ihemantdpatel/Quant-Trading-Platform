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
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  async function bootConfigModule(): Promise<{ executionMode: ExecutionMode; port: number }> {
    let result: { executionMode: ExecutionMode; port: number };

    await jest.isolateModulesAsync(async () => {
      const { Test } = await import('@nestjs/testing');
      const { AppConfigModule } = await import('./config.module');
      const { AppConfigService } = await import('./app-config.service');

      const moduleRef = await Test.createTestingModule({
        imports: [AppConfigModule],
      }).compile();

      const config = moduleRef.get(AppConfigService);
      result = { executionMode: config.executionMode, port: config.port };
      await moduleRef.close();
    });

    return result!;
  }

  it('boots with EXECUTION_MODE defaulted to SHADOW when unset', async () => {
    const config = await bootConfigModule();

    expect(config.executionMode).toBe(ExecutionMode.SHADOW);
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
});
