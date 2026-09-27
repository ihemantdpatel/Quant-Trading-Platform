import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AccountSwitcher } from './AccountSwitcher';
import type { AccountEntry } from '../lib/api';

const push = jest.fn();
let pathname = '/accounts/nuuixl118/parameters';

jest.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push }),
}));

function entry(alias: string, overrides: Partial<NonNullable<AccountEntry['account']>> = {}) {
  return {
    url: `http://${alias}:3000`,
    account: {
      alias,
      label: alias,
      ibAccountId: null,
      mode: 'PAPER' as const,
      allowedModes: ['PAPER' as const],
      broker: { name: 'ib', connected: true },
      halted: false,
      ...overrides,
    },
    error: null,
  };
}

beforeEach(() => {
  push.mockReset();
  pathname = '/accounts/nuuixl118/parameters';
});

describe('AccountSwitcher', () => {
  it('keeps the operator on the same tab of the account they switch to', async () => {
    const user = userEvent.setup();
    render(<AccountSwitcher accounts={[entry('nuuixl118'), entry('second')]} />);

    await user.selectOptions(screen.getByRole('combobox', { name: /switch account/i }), 'second');

    expect(push).toHaveBeenCalledWith('/accounts/second/parameters');
  });

  it("lands on the account's Execution tab from a page with no account", async () => {
    pathname = '/backtest';
    const user = userEvent.setup();
    render(<AccountSwitcher accounts={[entry('nuuixl118'), entry('second')]} />);

    await user.selectOptions(screen.getByRole('combobox', { name: /switch account/i }), 'second');

    expect(push).toHaveBeenCalledWith('/accounts/second');
  });

  it('says so when the account in the URL is not among those that answered', () => {
    pathname = '/accounts/gone';
    render(<AccountSwitcher accounts={[entry('nuuixl118')]} />);

    expect(screen.getByRole('option', { name: 'gone — not available' })).toBeInTheDocument();
  });

  it('shows a LIVE account in a way that cannot be mistaken for paper', () => {
    pathname = '/accounts/live';
    render(<AccountSwitcher accounts={[entry('live', { mode: 'LIVE' })]} />);

    expect(screen.getByTestId('account-mode')).toHaveTextContent('LIVE');
    expect(screen.getByTestId('account-mode').className).toMatch(/bg-red-600/);
  });

  it('marks an account whose broker is disconnected', () => {
    pathname = '/accounts/nuuixl118';
    render(
      <AccountSwitcher
        accounts={[entry('nuuixl118', { broker: { name: 'ib', connected: false } })]}
      />,
    );

    expect(screen.getByTestId('account-health')).toHaveAttribute('title', 'broker disconnected');
  });
});
