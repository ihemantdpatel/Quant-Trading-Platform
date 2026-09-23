/**
 * Holdings panel tests.
 *
 * The property this component exists for: held lots and closed trade history
 * are shown one tab at a time, never both at once, and switching tabs is the
 * only way to move between them.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HoldingsPanel } from './HoldingsPanel';
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
    status: 'HELD',
    closedAt: null,
    exitPrice: null,
    realized: null,
    ...overrides,
  };
}

describe('HoldingsPanel', () => {
  it('shows held lots by default, not trade history', () => {
    const held = lot();
    const closed = lot({
      id: 'TQQQ-lot-2',
      status: 'CLOSED',
      closedAt: '2024-03-04T11:00:00-05:00',
    });
    render(<HoldingsPanel holdings={[held]} allLots={[held, closed]} mark={100} />);

    expect(screen.getByTestId('lot-row-TQQQ-lot-1')).toBeInTheDocument();
    expect(screen.queryByTestId('history-row-TQQQ-lot-2')).not.toBeInTheDocument();
  });

  it('switches to trade history when that tab is selected', async () => {
    const user = userEvent.setup();
    const held = lot();
    const closed = lot({
      id: 'TQQQ-lot-2',
      status: 'CLOSED',
      closedAt: '2024-03-04T11:00:00-05:00',
    });
    render(<HoldingsPanel holdings={[held]} allLots={[held, closed]} mark={100} />);

    await user.click(screen.getByRole('tab', { name: /^trade history/i }));

    expect(screen.getByTestId('history-row-TQQQ-lot-2')).toBeInTheDocument();
    expect(screen.queryByTestId('lot-row-TQQQ-lot-1')).not.toBeInTheDocument();
  });

  it('reports the counts of each view in its tab label', () => {
    const held = lot();
    const closed = lot({
      id: 'TQQQ-lot-2',
      status: 'CLOSED',
      closedAt: '2024-03-04T11:00:00-05:00',
    });
    render(<HoldingsPanel holdings={[held]} allLots={[held, closed]} mark={100} />);

    expect(screen.getByRole('tab', { name: 'Holdings (1)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Trade history (1)' })).toBeInTheDocument();
  });

  it('marks the active tab via aria-selected', async () => {
    const user = userEvent.setup();
    render(<HoldingsPanel holdings={[lot()]} allLots={[lot()]} mark={100} />);

    expect(screen.getByRole('tab', { name: /^holdings/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: /^trade history/i })).toHaveAttribute(
      'aria-selected',
      'false',
    );

    await user.click(screen.getByRole('tab', { name: /^trade history/i }));

    expect(screen.getByRole('tab', { name: /^trade history/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('passes the unavailable flag through to whichever tab is active', async () => {
    const user = userEvent.setup();
    render(<HoldingsPanel holdings={[]} allLots={[]} mark={100} unavailable />);

    expect(screen.getByText(/lots unavailable/i)).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /^trade history/i }));

    expect(screen.getByText(/trade history unavailable/i)).toBeInTheDocument();
  });

  it('renders row detail within the active tab', () => {
    render(<HoldingsPanel holdings={[lot()]} allLots={[lot()]} mark={100} />);

    const row = screen.getByTestId('lot-row-TQQQ-lot-1');
    expect(within(row).getByTestId('cell-fill')).toHaveTextContent('$95.00');
  });
});
