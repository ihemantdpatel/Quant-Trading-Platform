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

import { render, screen, within } from '@testing-library/react';
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
    gridLots: [],
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

  it('renders the ladder and the shared holdings table together', async () => {
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
    expect(screen.getByRole('region', { name: /^holdings$/i })).toBeInTheDocument();
    expect(screen.getByTestId('lot-row-TQQQ-lot-1')).toBeInTheDocument();
    expect(screen.getByText(/reference only/i)).toBeInTheDocument();
  });

  it('renders the ladder’s and the grid strategy’s lots together in one shared holdings table', async () => {
    mockLoad.mockResolvedValue(
      executionData({
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
        gridLots: [
          {
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
            workingOrderId: 'co-1',
          },
        ],
      }),
    );

    render(await ExecutionPage());

    const holdings = screen.getByRole('region', { name: /^holdings$/i });

    expect(within(holdings).getByTestId('lot-row-TQQQ-lot-1')).toBeInTheDocument();
    expect(within(holdings).getByTestId('lot-row-TQQQ-grid-lot-1')).toBeInTheDocument();
    // Tagged so an operator can tell which strategy opened which row, now
    // that both share one table.
    expect(
      within(within(holdings).getByTestId('lot-row-TQQQ-lot-1')).getByTestId('cell-strategy'),
    ).toHaveTextContent('Dip ladder');
    expect(
      within(within(holdings).getByTestId('lot-row-TQQQ-grid-lot-1')).getByTestId('cell-strategy'),
    ).toHaveTextContent('Grid');
    // Only one panel now — not a second "Grid — Lots" region.
    expect(screen.queryByRole('region', { name: /^grid — lots$/i })).not.toBeInTheDocument();
  });

  it('hides the holdings table when no strategy is enabled and neither holds anything', async () => {
    mockLoad.mockResolvedValue(
      executionData({
        strategies: [
          { id: 'dip-ladder:TQQQ', enabled: false, symbols: ['TQQQ'], initialized: false },
        ],
      }),
    );

    render(await ExecutionPage());

    expect(screen.queryByRole('region', { name: /^holdings$/i })).not.toBeInTheDocument();
  });

  it('hides the ladder panel when the ladder is disabled and holds nothing', async () => {
    mockLoad.mockResolvedValue(
      executionData({
        strategies: [
          { id: 'dip-ladder:TQQQ', enabled: false, symbols: ['TQQQ'], initialized: false },
        ],
      }),
    );

    render(await ExecutionPage());

    expect(screen.queryByRole('region', { name: /^ladder$/i })).not.toBeInTheDocument();
  });

  it('hides the ladder panel once the ladder is disabled even when its old rungs are still in the database', async () => {
    // A disabled strategy's rungs are still served from the database
    // (flagged `unverified`), the same as its lots — but a rung describes
    // the ladder's own bookkeeping, not a broker fact like a held share, so
    // it must not keep the Ladder panel showing once the grid strategy (with
    // no rung concept of its own) is the one actually trading the symbol.
    mockLoad.mockResolvedValue(
      executionData({
        strategies: [
          { id: 'dip-ladder:TQQQ', enabled: false, symbols: ['TQQQ'], initialized: false },
          { id: 'grid:TQQQ', enabled: true, symbols: ['TQQQ'], initialized: true },
        ],
        rungs: [
          {
            price: 95,
            status: 'RE_ARMED',
            lotId: null,
            workingOrderId: null,
            completedCycles: 1,
            lastExitAt: '2024-03-04T10:00:00-05:00',
            held: false,
            fireable: false,
            unverified: true,
          },
        ],
      }),
    );

    render(await ExecutionPage());

    expect(screen.queryByRole('region', { name: /^ladder$/i })).not.toBeInTheDocument();
  });

  it('keeps the holdings table visible when the ladder is disabled but still holding a real position', async () => {
    // A disabled strategy's real broker position does not stop existing —
    // `GET /lots` serves it from the database, flagged `unverified`, and the
    // dashboard must not hide the one place that shows it.
    mockLoad.mockResolvedValue(
      executionData({
        strategies: [
          { id: 'dip-ladder:TQQQ', enabled: false, symbols: ['TQQQ'], initialized: false },
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
            unverified: true,
          },
        ],
      }),
    );

    render(await ExecutionPage());

    expect(screen.getByRole('region', { name: /^holdings$/i })).toBeInTheDocument();
    expect(screen.getByTestId('lot-row-TQQQ-lot-1')).toBeInTheDocument();
  });

  it('shows the holdings table once the grid strategy is enabled, even while flat, with no ladder panel', async () => {
    mockLoad.mockResolvedValue(
      executionData({
        strategies: [
          { id: 'dip-ladder:TQQQ', enabled: false, symbols: ['TQQQ'], initialized: false },
          { id: 'grid:TQQQ', enabled: true, symbols: ['TQQQ'], initialized: true },
        ],
      }),
    );

    render(await ExecutionPage());

    expect(screen.getByRole('region', { name: /^holdings$/i })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /^ladder$/i })).not.toBeInTheDocument();
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
