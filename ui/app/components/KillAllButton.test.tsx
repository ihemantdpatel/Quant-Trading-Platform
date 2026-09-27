import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KillAllButton } from './KillAllButton';

const killAllAccounts = jest.fn();

jest.mock('../actions', () => ({
  killAllAccounts: (...args: unknown[]) => killAllAccounts(...args),
}));

beforeEach(() => {
  killAllAccounts.mockReset();
});

describe('KillAllButton', () => {
  it('asks for confirmation before halting every account', async () => {
    const user = userEvent.setup();
    render(<KillAllButton />);

    await user.click(screen.getByRole('button', { name: /kill all accounts/i }));

    expect(killAllAccounts).not.toHaveBeenCalled();
    expect(screen.getByText(/halt every account\?/i)).toBeInTheDocument();
  });

  it('can be backed out of without acting', async () => {
    const user = userEvent.setup();
    render(<KillAllButton />);

    await user.click(screen.getByRole('button', { name: /kill all accounts/i }));
    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(killAllAccounts).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /kill all accounts/i })).toBeInTheDocument();
  });

  it('lists an account that could not be halted, rather than reporting success', async () => {
    killAllAccounts.mockResolvedValue({
      ok: false,
      message: '1 of 2 account(s) could NOT be halted.',
      outcomes: [
        { target: 'nuuixl118', ok: true, message: 'kill switch engaged' },
        { target: 'http://down:3000', ok: false, message: 'NOT halted — backend unreachable' },
      ],
    });
    const user = userEvent.setup();
    render(<KillAllButton />);

    await user.click(screen.getByRole('button', { name: /kill all accounts/i }));
    await user.click(screen.getByRole('button', { name: /confirm kill all/i }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('could NOT be halted');
    expect(status).toHaveTextContent('http://down:3000 — NOT halted — backend unreachable');
    expect(status).toHaveTextContent('nuuixl118 — kill switch engaged');
  });
});
