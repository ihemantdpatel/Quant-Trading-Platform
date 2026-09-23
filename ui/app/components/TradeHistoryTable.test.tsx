/**
 * Trade history table component tests.
 *
 * Split out of `LotTable.test.tsx`: this table owns closed lots exclusively,
 * so its own realized P&L and fill/exit price pair for each cycle.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TradeHistoryTable } from './TradeHistoryTable';
import type { Lot } from '../lib/api';

function lot(overrides: Partial<Lot> = {}): Lot {
  return {
    id: 'TQQQ-lot-1',
    symbol: 'TQQQ',
    rungPrice: 95,
    fillPrice: 95,
    quantity: 10,
    openedAt: '2024-03-04T09:50:00-05:00',
    exitTarget: 99.75,
    status: 'CLOSED',
    closedAt: '2024-03-04T11:00:00-05:00',
    exitPrice: 99.75,
    realized: 47.5,
    ...overrides,
  };
}

describe('TradeHistoryTable', () => {
  it('renders fill price, exit price, quantity, held-for, and realized P&L', () => {
    render(<TradeHistoryTable lots={[lot()]} />);

    const row = screen.getByTestId('history-row-TQQQ-lot-1');

    expect(within(row).getByTestId('cell-fill')).toHaveTextContent('$95.00');
    expect(within(row).getByTestId('cell-exit')).toHaveTextContent('$99.75');
    expect(within(row).getByTestId('cell-qty')).toHaveTextContent('10');
    // Opened 09:50, closed 11:00 → 1h.
    expect(within(row).getByTestId('cell-held-for')).toHaveTextContent('1h');
    expect(within(row).getByTestId('cell-realized')).toHaveTextContent('$47.50');
  });

  it('excludes held lots from the table entirely', () => {
    render(
      <TradeHistoryTable
        lots={[
          lot({ id: 'closed' }),
          lot({ id: 'held', status: 'HELD', closedAt: null, exitPrice: null, realized: null }),
        ]}
      />,
    );

    expect(screen.getByTestId('history-row-closed')).toBeInTheDocument();
    expect(screen.queryByTestId('history-row-held')).not.toBeInTheDocument();
  });

  it('sums realized P&L across closed cycles', () => {
    render(
      <TradeHistoryTable
        lots={[lot({ id: 'a', realized: 47.5 }), lot({ id: 'b', realized: 12.25 })]}
      />,
    );

    expect(screen.getByText('$59.75')).toBeInTheDocument();
  });

  it('orders the most recently closed trade first', () => {
    render(
      <TradeHistoryTable
        lots={[
          lot({ id: 'earlier', closedAt: '2024-03-04T10:00:00-05:00' }),
          lot({ id: 'later', closedAt: '2024-03-04T12:00:00-05:00' }),
        ]}
      />,
    );

    const rows = screen.getAllByTestId(/^history-row-/);
    expect(rows[0]).toHaveAttribute('data-testid', 'history-row-later');
    expect(rows[1]).toHaveAttribute('data-testid', 'history-row-earlier');
  });

  it('renders an empty state rather than a bare table when there are no closed trades', () => {
    render(<TradeHistoryTable lots={[]} />);

    expect(screen.getByText(/no closed trades yet/i)).toBeInTheDocument();
  });

  it('renders an unavailable message when the read failed', () => {
    render(<TradeHistoryTable lots={[]} unavailable />);

    expect(screen.getByText(/trade history unavailable/i)).toBeInTheDocument();
  });

  describe('pagination', () => {
    // 12 closed lots, most recent (`closed-11`) first.
    function manyClosedLots(count: number): Lot[] {
      return Array.from({ length: count }, (_, i) =>
        lot({
          id: `closed-${i}`,
          closedAt: `2024-03-04T${String(10 + i).padStart(2, '0')}:00:00-05:00`,
        }),
      );
    }

    it('shows no pagination controls when everything fits on one page', () => {
      render(<TradeHistoryTable lots={manyClosedLots(10)} />);

      expect(
        screen.queryByRole('navigation', { name: /trade history pages/i }),
      ).not.toBeInTheDocument();
    });

    it('shows only the first page of rows once there are more than 10 closed trades', () => {
      render(<TradeHistoryTable lots={manyClosedLots(12)} />);

      expect(screen.getAllByTestId(/^history-row-/)).toHaveLength(10);
      // Most recently closed (closed-11) sorts first and lands on page 1.
      expect(screen.getByTestId('history-row-closed-11')).toBeInTheDocument();
      expect(screen.queryByTestId('history-row-closed-0')).not.toBeInTheDocument();
      expect(screen.getByTestId('history-page-indicator')).toHaveTextContent('Page 1 of 2');
    });

    it('advances to the next page and back on Previous/Next', async () => {
      const user = userEvent.setup();
      render(<TradeHistoryTable lots={manyClosedLots(12)} />);

      await user.click(screen.getByRole('button', { name: 'Next' }));

      expect(screen.getByTestId('history-page-indicator')).toHaveTextContent('Page 2 of 2');
      // Only the 2 oldest lots remain on the second page.
      expect(screen.getAllByTestId(/^history-row-/)).toHaveLength(2);
      expect(screen.getByTestId('history-row-closed-0')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

      await user.click(screen.getByRole('button', { name: 'Previous' }));

      expect(screen.getByTestId('history-page-indicator')).toHaveTextContent('Page 1 of 2');
      expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    });
  });
});
