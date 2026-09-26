import { LossBasis } from '../risk/risk.config';
import {
  accountDefinitionInputSchema,
  DefinitionContext,
  MANAGED_CLIENT_ID_BASE,
  MANAGED_PORT_BASE,
  parseAccountDefinitionEnv,
  planAccountDefinition,
  StoredAccountDefinition,
  toAccountDefinition,
} from './account-definition';
import { environmentAccount, resolveActiveAccount } from './accounts.config';
import { validateConfig } from './config.schema';
import { ExecutionMode } from './execution-mode';

const FORM = {
  alias: 'second',
  label: 'Second paper account',
  mode: 'PAPER',
  ibAccountId: 'DU7654321',
  equity: 100_000,
  symbolCapital: { TQQQ: 25_000 },
  dailyLossThreshold: 3_000,
};

function input(overrides: Record<string, unknown> = {}) {
  return accountDefinitionInputSchema.parse({ ...FORM, ...overrides });
}

function context(overrides: Partial<DefinitionContext> = {}): DefinitionContext {
  return {
    codeAliases: ['nuuixl118'],
    registeredAccounts: [{ id: 'nuuixl118', ibAccountId: 'DU1111111' }],
    definitions: [],
    servingIbAccountId: 'DU1111111',
    ibAccountIdRequired: true,
    requiredSymbol: 'TQQQ',
    now: '2026-09-24T10:00:00.000Z',
    ...overrides,
  };
}

function stored(overrides: Partial<StoredAccountDefinition> = {}): StoredAccountDefinition {
  return {
    alias: 'third',
    label: 'Third',
    mode: ExecutionMode.PAPER,
    currency: 'USD',
    equity: 50_000,
    symbolCapital: { TQQQ: 10_000 },
    dailyLossThreshold: 2_000,
    dailyLossBasis: LossBasis.REALIZED_AND_UNREALIZED,
    ibAccountId: 'DU2222222',
    ibClientId: MANAGED_CLIENT_ID_BASE,
    port: MANAGED_PORT_BASE,
    createdAt: '2026-09-20T10:00:00.000Z',
    ...overrides,
  };
}

describe('account definition input', () => {
  it('accepts the form and defaults currency and loss basis', () => {
    const parsed = input();
    expect(parsed.currency).toBe('USD');
    expect(parsed.dailyLossBasis).toBe(LossBasis.REALIZED_AND_UNREALIZED);
  });

  it.each([
    ['an upper-case alias', { alias: 'Second' }],
    ['a one-character alias', { alias: 'a' }],
    ['the reserved alias "new"', { alias: 'new' }],
    ['SHADOW', { mode: 'SHADOW' }],
    ['a non-USD currency', { currency: 'CAD' }],
    ['zero equity', { equity: 0 }],
    ['a negative allocation', { symbolCapital: { TQQQ: -1 } }],
    ['a login name for the IB id', { ibAccountId: 'hdpatel' }],
  ])('refuses %s', (_, overrides) => {
    expect(accountDefinitionInputSchema.safeParse({ ...FORM, ...overrides }).success).toBe(false);
  });

  it('reads a blank IB id as none', () => {
    expect(input({ ibAccountId: '  ' }).ibAccountId).toBeNull();
  });

  it('accepts LIVE — the startup assertions, not the form, decide whether it can boot', () => {
    expect(input({ mode: 'LIVE' }).mode).toBe(ExecutionMode.LIVE);
  });
});

describe('planAccountDefinition', () => {
  it('allocates the first client id and port to the first account', () => {
    const plan = planAccountDefinition(input(), context());

    expect(plan).toEqual({
      ok: true,
      definition: expect.objectContaining({
        alias: 'second',
        ibClientId: MANAGED_CLIENT_ID_BASE,
        port: MANAGED_PORT_BASE,
        createdAt: '2026-09-24T10:00:00.000Z',
      }),
    });
  });

  it('steps client ids by two, leaving room for each daemon’s execution connection', () => {
    const plan = planAccountDefinition(
      input(),
      context({ definitions: [stored({ ibClientId: 13, port: 3102 })] }),
    );

    expect(plan.ok && plan.definition.ibClientId).toBe(15);
    expect(plan.ok && plan.definition.port).toBe(3103);
  });

  it.each([
    ['a code-registry alias', { alias: 'nuuixl118' }, {}, /accounts\.config\.ts/],
    ['an existing definition', { alias: 'third' }, { definitions: [stored()] }, /already exists/],
    [
      'an alias with rows from a hand-configured daemon',
      { alias: 'legacy' },
      { registeredAccounts: [{ id: 'legacy', ibAccountId: null }] },
      /trading records/,
    ],
    ['the primary’s IB id', { ibAccountId: 'DU1111111' }, {}, /already traded by "nuuixl118"/],
    [
      'another definition’s IB id',
      { ibAccountId: 'DU2222222' },
      { definitions: [stored()] },
      /already traded by "third"/,
    ],
    [
      'the serving daemon’s unpinned IB id',
      { ibAccountId: 'DU3333333' },
      { registeredAccounts: [], servingIbAccountId: 'DU3333333' },
      /this daemon/,
    ],
    ['no ladder allocation', { symbolCapital: { SOXL: 1 } }, {}, /TQQQ/],
    ['no IB id when IB is bound', { ibAccountId: '' }, {}, /IB account id is required/],
  ])('refuses %s', (_, overrides, contextOverrides, message) => {
    const plan = planAccountDefinition(input(overrides), context(contextOverrides));

    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.failures.join(' ')).toMatch(message);
  });

  it('allows no IB id under the mock broker', () => {
    expect(
      planAccountDefinition(input({ ibAccountId: '' }), context({ ibAccountIdRequired: false })).ok,
    ).toBe(true);
  });

  it('masks the IB id in a refusal', () => {
    const plan = planAccountDefinition(input({ ibAccountId: 'DU1111111' }), context());
    expect(!plan.ok && plan.failures.join(' ')).not.toContain('DU1111111');
  });
});

describe('ACCOUNT_DEFINITION', () => {
  const json = JSON.stringify(toAccountDefinition(stored()));

  it('round-trips a stored definition into the registry shape, with its one mode', () => {
    expect(parseAccountDefinitionEnv(json)).toEqual({
      alias: 'third',
      label: 'Third',
      allowedModes: [ExecutionMode.PAPER],
      currency: 'USD',
      equity: 50_000,
      symbolCapital: { TQQQ: 10_000 },
      dailyLossThreshold: 2_000,
      dailyLossBasis: LossBasis.REALIZED_AND_UNREALIZED,
    });
  });

  it.each([undefined, '', 'not json', '{"alias":"third"}'])('reads %p as no definition', (raw) => {
    expect(parseAccountDefinitionEnv(raw)).toBeNull();
  });

  it('is the active account when its alias is ACCOUNT_ALIAS', () => {
    const env = { ACCOUNT_ALIAS: 'third', ACCOUNT_DEFINITION: json };

    expect(environmentAccount(env)?.equity).toBe(50_000);
    expect(resolveActiveAccount(env).symbolCapital).toEqual({ TQQQ: 10_000 });
    expect(validateConfig(env).ACCOUNT_ALIAS).toBe('third');
  });

  it('is ignored, and refused, when its alias is not ACCOUNT_ALIAS', () => {
    const env = { ACCOUNT_ALIAS: 'fourth', ACCOUNT_DEFINITION: json };

    expect(environmentAccount(env)).toBeNull();
    expect(resolveActiveAccount(env).allowedModes).toEqual([]);
    expect(() => validateConfig(env)).toThrow(/ACCOUNT_DEFINITION: is not a valid account/);
  });

  it('cannot redefine a code-registry account', () => {
    const redefined = JSON.stringify({ ...toAccountDefinition(stored()), alias: 'nuuixl118' });
    const env = { ACCOUNT_ALIAS: 'nuuixl118', ACCOUNT_DEFINITION: redefined };

    expect(resolveActiveAccount(env).equity).not.toBe(50_000);
    expect(() => validateConfig(env)).toThrow(/must not be set for "nuuixl118"/);
  });
});
