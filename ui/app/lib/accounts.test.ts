/**
 * Account discovery and routing.
 *
 * The property that matters most: **a request for one account never reaches
 * another account's daemon.** Each daemon states its own identity on
 * `GET /account`, and every read and action resolves its target from those
 * answers afresh — an alias nobody claims, or two daemons claiming one alias,
 * is refused rather than guessed at.
 */

import {
  accountBackendUrls,
  accountFromPath,
  accountPath,
  loadAccounts,
  managedAccountUrl,
  pickDefaultAccount,
  post,
  type AccountEntry,
} from './api';

const ORIGINAL_ENV = process.env;

/** The reads that resolve which daemon trades what — never an action. */
function isDiscovery(url: string): boolean {
  return url.endsWith('/account') || url.endsWith('/accounts');
}

function account(alias: string, overrides: Record<string, unknown> = {}) {
  return {
    alias,
    label: alias,
    ibAccountId: 'DU•••567',
    mode: 'PAPER',
    allowedModes: ['PAPER'],
    broker: { name: 'ib', connected: true },
    halted: false,
    ...overrides,
  };
}

/** Each backend URL answers `/account` with the alias given, or fails when null. */
function daemons(byUrl: Record<string, string | null>): jest.Mock {
  return jest.fn(async (url: string) => {
    const base = Object.keys(byUrl).find((candidate) => url.startsWith(candidate));
    const alias = base === undefined ? null : byUrl[base];

    if (alias === null) {
      throw new Error('connect ECONNREFUSED');
    }

    if (url.endsWith('/account')) {
      return { ok: true, status: 200, json: async () => account(alias) };
    }

    return { ok: true, status: 200, json: async () => ({ servedBy: alias }) };
  });
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.ACCOUNT_BACKENDS;
  delete process.env.API_URL;
  delete process.env.NEXT_PUBLIC_API_URL;
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('accountBackendUrls', () => {
  it('parses a comma-separated list, trimming blanks, trailing slashes, and repeats', () => {
    expect(
      accountBackendUrls({
        ACCOUNT_BACKENDS: ' http://a:3000/ , ,http://b:3000,http://a:3000',
      }),
    ).toEqual(['http://a:3000', 'http://b:3000']);
  });

  it('falls back to the single API_URL that predates accounts', () => {
    expect(accountBackendUrls({ API_URL: 'http://backend:3000' })).toEqual(['http://backend:3000']);
    expect(accountBackendUrls({})).toEqual(['http://localhost:3000']);
  });
});

describe('loadAccounts', () => {
  it('asks every daemon who it is', async () => {
    process.env.ACCOUNT_BACKENDS = 'http://a,http://b';
    global.fetch = daemons({ 'http://a': 'nuuixl118', 'http://b': 'second' }) as never;

    const entries = await loadAccounts();

    expect(entries.map((entry) => [entry.url, entry.account?.alias, entry.error])).toEqual([
      ['http://a', 'nuuixl118', null],
      ['http://b', 'second', null],
    ]);
  });

  it('keeps an unreachable daemon in the list, marked, rather than dropping it', async () => {
    process.env.ACCOUNT_BACKENDS = 'http://a,http://down';
    global.fetch = daemons({ 'http://a': 'nuuixl118', 'http://down': null }) as never;

    const [, down] = await loadAccounts();

    expect(down.account).toBeNull();
    expect(down.error).toMatch(/ECONNREFUSED/);
  });

  it('flags two daemons claiming one account instead of picking one', async () => {
    process.env.ACCOUNT_BACKENDS = 'http://a,http://b';
    global.fetch = daemons({ 'http://a': 'nuuixl118', 'http://b': 'nuuixl118' }) as never;

    const entries = await loadAccounts();

    expect(entries.every((entry) => entry.error?.includes('more than one backend'))).toBe(true);
  });
});

describe('post', () => {
  it('sends an action to the daemon that trades the named account, and to no other', async () => {
    process.env.ACCOUNT_BACKENDS = 'http://a,http://b';
    const fetchMock = daemons({ 'http://a': 'nuuixl118', 'http://b': 'second' });
    global.fetch = fetchMock as never;

    const result = await post('second', '/kill-switch', { engaged: true });

    expect(result.ok).toBe(true);
    const actionCalls = fetchMock.mock.calls
      .map(([url]) => url as string)
      .filter((url) => !isDiscovery(url));
    expect(actionCalls).toEqual(['http://b/kill-switch']);
  });

  it('refuses an account no daemon claims, sending the action nowhere', async () => {
    process.env.ACCOUNT_BACKENDS = 'http://a';
    const fetchMock = daemons({ 'http://a': 'nuuixl118' });
    global.fetch = fetchMock as never;

    const result = await post('someone-else', '/kill-switch', { engaged: true });

    expect(result.ok).toBe(false);
    expect(result.error).toEqual({
      message: 'account "someone-else" is not served by any reachable backend',
    });
    expect(fetchMock.mock.calls.every(([url]) => isDiscovery(url as string))).toBe(true);
  });

  it('refuses an account two daemons claim', async () => {
    process.env.ACCOUNT_BACKENDS = 'http://a,http://b';
    const fetchMock = daemons({ 'http://a': 'nuuixl118', 'http://b': 'nuuixl118' });
    global.fetch = fetchMock as never;

    const result = await post('nuuixl118', '/kill-switch', { engaged: true });

    expect(result.ok).toBe(false);
    expect(fetchMock.mock.calls.every(([url]) => isDiscovery(url as string))).toBe(true);
  });
});

describe('pickDefaultAccount', () => {
  const entry = (alias: string | null, error: string | null = null): AccountEntry => ({
    url: `http://${alias ?? 'down'}`,
    account: alias === null ? null : (account(alias) as never),
    error,
  });

  it('returns to the account last viewed when it still answers', () => {
    expect(pickDefaultAccount([entry('a'), entry('b')], 'b')).toBe('b');
  });

  it('falls back to the first reachable account otherwise', () => {
    expect(pickDefaultAccount([entry(null, 'down'), entry('a'), entry('b')], 'gone')).toBe('a');
  });

  it('never lands on an unreachable or ambiguous account', () => {
    expect(
      pickDefaultAccount([entry('a', 'more than one backend'), entry(null, 'down')], 'a'),
    ).toBe(null);
  });
});

describe('account paths', () => {
  it('reads the account and the rest of the path', () => {
    expect(accountFromPath('/accounts/nuuixl118')).toEqual({ account: 'nuuixl118', rest: '' });
    expect(accountFromPath('/accounts/nuuixl118/parameters')).toEqual({
      account: 'nuuixl118',
      rest: '/parameters',
    });
  });

  it('decodes an encoded alias, and round-trips through accountPath', () => {
    const path = accountPath('paper two', '/parameters');

    expect(path).toBe('/accounts/paper%20two/parameters');
    expect(accountFromPath(path)).toEqual({ account: 'paper two', rest: '/parameters' });
  });

  it('is null for a page that belongs to no account', () => {
    expect(accountFromPath('/backtest')).toBeNull();
    expect(accountFromPath('/')).toBeNull();
  });
});

describe('dashboard-created accounts', () => {
  /** The primary lists `managed` on `/accounts`; every URL answers `/account` by port. */
  function withRegistry(managed: unknown, byUrl: Record<string, string | null>): jest.Mock {
    const probe = daemons(byUrl);
    return jest.fn(async (url: string) => {
      if (url === 'http://backend:3000/accounts') {
        if (managed instanceof Error) {
          throw managed;
        }
        return { ok: true, status: 200, json: async () => managed };
      }
      return probe(url);
    });
  }

  beforeEach(() => {
    process.env.API_URL = 'http://backend:3000';
  });

  it('builds a created account’s URL from the primary’s host and its own port', () => {
    expect(managedAccountUrl('http://backend:3000', 3101)).toBe('http://backend:3101');
    expect(managedAccountUrl('http://localhost:3000/', 3102)).toBe('http://localhost:3102');
  });

  it('discovers each created account’s daemon alongside the configured ones', async () => {
    global.fetch = withRegistry([{ alias: 'second', port: 3101 }], {
      'http://backend:3000': 'nuuixl118',
      'http://backend:3101': 'second',
    }) as never;

    const entries = await loadAccounts();

    expect(entries.map((entry) => [entry.url, entry.account?.alias])).toEqual([
      ['http://backend:3000', 'nuuixl118'],
      ['http://backend:3101', 'second'],
    ]);
  });

  it('lists a created account whose daemon is not up yet as unreachable, not absent', async () => {
    global.fetch = withRegistry([{ alias: 'second', port: 3101 }], {
      'http://backend:3000': 'nuuixl118',
      'http://backend:3101': null,
    }) as never;

    const [, second] = await loadAccounts();

    expect(second.url).toBe('http://backend:3101');
    expect(second.account).toBeNull();
  });

  it.each([
    ['cannot be read', new Error('ECONNREFUSED')],
    ['is not a list', { message: 'Cannot GET /accounts' }],
    ['holds a row with no port', [{ alias: 'second' }]],
  ])('still lists the configured backends when the registry %s', async (_, managed) => {
    global.fetch = withRegistry(managed, { 'http://backend:3000': 'nuuixl118' }) as never;

    expect((await loadAccounts()).map((entry) => entry.url)).toEqual(['http://backend:3000']);
  });

  it('reads the create-account page as no account', () => {
    expect(accountFromPath('/accounts/new')).toBeNull();
  });
});
