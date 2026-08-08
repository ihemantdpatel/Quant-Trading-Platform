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
});
