import { buildRiskConfig } from '../risk/risk.config';
import { evaluateStartupAssertions } from '../risk/startup-assertions';
import {
  ACCOUNTS,
  activeAccountAlias,
  checkAccountMode,
  DEFAULT_ACCOUNT_ALIAS,
  findAccount,
  resolveActiveAccount,
} from './accounts.config';
import { ExecutionMode } from './execution-mode';

describe('account registry', () => {
  it('keys every entry by its own alias, so a row owner and its registry entry cannot disagree', () => {
    for (const [key, account] of Object.entries(ACCOUNTS)) {
      expect(account.alias).toBe(key);
    }
  });

  it('holds the default account', () => {
    expect(findAccount(DEFAULT_ACCOUNT_ALIAS)).not.toBeNull();
  });

  it('never holds a raw IB account id — those stay in each daemon’s .env', () => {
    // IB ids look like DU1234567 / U1234567. The registry is committed; the id
    // must not be, so no field anywhere in it may look like one.
    expect(JSON.stringify(ACCOUNTS)).not.toMatch(/\bD?U\d{5,}\b/);
  });

  it('does not treat inherited object keys as accounts', () => {
    expect(findAccount('toString')).toBeNull();
    expect(findAccount('__proto__')).toBeNull();
  });

  describe('activeAccountAlias', () => {
    it('reads ACCOUNT_ALIAS, trimmed', () => {
      expect(activeAccountAlias({ ACCOUNT_ALIAS: '  nuuixl118 ' })).toBe('nuuixl118');
    });

    it('falls back to the default when unset or blank', () => {
      expect(activeAccountAlias({})).toBe(DEFAULT_ACCOUNT_ALIAS);
      expect(activeAccountAlias({ ACCOUNT_ALIAS: '   ' })).toBe(DEFAULT_ACCOUNT_ALIAS);
    });
  });

  describe('resolveActiveAccount', () => {
    it('returns the registry entry for a known alias', () => {
      expect(resolveActiveAccount({ ACCOUNT_ALIAS: 'nuuixl118' })).toBe(ACCOUNTS.nuuixl118);
    });

    it('returns an account that cannot trade for an unknown alias', () => {
      // Config validation refuses the alias at boot; this placeholder only
      // exists so module-level constants have something to import first.
      const account = resolveActiveAccount({ ACCOUNT_ALIAS: 'nobody' });

      expect(account.alias).toBe('nobody');
      expect(account.allowedModes).toEqual([]);
      expect(account.symbolCapital).toEqual({});

      const config = buildRiskConfig({
        accountEquity: account.equity,
        accountCurrency: account.currency,
        dailyLossThreshold: account.dailyLossThreshold,
        dailyLossBasis: account.dailyLossBasis,
      });

      expect(
        evaluateStartupAssertions(ExecutionMode.PAPER, config, {}, [], account).permitted,
      ).toBe(false);
    });
  });

  describe('checkAccountMode', () => {
    it('permits a mode the account lists', () => {
      expect(checkAccountMode(ACCOUNTS.nuuixl118, ExecutionMode.PAPER)).toBeNull();
    });

    it('refuses LIVE for the paper account, independently of allowLiveTrading', () => {
      expect(checkAccountMode(ACCOUNTS.nuuixl118, ExecutionMode.LIVE)).toMatch(
        /may not run in LIVE \(permitted: PAPER\)/,
      );
    });

    it('names "none" for an account that permits nothing', () => {
      expect(
        checkAccountMode(resolveActiveAccount({ ACCOUNT_ALIAS: 'nobody' }), ExecutionMode.PAPER),
      ).toMatch(/permitted: none/);
    });
  });

  it('refuses a LIVE boot of the paper account even with the live flag set', () => {
    const account = ACCOUNTS.nuuixl118;
    const config = buildRiskConfig({
      accountEquity: account.equity,
      accountCurrency: account.currency,
      dailyLossThreshold: account.dailyLossThreshold,
      dailyLossBasis: account.dailyLossBasis,
      allowLiveTrading: true,
    });

    const result = evaluateStartupAssertions(
      ExecutionMode.LIVE,
      config,
      { TQQQ: account.symbolCapital.TQQQ },
      ['USD'],
      account,
    );

    expect(result.permitted).toBe(false);
    expect(result.failures).toEqual([expect.stringContaining('may not run in LIVE')]);
  });
});
