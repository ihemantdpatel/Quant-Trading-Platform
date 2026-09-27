/**
 * Root shell tests.
 *
 * The root layout holds what spans accounts. The properties pinned here:
 *
 * - **Kill-all is on screen on every route, even with every backend down** —
 *   it is the only kill control on `/backtest`, which belongs to no account.
 * - **Every configured account is listed**, an unreachable one included and
 *   disabled, so "unreachable" never looks like "not configured".
 *
 * The layout renders `<html>`/`<body>`, so these tests assert against
 * `document.body` content rather than a container subtree.
 */

import { render, screen, within } from '@testing-library/react';
import RootLayout from './layout';
import { loadAccounts, type AccountEntry } from './lib/api';

jest.mock('./lib/api', () => {
  const actual = jest.requireActual('./lib/api');
  return { ...actual, loadAccounts: jest.fn() };
});

jest.mock('./actions', () => ({
  killAllAccounts: jest.fn().mockResolvedValue({ ok: true, message: 'ok', outcomes: [] }),
}));

jest.mock('next/navigation', () => ({
  usePathname: () => '/accounts/nuuixl118',
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
}));

// Its own suite covers it; the shell's job is only to place it.
jest.mock('./components/AutoRefresh', () => ({ AutoRefresh: () => null }));

const mockAccounts = loadAccounts as jest.MockedFunction<typeof loadAccounts>;

function entry(alias: string | null, overrides: Partial<AccountEntry> = {}): AccountEntry {
  return {
    url: `http://${alias ?? 'down'}:3000`,
    account:
      alias === null
        ? null
        : {
            alias,
            label: alias,
            ibAccountId: 'DU•••567',
            mode: 'PAPER',
            allowedModes: ['PAPER'],
            broker: { name: 'ib', connected: true },
            halted: false,
          },
    error: alias === null ? 'connect ECONNREFUSED' : null,
    ...overrides,
  };
}

/**
 * React warns that `<html>` cannot nest in the `<div>` RTL mounts into. That is
 * inherent to rendering a root layout in isolation and says nothing about the
 * component, so it is silenced here rather than left to look like a defect.
 */
beforeAll(() => {
  const original = console.error;
  jest.spyOn(console, 'error').mockImplementation((...args) => {
    if (typeof args[0] === 'string' && args[0].includes('cannot be a child of')) {
      return;
    }
    original(...args);
  });
});

afterAll(() => {
  jest.restoreAllMocks();
});

async function renderLayout(children: React.ReactNode = <div />) {
  render(await RootLayout({ children }));
}

describe('RootLayout', () => {
  it('lists every account, keeping an unreachable one visible but unselectable', async () => {
    mockAccounts.mockResolvedValue([entry('nuuixl118'), entry(null)]);

    await renderLayout();

    const switcher = screen.getByRole('combobox', { name: /switch account/i });
    const options = within(switcher).getAllByRole('option');

    expect(options.map((option) => option.textContent)).toEqual([
      'nuuixl118 (DU•••567) · PAPER',
      'http://down:3000 — unreachable',
    ]);
    expect(options[1]).toBeDisabled();
    expect(switcher).toHaveValue('nuuixl118');
  });

  it('badges the mode of the account on screen', async () => {
    mockAccounts.mockResolvedValue([entry('nuuixl118')]);

    await renderLayout();

    expect(screen.getByTestId('account-mode')).toHaveTextContent('PAPER');
    expect(screen.getByTestId('account-health')).toHaveAttribute('title', 'healthy');
  });

  it('marks a halted account in the switcher', async () => {
    mockAccounts.mockResolvedValue([
      entry('nuuixl118', {
        account: { ...entry('nuuixl118').account!, halted: true },
      }),
    ]);

    await renderLayout();

    expect(screen.getByTestId('account-health')).toHaveAttribute('title', 'halted');
    expect(screen.getByRole('option', { name: /halted/ })).toBeInTheDocument();
  });

  it('keeps kill-all on screen even when no backend answers', async () => {
    mockAccounts.mockResolvedValue([entry(null)]);

    await renderLayout();

    expect(screen.getByRole('button', { name: /kill all accounts/i })).toBeInTheDocument();
  });

  it('offers account creation from every route, even with every backend down', async () => {
    mockAccounts.mockResolvedValue([entry(null)]);

    await renderLayout();

    expect(screen.getByRole('link', { name: 'Add account' })).toHaveAttribute(
      'href',
      '/accounts/new',
    );
  });

  it('renders the page beneath the shell', async () => {
    mockAccounts.mockResolvedValue([entry('nuuixl118')]);

    await renderLayout(<p>execution tab</p>);

    expect(screen.getByText('execution tab')).toBeInTheDocument();
  });
});
