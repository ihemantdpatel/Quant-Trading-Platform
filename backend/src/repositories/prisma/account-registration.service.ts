/**
 * Registers this daemon's account and pins its alias to its IB account id.
 *
 * Every per-account row carries the alias; the IB id lives only in the daemon's
 * environment. That split keeps the id out of git, but it means nothing in the
 * rows themselves says which *broker* account their lots came from. This is the
 * check that does: the first daemon bound to IB records the pairing, and any
 * later boot that pairs the alias with a different id — or claims an id another
 * alias already owns — is refused before a single bar is processed.
 *
 * **The pin is written only after IB confirms the account** (see
 * `confirmedByBroker`); boot only checks against a pin already recorded.
 *
 * Refusing matters because the failure is silent otherwise. A `.env` copied
 * from one account's daemon to another's would boot cleanly, reconcile this
 * alias's lots against a different account's position, and either halt every
 * symbol or — worse — find a coincidental match and trade on it.
 *
 * Runs from `RepositoriesModule`, which `EngineModule` imports, so Nest
 * completes it before `EngineModule.onModuleInit` starts the startup sequence:
 * the `Account` row every foreign key points at exists before anything writes.
 */

import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import {
  AccountRegistrationInput,
  planAccountRegistration,
} from '../../config/account-registration';
import { resolveActiveAccount } from '../../config/accounts.config';
import { AppConfigService } from '../../config/app-config.service';
import { StartupAssertionError } from '../../risk/startup-assertions';
import { ACCOUNT_ID } from '../account-scope';
import { PrismaService } from './prisma.service';

@Injectable()
export class AccountRegistrationService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    @Inject(ACCOUNT_ID) private readonly accountId: string,
  ) {}

  /**
   * At boot: ensure the row exists and refuse a configuration that contradicts
   * an existing pin. Writes no pin — IB has not been asked yet.
   */
  async onModuleInit(): Promise<void> {
    await this.register(false);
  }

  /**
   * After IB confirmed the login manages the configured account (a successful
   * connect — `EngineModule` calls this on `CONNECTED`). Pins the id if it is
   * not pinned yet. Refusal here cannot stop a process already running, so it
   * throws for the caller to report; boot has already refused every
   * contradiction it could see.
   */
  async confirmBrokerAccount(): Promise<void> {
    await this.register(true);
  }

  /* istanbul ignore next -- database I/O around the pure plan above */
  async register(confirmedByBroker: boolean): Promise<void> {
    const input: AccountRegistrationInput = {
      alias: this.accountId,
      label: resolveActiveAccount().label,
      ibAccountId: this.config.ibAccountId,
      confirmedByBroker,
    };

    const existing = await this.prisma.account.findUnique({ where: { id: input.alias } });
    const owner =
      input.ibAccountId === undefined
        ? null
        : await this.prisma.account.findUnique({ where: { ibAccountId: input.ibAccountId } });

    const plan = planAccountRegistration(input, existing, owner?.id ?? null);

    switch (plan.action) {
      case 'REFUSE':
        throw new StartupAssertionError([plan.failure]);
      case 'CREATE':
        await this.prisma.account.create({
          data: {
            id: input.alias,
            label: input.label,
            ibAccountId: plan.ibAccountId,
            createdAt: new Date().toISOString(),
          },
        });
        return;
      case 'UPDATE':
        await this.prisma.account.update({
          where: { id: input.alias },
          data: { ibAccountId: plan.ibAccountId, label: plan.label },
        });
        return;
      case 'NONE':
        return;
    }
  }
}
