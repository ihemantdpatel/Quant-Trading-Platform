/**
 * Per-lot table component tests (`stories.md:463`).
 *
 * Two properties are asserted here that are not cosmetic:
 *
 * 1. **Each lot shows its own target**, from its own fill price. Two lots at
 *    different fills must show different targets — a table that displayed one
 *    shared target would be describing an average-cost exit, which is not the
 *    strategy.
 * 2. **The blended average carries its "reference only" label** (`PRD.md:378`).
 *    Unlabelled beside real targets, it invites exactly the average-cost
 *    thinking per-lot exits exist to avoid.
 */

import { render, screen, within } from '@testing-library/react';
import { LotTable } from './LotTable';
import type { Lot } from '../lib/api';

const NOW = Date.parse('2024-03-04T11:00:00-05:00');

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

describe('LotTable', () => {
  it('renders fill price, quantity, age, own target, and distance to target', () => {
    render(<LotTable lots={[lot()]} mark={95} now={NOW} />);

    const row = screen.getByTestId('lot-row-TQQQ-lot-1');

    expect(within(row).getByTestId('cell-fill')).toHaveTextContent('$95.00');
    expect(within(row).getByTestId('cell-qty')).toHaveTextContent('10');
    // Opened 09:50, "now" is 11:00 → 1h 10m.
    expect(within(row).getByTestId('cell-age')).toHaveTextContent('1h 10m');
    expect(within(row).getByTestId('cell-target')).toHaveTextContent('$99.75');
    // (99.75 - 95) / 95 = 5.00%
    expect(within(row).getByTestId('cell-distance')).toHaveTextContent('5.00%');
  });

  it('shows each lot its own target rather than one shared target', () => {
    render(
      <LotTable
        lots={[
          lot({ id: 'TQQQ-lot-1', fillPrice: 95, exitTarget: 99.75 }),
          lot({ id: 'TQQQ-lot-2', rungPrice: 90.25, fillPrice: 90.25, exitTarget: 94.76 }),
        ]}
        mark={92}
        now={NOW}
      />,
    );

    expect(
      within(screen.getByTestId('lot-row-TQQQ-lot-1')).getByTestId('cell-target'),
    ).toHaveTextContent('$99.75');
    expect(
      within(screen.getByTestId('lot-row-TQQQ-lot-2')).getByTestId('cell-target'),
    ).toHaveTextContent('$94.76');
  });

  it('labels the blended average "reference only"', () => {
    render(<LotTable lots={[lot()]} mark={95} now={NOW} />);

    expect(screen.getByText(/reference only/i)).toBeInTheDocument();
    // And it is attached to the blended-average figure, not floating elsewhere.
    expect(screen.getByText(/blended average/i)).toHaveTextContent(/reference only/i);
  });

  it('computes the blended average quantity-weighted across held lots', () => {
    render(
      <LotTable
        lots={[
          lot({ id: 'a', fillPrice: 100, quantity: 10 }),
          lot({ id: 'b', fillPrice: 90, quantity: 30 }),
        ]}
        mark={95}
        now={NOW}
      />,
    );

    // (100*10 + 90*30) / 40 = 92.50 — not the unweighted 95.
    expect(screen.getByTestId('blended-average')).toHaveTextContent('$92.50');
  });

  it('excludes closed lots from the blended average and reports their realized P&L', () => {
    render(
      <LotTable
        lots={[
          lot({
            id: 'closed',
            status: 'CLOSED',
            fillPrice: 100,
            exitPrice: 105,
            closedAt: '2024-03-04T10:30:00-05:00',
            realized: 50,
          }),
          lot({ id: 'held', fillPrice: 90, quantity: 10 }),
        ]}
        mark={95}
        now={NOW}
      />,
    );

    const closed = screen.getByTestId('lot-row-closed');
    expect(within(closed).getByText('$50.00')).toBeInTheDocument();
    // Blended reflects only the held lot, not the closed one at 100.
    expect(screen.getByTestId('blended-average')).toHaveTextContent('$90.00');
  });

  it('shows a dash for distance when no mark price is available', () => {
    // SHADOW submits nothing, so there are frequently no fills to mark against.
    render(<LotTable lots={[lot()]} mark={null} now={NOW} />);

    expect(
      within(screen.getByTestId('lot-row-TQQQ-lot-1')).getByTestId('cell-distance'),
    ).toHaveTextContent('—');
  });

  it('renders an empty state rather than a bare table when there are no lots', () => {
    render(<LotTable lots={[]} mark={null} now={NOW} />);

    expect(screen.getByText(/no lots yet/i)).toBeInTheDocument();
  });
});
