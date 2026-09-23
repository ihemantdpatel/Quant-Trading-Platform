/**
 * Overview panel tests.
 *
 * Status (Broker, Open positions, Deployed at cost, Realized P&L, Account
 * equity, combined into one tab), Execution mode, and Strategies are three
 * tabs on one panel now rather than two always-visible blocks — the property
 * worth pinning is that only the active tab's content is on screen, Status is
 * the default, and the five status figures all show together on that tab.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OverviewPanel } from './OverviewPanel';
import type { Position, Status } from '../lib/api';

jest.mock('../actions', () => ({
  setMode: jest.fn().mockResolvedValue({ ok: true, message: 'ok' }),
  setStrategyEnabled: jest.fn().mockResolvedValue({ ok: true, message: 'ok' }),
}));

function status(overrides: Partial<Status> = {}): Status {
  return {
    mode: 'PAPER',
    broker: {
      name: 'ib',
      connected: true,
      state: 'CONNECTED',
      reconnectAttempts: 0,
      lastError: null,
    },
    halts: {
      killSwitch: { engaged: false, reason: null, changedAt: null },
      dailyLossBreaker: { halted: false },
      entryHalt: { halted: false, reason: null },
    },
    alerts: [],
    strategies: [{ id: 'dip-ladder:TQQQ', enabled: true }],
    ...overrides,
  };
}

function position(overrides: Partial<Position> = {}): Position {
  return { symbol: 'TQQQ', quantity: 10, averageCost: 95, ...overrides };
}

function renderPanel(props: Partial<React.ComponentProps<typeof OverviewPanel>> = {}) {
  render(
    <OverviewPanel
      status={status()}
      positions={[]}
      deployed={0}
      realized={0}
      mode="PAPER"
      strategies={[{ id: 'dip-ladder:TQQQ', enabled: true, symbols: ['TQQQ'], initialized: true }]}
      {...props}
    />,
  );
}

describe('OverviewPanel', () => {
  it('shows Status by default, with Broker on it', () => {
    renderPanel();

    expect(screen.getByText('ib · CONNECTED')).toBeInTheDocument();
  });

  it('shows all five status figures together on the Status tab', () => {
    renderPanel({ positions: [position()], deployed: 1234.5, realized: -50 });

    expect(screen.getByText('ib · CONNECTED')).toBeInTheDocument();
    expect(screen.getByText('10 TQQQ')).toBeInTheDocument();
    expect(screen.getByText('$1,234.50')).toBeInTheDocument();
    expect(screen.getByText('-$50.00')).toBeInTheDocument();
    expect(screen.getByText('not set')).toBeInTheDocument();
  });

  it('shows only one tab’s content at a time', async () => {
    const user = userEvent.setup();
    renderPanel({ positions: [position()] });

    expect(screen.getByText('10 TQQQ')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Strategies' }));

    expect(screen.queryByText('10 TQQQ')).not.toBeInTheDocument();
    expect(screen.queryByText('ib · CONNECTED')).not.toBeInTheDocument();
  });

  it('reports flat rather than unavailable when positions are genuinely empty', () => {
    renderPanel({ positions: [] });

    expect(screen.getByText('flat')).toBeInTheDocument();
  });

  it('distinguishes an unreachable broker from a flat account', () => {
    renderPanel({ positions: [], positionsUnavailable: true });

    expect(screen.getByText('unavailable')).toBeInTheDocument();
    expect(screen.queryByText('flat')).not.toBeInTheDocument();
  });

  it('shows the execution mode switch on the Execution mode tab', async () => {
    const user = userEvent.setup();
    renderPanel({ mode: 'SHADOW' });

    await user.click(screen.getByRole('tab', { name: 'Execution mode' }));

    expect(screen.getByTestId('current-mode')).toHaveTextContent('SHADOW');
  });

  it('shows the strategy list on the Strategies tab', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('tab', { name: 'Strategies' }));

    expect(screen.getByText('dip-ladder:TQQQ')).toBeInTheDocument();
  });

  it('marks the active tab via aria-selected', async () => {
    const user = userEvent.setup();
    renderPanel();

    expect(screen.getByRole('tab', { name: 'Status' })).toHaveAttribute('aria-selected', 'true');

    await user.click(screen.getByRole('tab', { name: 'Strategies' }));

    expect(screen.getByRole('tab', { name: 'Strategies' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Status' })).toHaveAttribute('aria-selected', 'false');
  });
});
