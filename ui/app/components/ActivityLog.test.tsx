/**
 * Pending-order panel tests (`PRD.md:379`).
 *
 * The properties asserted here are the ones that stop the panel lying about
 * live broker exposure:
 *
 * 1. **Only open orders appear.** A filled or cancelled order is history;
 *    showing it as pending would report exposure that no longer exists.
 * 2. **A partial shows its unfilled remainder**, not the size originally
 *    submitted — the remainder is what is still working at the broker.
 * 3. **The panel is not truncated.** The history log is capped at 12 rows, and
 *    the whole reason this panel is separate is that a resting order must not
 *    scroll out of view behind a busy session.
 */

import { render, screen, within } from '@testing-library/react';
import { ActivityLog } from './ActivityLog';
import type { Fill, Order } from '../lib/api';

function order(overrides: Partial<Order> = {}): Order {
  return {
    clientOrderId: 'co-1',
    brokerOrderId: 'ib-1',
    symbol: 'TQQQ',
    side: 'BUY',
    quantity: 10,
    limitPrice: 95,
    status: 'SUBMITTED',
    rejectReason: null,
    strategyId: 'dip-ladder',
    createdAt: '2024-03-04T09:50:00-05:00',
    ...overrides,
  };
}

function fill(overrides: Partial<Fill> = {}): Fill {
  return {
    clientOrderId: 'co-1',
    brokerOrderId: 'ib-1',
    fillId: 'f-1',
    symbol: 'TQQQ',
    side: 'BUY',
    quantity: 4,
    price: 95,
    commission: 1,
    timestamp: '2024-03-04T09:51:00-05:00',
    ...overrides,
  };
}

function renderLog(orders: Order[], fills: Fill[] = [], mode = 'PAPER') {
  render(<ActivityLog orders={orders} fills={fills} riskEvents={[]} mode={mode} />);
}

describe('ActivityLog pending orders', () => {
  it('lists an order resting at the broker with its side, quantity, and limit', () => {
    renderLog([order()]);

    const row = screen.getByTestId('pending-order-co-1');

    expect(within(row).getByText('BUY')).toBeInTheDocument();
    expect(row).toHaveTextContent('10 TQQQ @ $95.00');
    expect(row).toHaveTextContent('Working');
  });

  /*
    The distinction the panel exists for: terminal statuses carry no live
    exposure. Asserted per status rather than in aggregate so a regression names
    the status it broke on.
  */
  it.each(['FILLED', 'CANCELLED', 'REJECTED'] as const)('excludes a %s order', (status) => {
    renderLog([order({ status })]);

    expect(screen.queryByTestId('pending-order-co-1')).not.toBeInTheDocument();
    expect(screen.getByText(/no orders resting at the broker/i)).toBeInTheDocument();
  });

  it('counts a partially filled order as pending and shows the unfilled remainder', () => {
    renderLog([order({ status: 'PARTIALLY_FILLED' })], [fill()]);

    const row = screen.getByTestId('pending-order-co-1');

    // 6 remaining of 10, not the 10 originally submitted.
    expect(row).toHaveTextContent('6 TQQQ @ $95.00');
    expect(row).toHaveTextContent('4/10 filled');
    expect(row).toHaveTextContent('Partial');
  });

  it('sums multiple fills against one order', () => {
    renderLog(
      [order({ status: 'PARTIALLY_FILLED' })],
      [fill(), fill({ fillId: 'f-2', quantity: 3 })],
    );

    expect(screen.getByTestId('pending-order-co-1')).toHaveTextContent('3 TQQQ');
  });

  /*
    Fills belonging to a *different* order must not be attributed to this one —
    a naive total over all fills would understate the remainder and report less
    exposure than is actually working.
  */
  it('ignores fills belonging to another order', () => {
    renderLog(
      [order({ status: 'PARTIALLY_FILLED' })],
      [fill(), fill({ fillId: 'f-9', clientOrderId: 'co-other', quantity: 7 })],
    );

    expect(screen.getByTestId('pending-order-co-1')).toHaveTextContent('6 TQQQ');
  });

  it('renders every pending order rather than truncating like the history log', () => {
    const orders = Array.from({ length: 15 }, (_, i) =>
      order({ clientOrderId: `co-${i}`, limitPrice: 90 + i }),
    );

    renderLog(orders);

    expect(screen.getByTestId('pending-order-co-0')).toBeInTheDocument();
    expect(screen.getByTestId('pending-order-co-14')).toBeInTheDocument();
  });

  it('reports the pending count in the panel heading', () => {
    renderLog([order(), order({ clientOrderId: 'co-2', status: 'FILLED' })]);

    expect(screen.getByText('Pending orders (1)')).toBeInTheDocument();
  });

  /*
    SHADOW submits nothing, so an empty panel there is correct rather than a
    fault. Saying so is the same reasoning the order log already applies.
  */
  it('explains an empty panel in SHADOW as the mode, not a fault', () => {
    renderLog([], [], 'SHADOW');

    expect(screen.getByText(/SHADOW submits nothing/i)).toBeInTheDocument();
  });
});
