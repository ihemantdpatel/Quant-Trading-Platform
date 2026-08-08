/**
 * Alert banner tests, with an emphasis on the reconciliation halt (Story 9).
 *
 * The copy is the feature here. An operator seeing a halted symbol has to learn
 * three things from the banner alone: that the symbol stopped trading, that the
 * position was **not** sold, and that resolving it is a manual step. A banner
 * that said only "HALTED" would leave the most alarming reading — "it sold
 * everything" — as the plausible one.
 */

import { render, screen } from '@testing-library/react';
import { AlertBanner } from './AlertBanner';
import type { Status } from '../lib/api';

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
      symbols: [],
    },
    alerts: [],
    strategies: [],
    ...overrides,
  } as Status;
}

describe('AlertBanner', () => {
  it('renders nothing when everything is healthy', () => {
    const { container } = render(<AlertBanner status={status()} error={null} />);

    expect(container).toBeEmptyDOMElement();
  });

  describe('reconciliation halts', () => {
    const halted = status({
      halts: {
        killSwitch: { engaged: false, reason: null, changedAt: null },
        dailyLossBreaker: { halted: false },
        entryHalt: { halted: false, reason: null },
        symbols: [
          {
            symbol: 'TQQQ',
            code: 'LOT_SUM_MISMATCH',
            reason: 'TQQQ: lot sum 300 does not equal broker net position 200',
            at: '2025-01-20T09:25:00.000-05:00',
          },
        ],
      },
    });

    it('shows the halted symbol and its reason', () => {
      render(<AlertBanner status={halted} error={null} />);

      expect(screen.getByText(/TQQQ is halted/i)).toBeInTheDocument();
      expect(screen.getByText('LOT_SUM_MISMATCH')).toBeInTheDocument();
      expect(
        screen.getByText(/lot sum 300 does not equal broker net position 200/i),
      ).toBeInTheDocument();
    });

    it('says both entries and exits are stopped', () => {
      // The distinction from ENTRY_HALT, which still permits exits. An operator
      // who assumed exits were still firing would wait for a target that never
      // triggers.
      render(<AlertBanner status={halted} error={null} />);

      expect(screen.getByText(/no entries and no exits/i)).toBeInTheDocument();
    });

    it('states the position was not liquidated', () => {
      // The single most important line in this component.
      render(<AlertBanner status={halted} error={null} />);

      expect(screen.getByText(/will not be liquidated/i)).toBeInTheDocument();
    });

    it('tells the operator resolution is manual', () => {
      render(<AlertBanner status={halted} error={null} />);

      expect(screen.getByText(/resolve the discrepancy manually/i)).toBeInTheDocument();
    });

    it('renders one banner per halted symbol', () => {
      const two = status({
        halts: {
          killSwitch: { engaged: false, reason: null, changedAt: null },
          dailyLossBreaker: { halted: false },
          entryHalt: { halted: false, reason: null },
          symbols: [
            { symbol: 'TQQQ', code: 'LOT_SUM_MISMATCH', reason: 'a', at: 'now' },
            { symbol: 'SOXL', code: 'STATE_VERSION_MISMATCH', reason: 'b', at: 'now' },
          ],
        },
      });

      render(<AlertBanner status={two} error={null} />);

      expect(screen.getByText(/TQQQ is halted/i)).toBeInTheDocument();
      expect(screen.getByText(/SOXL is halted/i)).toBeInTheDocument();
    });

    it('tolerates a backend that does not report symbol halts', () => {
      // `halts.symbols` is optional in the client type. A dashboard pointed at
      // an older backend must render, not crash.
      const older = status();
      delete (older.halts as { symbols?: unknown }).symbols;

      const { container } = render(<AlertBanner status={older} error={null} />);

      expect(container).toBeEmptyDOMElement();
    });
  });

  describe('the other alert kinds still work', () => {
    it('shows an entry halt as entries-only, not as a full stop', () => {
      const entryHalted = status({
        halts: {
          killSwitch: { engaged: false, reason: null, changedAt: null },
          dailyLossBreaker: { halted: false },
          entryHalt: { halted: true, reason: 'broker connection failed' },
          symbols: [],
        },
      });

      render(<AlertBanner status={entryHalted} error={null} />);

      expect(screen.getByText(/new entries are halted/i)).toBeInTheDocument();
      expect(screen.getByText(/held, not liquidated/i)).toBeInTheDocument();
    });

    it('shows a disconnected broker', () => {
      const down = status({
        broker: {
          name: 'mock',
          connected: false,
          state: 'FAILED',
          reconnectAttempts: 3,
          lastError: 'socket closed',
        },
      });

      render(<AlertBanner status={down} error={null} />);

      expect(screen.getByText('BROKER_DISCONNECTED')).toBeInTheDocument();
    });

    it('shows an unreachable backend', () => {
      render(<AlertBanner status={null} error="Failed to fetch" />);

      expect(screen.getByText('BACKEND_UNREACHABLE')).toBeInTheDocument();
    });
  });
});
