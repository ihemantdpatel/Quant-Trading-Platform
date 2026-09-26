/**
 * Tab bar tests.
 *
 * Active state is asserted through `aria-current`, not class names: the marker
 * an assistive technology reads is the one worth pinning, and styling is free
 * to change without breaking these.
 */

import { render, screen } from '@testing-library/react';
import { usePathname } from 'next/navigation';
import { Tabs } from './Tabs';

jest.mock('next/navigation', () => ({ usePathname: jest.fn() }));

const mockPathname = usePathname as jest.MockedFunction<typeof usePathname>;

function current(): string | null {
  return screen.getByRole('link', { current: 'page' }).textContent;
}

describe('Tabs', () => {
  it('links to all three views within the account on screen', () => {
    mockPathname.mockReturnValue('/accounts/nuuixl118');

    render(<Tabs />);

    expect(screen.getByRole('link', { name: 'Execution' })).toHaveAttribute(
      'href',
      '/accounts/nuuixl118',
    );
    expect(screen.getByRole('link', { name: 'Parameters' })).toHaveAttribute(
      'href',
      '/accounts/nuuixl118/parameters',
    );
    expect(screen.getByRole('link', { name: 'Backtesting' })).toHaveAttribute('href', '/backtest');
  });

  it.each([
    ['/accounts/nuuixl118', 'Execution'],
    ['/accounts/nuuixl118/parameters', 'Parameters'],
    ['/backtest', 'Backtesting'],
  ])('marks the tab for %s as current', (pathname, expected) => {
    mockPathname.mockReturnValue(pathname);

    render(<Tabs fallbackAccount="nuuixl118" />);

    expect(current()).toBe(expected);
  });

  it('keeps a nested backtest route on the Backtesting tab', () => {
    // A run selected by query or a deeper segment is still that tab.
    mockPathname.mockReturnValue('/backtest/run-1');

    render(<Tabs fallbackAccount="nuuixl118" />);

    expect(current()).toBe('Backtesting');
  });

  it('does not mark Execution current on another tab of the same account', () => {
    // Execution is the account's root, so it would prefix-match every tab.
    mockPathname.mockReturnValue('/accounts/nuuixl118/parameters');

    render(<Tabs />);

    expect(screen.getByRole('link', { name: 'Execution' })).not.toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('links the account tabs to the fallback account from a page with none', () => {
    mockPathname.mockReturnValue('/backtest');

    render(<Tabs fallbackAccount="second" />);

    expect(screen.getByRole('link', { name: 'Execution' })).toHaveAttribute(
      'href',
      '/accounts/second',
    );
  });

  it('omits the account tabs entirely when no account is reachable', () => {
    // Rather than linking to a page every control on which would fail.
    mockPathname.mockReturnValue('/backtest');

    render(<Tabs fallbackAccount={null} />);

    expect(screen.queryByRole('link', { name: 'Execution' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Backtesting' })).toBeInTheDocument();
  });
});
