/**
 * Operator shell tests (`stories.md:465`).
 *
 * The property under test: **the kill switch is present on every dashboard
 * route** (`PRD.md:383`) — including when the backend cannot be reached. It
 * lives in the layout precisely so that holds on all three tabs, and these
 * assertions are what keep it there.
 *
 * The unreachable-backend case is the one worth having a test for. A shell that
 * renders its controls only after a successful fetch hides the kill switch
 * during exactly the kind of incident where an operator wants it.
 *
 * The layout renders `<html>`/`<body>`, so these tests assert against
 * `document.body` content rather than a container subtree.
 */

import { render, screen } from '@testing-library/react';
import RootLayout from './layout';
import { loadStatus, type Status, type StatusData } from './lib/api';

jest.mock('./lib/api', () => {
  const actual = jest.requireActual('./lib/api');
  return { ...actual, loadStatus: jest.fn() };
});

jest.mock('./actions', () => ({
  setKillSwitch: jest.fn().mockResolvedValue({ ok: true, message: 'ok' }),
  setMode: jest.fn().mockResolvedValue({ ok: true, message: 'ok' }),
  setStrategyEnabled: jest.fn().mockResolvedValue({ ok: true, message: 'ok' }),
  editParameters: jest.fn().mockResolvedValue({ ok: true, message: 'ok' }),
  runReplay: jest.fn().mockResolvedValue({ ok: true, message: 'ok' }),
  resetEngine: jest.fn().mockResolvedValue({ ok: true, message: 'ok' }),
}));

// Both use App Router hooks that have no provider in a bare render. Their own
// suites cover them; the shell's job is only to place them.
jest.mock('./components/AutoRefresh', () => ({ AutoRefresh: () => null }));
jest.mock('./components/Tabs', () => ({ Tabs: () => null }));

const mockLoad = loadStatus as jest.MockedFunction<typeof loadStatus>;

function status(overrides: Partial<Status> = {}): Status {
  return {
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
    ...overrides,
  };
}

function statusData(overrides: Partial<StatusData> = {}): StatusData {
  return { status: status(), error: null, ...overrides };
}

/**
 * React warns that `<html>` cannot nest in the `<div>` RTL mounts into. That is
 * inherent to rendering a root layout in isolation and says nothing about the
 * component, so it is silenced here rather than left to look like a defect.
 * Any *other* console error still surfaces.
 */
beforeAll(() => {
  const original = console.error;
  jest.spyOn(console, 'error').mockImplementation((...args) => {
    if (typeof args[0] === 'string' && args[0].includes('cannot be a child of')) {
      return;
    }
    original(...args);
  });
});

afterAll(() => {
  jest.restoreAllMocks();
});

async function renderLayout(children: React.ReactNode = <div />) {
  render(await RootLayout({ children }));
}

describe('RootLayout', () => {
  it('renders the kill switch', async () => {
    mockLoad.mockResolvedValue(statusData());

    await renderLayout();

    expect(screen.getByRole('region', { name: /global kill switch/i })).toBeInTheDocument();
    expect(screen.getByTestId('kill-switch-state')).toHaveTextContent('ARMED');
  });

  it('renders the kill switch even when the backend is unreachable', async () => {
    mockLoad.mockResolvedValue({ status: null, error: 'fetch failed' });

    await renderLayout();

    // The control an operator needs during an outage is still there.
    expect(screen.getByRole('region', { name: /global kill switch/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /engage kill switch/i })).toBeInTheDocument();
    // And the outage itself is reported rather than rendered as calm state.
    expect(screen.getByRole('alert')).toHaveTextContent(/fetch failed/i);
  });

  it('reflects an engaged kill switch from server state', async () => {
    mockLoad.mockResolvedValue(
      statusData({
        status: status({
          halts: {
            killSwitch: {
              engaged: true,
              reason: 'operator',
              changedAt: '2024-03-04T10:00:00-05:00',
            },
            dailyLossBreaker: { halted: false },
            entryHalt: { halted: false, reason: null },
          },
        }),
      }),
    );

    await renderLayout();

    expect(screen.getByTestId('kill-switch-state')).toHaveTextContent('ENGAGED');
  });

  it('surfaces an entry halt and states positions are not liquidated', async () => {
    mockLoad.mockResolvedValue(
      statusData({
        status: status({
          halts: {
            killSwitch: { engaged: false, reason: null, changedAt: null },
            dailyLossBreaker: { halted: false },
            entryHalt: { halted: true, reason: 'broker connection failed' },
          },
        }),
      }),
    );

    await renderLayout();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/new entries are halted/i);
    expect(alert).toHaveTextContent(/held, not liquidated/i);
  });

  it('renders no alert when the engine is healthy', async () => {
    mockLoad.mockResolvedValue(statusData());

    await renderLayout();

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders the active tab content beneath the shell', async () => {
    mockLoad.mockResolvedValue(statusData());

    await renderLayout(<p>execution tab</p>);

    expect(screen.getByText('execution tab')).toBeInTheDocument();
    // Still alongside the shell, not instead of it.
    expect(screen.getByRole('region', { name: /global kill switch/i })).toBeInTheDocument();
  });
});
