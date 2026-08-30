/**
 * Pending-orders panel.
 *
 * The two acting controls here create and destroy real orders, so these tests
 * are organised around the interaction rules that keep that safe: neither
 * button is reachable before a check has run, neither fires without an explicit
 * confirmation, and neither offers to act on findings it will not actually
 * touch.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PendingOrders } from './PendingOrders';
import type { OrderDiagnosis } from '../lib/api';

const checkPendingOrders = jest.fn();
const placeMissingOrders = jest.fn();
const resolveDuplicateOrders = jest.fn();

jest.mock('../actions', () => ({
  checkPendingOrders: () => checkPendingOrders(),
  placeMissingOrders: () => placeMissingOrders(),
  resolveDuplicateOrders: () => resolveDuplicateOrders(),
}));

function diagnosis(overrides: Partial<OrderDiagnosis> = {}): OrderDiagnosis {
  return {
    ranAt: '2025-01-20T10:00:00.000-05:00',
    brokerReachable: true,
    reason: null,
    matched: [],
    unbacked: [],
    orphans: [],
    duplicates: [],
    missing: [],
    skippedSymbols: [],
    ...overrides,
  };
}

const MISSING_SELL = {
  symbol: 'TQQQ',
  strategyId: 'dip-ladder:TQQQ',
  side: 'SELL' as const,
  quantity: 100,
  limitPrice: 99.75,
  reason: 'lot-1 is held with no resting sell',
  lotId: 'lot-1',
  rungPrice: 95,
};

const RESOLVABLE_DUPLICATE = {
  symbol: 'TQQQ',
  side: 'BUY' as const,
  limitPrice: 95,
  tracked: ['mine'],
  untracked: ['extra'],
  resolvable: true,
};

beforeEach(() => {
  checkPendingOrders.mockReset();
  placeMissingOrders.mockReset();
  resolveDuplicateOrders.mockReset();
  placeMissingOrders.mockResolvedValue({ ok: true, message: 'Placed 1 order(s).' });
  resolveDuplicateOrders.mockResolvedValue({
    ok: true,
    message: 'Cancelled 1 duplicate order(s).',
  });
});

describe('PendingOrders', () => {
  it('offers only the check before anything has been examined', () => {
    render(<PendingOrders />);

    expect(screen.getByRole('button', { name: /check pending orders/i })).toBeInTheDocument();
    // The acting controls are not merely disabled — they are absent, because
    // there are no findings for them to act on yet.
    expect(screen.queryByRole('button', { name: /place/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /cancel \d/i })).not.toBeInTheDocument();
  });

  it('reports a clean book without offering to place anything', async () => {
    checkPendingOrders.mockResolvedValue({
      ok: true,
      message: '2 resting order(s) — all accounted for.',
      diagnosis: diagnosis({
        matched: [
          {
            clientOrderId: 'buy-1',
            symbol: 'TQQQ',
            side: 'BUY',
            quantity: 100,
            filledQuantity: 0,
            limitPrice: 95,
            claimedBy: 'rung 95.00',
          },
        ],
      }),
    });

    render(<PendingOrders />);
    await userEvent.click(screen.getByRole('button', { name: /check pending orders/i }));

    expect(await screen.findByText(/all accounted for/i)).toBeInTheDocument();
    // A flat, healthy ladder must not present a live "place orders" control.
    expect(screen.getByRole('button', { name: /place 0 missing/i })).toBeDisabled();
  });

  it('does not place without an explicit confirmation', async () => {
    checkPendingOrders.mockResolvedValue({
      ok: true,
      message: 'findings',
      diagnosis: diagnosis({ missing: [MISSING_SELL] }),
    });

    render(<PendingOrders />);
    await userEvent.click(screen.getByRole('button', { name: /check pending orders/i }));
    await userEvent.click(await screen.findByRole('button', { name: /place 1 missing/i }));

    // The first click only opens the confirmation.
    expect(placeMissingOrders).not.toHaveBeenCalled();
    expect(screen.getByText(/still passes the risk caps/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /confirm placement/i }));
    await waitFor(() => expect(placeMissingOrders).toHaveBeenCalledTimes(1));
  });

  it('does not cancel a duplicate without an explicit confirmation', async () => {
    checkPendingOrders.mockResolvedValue({
      ok: true,
      message: 'findings',
      diagnosis: diagnosis({ duplicates: [RESOLVABLE_DUPLICATE] }),
    });

    render(<PendingOrders />);
    await userEvent.click(screen.getByRole('button', { name: /check pending orders/i }));
    await userEvent.click(await screen.findByRole('button', { name: /cancel 1 duplicate/i }));

    expect(resolveDuplicateOrders).not.toHaveBeenCalled();
    expect(screen.getByText(/the order the ladder depends on is kept/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /confirm cancellation/i }));
    await waitFor(() => expect(resolveDuplicateOrders).toHaveBeenCalledTimes(1));
  });

  it('does not offer to cancel a duplicate group it cannot resolve', async () => {
    // The count on the button must reflect what will actually be cancelled. An
    // operator reading "cancel 1" over a group the system will refuse to touch
    // would conclude the control had failed.
    checkPendingOrders.mockResolvedValue({
      ok: true,
      message: 'findings',
      diagnosis: diagnosis({
        duplicates: [
          { ...RESOLVABLE_DUPLICATE, tracked: [], untracked: ['a', 'b'], resolvable: false },
        ],
      }),
    });

    render(<PendingOrders />);
    await userEvent.click(screen.getByRole('button', { name: /check pending orders/i }));

    expect(await screen.findByText(/must be resolved in TWS/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel 0 duplicate/i })).toBeDisabled();
  });

  it('directs an unbacked level to Reconcile rather than re-placing it', async () => {
    checkPendingOrders.mockResolvedValue({
      ok: true,
      message: 'findings',
      diagnosis: diagnosis({
        unbacked: [
          { symbol: 'TQQQ', clientOrderId: 'expired-1', rungPrice: 95, lotId: null, side: 'BUY' },
        ],
      }),
    });

    render(<PendingOrders />);
    await userEvent.click(screen.getByRole('button', { name: /check pending orders/i }));

    expect(await screen.findByText(/blocked by an order that is gone/i)).toBeInTheDocument();
    // The sentence is split by a <strong>, so match the element that owns the
    // whole text rather than a single text node.
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === 'P' &&
          Boolean(element.textContent?.match(/Press Reconcile to release these/i)),
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /place 0 missing/i })).toBeDisabled();
  });

  it('reports an orphan as something it will not cancel', async () => {
    checkPendingOrders.mockResolvedValue({
      ok: true,
      message: 'findings',
      diagnosis: diagnosis({
        orphans: [
          {
            clientOrderId: 'by-hand',
            symbol: 'TQQQ',
            side: 'BUY',
            quantity: 100,
            filledQuantity: 0,
            limitPrice: 88,
          },
        ],
      }),
    });

    render(<PendingOrders />);
    await userEvent.click(screen.getByRole('button', { name: /check pending orders/i }));

    expect(await screen.findByText(/Reported, never cancelled/i)).toBeInTheDocument();
  });

  it('shows an unreachable broker as a failure, not as an empty book', async () => {
    checkPendingOrders.mockResolvedValue({
      ok: false,
      message: 'The broker could not be reached, so nothing could be checked.',
      failures: ['socket closed'],
      diagnosis: diagnosis({ brokerReachable: false, reason: 'socket closed' }),
    });

    render(<PendingOrders />);
    await userEvent.click(screen.getByRole('button', { name: /check pending orders/i }));

    expect(await screen.findByText(/could not be reached/i)).toBeInTheDocument();
    // No findings panel, and therefore no way to act on a book nobody could read.
    expect(screen.queryByRole('button', { name: /place/i })).not.toBeInTheDocument();
  });

  it('clears stale findings after acting so a second action needs a fresh check', async () => {
    // Acting twice on one diagnosis is how a duplicate order gets placed.
    checkPendingOrders.mockResolvedValue({
      ok: true,
      message: 'findings',
      diagnosis: diagnosis({ missing: [MISSING_SELL] }),
    });

    render(<PendingOrders />);
    await userEvent.click(screen.getByRole('button', { name: /check pending orders/i }));
    await userEvent.click(await screen.findByRole('button', { name: /place 1 missing/i }));
    await userEvent.click(screen.getByRole('button', { name: /confirm placement/i }));

    await waitFor(() => expect(placeMissingOrders).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /place 1 missing/i })).not.toBeInTheDocument(),
    );
  });
});
