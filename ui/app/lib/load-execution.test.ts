/**
 * `loadExecution` must not let one failed endpoint blank the whole tab.
 *
 * These reads were a single `Promise.all`, so any rejection discarded the
 * results that had already resolved. `/positions` is the one that fails in
 * normal operation — it is the only read here needing the broker — so an IB
 * Gateway that was down or not logged in emptied the lots, rungs, orders,
 * fills, and risk events too, none of which touch the broker at all.
 *
 * The dashboard is a control surface. Blanking it during an outage removes the
 * operator's view at exactly the moment they need it, which is why this is
 * pinned rather than left to the loader's shape.
 */

import { loadExecution } from './api';

// `/grid/lots` must precede `/lots` — both match `url.endsWith(...)` for a
// `/grid/lots` request, and `Array.find` takes the first hit, so the more
// specific path has to come first or every grid-lots request would be
// misidentified as a ladder-lots one.
const ENDPOINTS = [
  '/status',
  '/grid/lots',
  '/lots',
  '/rungs',
  '/positions',
  '/orders',
  '/fills',
  '/risk-events',
  '/strategies',
];

/**
 * Serves every endpoint a plausible body, failing only those named.
 *
 * Driven through `fetch` rather than by mocking the loader, because the
 * regression was in how the loader *combines* its reads — a mocked loader
 * would assert nothing about that.
 */
function mockFetch(failing: string[] = []): jest.Mock {
  return jest.fn(async (url: string) => {
    // The account probe that resolves which daemon trades `nuuixl118`.
    if (url.endsWith('/account')) {
      return { ok: true, status: 200, json: async () => ({ alias: 'nuuixl118', broker: {} }) };
    }

    const path = ENDPOINTS.find((endpoint) => url.endsWith(endpoint)) ?? '';

    if (failing.includes(path)) {
      return { ok: false, status: 503, json: async () => ({ message: 'broker unavailable' }) };
    }

    // `/status` is the only non-array body among these reads.
    const body = path === '/status' ? { mode: 'PAPER', broker: {}, halts: {} } : [{ path }];

    return { ok: true, status: 200, json: async () => body };
  });
}

describe('loadExecution', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps every other panel when /positions fails', async () => {
    global.fetch = mockFetch(['/positions']) as unknown as typeof fetch;

    const data = await loadExecution('nuuixl118');

    // The regression: these were all `[]` because one rejection threw away
    // seven resolved results.
    expect(data.lots).toHaveLength(1);
    expect(data.rungs).toHaveLength(1);
    expect(data.orders).toHaveLength(1);
    expect(data.fills).toHaveLength(1);
    expect(data.riskEvents).toHaveLength(1);
    expect(data.strategies).toHaveLength(1);
    expect(data.status).not.toBeNull();

    expect(data.positions).toEqual([]);
    expect(data.unavailable?.positions).toBe(true);
  });

  it('does not claim the backend is unreachable over a single failed read', async () => {
    global.fetch = mockFetch(['/positions']) as unknown as typeof fetch;

    const data = await loadExecution('nuuixl118');

    // `error` drives the BACKEND_UNREACHABLE banner. Firing it because one
    // endpoint is down would make it stop meaning anything — and a banner that
    // cries wolf on a control surface is worse than no banner.
    expect(data.error).toBeNull();
  });

  it('reports a total outage as an error', async () => {
    global.fetch = mockFetch(ENDPOINTS) as unknown as typeof fetch;

    const data = await loadExecution('nuuixl118');

    expect(data.error).not.toBeNull();
    expect(data.status).toBeNull();
    expect(data.lots).toEqual([]);
  });

  it('flags only the endpoints that actually failed', async () => {
    global.fetch = mockFetch(['/lots', '/fills']) as unknown as typeof fetch;

    const data = await loadExecution('nuuixl118');

    expect(data.unavailable).toEqual(
      expect.objectContaining({
        lots: true,
        fills: true,
        rungs: false,
        positions: false,
        status: false,
      }),
    );
  });

  it('reports nothing unavailable on a healthy load', async () => {
    global.fetch = mockFetch() as unknown as typeof fetch;

    const data = await loadExecution('nuuixl118');

    expect(data.error).toBeNull();
    expect(Object.values(data.unavailable ?? {}).every((failed) => failed === false)).toBe(true);
  });

  it('reads nothing at all for an account no daemon claims', async () => {
    const fetchMock = mockFetch();
    global.fetch = fetchMock as unknown as typeof fetch;

    const data = await loadExecution('someone-else');

    // Only the account probe went out: no panel may be filled from a daemon
    // that trades a different account.
    // Discovery only: who trades what (`/account`) and which accounts exist
    // (`/accounts`). No read of any account's state.
    expect(fetchMock.mock.calls.every(([url]) => /\/accounts?$/.test(url as string))).toBe(true);
    expect(data.lots).toEqual([]);
    expect(data.status).toBeNull();
    expect(data.error).toMatch(/account "someone-else" is not served by any reachable backend/);
  });
});
