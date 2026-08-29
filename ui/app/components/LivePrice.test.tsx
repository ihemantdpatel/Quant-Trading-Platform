/**
 * Header price tests.
 *
 * The properties that matter are about honesty rather than layout. A price
 * shown on a control surface must never be invented when none exists, and a
 * price that has stopped updating must not read as current — an operator
 * glancing at the header is deciding whether the ladder is watching a live
 * market.
 */

import { act, render, screen } from '@testing-library/react';
import { LivePrice } from './LivePrice';

describe('LivePrice', () => {
  it('renders a dash rather than a zero when no bar has arrived', () => {
    render(<LivePrice symbol="TQQQ" last={null} />);

    expect(screen.getByText('TQQQ')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText(/no live feed/i)).toBeInTheDocument();
    expect(screen.queryByText(/\$0/)).not.toBeInTheDocument();
  });

  it('renders the last bar close for its symbol', () => {
    render(<LivePrice symbol="TQQQ" last={{ symbol: 'TQQQ', price: 72.15, at: Date.now() }} />);

    expect(screen.getByText('$72.15')).toBeInTheDocument();
  });

  it('ages the price between polls, so a frozen page cannot look live', () => {
    jest.useFakeTimers();

    try {
      const at = Date.now();
      render(<LivePrice symbol="TQQQ" last={{ symbol: 'TQQQ', price: 72.15, at }} />);

      // The tick runs on an interval, not on the server-fetched prop, which is
      // the whole reason this is a Client Component.
      act(() => {
        jest.advanceTimersByTime(45_000);
      });

      expect(screen.getByText(/45s ago/)).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it('marks a price as stale once it is older than the bar cadence allows', () => {
    const at = Date.now() - 10 * 60_000;

    jest.useFakeTimers();

    try {
      render(<LivePrice symbol="TQQQ" last={{ symbol: 'TQQQ', price: 72.15, at }} />);

      // Mount is what reads the clock, so the age is unknown until then.
      act(() => {
        jest.advanceTimersByTime(1_000);
      });

      // Still shown, deliberately: a blank tells an operator nothing, while a
      // price labelled stale tells them the number and how far to trust it.
      expect(screen.getByText('$72.15')).toBeInTheDocument();
      expect(screen.getByText(/stale/i)).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });
});
