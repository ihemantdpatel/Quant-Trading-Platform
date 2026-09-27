/**
 * The Prisma registry of dashboard-created accounts. See
 * `AccountDefinitionRepository` for why it is not account-scoped.
 *
 * `toStoredAccountDefinition` is exported because the supervisor reads the same
 * table outside Nest, and one mapping keeps the two readers from disagreeing
 * about what a row means.
 */

import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { StoredAccountDefinition } from '../../config/account-definition';
import { ExecutionMode } from '../../config/execution-mode';
import { LossBasis } from '../../risk/risk.config';
import {
  AccountDefinitionConflictError,
  AccountDefinitionRepository,
} from '../repository.interfaces';
import { toDecimal, toNumber } from './decimal';
import { PrismaService } from './prisma.service';

type AccountDefinitionRow = Prisma.AccountDefinitionGetPayload<object>;

export function toStoredAccountDefinition(row: AccountDefinitionRow): StoredAccountDefinition {
  const capital = (row.symbolCapital ?? {}) as Record<string, unknown>;

  return {
    alias: row.alias,
    label: row.label,
    mode: row.executionMode as ExecutionMode,
    currency: row.currency,
    equity: toNumber(row.equity),
    symbolCapital: Object.fromEntries(
      Object.entries(capital).map(([symbol, amount]) => [symbol, Number(amount)]),
    ),
    dailyLossThreshold: toNumber(row.dailyLossThreshold),
    dailyLossBasis: row.dailyLossBasis as LossBasis,
    ibAccountId: row.ibAccountId,
    ibClientId: row.ibClientId,
    port: row.port,
    createdAt: row.createdAt,
  };
}

/** Every definition, oldest first. Shared with the supervisor. */
export async function readAccountDefinitions(
  prisma: PrismaClient,
): Promise<StoredAccountDefinition[]> {
  const rows = await prisma.accountDefinition.findMany({
    orderBy: [{ createdAt: 'asc' }, { alias: 'asc' }],
  });

  return rows.map(toStoredAccountDefinition);
}

@Injectable()
export class PrismaAccountDefinitionRepository implements AccountDefinitionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<StoredAccountDefinition[]> {
    return readAccountDefinitions(this.prisma);
  }

  async findRegisteredAccounts(): Promise<{ id: string; ibAccountId: string | null }[]> {
    return this.prisma.account.findMany({ select: { id: true, ibAccountId: true } });
  }

  /* istanbul ignore next -- database I/O; covered by the database suite */
  async create(definition: StoredAccountDefinition, reason: string | null): Promise<void> {
    try {
      await this.prisma.$transaction([
        this.prisma.accountDefinition.create({
          data: {
            alias: definition.alias,
            label: definition.label,
            executionMode: definition.mode,
            currency: definition.currency,
            equity: toDecimal(definition.equity),
            symbolCapital: definition.symbolCapital,
            dailyLossThreshold: toDecimal(definition.dailyLossThreshold),
            dailyLossBasis: definition.dailyLossBasis,
            ibAccountId: definition.ibAccountId,
            ibClientId: definition.ibClientId,
            port: definition.port,
            createdAt: definition.createdAt,
          },
        }),
        this.prisma.accountDefinitionChange.create({
          data: {
            alias: definition.alias,
            action: 'CREATED',
            definition: definition as unknown as Prisma.InputJsonObject,
            reason,
            timestamp: definition.createdAt,
          },
        }),
      ]);
    } catch (error) {
      // Two creations racing past the service's own checks: the unique keys
      // decide, and the loser is told why rather than seeing a raw P2002.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AccountDefinitionConflictError(
          `account "${definition.alias}" conflicts with an existing account (${String(error.meta?.target ?? 'unique key')}); try again`,
        );
      }

      throw error;
    }
  }
}
