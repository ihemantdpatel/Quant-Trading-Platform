/**
 * Ladder view tests (`stories.md:432`).
 *
 * `GET /rungs` distinguishes held / re-armed / pending, and so must the view —
 * a re-armed rung and a pending one are both fireable but mean different things
 * to an operator: one has already completed a cycle and booked a realized gain.
 * Collapsing them would hide the chop behaviour that Story 7 exists to make
 * visible in a browser.
 */

import { render, screen, within } from '@testing-library/react';
import { LadderView } from './LadderView';
import type { Rung } from '../lib/api';

function rung(overrides: Partial<Rung> = {}): Rung {
  return {
    price: 95,
    status: 'PENDING',
    lotId: null,
    completedCycles: 0,
    lastExitAt: null,
    held: false,
    fireable: true,
    ...overrides,
  };
}

describe('LadderView', () => {
  it('distinguishes held, re-armed, and pending rungs', () => {
    render(
      <LadderView
        rungs={[
          rung({ price: 95, status: 'HELD', lotId: 'TQQQ-lot-1', held: true, fireable: false }),
          rung({ price: 90.25, status: 'RE_ARMED', completedCycles: 2 }),
          rung({ price: 85.5, status: 'PENDING' }),
        ]}
        mark={92}
      />,
    );

    expect(within(screen.getByTestId('rung-95')).getByText('Held')).toBeInTheDocument();
    expect(within(screen.getByTestId('rung-90.25')).getByText('Re-armed')).toBeInTheDocument();
    expect(within(screen.getByTestId('rung-85.5')).getByText('Pending')).toBeInTheDocument();
  });

  it('orders rungs highest price first', () => {
    render(
      <LadderView
        rungs={[rung({ price: 85.5 }), rung({ price: 95 }), rung({ price: 90.25 })]}
        mark={null}
      />,
    );

    const prices = screen.getAllByText(/^\$\d+\.\d{2}$/).map((node) => node.textContent);

    expect(prices).toEqual(['$95.00', '$90.25', '$85.50']);
  });

  it('reports completed cycles, which is what makes chop visible', () => {
    render(<LadderView rungs={[rung({ price: 95, completedCycles: 3 })]} mark={null} />);

    expect(screen.getByText(/3 completed cycles/i)).toBeInTheDocument();
    expect(within(screen.getByTestId('rung-95')).getByText('3 cycles')).toBeInTheDocument();
  });

  it('counts only held rungs against the 5-concurrent limit', () => {
    render(
      <LadderView
        rungs={[
          rung({ price: 95, status: 'HELD', held: true, fireable: false }),
          rung({ price: 90.25, status: 'RE_ARMED', completedCycles: 1 }),
          rung({ price: 85.5, status: 'PENDING' }),
        ]}
        mark={null}
      />,
    );

    // Three rungs exist, one is held.
    expect(screen.getByText(/1\/5 rungs held/i)).toBeInTheDocument();
  });

  it('states that re-armed rungs return at their original price', () => {
    render(<LadderView rungs={[rung()]} mark={null} />);

    expect(screen.getByText(/original/i)).toBeInTheDocument();
  });

  it('renders an empty state before the first rung exists', () => {
    render(<LadderView rungs={[]} mark={null} />);

    expect(screen.getByText(/no rungs yet/i)).toBeInTheDocument();
  });
});
