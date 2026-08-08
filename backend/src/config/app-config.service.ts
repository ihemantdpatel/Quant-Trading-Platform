import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from './config.schema';
import { ExecutionMode } from './execution-mode';

/**
 * Typed accessor over Nest's ConfigService. Call sites get `ExecutionMode`
 * rather than `string | undefined`, so no consumer has to re-validate or
 * defend against a missing value.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

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
}
