import { validateConfig } from './config.schema';
import { ExecutionMode } from './execution-mode';

describe('validateConfig', () => {
  it('defaults EXECUTION_MODE to SHADOW when unset', () => {
    const config = validateConfig({});

    expect(config.EXECUTION_MODE).toBe(ExecutionMode.SHADOW);
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
      expect(validateConfig({ IB_HOST: 'host.docker.internal' }).IB_HOST).toBe(
        'host.docker.internal',
      );
    });
  });
});
