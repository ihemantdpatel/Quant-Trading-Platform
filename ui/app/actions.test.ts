/**
 * Server Actions that decide *which account* an action reaches.
 *
 * Driven through `fetch`, because the property is about where requests go:
 * an action with no account goes nowhere, and kill-all reaches every daemon
 * it can and reports, per account, the ones it could not.
 */

import { createAccount, killAllAccounts, setKillSwitch } from './actions';

jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }));

const ORIGINAL_ENV = process.env;

function daemons(byUrl: Record<string, string | null>): jest.Mock {
  return jest.fn(async (url: string) => {
    const base = Object.keys(byUrl).find((candidate) => url.startsWith(candidate));
    const alias = base === undefined ? null : byUrl[base];

    if (alias === null) {
      throw new Error('connect ECONNREFUSED');
    }

    if (url.endsWith('/account')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ alias, label: alias, broker: { connected: true }, halted: false }),
      };
    }

    return { ok: true, status: 200, json: async () => ({ engaged: true }) };
  });
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('an action with no account', () => {
  it('is refused and sends nothing, rather than defaulting to some account', async () => {
    const fetchMock = daemons({ 'http://a': 'nuuixl118' });
    global.fetch = fetchMock as never;
    process.env.ACCOUNT_BACKENDS = 'http://a';

    const result = await setKillSwitch(null, true);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no account selected/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('killAllAccounts', () => {
  it('engages every reachable account and names the one it could not reach', async () => {
    const fetchMock = daemons({ 'http://a': 'nuuixl118', 'http://b': 'second', 'http://c': null });
    global.fetch = fetchMock as never;
    process.env.ACCOUNT_BACKENDS = 'http://a,http://b,http://c';

    const result = await killAllAccounts('drill');

    expect(result.ok).toBe(false);
    expect(result.outcomes).toEqual([
      { target: 'nuuixl118', ok: true, message: 'kill switch engaged' },
      { target: 'second', ok: true, message: 'kill switch engaged' },
      { target: 'http://c', ok: false, message: 'NOT halted — connect ECONNREFUSED' },
    ]);

    const kills = fetchMock.mock.calls
      .filter(([url]) => (url as string).endsWith('/kill-switch'))
      .map(([url, init]) => [url, JSON.parse((init as RequestInit).body as string)]);

    expect(kills).toEqual([
      ['http://a/kill-switch', { engaged: true, reason: 'drill' }],
      ['http://b/kill-switch', { engaged: true, reason: 'drill' }],
    ]);
  });

  it('reports success only when every account was halted', async () => {
    global.fetch = daemons({ 'http://a': 'nuuixl118' }) as never;
    process.env.ACCOUNT_BACKENDS = 'http://a';

    const result = await killAllAccounts();

    expect(result.ok).toBe(true);
    expect(result.message).toBe('Kill switch engaged on all 1 account(s).');
  });
});

describe('createAccount', () => {
  const input = {
    alias: 'second',
    label: 'Second',
    mode: 'PAPER',
    ibAccountId: 'DU7654321',
    equity: 100_000,
    symbolCapital: { TQQQ: 25_000 },
    dailyLossThreshold: 3_000,
    dailyLossBasis: 'REALIZED_AND_UNREALIZED',
    reason: '',
  };

  it('posts to the primary backend — the account has no daemon yet', async () => {
    process.env.API_URL = 'http://primary:3000';
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ alias: 'second', mode: 'PAPER', ibClientId: 11 }),
    }));
    global.fetch = fetchMock as never;

    const result = await createAccount(input);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual([
      'http://primary:3000/accounts',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }),
    ]);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/"second" created/);
  });

  it('surfaces every reason the backend refused', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 422,
      json: async () => ({
        message: 'account not created',
        failures: ['alias "second" already exists'],
      }),
    })) as never;

    const result = await createAccount(input);

    expect(result).toEqual({
      ok: false,
      message: 'account not created',
      failures: ['alias "second" already exists'],
    });
  });
});
