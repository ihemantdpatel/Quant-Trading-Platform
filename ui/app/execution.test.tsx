/**
 * Execution tab tests.
 *
 * Scoped to current engine state. The kill switch and alert assertions moved to
 * `layout.test.tsx` when those components were hoisted into the shell, since
 * they must hold on every tab rather than on this page alone.
 *
 * The replay-controls cases are the new safety property: fixture replay must
 * disappear once a live Gateway is bound, because it would otherwise drive
 * synthetic bars through the engine running the session under observation.
 */

import { render, screen } from '@testing-library/react';
import ExecutionPage from './page';
import { loadExecution, type ExecutionData } from './lib/api';

jest.mock('./lib/api', () => {
  const actual = jest.requireActual('./lib/api');
  return { ...actual, loadExecution: jest.fn() };
});

jest.mock('./actions', () => ({
  setKillSwitch: jest.fn().mockResolvedValue({ ok: true, message: 'ok' }),
  setMode: jest.fn().mockResolvedValue({ ok: true, message: 'ok' }),
  setStrategyEnabled: jest.fn().mockResolvedValue({ ok: true, message: 'ok' }),
  editParameters: jest.fn().mockResolvedValue({ ok: true, message: 'ok' }),
  runReplay: jest.fn().mockResolvedValue({ ok: true, message: 'ok' }),
  resetEngine: jest.fn().mockResolvedValue({ ok: true, message: 'ok' }),
}));

const mockLoad = loadExecution as jest.MockedFunction<typeof loadExecution>;

function executionData(overrides: Partial<ExecutionData> = {}): ExecutionData {
  return {
    status: {
      mode: 'SHADOW',
      broker: {
        name: 'mock',
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
    },
    lots: [],
    rungs: [],
    positions: [],
    orders: [],
    fills: [],
    riskEvents: [],
    strategies: [{ id: 'dip-ladder:TQQQ', enabled: true, symbols: ['TQQQ'], initialized: true }],
    error: null,
    ...overrides,
  };
}

/** The same data with a different broker bound. */
function withBroker(name: string): ExecutionData {
  const data = executionData();
  data.status!.broker.name = name;
  return data;
}

describe('Execution page', () => {
  it('shows the current execution mode', async () => {
    mockLoad.mockResolvedValue(executionData());

    render(await ExecutionPage());

    expect(screen.getByTestId('current-mode')).toHaveTextContent('SHADOW');
    expect(screen.getByText(/nothing is submitted/i)).toBeInTheDocument();
  });

  it('renders the ladder and lot table together', async () => {
    mockLoad.mockResolvedValue(
      executionData({
        rungs: [
          {
            price: 95,
            status: 'HELD',
            lotId: 'TQQQ-lot-1',
            workingOrderId: null,
            completedCycles: 0,
            lastExitAt: null,
            held: true,
            fireable: false,
          },
        ],
        lots: [
          {
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
          },
        ],
      }),
    );

    render(await ExecutionPage());

    expect(screen.getByRole('region', { name: /^ladder$/i })).toBeInTheDocument();
    expect(screen.getByTestId('rung-95')).toBeInTheDocument();
    expect(screen.getByTestId('lot-row-TQQQ-lot-1')).toBeInTheDocument();
    expect(screen.getByText(/reference only/i)).toBeInTheDocument();
  });

  it('offers replay controls against the mock broker', async () => {
    mockLoad.mockResolvedValue(withBroker('mock'));

    render(await ExecutionPage());

    expect(screen.getByRole('region', { name: /engine controls/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^replay$/i })).toBeInTheDocument();
  });

  it('hides replay controls when IB is the bound broker', async () => {
    mockLoad.mockResolvedValue(withBroker('ib'));

    render(await ExecutionPage());

    // Replaying a fixture into a live session would corrupt the session being
    // observed, and Reset would discard the state the daily report reads.
    expect(screen.queryByRole('region', { name: /engine controls/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^replay$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^reset$/i })).not.toBeInTheDocument();
  });

  it('hides replay controls when the broker is unknown', async () => {
    // An unreachable backend must not be read as "safe to replay".
    mockLoad.mockResolvedValue(executionData({ status: null, error: 'fetch failed' }));

    render(await ExecutionPage());

    expect(screen.queryByRole('button', { name: /^replay$/i })).not.toBeInTheDocument();
  });

  it('does not render the parameter editor', async () => {
    // Configuration lives on its own tab; this page is execution state only.
    mockLoad.mockResolvedValue(executionData());

    render(await ExecutionPage());

    expect(screen.queryByRole('button', { name: /apply/i })).not.toBeInTheDocument();
  });
});
