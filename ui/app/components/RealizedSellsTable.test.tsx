/**
 * Today's average-cost sells.
 *
 * The property that matters: every figure comes from the backend's
 * average-cost report, and an unknown or untracked day never renders as $0.
 */

import { render, screen, within } from '@testing-library/react';
import { RealizedSellsTable } from './RealizedSellsTable';
import type { RealizedPnl } from '../lib/api';

const tracked = { trackedSince: '2026-10-01T16:20:00.000-04:00', tracked: true, partial: false };

function realized(overrides: Partial<RealizedPnl> = {}): RealizedPnl {
  return {
    date: '2026-10-05',
    sells: [
      {
        fillId: 'f1',
        symbol: 'TQQQ',
        timestamp: '2026-10-05T11:30:00.000-04:00',
        quantity: 100,
        price: 79.5,
        averageCost: 79.5,
        commission: 0,
        gross: 0,
        realized: 0,
        uncovered: 0,
      },
    ],
    totals: { trades: 1, gross: 0, commissions: 0, net: 0 },
    held: [],
    monthToDate: { trades: 1, gross: 0, commissions: 0, net: 0 },
    coverage: tracked,
    monthCoverage: tracked,
    mismatches: [],
    ...overrides,
  };
}

describe('RealizedSellsTable', () => {
  // The operator's example: a sell at the position's average realizes $0.
  it('shows each sell against the average cost', () => {
    render(<RealizedSellsTable realized={realized()} />);

    const row = screen.getByTestId('sell-row-f1');
    expect(within(row).getByText('11:30')).toBeInTheDocument();
    expect(within(row).getByTestId('cell-avg-cost')).toHaveTextContent('79.50');
    expect(within(row).getByTestId('cell-realized')).toHaveTextContent('$0.00');
    expect(screen.getByTestId('sells-total')).toHaveTextContent('$0.00');
  });

  it('says so on a day with no sells', () => {
    render(<RealizedSellsTable realized={realized({ sells: [] })} />);

    expect(screen.getByText('No sells today.')).toBeInTheDocument();
  });

  it('says "not tracked" before the first IB snapshot, rather than $0', () => {
    render(
      <RealizedSellsTable
        realized={realized({ coverage: { trackedSince: null, tracked: false, partial: false } })}
      />,
    );

    expect(screen.getByText(/Not tracked yet/)).toBeInTheDocument();
    expect(screen.queryByTestId('sells-total')).not.toBeInTheDocument();
  });

  it('says unavailable when the read failed', () => {
    render(<RealizedSellsTable realized={null} unavailable />);

    expect(screen.getByText(/Realized P&L unavailable/)).toBeInTheDocument();
  });
});
