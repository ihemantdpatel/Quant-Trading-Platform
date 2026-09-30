import { resolveEmailConfig } from './app-config.service';
import { validateConfig } from './config.schema';

describe('resolveEmailConfig', () => {
  it('is null when email is not configured', () => {
    expect(resolveEmailConfig(validateConfig({}))).toBeNull();
  });

  it('resolves validated settings, defaulting the sender to the SMTP user', () => {
    const config = validateConfig({
      SMTP_USER: 'me@gmail.com',
      SMTP_PASS: 'app-password',
      EMAIL_TO: 'a@x.com,b@y.com',
    });

    expect(resolveEmailConfig(config)).toEqual({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      user: 'me@gmail.com',
      pass: 'app-password',
      from: 'me@gmail.com',
      to: ['a@x.com', 'b@y.com'],
    });
  });

  it('reads raw environment strings, which is what ConfigService falls through to', () => {
    // A blank variable validates to `undefined`, so `ConfigService.get` returns
    // the raw value instead — `''` for the blank, or the unsplit string.
    expect(
      resolveEmailConfig({
        SMTP_HOST: '' as never,
        SMTP_PORT: '587' as never,
        SMTP_SECURE: 'false' as never,
        SMTP_USER: 'me@gmail.com',
        SMTP_PASS: 'pw',
        EMAIL_FROM: '' as never,
        EMAIL_TO: 'a@x.com, b@y.com' as never,
      }),
    ).toEqual({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      user: 'me@gmail.com',
      pass: 'pw',
      from: 'me@gmail.com',
      to: ['a@x.com', 'b@y.com'],
    });
  });

  it('is null when a raw value is blank', () => {
    expect(
      resolveEmailConfig({
        SMTP_HOST: 'smtp.gmail.com',
        SMTP_PORT: 465,
        SMTP_SECURE: true,
        SMTP_USER: '' as never,
        SMTP_PASS: 'pw',
        EMAIL_FROM: undefined,
        EMAIL_TO: ['a@x.com'],
      }),
    ).toBeNull();
  });
});
