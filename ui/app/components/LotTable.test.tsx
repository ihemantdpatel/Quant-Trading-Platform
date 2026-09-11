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
import type { Lot, LotLike } from '../lib/api';

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

/** A grid-shaped lot — no `rungPrice`, unlike `lot()` above. */
function gridLikeLot(overrides: Partial<LotLike> = {}): LotLike {
  return {
    id: 'TQQQ-grid-lot-1',
    symbol: 'TQQQ',
    fillPrice: 100,
    quantity: 50,
    openedAt: '2024-03-04T09:50:00-05:00',
    exitTarget: 101,
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

  it('excludes closed lots from the blended average and from the table entirely', () => {
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

    // Closed lots belong to TradeHistoryTable, not here.
    expect(screen.queryByTestId('lot-row-closed')).not.toBeInTheDocument();
    expect(screen.getByTestId('lot-row-held')).toBeInTheDocument();
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

    expect(screen.getByText(/no lots held/i)).toBeInTheDocument();
  });

  it('renders the held-only empty state even when only closed lots exist', () => {
    render(
      <LotTable
        lots={[
          lot({
            id: 'closed',
            status: 'CLOSED',
            realized: 50,
            closedAt: '2024-03-04T10:30:00-05:00',
          }),
        ]}
        mark={null}
        now={NOW}
      />,
    );

    expect(screen.getByText(/no lots held/i)).toBeInTheDocument();
  });

  it('omits the Rung column and cell when showRungColumn is false', () => {
    // The grid strategy's own lots have no rung — this is how its instance of
    // the table (reused rather than duplicated) renders them. `rungPrice` is
    // left on the fixture to prove the column is hidden even when the field
    // is present, not merely when it is absent.
    render(<LotTable lots={[lot()]} mark={95} now={NOW} showRungColumn={false} />);

    expect(screen.queryByText('Rung')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cell-rung')).not.toBeInTheDocument();
    expect(screen.getByTestId('cell-fill')).toHaveTextContent('$95.00');
  });

  it('shows no Strategy column when no lot carries a strategy tag', () => {
    render(<LotTable lots={[lot()]} mark={95} now={NOW} />);

    expect(screen.queryByText('Strategy')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cell-strategy')).not.toBeInTheDocument();
  });

  it('adds a Strategy column when lots are tagged, for a shared holdings view', () => {
    render(
      <LotTable
        lots={[
          lot({ id: 'TQQQ-lot-1', strategy: 'Dip ladder' }),
          gridLikeLot({ id: 'TQQQ-grid-lot-1', strategy: 'Grid' }),
        ]}
        mark={95}
        now={NOW}
      />,
    );

    expect(
      within(screen.getByTestId('lot-row-TQQQ-lot-1')).getByTestId('cell-strategy'),
    ).toHaveTextContent('Dip ladder');
    expect(
      within(screen.getByTestId('lot-row-TQQQ-grid-lot-1')).getByTestId('cell-strategy'),
    ).toHaveTextContent('Grid');
    // A grid row still renders in the shared Rung column — a dash, not an
    // omitted cell, since some rows in this table genuinely have a rung.
    expect(
      within(screen.getByTestId('lot-row-TQQQ-grid-lot-1')).getByTestId('cell-rung'),
    ).toHaveTextContent('—');
  });

  it('renders a custom title and empty message', () => {
    render(
      <LotTable lots={[]} mark={null} now={NOW} title="Grid — Lots" emptyMessage="Nothing here." />,
    );

    expect(screen.getByRole('region', { name: /^grid — lots$/i })).toBeInTheDocument();
    expect(screen.getByText('Nothing here.')).toBeInTheDocument();
  });
});
