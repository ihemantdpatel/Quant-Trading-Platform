/**
 * The create-account form. What matters: it sends what the operator typed —
 * the ladder allocation keyed by the traded symbol, numbers as numbers — and it
 * shows every reason the backend refused, since those are the whole feedback.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NewAccountForm } from './NewAccountForm';

const createAccount = jest.fn();

jest.mock('../../actions', () => ({
  createAccount: (...args: unknown[]) => createAccount(...args),
}));

beforeEach(() => {
  createAccount.mockReset();
  createAccount.mockResolvedValue({ ok: true, message: 'Account "second" created' });
});

async function fill(): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Alias'), 'second');
  await user.type(screen.getByLabelText('Label'), 'Second paper');
  await user.type(screen.getByLabelText('IB account id'), 'DU7654321');
  await user.type(screen.getByLabelText('Equity (USD)'), '100000');
  await user.type(screen.getByLabelText('TQQQ allocation (USD)'), '25000');
  await user.type(screen.getByLabelText('Daily loss threshold (USD)'), '3000');
}

describe('NewAccountForm', () => {
  it('submits the account with the ladder allocation keyed by symbol', async () => {
    render(<NewAccountForm />);
    await fill();
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(createAccount).toHaveBeenCalledWith({
      alias: 'second',
      label: 'Second paper',
      mode: 'PAPER',
      ibAccountId: 'DU7654321',
      equity: 100_000,
      symbolCapital: { TQQQ: 25_000 },
      dailyLossThreshold: 3_000,
      dailyLossBasis: 'REALIZED_AND_UNREALIZED',
      reason: '',
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Account "second" created');
  });

  it('lists every reason a creation was refused', async () => {
    createAccount.mockResolvedValue({
      ok: false,
      message: 'account not created',
      failures: ['alias "second" already exists', 'IB account DU•••321 is already traded'],
    });

    render(<NewAccountForm />);
    await fill();
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('already exists');
    expect(status).toHaveTextContent('already traded');
  });

  it('warns that a LIVE account will not boot before Story 15', async () => {
    render(<NewAccountForm />);
    expect(screen.queryByRole('note')).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText('Mode'), 'LIVE');

    expect(screen.getByRole('note')).toHaveTextContent(/refuse to boot LIVE/);
  });
});
