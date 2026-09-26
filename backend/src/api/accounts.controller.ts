/**
 * Accounts created from the dashboard (`account-definition.ts`).
 *
 * Distinct from `GET /account` on `EngineController`, which is one daemon
 * describing itself. This is the registry every daemon can read: the list of
 * dashboard-created accounts the supervisor runs, and the one route that adds
 * to it.
 *
 * **Creating an account writes a row and nothing else.** No daemon is started
 * from here — the supervisor notices the row on its next poll and starts one,
 * in its own process, where it connects, reconciles, and trades behind the
 * same startup assertions, risk caps, and kill switch as every other account.
 * Nothing on this path submits, cancels, or reaches a broker.
 */

import {
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  Post,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AccountDefinitionInput,
  accountDefinitionInputSchema,
  planAccountDefinition,
  StoredAccountDefinition,
} from '../config/account-definition';
import { maskAccountId } from '../config/account-registration';
import { ACCOUNTS } from '../config/accounts.config';
import { AppConfigService } from '../config/app-config.service';
import { STORAGE_MODE, StorageMode } from '../repositories/repositories.module';
import {
  ACCOUNT_DEFINITION_REPOSITORY,
  AccountDefinitionConflictError,
  AccountDefinitionRepository,
} from '../repositories/repository.interfaces';
import { DIP_LADDER_SYMBOL } from '../strategies/strategies.module';

/** A definition as served: the IB id masked, as `GET /account` does. */
export type AccountDefinitionView = Omit<StoredAccountDefinition, 'ibAccountId'> & {
  ibAccountId: string | null;
};

function toView(definition: StoredAccountDefinition): AccountDefinitionView {
  return {
    ...definition,
    ibAccountId: definition.ibAccountId === null ? null : maskAccountId(definition.ibAccountId),
  };
}

@Controller('accounts')
export class AccountsController {
  constructor(
    @Inject(ACCOUNT_DEFINITION_REPOSITORY)
    private readonly definitions: AccountDefinitionRepository,
    private readonly appConfig: AppConfigService,
    @Inject(STORAGE_MODE) private readonly storageMode: StorageMode,
  ) {}

  @Get()
  async list(): Promise<AccountDefinitionView[]> {
    return (await this.definitions.findAll()).map(toView);
  }

  @Post()
  async create(@Body() body: unknown): Promise<AccountDefinitionView> {
    // The supervisor reads MySQL. Without it, a created account would be
    // reported as created and never start — a silent no-op on the one control
    // whose whole effect is to start something.
    if (this.storageMode !== 'DURABLE') {
      throw new ServiceUnavailableException({
        message: 'creating an account needs durable storage (DATABASE_URL) and the supervisor',
      });
    }

    const parsed = accountDefinitionInputSchema.safeParse(body);

    if (!parsed.success) {
      throw new UnprocessableEntityException({
        message: 'invalid account definition',
        failures: parsed.error.issues.map(
          (issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`,
        ),
      });
    }

    const input: AccountDefinitionInput = parsed.data;

    const [definitions, registeredAccounts] = await Promise.all([
      this.definitions.findAll(),
      this.definitions.findRegisteredAccounts(),
    ]);

    const plan = planAccountDefinition(input, {
      codeAliases: Object.keys(ACCOUNTS),
      registeredAccounts,
      definitions,
      servingIbAccountId: this.appConfig.ibAccountId,
      ibAccountIdRequired: this.appConfig.usesIbBroker,
      requiredSymbol: DIP_LADDER_SYMBOL,
      now: new Date().toISOString(),
    });

    if (!plan.ok) {
      throw new UnprocessableEntityException({
        message: 'account not created',
        failures: plan.failures,
      });
    }

    try {
      await this.definitions.create(plan.definition, input.reason ?? null);
    } catch (error) {
      if (error instanceof AccountDefinitionConflictError) {
        throw new ConflictException({ message: 'account not created', failures: [error.message] });
      }

      throw error;
    }

    return toView(plan.definition);
  }
}
