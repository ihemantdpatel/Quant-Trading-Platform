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
  it('links to all three views', () => {
    mockPathname.mockReturnValue('/');

    render(<Tabs />);

    expect(screen.getByRole('link', { name: 'Execution' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Parameters' })).toHaveAttribute('href', '/parameters');
    expect(screen.getByRole('link', { name: 'Backtesting' })).toHaveAttribute('href', '/backtest');
  });

  it.each([
    ['/', 'Execution'],
    ['/parameters', 'Parameters'],
    ['/backtest', 'Backtesting'],
  ])('marks the tab for %s as current', (pathname, expected) => {
    mockPathname.mockReturnValue(pathname);

    render(<Tabs />);

    expect(current()).toBe(expected);
  });

  it('keeps a nested backtest route on the Backtesting tab', () => {
    // A run selected by query or a deeper segment is still that tab.
    mockPathname.mockReturnValue('/backtest/run-1');

    render(<Tabs />);

    expect(current()).toBe('Backtesting');
  });

  it('does not mark Execution current on another tab', () => {
    // `/` prefix-matches everything, so this is the mistake worth guarding.
    mockPathname.mockReturnValue('/parameters');

    render(<Tabs />);

    expect(screen.getByRole('link', { name: 'Execution' })).not.toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
