import { validateConfig } from './config.schema';
import { ExecutionMode } from './execution-mode';

describe('validateConfig', () => {
  it('defaults EXECUTION_MODE to PAPER when unset', () => {
    // SHADOW was the default until it was retired (`execution-mode.ts`). The
    // default is a submitting mode now, which is why `assertStartupSafe` must
    // refuse to boot without the capital and loss-threshold decisions set.
    const config = validateConfig({});

    expect(config.EXECUTION_MODE).toBe(ExecutionMode.PAPER);
  });

  it('rejects an invalid EXECUTION_MODE value', () => {
    expect(() => validateConfig({ EXECUTION_MODE: 'YOLO' })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('rejects an explicitly empty EXECUTION_MODE rather than falling back to the default', () => {
    // A blank value in .env is a misconfiguration, not an omission. Silently
    // defaulting it would hide a broken deploy config.
    expect(() => validateConfig({ EXECUTION_MODE: '' })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it.each([ExecutionMode.SHADOW, ExecutionMode.PAPER, ExecutionMode.LIVE])('accepts %s', (mode) => {
    expect(validateConfig({ EXECUTION_MODE: mode }).EXECUTION_MODE).toBe(mode);
  });

  it('defaults PORT to 3000 and coerces a string port to a number', () => {
    expect(validateConfig({}).PORT).toBe(3000);
    expect(validateConfig({ PORT: '4000' }).PORT).toBe(4000);
  });

  it('rejects a non-numeric PORT', () => {
    expect(() => validateConfig({ PORT: 'not-a-port' })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('names the offending variable in the error message', () => {
    expect(() => validateConfig({ EXECUTION_MODE: 'YOLO' })).toThrow(/EXECUTION_MODE/);
  });

  describe('IB_HOST', () => {
    it('is undefined when unset, selecting the mock broker', () => {
      expect(validateConfig({}).IB_HOST).toBeUndefined();
    });

    it('treats an empty value as unset rather than rejecting it', () => {
      // Compose passes `IB_HOST: ${IB_HOST:-}`, which supplies '' rather than
      // omitting the variable. Rejecting blank here crashed the backend at boot
      // on `docker compose up` with no .env — the default path for a new
      // checkout, where the mock broker is exactly what should bind.
      //
      // This deliberately differs from EXECUTION_MODE above, which rejects
      // blank: there, a blank value would silently pick a *behaviour* the
      // operator did not choose. Here, blank and absent select the same broker,
      // so treating them alike hides nothing.
      expect(validateConfig({ IB_HOST: '' }).IB_HOST).toBeUndefined();
      expect(validateConfig({ IB_HOST: '   ' }).IB_HOST).toBeUndefined();
    });

    it('keeps a real host value', () => {
      expect(
        validateConfig({ IB_HOST: 'host.docker.internal', IB_ACCOUNT_ID: 'DU1234567' }).IB_HOST,
      ).toBe('host.docker.internal');
    });
  });

  describe('ACCOUNT_ALIAS', () => {
    it('defaults to the one account that predates accounts, so an old deployment keeps trading it', () => {
      expect(validateConfig({}).ACCOUNT_ALIAS).toBe('nuuixl118');
      expect(validateConfig({ ACCOUNT_ALIAS: '' }).ACCOUNT_ALIAS).toBe('nuuixl118');
    });

    it('accepts an alias the registry knows', () => {
      expect(validateConfig({ ACCOUNT_ALIAS: ' nuuixl118 ' }).ACCOUNT_ALIAS).toBe('nuuixl118');
    });

    it('refuses an alias the registry does not know rather than borrowing another account', () => {
      expect(() => validateConfig({ ACCOUNT_ALIAS: 'nobody' })).toThrow(
        /ACCOUNT_ALIAS: must be one of nuuixl118/,
      );
    });
  });

  describe('IB_ACCOUNT_ID', () => {
    it('is optional under the mock broker, where there is no account to name', () => {
      expect(validateConfig({}).IB_ACCOUNT_ID).toBeUndefined();
    });

    it('refuses a value that is not an IB account id, such as the alias or login username', () => {
      expect(() =>
        validateConfig({ IB_HOST: 'host.docker.internal', IB_ACCOUNT_ID: 'nuuixl118' }),
      ).toThrow(/IB_ACCOUNT_ID: must be an IB account id/);
    });

    it('accepts live and paper account ids', () => {
      expect(validateConfig({ IB_ACCOUNT_ID: 'U1234567' }).IB_ACCOUNT_ID).toBe('U1234567');
      expect(validateConfig({ IB_ACCOUNT_ID: ' DU1234567 ' }).IB_ACCOUNT_ID).toBe('DU1234567');
    });

    it('is required whenever IB is bound, so no IB read can go unfiltered', () => {
      expect(() => validateConfig({ IB_HOST: 'host.docker.internal' })).toThrow(
        /IB_ACCOUNT_ID: is required when IB_HOST is set/,
      );
      expect(() =>
        validateConfig({ IB_HOST: 'host.docker.internal', IB_ACCOUNT_ID: '  ' }),
      ).toThrow(/IB_ACCOUNT_ID/);
    });
  });
});
