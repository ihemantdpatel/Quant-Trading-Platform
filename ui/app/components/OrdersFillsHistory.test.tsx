/**
 * Orders & fills history tests.
 *
 * The property this component exists for: submitted orders and executed
 * fills are shown one tab at a time, never mixed in one list, and switching
 * tabs is the only way to move between them.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OrdersFillsHistory } from './OrdersFillsHistory';
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

describe('OrdersFillsHistory', () => {
  it('shows submitted orders by default, not fills', () => {
    render(<OrdersFillsHistory orders={[order()]} fills={[fill()]} mode="PAPER" />);

    expect(screen.getByTestId('order-row-co-1')).toBeInTheDocument();
    expect(screen.queryByTestId('fill-row-f-1')).not.toBeInTheDocument();
  });

  it('switches to fills when the Filled tab is selected', async () => {
    const user = userEvent.setup();
    render(<OrdersFillsHistory orders={[order()]} fills={[fill()]} mode="PAPER" />);

    await user.click(screen.getByRole('tab', { name: /^filled/i }));

    expect(screen.getByTestId('fill-row-f-1')).toBeInTheDocument();
    expect(screen.queryByTestId('order-row-co-1')).not.toBeInTheDocument();
  });

  it('reports the counts of each list in its tab label', () => {
    render(
      <OrdersFillsHistory
        orders={[order(), order({ clientOrderId: 'co-2' })]}
        fills={[fill()]}
        mode="PAPER"
      />,
    );

    expect(screen.getByRole('tab', { name: 'Submitted (2)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Filled (1)' })).toBeInTheDocument();
  });

  it('marks the active tab via aria-selected', async () => {
    const user = userEvent.setup();
    render(<OrdersFillsHistory orders={[order()]} fills={[fill()]} mode="PAPER" />);

    expect(screen.getByRole('tab', { name: /^submitted/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: /^filled/i })).toHaveAttribute('aria-selected', 'false');

    await user.click(screen.getByRole('tab', { name: /^filled/i }));

    expect(screen.getByRole('tab', { name: /^filled/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('renders order side, quantity, symbol, limit, and status', () => {
    render(<OrdersFillsHistory orders={[order()]} fills={[]} mode="PAPER" />);

    const row = screen.getByTestId('order-row-co-1');
    expect(within(row).getByText('BUY')).toBeInTheDocument();
    expect(row).toHaveTextContent('10 TQQQ @ $95.00');
    expect(row).toHaveTextContent('SUBMITTED');
  });

  it('renders fill quantity, price, and timestamp', async () => {
    const user = userEvent.setup();
    render(<OrdersFillsHistory orders={[]} fills={[fill()]} mode="PAPER" />);

    await user.click(screen.getByRole('tab', { name: /^filled/i }));

    const row = screen.getByTestId('fill-row-f-1');
    expect(row).toHaveTextContent('FILL 4 @ $95.00');
    expect(row).toHaveTextContent('2024-03-04T09:51:00-05:00');
  });

  it('explains an empty Submitted tab in SHADOW as the mode, not a fault', () => {
    render(<OrdersFillsHistory orders={[]} fills={[]} mode="SHADOW" />);

    expect(screen.getByText(/SHADOW logs full order payloads/i)).toBeInTheDocument();
  });

  it('explains an empty Filled tab in SHADOW as the mode, not a fault', async () => {
    const user = userEvent.setup();
    render(<OrdersFillsHistory orders={[]} fills={[]} mode="SHADOW" />);

    await user.click(screen.getByRole('tab', { name: /^filled/i }));

    expect(screen.getByText(/SHADOW submits nothing, so nothing can fill/i)).toBeInTheDocument();
  });

  it('shows a plain empty state outside SHADOW', () => {
    render(<OrdersFillsHistory orders={[]} fills={[]} mode="PAPER" />);

    expect(screen.getByText(/no orders yet/i)).toBeInTheDocument();
  });
});
