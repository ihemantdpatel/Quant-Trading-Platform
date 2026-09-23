/**
 * Activity panel tests (`PRD.md:379`).
 *
 * Two kinds of property live here now that Pending orders, Orders & fills, and
 * Risk events are one tabbed panel rather than three:
 *
 * 1. **The tab switch itself** — Pending is the default view, and only one
 *    view's content is on screen at a time.
 * 2. **What the Pending tab shows**, which is the one that stops it lying
 *    about live broker exposure:
 *    - Only open orders appear. A filled or cancelled order is history;
 *      showing it as pending would report exposure that no longer exists.
 *    - A partial shows its unfilled remainder, not the size originally
 *      submitted — the remainder is what is still working at the broker.
 *    - The list is not truncated. The history tab is capped at 12 rows, and
 *      the whole reason Pending is separate is that a resting order must not
 *      scroll out of view behind a busy session.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActivityLog } from './ActivityLog';
import type { Fill, Order, RiskEvent } from '../lib/api';

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

function riskEvent(overrides: Partial<RiskEvent> = {}): RiskEvent {
  return {
    type: 'REJECTION',
    reason: 'CAPITAL_CAP',
    detail: 'capital cap breached',
    timestamp: '2024-03-04T09:52:00-05:00',
    approvedQuantity: null,
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

describe('ActivityLog tabs', () => {
  it('shows Pending orders by default', () => {
    render(<ActivityLog orders={[order()]} fills={[]} riskEvents={[riskEvent()]} mode="PAPER" />);

    expect(screen.getByTestId('pending-order-co-1')).toBeInTheDocument();
    expect(screen.queryByText('capital cap breached')).not.toBeInTheDocument();
  });

  it('switches to Orders & fills, showing submitted orders', async () => {
    const user = userEvent.setup();
    render(<ActivityLog orders={[order()]} fills={[]} riskEvents={[riskEvent()]} mode="PAPER" />);

    await user.click(screen.getByRole('tab', { name: /^orders & fills/i }));

    // Delegated to OrdersFillsHistory's own Submitted/Filled tabs, which
    // default to Submitted.
    expect(screen.getByTestId('order-row-co-1')).toBeInTheDocument();
    expect(screen.queryByTestId('pending-order-co-1')).not.toBeInTheDocument();
  });

  it('switches to Risk events', async () => {
    const user = userEvent.setup();
    render(<ActivityLog orders={[order()]} fills={[]} riskEvents={[riskEvent()]} mode="PAPER" />);

    await user.click(screen.getByRole('tab', { name: /^risk events/i }));

    expect(screen.getByText('capital cap breached')).toBeInTheDocument();
    expect(screen.queryByTestId('pending-order-co-1')).not.toBeInTheDocument();
  });

  it('reports the risk event count in its tab label', () => {
    render(
      <ActivityLog orders={[]} fills={[]} riskEvents={[riskEvent(), riskEvent()]} mode="PAPER" />,
    );

    expect(screen.getByRole('tab', { name: 'Risk events (2)' })).toBeInTheDocument();
  });

  it('marks the active tab via aria-selected', async () => {
    const user = userEvent.setup();
    render(<ActivityLog orders={[]} fills={[]} riskEvents={[]} mode="PAPER" />);

    expect(screen.getByRole('tab', { name: /^pending orders/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await user.click(screen.getByRole('tab', { name: /^risk events/i }));

    expect(screen.getByRole('tab', { name: /^risk events/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: /^pending orders/i })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('shows an empty state on Risk events when there are none', async () => {
    const user = userEvent.setup();
    render(<ActivityLog orders={[]} fills={[]} riskEvents={[]} mode="PAPER" />);

    await user.click(screen.getByRole('tab', { name: /^risk events/i }));

    expect(screen.getByText(/no rejections, resizes, or halts/i)).toBeInTheDocument();
  });
});
