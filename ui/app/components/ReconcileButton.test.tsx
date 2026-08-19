/**
 * Manual reconcile control tests.
 *
 * Two properties matter here. First, the button must actually call through to
 * the backend — a control that reported "reconciled" without asking the broker
 * would leave an operator believing a stale rung was repaired when it was not.
 * Second, the confirmation must state the halt consequence *before* the run,
 * because this endpoint re-runs the lot-sum assertion and can stop a symbol
 * trading.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReconcileButton } from './ReconcileButton';

const reconcileNow = jest.fn();

jest.mock('../actions', () => ({
  reconcileNow: (...args: unknown[]) => reconcileNow(...args),
}));

beforeEach(() => {
  reconcileNow.mockReset();
  reconcileNow.mockResolvedValue({ ok: true, message: 'Reconciled 1 symbol(s) — clean.' });
});

describe('ReconcileButton', () => {
  it('does not reconcile until the operator confirms', async () => {
    render(<ReconcileButton />);

    await userEvent.click(screen.getByRole('button', { name: /reconcile now/i }));

    expect(reconcileNow).not.toHaveBeenCalled();
    expect(screen.getByText(/will be halted/i)).toBeInTheDocument();
  });

  it('calls the backend once confirmed', async () => {
    render(<ReconcileButton />);

    await userEvent.click(screen.getByRole('button', { name: /reconcile now/i }));
    await userEvent.click(screen.getByRole('button', { name: /confirm reconcile/i }));

    expect(reconcileNow).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('status')).toHaveTextContent(/clean/i);
  });

  it('abandons the run when cancelled', async () => {
    render(<ReconcileButton />);

    await userEvent.click(screen.getByRole('button', { name: /reconcile now/i }));
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(reconcileNow).not.toHaveBeenCalled();
    expect(screen.queryByText(/will be halted/i)).not.toBeInTheDocument();
  });

  it('reports halted symbols as a failure rather than a clean run', async () => {
    reconcileNow.mockResolvedValue({
      ok: false,
      message: 'Reconciled — 1 symbol(s) HALTED and will not trade until released.',
      failures: ['TQQQ'],
    });

    render(<ReconcileButton />);

    await userEvent.click(screen.getByRole('button', { name: /reconcile now/i }));
    await userEvent.click(screen.getByRole('button', { name: /confirm reconcile/i }));

    const status = await screen.findByRole('status');

    expect(status).toHaveTextContent(/HALTED/);
    expect(status).toHaveTextContent('TQQQ');
  });

  it('reports stale order rows corrected from the broker history', async () => {
    reconcileNow.mockResolvedValue({
      ok: true,
      message:
        'Reconciled 1 symbol(s) against the broker — clean. 2 stale order row(s) corrected from broker history.',
    });

    render(<ReconcileButton />);

    await userEvent.click(screen.getByRole('button', { name: /reconcile now/i }));
    await userEvent.click(screen.getByRole('button', { name: /confirm reconcile/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/2 stale order row\(s\) corrected/);
  });

  it('shows when the scheduled post-close job last ran', async () => {
    render(
      <ReconcileButton
        lastRun={{
          ranAt: '2025-01-20T16:15:00.000-05:00',
          symbols: ['TQQQ'],
          brokerReachable: true,
          ordersUpdated: 3,
        }}
      />,
    );

    expect(screen.getByText(/post-close job last ran/i)).toHaveTextContent(
      /3 order row\(s\) corrected/,
    );
  });

  it('says the ledger was left unchanged when the job could not reach the broker', async () => {
    // "Ran and found nothing" and "could not check" must not look alike.
    render(
      <ReconcileButton
        lastRun={{
          ranAt: '2025-01-20T16:15:00.000-05:00',
          symbols: ['TQQQ'],
          brokerReachable: false,
          ordersUpdated: 0,
        }}
      />,
    );

    expect(screen.getByText(/could not be reached/i)).toBeInTheDocument();
  });

  it('says nothing about a scheduled run that has not happened yet', async () => {
    render(<ReconcileButton />);

    expect(screen.queryByText(/post-close job last ran/i)).not.toBeInTheDocument();
  });

  it('states that nothing is traded by the run', async () => {
    render(<ReconcileButton />);

    await userEvent.click(screen.getByRole('button', { name: /reconcile now/i }));

    expect(screen.getByText(/no position is closed/i)).toBeInTheDocument();
  });
});
