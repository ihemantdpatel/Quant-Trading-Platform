import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from './config.schema';
import { ExecutionMode } from './execution-mode';

/** Resolved SMTP settings for the P&L emails. */
export interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  to: string[];
}

/**
 * Typed accessor over Nest's ConfigService. Call sites get `ExecutionMode`
 * rather than `string | undefined`, so no consumer has to re-validate or
 * defend against a missing value.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  /** The `accounts.config.ts` key this daemon trades. Validated at boot. */
  get accountAlias(): string {
    return this.config.get('ACCOUNT_ALIAS', { infer: true });
  }

  /**
   * The IB account id this daemon trades, or `undefined` under the mock broker,
   * where there is no account to name. Validated as present whenever IB is bound.
   */
  get ibAccountId(): string | undefined {
    return this.config.get('IB_ACCOUNT_ID', { infer: true });
  }

  get executionMode(): ExecutionMode {
    return this.config.get('EXECUTION_MODE', { infer: true });
  }

  get port(): number {
    return this.config.get('PORT', { infer: true });
  }

  /** MySQL DSN, or undefined when durable storage is not configured. */
  get databaseUrl(): string | undefined {
    return this.config.get('DATABASE_URL', { infer: true });
  }

  /**
   * Whether repositories are durable.
   *
   * The presence of a `DATABASE_URL` is the whole switch — there is no separate
   * "use Prisma" flag to drift out of agreement with it, and no in-between
   * state where the engine believes it is persisting to a database it was never
   * given (`repositories.module.ts`).
   */
  get hasDurableStorage(): boolean {
    return this.databaseUrl !== undefined;
  }

  /**
   * IB Gateway host, or undefined when no gateway is configured (Story 10).
   *
   * **A blank value is normalized to `undefined`.** Compose passes `IB_HOST:
   * ${IB_HOST:-}`, so an unset variable arrives as `''` rather than absent, and
   * `ConfigService.get` reads the raw environment — an empty string here would
   * make `usesIbBroker` true and bind the IB adapter with no host to reach,
   * leaving `docker compose up` with no `.env` stuck on a gateway that cannot
   * connect. Normalizing at the accessor keeps every reader of this switch in
   * agreement.
   */
  get ibHost(): string | undefined {
    const host = this.config.get('IB_HOST', { infer: true });
    return typeof host === 'string' && host.trim() === '' ? undefined : host;
  }

  get ibPort(): number {
    return this.config.get('IB_PORT', { infer: true });
  }

  get ibClientId(): number {
    return this.config.get('IB_CLIENT_ID', { infer: true });
  }

  /**
   * Whether the engine trades through IB rather than the mock broker.
   *
   * The presence of `IB_HOST` is the whole switch, mirroring
   * `hasDurableStorage` — see the note on the schema field. This says nothing
   * about whether orders may be *submitted*: that remains `EXECUTION_MODE`'s
   * decision, and `SHADOW` submits nothing regardless of which broker is bound.
   */
  get usesIbBroker(): boolean {
    return this.ibHost !== undefined;
  }

  /**
   * SMTP settings, or `null` when email is not configured. The schema has
   * already refused a partial configuration, so `null` means "deliberately off".
   */
  get email(): EmailConfig | null {
    return resolveEmailConfig({
      SMTP_HOST: this.config.get('SMTP_HOST', { infer: true }),
      SMTP_PORT: this.config.get('SMTP_PORT', { infer: true }),
      SMTP_SECURE: this.config.get('SMTP_SECURE', { infer: true }),
      SMTP_USER: this.config.get('SMTP_USER', { infer: true }),
      SMTP_PASS: this.config.get('SMTP_PASS', { infer: true }),
      EMAIL_FROM: this.config.get('EMAIL_FROM', { infer: true }),
      EMAIL_TO: this.config.get('EMAIL_TO', { infer: true }),
    });
  }
}

type EmailFields = Pick<
  AppConfig,
  'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_SECURE' | 'SMTP_USER' | 'SMTP_PASS' | 'EMAIL_FROM' | 'EMAIL_TO'
>;

/**
 * Resolves validated SMTP fields to an `EmailConfig`, or `null` when email is off.
 *
 * Blank means unset, as for `ibHost`: the validated value of a blank variable is
 * `undefined`, and `ConfigService.get` then falls through to the raw `''`
 * compose passes. `EMAIL_TO` is re-split for the same reason — a fall-through
 * returns the raw comma-separated string rather than the parsed list.
 */
export function resolveEmailConfig(fields: EmailFields): EmailConfig | null {
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  const raw: unknown = fields.EMAIL_TO;
  const to = (Array.isArray(raw) ? (raw as string[]) : (text(raw)?.split(',') ?? []))
    .map((address) => address.trim())
    .filter((address) => address !== '');
  const user = text(fields.SMTP_USER);
  const pass =
    typeof fields.SMTP_PASS === 'string' && fields.SMTP_PASS !== '' ? fields.SMTP_PASS : undefined;

  if (user === undefined || pass === undefined || to.length === 0) {
    return null;
  }

  return {
    host: text(fields.SMTP_HOST) ?? 'smtp.gmail.com',
    port: Number(fields.SMTP_PORT ?? 465),
    secure: fields.SMTP_SECURE !== false && String(fields.SMTP_SECURE) !== 'false',
    user,
    pass,
    from: text(fields.EMAIL_FROM) ?? user,
    to,
  };
}
