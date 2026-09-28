import { ExecutionMode } from '../config/execution-mode';
import { price, renderDaily, renderPeriod, signedUsd } from './pnl-email.renderer';
import { DailyPnl, PeriodPnl } from './pnl-summary';

const account = { alias: 'nuuixl118', mode: ExecutionMode.PAPER };

const daily: DailyPnl = {
  date: '2026-09-25',
  trades: [
    {
      lotId: 'g1',
      symbol: 'TQQQ',
      strategyId: 'grid:TQQQ',
      quantity: 50,
      buyPrice: 70,
      sellPrice: 70.5,
      openedAt: '2026-09-24T15:00:00.000-04:00',
      closedAt: '2026-09-25T11:05:00.000-04:00',
      gain: 25,
    },
    {
      lotId: 'g2',
      symbol: 'TQQQ',
      strategyId: 'grid:TQQQ',
      quantity: 10,
      buyPrice: 71.1234,
      sellPrice: 70.5,
      openedAt: '2026-09-25T10:00:00.000-04:00',
      closedAt: '2026-09-25T14:00:00.000Z',
      gain: -6.23,
    },
  ],
  totals: { trades: 2, gross: 18.77, commissions: 2.5, net: 16.27 },
  held: [{ symbol: 'TQQQ', strategyId: 'grid:TQQQ', lots: 3, quantity: 150 }],
  monthToDate: { trades: 40, gross: 1000, commissions: 50, net: 950 },
};

describe('pnl-email.renderer', () => {
  it('formats signed money and prices', () => {
    expect(signedUsd(1234.5)).toBe('+$1,234.50');
    expect(signedUsd(-12)).toBe('-$12.00');
    expect(signedUsd(0)).toBe('$0.00');
    expect(price(70)).toBe('70.00');
    expect(price(71.1234)).toBe('71.1234');
  });

  describe('renderDaily', () => {
    const email = renderDaily(daily, account);

    it('puts account, mode, net, and trade count in the subject', () => {
      expect(email.subject).toBe(
        '[IB nuuixl118 · PAPER] Daily P&L · Fri, Sep 25, 2026 (session close): +$16.27 (2 trades)',
      );
    });

    it('prefixes the subject when asked', () => {
      expect(renderDaily(daily, account, { subjectPrefix: '[SAMPLE]' }).subject).toMatch(
        /^\[SAMPLE\] \[IB nuuixl118/,
      );
    });

    it('lists each trade with buy, sell, and gain in both parts', () => {
      for (const body of [email.html, email.text]) {
        expect(body).toContain('70.00');
        expect(body).toContain('70.50');
        expect(body).toContain('+$25.00');
        expect(body).toContain('-$6.23');
        expect(body).toContain('+$16.27');
        expect(body).toContain('$2.50');
      }
    });

    it('shows the buy date when the lot was bought on an earlier day', () => {
      expect(email.html).toContain('Sep 24 15:00');
      expect(email.html).toContain('>10:00<');
    });

    it('colors a loss red', () => {
      expect(email.html).toMatch(/color:#b91c1c[^>]*>-\$6\.23/);
    });

    it('includes month to date and held lots', () => {
      expect(email.text).toContain('Month to date: 40 trades, gross +$1,000.00');
      expect(email.text).toContain('TQQQ (grid:TQQQ): 3 lots, 150 sh');
    });

    it('says so on a day with no trades rather than rendering an empty table', () => {
      const empty = renderDaily(
        { ...daily, trades: [], totals: { trades: 0, gross: 0, commissions: 0, net: 0 }, held: [] },
        account,
      );

      expect(empty.subject).toContain('$0.00 (0 trades)');
      expect(empty.html).toContain('No trades closed today.');
      expect(empty.text).toContain('No lots held.');
    });

    it('escapes interpolated strings', () => {
      const hostile = renderDaily(
        { ...daily, held: [{ symbol: '<b>X</b>', strategyId: 'grid:X', lots: 1, quantity: 1 }] },
        account,
      );

      expect(hostile.html).toContain('&lt;b&gt;X&lt;/b&gt;');
      expect(hostile.html).not.toContain('<b>X</b>');
    });
  });

  describe('renderPeriod', () => {
    const period: PeriodPnl = {
      from: '2026-09-01',
      to: '2026-09-30',
      days: [{ date: '2026-09-25', trades: 2, gross: 18.77, commissions: 2.5, net: 16.27 }],
      byStrategy: [{ symbol: 'TQQQ', strategyId: 'grid:TQQQ', trades: 2, gross: 18.77 }],
      totals: { trades: 2, gross: 18.77, commissions: 2.5, net: 16.27 },
    };

    it('titles a month by default', () => {
      const email = renderPeriod(period, account);

      expect(email.subject).toBe(
        '[IB nuuixl118 · PAPER] Monthly P&L · September 2026 (Sep 1 – Sep 30, 2026): +$16.27 (2 trades)',
      );
      expect(email.html).toContain('Fri, Sep 25');
      expect(email.text).toContain('2026-09-25  2 trades, gross +$18.77');
      expect(email.text).toContain('TQQQ (grid:TQQQ): 2 trades');
    });

    it('uses a custom label for a non-month window', () => {
      expect(renderPeriod(period, account, { periodLabel: 'last 7 days' }).subject).toBe(
        '[IB nuuixl118 · PAPER] P&L · last 7 days (Sep 1 – Sep 30, 2026): +$16.27 (2 trades)',
      );
    });

    it('says so when the period has no trades', () => {
      const empty = renderPeriod(
        {
          ...period,
          days: [],
          byStrategy: [],
          totals: { trades: 0, gross: 0, commissions: 0, net: 0 },
        },
        account,
      );

      expect(empty.html).toContain('No trades closed in this period.');
      expect(empty.subject).toContain('(0 trades)');
    });
  });
});

describe('subject dates', () => {
  it('writes a range within one year once, and both years across one', () => {
    const { dateRange, longDate } = jest.requireActual('./pnl-email.renderer');

    expect(longDate('2026-09-28')).toBe('Mon, Sep 28, 2026');
    expect(dateRange('2026-09-21', '2026-09-27')).toBe('Sep 21 – Sep 27, 2026');
    expect(dateRange('2026-12-29', '2027-01-04')).toBe('Dec 29, 2026 – Jan 4, 2027');
  });
});
